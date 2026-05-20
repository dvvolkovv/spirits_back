# SMM Producer for External Creators — Implementation Plan

**Goal:** Open Юля to all users with a creator-mode pipeline (custom CTA, random Yandex voice, alternate sceptwriter prompt), while preserving the Linkeon-admin pipeline via `is_linkeon_official` flag.

**Architecture:** Single SMM tool-calling agent (Юля). Mode is decided per-campaign — admin-created campaigns default to Linkeon-official (existing pipeline), all others use creator-mode (new pipeline). New table `smm_creator_campaign` holds the user's CTA / voice / genre choices.

**Tech Stack:** NestJS 10, BullMQ, PostgreSQL 16, Remotion 4, Yandex SpeechKit, React 18, Tailwind, Vite.

---

## Task 1: DB migration + entity

**Files:**
- Create: `src/smm/migrations/007_creator_campaign.sql`
- Modify: `src/smm/entities/smm-campaign.entity.ts` — add `isLinkeonOfficial: boolean`
- Create: `src/smm/entities/smm-creator-campaign.entity.ts`

### Step 1.1: Write migration

`007_creator_campaign.sql`:
```sql
-- 007_creator_campaign.sql
-- Adds is_linkeon_official flag to smm_campaign and creates
-- smm_creator_campaign for external-user CTA/voice/genre settings.

ALTER TABLE smm_campaign
  ADD COLUMN IF NOT EXISTS is_linkeon_official boolean NOT NULL DEFAULT false;

-- Backfill: all existing campaigns are admin-owned Linkeon-marketing.
UPDATE smm_campaign SET is_linkeon_official = true WHERE created_at < now();

CREATE TABLE IF NOT EXISTS smm_creator_campaign (
  campaign_id   uuid PRIMARY KEY REFERENCES smm_campaign(id) ON DELETE CASCADE,
  cta_handle    text NOT NULL,
  cta_label     text NOT NULL DEFAULT 'Подписывайся',
  voice_gender  text NOT NULL CHECK (voice_gender IN ('male', 'female')),
  genre         text NOT NULL DEFAULT 'dialog'
                CHECK (genre IN ('dialog', 'monologue', 'fact_explanation')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS smm_creator_updated_at ON smm_creator_campaign;
CREATE TRIGGER smm_creator_updated_at BEFORE UPDATE ON smm_creator_campaign
  FOR EACH ROW EXECUTE FUNCTION trg_smm_set_updated_at();
```

### Step 1.2: Apply migration on prod (via SSH)

```bash
cat ~/Downloads/spirits_back/src/smm/migrations/007_creator_campaign.sql | \
  ssh dvolkov@212.113.106.202 'PGPASSWORD=linkeon_pass_2026 psql -h localhost -p 5433 -U linkeon -d linkeon'
```

Expected: `ALTER TABLE`, `UPDATE 5` (or however many existing campaigns), `CREATE TABLE`, trigger create.

### Step 1.3: Entity files

`smm-campaign.entity.ts` (extend existing interface) — add `isLinkeonOfficial: boolean` to the type, update `rowToCampaign` to map `row.is_linkeon_official`.

`smm-creator-campaign.entity.ts` (new):
```ts
export interface SmmCreatorCampaign {
  campaignId: string;
  ctaHandle: string;
  ctaLabel: string;
  voiceGender: 'male' | 'female';
  genre: 'dialog' | 'monologue' | 'fact_explanation';
}

export function rowToCreatorCampaign(row: any): SmmCreatorCampaign {
  return {
    campaignId: row.campaign_id,
    ctaHandle: row.cta_handle,
    ctaLabel: row.cta_label,
    voiceGender: row.voice_gender,
    genre: row.genre,
  };
}
```

### Step 1.4: Commit

```bash
git add src/smm/migrations/007_creator_campaign.sql \
        src/smm/entities/smm-campaign.entity.ts \
        src/smm/entities/smm-creator-campaign.entity.ts
git commit -m "feat(smm): схема creator-mode — is_linkeon_official + smm_creator_campaign"
```

---

## Task 2: Service for creator-campaign CRUD

**Files:**
- Create: `src/smm/producer/creator-campaign.service.ts`
- Modify: `src/smm/smm.module.ts` — register

### Step 2.1: Write the service

