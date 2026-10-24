import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { PgService } from '../common/services/pg.service';
import { classifyLlmError } from '../monitoring/claude-health.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { InsightsCollectService } from './insights-collect.service';
import { buildDigest, buildKeyboard, insightsChatId, type DigestInput } from './insights-digest';
import { buildLabelPrompt, LABEL_BATCH, LABEL_MODEL, LABEL_SYSTEM, parseLabels, type LabelInput } from './insights-label';
import { InsightsStore, type RunRow } from './insights-store.service';
import { buildSynthPrompt, parseFindings, SYNTH_SYSTEM, synthModel } from './insights-synth';
import { weekLabel, weekOf, type Week } from './insights-week';
import type { Label, SynthFinding } from './insights.types';

/** Один прогон за раз на все процессы API. */
export const INSIGHTS_LOCK_KEY = 7_361_001;
export const MAX_POSTPONES = 3;

/** Недельный лимит или rate limit подписки: прогон откладывается, а не падает. */
export class PostponeError extends Error {}

function isLimit(msg: string): boolean {
  const kind = classifyLlmError(msg).kind;
  return kind === 'weekly_limit' || kind === 'rate_limit';
}

@Injectable()
export class InsightsService {
  private readonly log = new Logger('Insights');

  constructor(
    private readonly store: InsightsStore,
    private readonly collector: InsightsCollectService,
    private readonly claude: ClaudeCliService,
    private readonly pg: PgService,
    @Inject(forwardRef(() => TgGrammyClient)) private readonly tg: TgGrammyClient,
  ) {}

  /** Плановый прогон — один раз на неделю. */
  async runScheduled(week: Week): Promise<void> {
    if (await this.store.doneRunExists(week.weekStart)) return;
    const id = await this.store.createRun(week.weekStart, false);
    await this.execute(id, week);
  }

  /** Ручной прогон из админки: в фоне, сразу возвращает id. Сводка — только владельцу. */
  async startManual(week: Week): Promise<string> {
    const id = await this.store.createRun(week.weekStart, true);
    void this.execute(id, week).catch((e) => this.log.error(`ручной прогон ${id}: ${e?.message}`));
    return id;
  }

  async retry(run: RunRow): Promise<void> {
    await this.store.markRunning(run.id);
    await this.execute(run.id, weekOf(run.week_start));
  }

  async execute(runId: string, week: Week): Promise<void> {
    const lock = await this.pg.tryAdvisoryLock(INSIGHTS_LOCK_KEY);
    if (!lock) {
      await this.store.failRun(runId, 'другой прогон уже идёт');
      return;
    }
    try {
      // Повтор той же недели заменяет её итоги — до чтения прошлых находок.
      if (await this.store.weekHasResults(week.weekStart)) await this.store.resetWeek(week.weekStart);
      const collected = await this.collector.collect(week);
      // «Человек N» — только внутри прогона: номер нигде не сохраняется.
      const personOf = new Map<string, number>();
      const inputs: LabelInput[] = collected.conversations.map((conversation) => {
        if (!personOf.has(conversation.userId)) personOf.set(conversation.userId, personOf.size + 1);
        return { person: personOf.get(conversation.userId)!, conversation };
      });
      let cost = 0;
      const labels: Label[] = [];
      for (let i = 0; i < inputs.length; i += LABEL_BATCH) {
        const batch = inputs.slice(i, i + LABEL_BATCH);
        const prompt = buildLabelPrompt(batch, (u) => collected.names.get(u) ?? []);
        const r = await this.callModel(prompt, LABEL_SYSTEM, LABEL_MODEL, 120_000, (t) => parseLabels(t, batch));
        cost += r.cost;
        if (r.value) labels.push(...r.value);
        else this.log.warn(`пачка разговоров ${i / LABEL_BATCH + 1} пропущена: разметка не разобралась дважды`);
      }
      const prior = await this.store.priorFindings(week.weekStart);
      let findings: SynthFinding[] = [];
      if (labels.length) {
        const prompt = buildSynthPrompt({ weekLabel: weekLabel(week.weekStart), labels, signals: collected.signals, prior });
        const r = await this.callModel(prompt, SYNTH_SYSTEM, synthModel(), 300_000, (t) => parseFindings(t, labels, prior));
        cost += r.cost;
        if (!r.value) throw new Error('сводка не разобралась дважды');
        findings = r.value;
      }
      const saved = await this.store.saveFindings(week.weekStart, findings, prior);
      const totals = {
        conversations: inputs.length,
        people: personOf.size,
        crisis: collected.signals.crisisConversations,
        signals: collected.signals,
      };
      await this.store.finishRun(runId, { ...totals, costUsd: cost });
      await this.sendDigest(runId, { weekStart: week.weekStart, ...totals, findings: saved });
    } catch (e: any) {
      await this.handleFailure(runId, week, e);
    } finally {
      await lock.release();
    }
  }

  /** Вызов модели с одним повтором. null — ответ дважды не по форме или вызов дважды упал. */
  private async callModel<T>(
    prompt: string,
    system: string,
    model: string,
    timeoutMs: number,
    parse: (text: string) => T | null,
  ): Promise<{ value: T | null; cost: number }> {
    let cost = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.claude.textWithCost(prompt, { system, model, timeoutMs });
        cost += r.costUsd || 0;
        const value = parse(r.text);
        if (value !== null) return { value, cost };
        // Отказ CLI иногда приходит под видом ответа — короткой строкой.
        if (r.text.length <= 300 && isLimit(r.text)) throw new PostponeError(r.text);
        this.log.warn(`ответ модели не по форме (попытка ${attempt})`);
      } catch (e: any) {
        if (e instanceof PostponeError) throw e;
        if (isLimit(String(e?.message))) throw new PostponeError(String(e?.message));
        this.log.warn(`модель не ответила (попытка ${attempt}): ${e?.message}`);
      }
    }
    return { value: null, cost };
  }

  private async handleFailure(runId: string, week: Week, e: any): Promise<void> {
    const reason = String(e?.message || e).slice(0, 200);
    if (e instanceof PostponeError) {
      const attempts = await this.store.postponeRun(runId, reason);
      if (attempts < MAX_POSTPONES) return;
      await this.store.failRun(runId, `лимит подписки ${MAX_POSTPONES} раза подряд: ${reason}`);
    } else {
      this.log.error(`прогон ${runId} не удался: ${reason}`);
      await this.store.failRun(runId, reason);
    }
    await this.notify(`Затыки недели · ${weekLabel(week.weekStart)}: сводка не собралась — ${reason}`);
  }

  private async sendDigest(runId: string, input: DigestInput): Promise<void> {
    const chatId = insightsChatId();
    if (!chatId) {
      this.log.warn('чат сводки не задан (INSIGHTS_TG_CHAT_ID / BLOG_APPROVER_TG_ID) — сводка не отправлена');
      return;
    }
    const { text, shown } = buildDigest(input);
    const msg: any = await this.tg.sendMessage(chatId, text, shown.length ? { reply_markup: buildKeyboard(shown) } : {});
    await this.store.setDigest(runId, chatId, msg?.message_id ?? null, shown.map((f) => f.id));
  }

  private async notify(text: string): Promise<void> {
    const chatId = insightsChatId();
    if (!chatId) return;
    try {
      await this.tg.sendMessage(chatId, text);
    } catch (e: any) {
      this.log.error(`не смог сообщить о сбое прогона: ${e?.message}`);
    }
  }
}
