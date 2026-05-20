# SMM Producer for External Creators — Design Spec

**Status:** draft — to be approved
**Author:** Claude + Dmitry
**Date:** 2026-05-19

## Goal

Open the SMM Producer chat assistant («Юлия») to all my.linkeon.io users (not only admins). Each user can chat with Юлия, describe a video topic, and get a short vertical clip generated, edited, and published to their social media — paid via the existing Linkeon-token balance.

## Why

Two products in one engine:

1. **Linkeon marketing** (current). Admin operator uses Юлия to generate clips that promote my.linkeon.io itself; clips feature our 14 AI-assistants as the experts.
2. **Creator-mode** (new). External users — bloggers, niche experts, small businesses — generate clips that promote *their own* channels and contacts. Same Юля, same pipeline, but the «expert» in the script and the CTA at the end belong to the user, not to Linkeon.

Path B (creator-mode) is the new addition. Path A (Linkeon marketing) stays as-is.

## Non-goals (V2 backlog)

- ElevenLabs voice cloning of the creator's voice.
- Custom logo upload (CTA stays text-only for non-Linkeon users).
- Multi-genre templates with pre-baked examples (only `dialog` for V1; `monologue` / `fact_explanation` are accepted but use the same renderer).
- Analytics dashboards beyond the existing publication log.
- Batch generation (10 clips in one shot).
- SaaS subscription billing. Linkeon-token charges are reused.

## User flow (non-admin)

```
User opens chat → selects Юлия (now visible to all users)
   ↓
Юля: «О чём хочешь ролик? Какую тему раскроем?»
User: тема (+ optionally CTA hint, voice gender — Юля доспрашивает чего не хватает)
   ↓
Юля предлагает жанр (dialog by default). User: «Ок» или «давай другой»
   ↓
Юля генерит сценарий → ScenarioCard в чате
   ↓
User: Редактировать / Перегенерировать / Утвердить
   ↓ (на «Утвердить» — токены за рендер списываются)
SmmVideoPlayer в чате с прогрессом рендера
   ↓
User: Сделать заново / Отклонить / Опубликовать
   ↓ (на «Опубликовать»)
PublishModal — выбор соцсетей + времени + caption → пост уходит
```

## Schema changes

### New table: `smm_creator_campaign`

One row per `smm_campaign` to hold creator-specific metadata. Optional — admin/Linkeon campaigns omit this row entirely.

```sql
CREATE TABLE smm_creator_campaign (
  campaign_id        uuid PRIMARY KEY REFERENCES smm_campaign(id) ON DELETE CASCADE,
  cta_handle         text NOT NULL,           -- '@ekat_travels' / 'ekat.com' / 't.me/ekat'
  cta_label          text NOT NULL DEFAULT 'Подписывайся',
  voice_gender       text NOT NULL CHECK (voice_gender IN ('male', 'female')),
  genre              text NOT NULL DEFAULT 'dialog'
                     CHECK (genre IN ('dialog', 'monologue', 'fact_explanation')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
```

### New column: `smm_campaign.is_linkeon_official`

```sql
ALTER TABLE smm_campaign
  ADD COLUMN is_linkeon_official boolean NOT NULL DEFAULT false;
```

When the campaign is created by an admin AND no `smm_creator_campaign` settings are provided, `is_linkeon_official=true`. Otherwise `false`.

`assistant_role` column on `smm_scenario` keeps existing values. For creator-mode it defaults to `expert` and is otherwise unused at runtime (CTA reads from `smm_creator_campaign` instead).

## Backend changes

### Routing in `chat.service.ts`

The existing branch on `agent.name === 'smm_producer'` stays. Inside the SMM pipeline:

- Always pass `userId = req.user.phone` and `isAdmin = req.user.isAdmin` to `SmmProducerToolsService`.
- The tools service creates `smm_campaign` with `is_linkeon_official = isAdmin` (admin path) or `false` (everyone else).

### New SMM tool: `set_creator_campaign_settings`

Юля calls this once at the start of a creator-mode chat (or whenever the user changes the CTA / voice gender / genre). Args:

```ts
{
  cta_handle: string,           // required
  cta_label?: string,            // default 'Подписывайся'
  voice_gender: 'male' | 'female',
  genre?: 'dialog' | 'monologue' | 'fact_explanation',  // default 'dialog'
}
```

Inserts/updates the row in `smm_creator_campaign` keyed by the user's active draft campaign.

### `ScenarioService.generate` — branch on creator-mode

If the active campaign has `is_linkeon_official=false`:

- System prompt switches to the **creator-mode template**:
  ```
  Ты — креативный сценарист коротких видео для эксперта-блогера.
  Тема: {topic}.
  Жанр: {genre}.
  CTA: {cta_label} → {cta_handle}.

  Сценарий: герой-зритель задаёт вопрос → эксперт по теме отвечает →
  итог + CTA. Реплики на русском, живой разговорный язык. БЕЗ канцелярита.

  Верни JSON в том же формате (title, dialog, broll_prompts, mood).
  assistant_role укажи 'expert'.
  ```
- `assistant_role` фиксированно `'expert'`.