```ts
// src/smm/producer/creator-campaign.service.ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { SmmCreatorCampaign, rowToCreatorCampaign } from '../entities/smm-creator-campaign.entity';

export interface UpsertCreatorCampaignInput {
  campaignId: string;
  ctaHandle: string;
  ctaLabel?: string;
  voiceGender: 'male' | 'female';
  genre?: 'dialog' | 'monologue' | 'fact_explanation';
}

@Injectable()
export class CreatorCampaignService {
  constructor(private readonly pg: PgService) {}

  async upsert(input: UpsertCreatorCampaignInput): Promise<SmmCreatorCampaign> {
    const r = await this.pg.query(
      `INSERT INTO smm_creator_campaign
         (campaign_id, cta_handle, cta_label, voice_gender, genre)
       VALUES ($1, $2, COALESCE($3, 'Подписывайся'), $4, COALESCE($5, 'dialog'))
       ON CONFLICT (campaign_id) DO UPDATE SET
         cta_handle = EXCLUDED.cta_handle,
         cta_label = EXCLUDED.cta_label,
         voice_gender = EXCLUDED.voice_gender,
         genre = EXCLUDED.genre,
         updated_at = now()
       RETURNING *`,
      [input.campaignId, input.ctaHandle, input.ctaLabel ?? null, input.voiceGender, input.genre ?? null],
    );
    return rowToCreatorCampaign(r.rows[0]);
  }

  async getByCampaign(campaignId: string): Promise<SmmCreatorCampaign | null> {
    const r = await this.pg.query(
      `SELECT * FROM smm_creator_campaign WHERE campaign_id = $1`,
      [campaignId],
    );
    return r.rows[0] ? rowToCreatorCampaign(r.rows[0]) : null;
  }
}
```

### Step 2.2: Register in module

In `smm.module.ts` add `CreatorCampaignService` to both `providers` and `exports`.

### Step 2.3: Commit

```bash
git commit -m "feat(smm): CreatorCampaignService — upsert/get CTA+voice+genre settings"
```

---

## Task 3: New MCP tool `set_creator_campaign_settings`

**Files:**
- Modify: `src/smm/producer/smm-producer-tools.service.ts`
- Modify: `src/chat/claude-agent.service.ts` — register the tool

### Step 3.1: Add handler

In `SmmProducerToolsService.handle()` add a new branch:

```ts
case 'set_creator_campaign_settings': {
  // Find or create the draft campaign for this user
  const camp = await this.getOrCreateDraftCampaign(ctx.userId, ctx.isAdmin);
  await this.creatorCampaigns.upsert({
    campaignId: camp.id,
    ctaHandle: args.cta_handle,
    ctaLabel: args.cta_label,
    voiceGender: args.voice_gender,
    genre: args.genre,
  });
  return { ok: true, campaignId: camp.id };
}
```

`getOrCreateDraftCampaign` is a new helper — finds the latest campaign with `status='drafting'` for the user, or creates one with `is_linkeon_official = isAdmin && !creatorSettingsProvided`. Wire `isAdmin` via `ctx.isAdmin` from `ToolContext`.

### Step 3.2: Register in event-translator + Claude-agent SDK

`src/chat/claude-agent.service.ts` — in the `tools` array in `buildMcpServer`, add:

```ts
tool(
  'set_creator_campaign_settings',
  'Сохранить настройки кампании внешнего автора: CTA-ссылка, пол голоса, жанр. Вызывай первым делом для не-админских юзеров до generate_scenarios.',
  {
    cta_handle: z.string(),
    cta_label: z.string().optional(),
    voice_gender: z.enum(['male', 'female']),
    genre: z.enum(['dialog', 'monologue', 'fact_explanation']).optional(),
  },
  async (args: any) => handle('set_creator_campaign_settings', args),
),
```

### Step 3.3: Test via REST

Smoke check that the tool resolves (will be implicit when E2E runs later). No standalone unit test for V1.

### Step 3.4: Commit

```bash
git commit -m "feat(smm): MCP tool set_creator_campaign_settings"
```

---

## Task 4: Branched system prompt in `ScenarioService`

**Files:**
- Modify: `src/smm/producer/scenario.service.ts`

### Step 4.1: Add creator-mode prompt

Inside `ScenarioService.generate`, check `campaign.is_linkeon_official`. If false:

```ts
const creator = await this.creatorCampaigns.getByCampaign(input.campaignId);
if (!creator) {
  throw new Error('Creator campaign settings missing — call set_creator_campaign_settings first');
}
const systemPrompt = `Ты — креативный сценарист коротких видео для эксперта-блогера.

ТЕМА: ${input.topic ?? 'свободная'}
ЖАНР: ${creator.genre}
CTA: ${creator.ctaLabel} → ${creator.ctaHandle}

Сценарий 30-60 секунд: герой-зритель задаёт вопрос → эксперт по теме отвечает → итог + CTA. Реплики на русском, живой разговорный язык. БЕЗ канцелярита.

Верни массив сценариев в том же JSON-формате (title, dialog, broll_prompts, mood). assistant_role фиксированно 'expert'.`;
```

For `is_linkeon_official=true` — текущий `SYSTEM_PROMPT` без изменений.

### Step 4.2: Inject `CreatorCampaignService` via constructor

Add to `ScenarioService` constructor and import.

### Step 4.3: Commit

```bash
git commit -m "feat(smm): branched system prompt — creator-mode vs Linkeon-official"
```

---

## Task 5: Random Yandex voice picker

**Files:**
- Create: `src/smm/producer/voice-picker.ts`
- Modify: `src/smm/migrations/008_scenario_voice.sql` — add column `tts_voice_id`
- Modify: `src/smm/producer/scenario.service.ts` — store picked voice
- Modify: `worker/src/tts/yandex.ts` (or wherever TTS reads voice) — use scenario's voice

### Step 5.1: Migration

```sql
ALTER TABLE smm_scenario ADD COLUMN IF NOT EXISTS tts_voice_id text;
```

Apply on prod.

### Step 5.2: Voice picker helper

```ts
// src/smm/producer/voice-picker.ts
const MALE_VOICES = ['ermil', 'filipp', 'madirus'];
const FEMALE_VOICES = ['alena', 'jane', 'omazh'];

export function pickRandomVoice(gender: 'male' | 'female'): string {
  const pool = gender === 'male' ? MALE_VOICES : FEMALE_VOICES;
  return pool[Math.floor(Math.random() * pool.length)];
}
```

### Step 5.3: Wire into ScenarioService

When inserting `smm_scenario` row, if creator-mode → `tts_voice_id = pickRandomVoice(creator.voiceGender)`. Otherwise NULL (admin path uses per-role map as today).

### Step 5.4: Worker reads tts_voice_id

In `worker/src/render/pipeline.ts` or TTS module, prefer `scenario.ttsVoiceId` over the role-based default if set.

### Step 5.5: Commit

```bash
git commit -m "feat(smm): random Yandex voice per scenario for creator-mode"
```

---

## Task 6: CTA component creator-branch

**Files:**
- Modify: `worker/remotion/src/components/CTA.tsx`
- Modify: `worker/remotion/src/compositions/ChatCase.tsx`
- Modify: `worker/remotion/src/types.ts`
- Modify: `worker/src/render/pipeline.ts`

### Step 6.1: Extend types

```ts
// types.ts
export interface CaseVideoProps {
  ...,
  isLinkeonOfficial: boolean;
  ctaHandle?: string;
  ctaLabel?: string;
}
```

### Step 6.2: CTA.tsx — branch

```tsx
if (isLinkeonOfficial) {
  // existing dark forest gradient + logo + ИИ-<role> + my.linkeon.io
} else {
  // same forest gradient + logo
  // headline = ctaLabel (e.g. "Подписывайся")
  // big text = ctaHandle (e.g. "@ekat_travels")
  // tiny footer = "создано на my.linkeon.io"
}
```

### Step 6.3: ChatCase.tsx — pass props

`<CTA atSec={ctaAt} durationSec={5} assistantRole={props.assistantRole} isLinkeonOfficial={props.isLinkeonOfficial} ctaHandle={props.ctaHandle} ctaLabel={props.ctaLabel} />`

### Step 6.4: pipeline.ts — build props

Load `is_linkeon_official` from campaign, and (if false) creator settings, and assemble `remotionProps`.

### Step 6.5: Build + verify locally with a dry render

```bash
cd ~/Downloads/spirits_back/worker && npm run build
```

### Step 6.6: Commit

```bash
git commit -m "feat(smm): CTA-кадр поддерживает creator-mode (текстовый CTA)"
```

---

## Task 7: Frontend — make Юля visible to everyone

**Files:**
- Modify: `src/components/chat/ChatLayout.tsx`
- Modify: `src/components/chat/AssistantSelection.tsx`

### Step 7.1: Remove the category filter

In both files replace:
```ts
: assistants.filter(a => a.category !== 'smm');
```
with:
```ts
: assistants;
```

Юля appears in all users' assistant lists.

### Step 7.2: Build, smoke

```bash
cd ~/Downloads/spirits_front && pnpm build
```