If `is_linkeon_official=true` — текущий промпт без изменений (14 Linkeon ролей).

### `voice.service` / TTS voice picker

New helper `pickRandomVoice(gender)` returns a Yandex SpeechKit voice ID:

- `male`: `['ermil', 'filipp', 'madirus']`
- `female`: `['alena', 'jane', 'omazh']`

Voice is picked **per scenario** (not per turn — same voice within a scenario). Stored in `smm_scenario.tts_voice_id` (new column or in render_state). For admin path (existing) — current per-role mapping stays.

### CTA component (`worker/remotion/CTA.tsx`)

New props:
```ts
{
  isLinkeonOfficial: boolean,
  ctaHandle?: string,
  ctaLabel?: string,
  assistantRole?: AssistantRole,  // only used if isLinkeonOfficial
}
```

- `isLinkeonOfficial=true` → текущий дизайн (forest gradient + Linkeon logo + «ИИ-<role>» + my.linkeon.io). Unchanged.
- `isLinkeonOfficial=false` → тот же forest gradient (брендирование платформы остаётся в фоне), но текст:
  - Headline: `ctaLabel` (например «Подписывайся»)
  - Subtitle: `ctaHandle` (например «@ekat_travels»)
  - Маленький подпись внизу: «создано на my.linkeon.io» (тонкая, не отвлекает) — это нативная реклама нашей платформы.

`pipeline.ts` пробрасывает все props.

### `chat.service.ts` admin filter remove

Currently the chat-history loader / SMM agent gating may rely on admin status. After this change, **any logged-in user** can chat with Юлия. Remove only the `category === 'smm'` filter in frontend — backend already routes by `agent.name === 'smm_producer'` regardless of admin.

## Frontend changes

### Юля visible to all

`ChatLayout.tsx:77` and `AssistantSelection.tsx:68` — remove `.filter(a => a.category !== 'smm')` for non-admins. Юля показывается всем юзерам в общем списке (но всё ещё с категорией `smm` для возможной будущей группировки).

### Wizard pattern

No separate wizard UI — Юля задаёт вопросы по очереди в чате через серию tool-calls. Системный промпт Юли расширяется: «Если у юзера нет активной кампании или не заданы creator-настройки — спроси про тему / CTA / голос / жанр и вызови `set_creator_campaign_settings`. Только потом — `generate_scenarios`.»

Для админа — старая логика (Юля сразу предлагает «давай сделаю ролик про <тему>»), creator-настройки не нужны.

### `ScenarioCard` / `SmmVideoPlayer` / `PublishModal`

Без изменений — текущая UX подходит обоим режимам. CTA-превью в карточке сценария может показывать `{ctaLabel} → {ctaHandle}` для creator-mode (или текущий «ИИ-<role>» для админа) — мелкий UX-штрих.

## Token charges

Существующие схемы списания не меняются:
- Чат с Юлей → Claude API через subprocess → ~600 токенов/реплика
- Сценарий через ClaudeCliService → ~2k токенов на генерацию
- Рендер → 15k токенов (через `smm_billing_ledger`)
- Регенерация → +15k
- Все привязки к ai-сообщению через `tokens_used` суффикс работают как сейчас

Стартовых 25k хватает на ~1 ролик. После — пополнение через YooKassa.

## Migration / backfill

1. ALTER TABLE для `smm_campaign.is_linkeon_official` + CREATE TABLE `smm_creator_campaign`.
2. Backfill `is_linkeon_official=true` для **всех** существующих кампаний — они все админские.
3. Никаких изменений в UI для существующих 10 готовых видео.

## Open questions / risks

- **CTA «создано на my.linkeon.io»** в creator-mode — допустимо ли пользователю? Может быть option «убрать упоминание Linkeon» за дополнительные токены / на платном плане. V2.
- **Бесплатные 25k токенов** — хватит на 1 рендер. Если юзер не понимает что это мало, может быстро упереться в стену. Возможно увеличить welcome bonus или дать первый рендер за 5k (флешсейл) — нужно отдельное решение по биллингу.
- **Качество creator-сценариев** — у нас нет шаблона «эксперт по туризму отвечает зрителю». Claude haiku может выдать вольный текст. Подсмотреть на первых клиентах и поправить промпт.
- **Спам / abuse** — публикация в чужой Telegram-канал требует bot-токена. Сейчас юзер сам подключает свой бот через `TelegramConnectForm` — `socialAccountApi.add` validate-ит токен. То есть юзер не может публиковать в чужой канал без права. Норм.
- **Контентный модератор** — потенциально юзер сделает ролик с нелегальным/опасным контентом. У нас нет content moderation на сценариях. V2.

## What stays unchanged

- `chat.service.ts` routing on `agent.name === 'smm_producer'`
- Approval / rejection / regeneration buttons in ScenarioCard and SmmVideoPlayer
- Render pipeline (TTS → Imagen/Pexels → Remotion → ffmpeg → MinIO)
- PublishModal flow with inline social connection
- Token billing schemes (charge / refund / ledger)
- Admin pipeline (14 Linkeon-роли, brand=Linkeon) — fully preserved via `is_linkeon_official` flag