### Step 7.3: Commit

```bash
git commit -m "feat(smm): Юля видна всем пользователям, не только админам"
```

---

## Task 8: System prompt for Юля (creator-mode questions)

**Files:**
- Modify: `src/smm/producer/smm-producer.prompt.ts`

### Step 8.1: Append creator-mode section

At the bottom of `SMM_PRODUCER_SYSTEM_PROMPT`:

```
ЕСЛИ юзер НЕ админ Linkeon (свойство ctx.isAdmin = false):
- Сначала собери настройки кампании через `set_creator_campaign_settings`:
  - Спроси тему ролика
  - Спроси CTA: куда ведём аудиторию (TG-канал, сайт, IG-handle)
  - Спроси пол озвучки (мужской / женский)
  - Предложи жанр (по умолчанию 'dialog'), дай возможность поменять
- Только после `set_creator_campaign_settings` — вызывай `generate_scenarios`.
- Не используй роли psy/coach/lawyer/... — для creator-mode роль фиксированно 'expert'.

ЕСЛИ юзер админ — старая логика (предложи тему, выбери из 14 Linkeon-ролей).
```

### Step 8.2: Inject `isAdmin` flag into the prompt context

`claude-agent.service.ts` `streamSmmProducer` — pass `isAdmin: ctx.isAdmin` info into the system prompt via templating or via a prepended user-context block.

Simplest: prepend a context block to the system prompt at call time:
```ts
const systemPromptWithCtx = `Контекст юзера: isAdmin=${ctx.isAdmin}.\n\n${SMM_PRODUCER_SYSTEM_PROMPT}`;
```

### Step 8.3: Commit

```bash
git commit -m "feat(smm): системный промпт Юли — creator-mode wizard"
```

---

## Task 9: E2E test on staging

### Step 9.1: Log in as a non-admin test user

Use `integration_test@taler-test.com` equivalent for my.linkeon.io — pick a phone with isAdmin=false (NOT 79030169187 which is admin). Use the debug OTP endpoint to get a JWT.

### Step 9.2: Open Юля in chat, walk through:
- Тема: «куда поехать в марте на 3 дня»
- CTA: `@ekat_travels`
- Voice: female
- Genre: dialog
- Утвердить сценарий → рендер → утвердить ролик
- (Не публикуем — нет реальной соцсети у тестового юзера)

### Step 9.3: Inspect rendered mp4

Check the final CTA frame manually — should show `Подписывайся → @ekat_travels` on forest gradient + tiny «создано на my.linkeon.io».

### Step 9.4: Verify token balance dropped correctly

Compare balance before / after — should be ~15k (rendering) + ~2k (Claude calls) deducted.

### Step 9.5: Verify admin path still works

Log in as 79030169187 (admin), generate a Linkeon-marketing video. CTA should be the existing «ИИ-<role>» + my.linkeon.io.

---

## Task 10: Deploy + commit

### Step 10.1: Full deploy via `scripts/deploy.sh`

```bash
SKIP_SMOKE=1 bash ~/Downloads/spirits_back/scripts/deploy.sh
```

### Step 10.2: Restart worker explicitly

```bash
ssh dvolkov@212.113.106.202 "pm2 restart linkeon-smm-worker"
```

### Step 10.3: Run smoke tests

```bash
bash ~/Downloads/spirits_back/tests/smoke/run.sh
```

If smoke fails — investigate and fix before merging.

---

## Rollout plan

1. Deploy to prod with `category='smm'` filter still applied (Юля still admin-only). Smoke tests pass.
2. Remove the filter (Task 7) — flips Юля to public.
3. Monitor `pm2 logs linkeon-api` and `linkeon-smm-worker` for the first day for any unexpected creator-mode failures.
4. Roll back: revert Task 7 commit (one-line filter restoration).

## Risks

- **Tool prompt confusion**: Claude haiku может пропускать `set_creator_campaign_settings` и сразу прыгать в `generate_scenarios`. Mitigation: жёстко в system prompt — «НЕ вызывай generate_scenarios пока set_creator_campaign_settings не выполнен для не-админа».
- **CTA-handle validation**: пользователь может ввести `@` без знака, или URL с `https://`. Frontend / Юля должны нормализовать.
- **Voice availability**: не все 6 Yandex voices активны в текущем тарифе. Smoke-проверка отдельно.

## Out of scope

- Voice cloning.
- Logo upload.
- SaaS billing.
- Pre-baked templates / examples.
- Analytics.
