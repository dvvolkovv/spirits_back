// src/guest-trial/guest-turn.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Response } from 'express';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { LanguageService } from '../common/services/language.service';
import { looksLikeCliRefusal } from '../common/llm-error';
import { CHAT_MODEL } from '../common/chat-model';
import { sendTelegramAlert } from '../common/telegram-alert';
import { firstInWindow, humanLeft, opensAtMsk } from '../auth/limit-alert';
import { AgentsService } from '../agents/agents.service';
import { ChatService } from '../chat/chat.service';
import { EventsService } from '../events/events.service';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionRow, GuestSessionsService } from './guest-sessions.service';
import { GuestQuotaReply, answerRules, takeGuestQuota, trialRules } from './guest-limits';
import { buildGuestPrompt, buildGuestSystemPrompt } from './guest-prompt';
import { hashGuestToken, isGuestTokenShape, newGuestToken } from './guest-token';
import { GUEST_PROMPT_HISTORY_MESSAGES, GUEST_REDIS_TIMEOUT_MS, GUEST_TURN_TIMEOUT_MS } from './guest-trial.types';
import { withTimeout } from '../common/with-timeout';

export interface GuestTurnInput {
  token: string | null;
  assistantId: string;
  message: string;
  lang: string;
  tz?: string;
  source: string | null;
  campaign: string | null;
  /** linkeon_session_id вкладки — склеить события сервера с событиями фронта. */
  sid: string | null;
  preview: boolean;
}

/** Те же виды меток, что принимает EventsService.setSignupSourceIfEmpty. */
const SOURCE_RE = /^(utm:|referral:|ref-site:|direct$|organic$)/;

export function parseGuestTurnInput(body: any): GuestTurnInput {
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const source = str(body?.source, 120);
  const sid = str(body?.sid, 64);
  return {
    token: str(body?.token, 64) || null,
    assistantId: str(body?.assistantId, 16).trim(),
    message: typeof body?.message === 'string' ? body.message : '',
    lang: LanguageService.normalize(str(body?.lang, 16)),
    tz: str(body?.tz, 64) || undefined,
    source: SOURCE_RE.test(source) ? source : null,
    campaign: str(body?.campaign, 120) || null,
    sid: /^[\w.-]+$/.test(sid) ? sid : null,
    preview: body?.preview === true,
  };
}

interface GuestAgent {
  id: number;
  name: string;
  description: string;
  persona: string;
}

const SCOPE_TEXT: Record<string, string> = {
  trials_hour: 'новых проб в час',
  trials_day: 'новых проб в сутки',
  answers_hour: 'гостевых ответов в час',
  answers_day: 'гостевых ответов в сутки',
};

/** О лежащем Redis — не чаще раза в 10 минут: отметку «уже сообщили» без него не поставить. */
const REDIS_ALERT_EVERY_MS = 10 * 60_000;
const PING_MS = 20_000;

@Injectable()
export class GuestTurnService {
  private readonly log = new Logger('GuestTurn');
  /** Ходов в полёте и проб с ходом в полёте — в памяти: процесс API один, как и счётчик ходов ChatService. */
  private inFlight = 0;
  private readonly busy = new Set<string>();
  private lastRedisAlertAt = 0;
  /** Публичное ради тестов: в них Redis «висит» 50 мс, а не 2 с. */
  redisTimeoutMs = GUEST_REDIS_TIMEOUT_MS;

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly claudeCli: ClaudeCliService,
    private readonly store: GuestTrialStore,
    private readonly sessions: GuestSessionsService,
    @Optional() private readonly chat?: ChatService,
    @Optional() private readonly events?: EventsService,
  ) {}

  async handle(input: GuestTurnInput, res: Response): Promise<void> {
    const { mode, limits } = await this.store.settings();
    if (mode === 'off' || (mode === 'preview' && !input.preview)) {
      this.closedStream(res, null);
      return;
    }

    const agent = await this.loadAgent(input.assistantId, input.lang);
    if (!agent) {
      res.status(400).json({ error: 'assistant' });
      return;
    }
    const message = input.message.trim();
    if (!message || message.length > limits.maxChars) {
      res.status(400).json({ error: 'message' });
      return;
    }

    let session: GuestSessionRow;
    let issued: string | null = null;
    // Хеш ключа — общий для обеих веток ниже: нужен ещё раз после busy.add (M2).
    let tokenHash = '';
    if (input.token) {
      tokenHash = isGuestTokenShape(input.token) ? hashGuestToken(input.token) : '';
      const found = tokenHash ? await this.sessions.findLive(tokenHash) : null;
      if (!found) {
        res.status(404).json({ error: 'trial' });
        return;
      }
      if (found.assistant_id !== agent.id) {
        res.status(409).json({ error: 'assistant_mismatch' });
        return;
      }
      session = found;
    } else {
      const q = await takeGuestQuota(this.redis, trialRules(limits), this.redisTimeoutMs);
      if (!q.counted) {
        this.closedStream(res, q);
        return;
      }
      issued = newGuestToken();
      tokenHash = hashGuestToken(issued);
      session = await this.sessions.create({
        tokenHash,
        assistantId: agent.id,
        lang: input.lang,
        source: input.source,
        campaign: input.campaign,
      });
    }

    let left = Math.max(0, limits.answersPerTrial - session.answers);
    let guestEvent = { type: 'guest', ...(issued ? { token: issued } : {}), left };
    if (session.claimed_at || left === 0) {
      this.startStream(res);
      this.write(res, { ...guestEvent, left: 0 });
      this.write(res, { type: 'wall', reason: 'limit' });
      this.end(res);
      return;
    }
    if (this.busy.has(session.id)) {
      res.status(409).json({ error: 'busy_trial' });
      return;
    }

    this.busy.add(session.id);
    try {
      // M2: между первым чтением пробы (выше) и этим локом могла случиться
      // гонка — перенос пробы в аккаунт с другой вкладки/устройства (его
      // делает guest-claim.service, этот busy-лок он не видит и не трогает).
      // Перечитываем свежую строку и пересчитываем left/claimed_at по ней,
      // прежде чем тратить окно ответов и звать модель.
      const fresh = await this.sessions.findLive(tokenHash);
      left = fresh ? Math.max(0, limits.answersPerTrial - fresh.answers) : 0;
      if (!fresh || fresh.claimed_at || left === 0) {
        this.startStream(res);
        this.write(res, { ...guestEvent, left: 0 });
        this.write(res, { type: 'wall', reason: 'limit' });
        this.end(res);
        return;
      }
      session = fresh;
      guestEvent = { type: 'guest', ...(issued ? { token: issued } : {}), left };

      // Claude сейчас недоступен (окно запасного пути открыто платными вызовами):
      // гостю — сразу ошибка, а не две минуты ожидания и занятый слот.
      if (this.claudeCli.fallbackStats().breakerOpenUntil > Date.now()) {
        this.startStream(res);
        this.write(res, guestEvent);
        this.write(res, { type: 'error', code: 'model' });
        this.end(res);
        this.events?.track('guest_trial_error', { props: { reason: 'breaker', assistant_id: String(agent.id) } });
        return;
      }

      // M1: занятый слот не должен тратить окно ответов — проверяем ДО
      // takeGuestQuota(answerRules), а не после. Проверка и инкремент —
      // синхронно, без await между ними: иначе два параллельных хода могли
      // бы оба увидеть свободный слот и проскочить потолок вдвоём.
      if (this.inFlight >= limits.concurrentTurns) {
        this.startStream(res);
        this.write(res, guestEvent);
        this.write(res, { type: 'error', code: 'busy' });
        this.end(res);
        this.events?.track('guest_trial_error', { props: { reason: 'busy', assistant_id: String(agent.id) } });
        return;
      }
      this.inFlight++;
      try {
        const q = await takeGuestQuota(this.redis, answerRules(limits), this.redisTimeoutMs);
        if (!q.counted) {
          this.closedStream(res, q, issued);
          return;
        }
        // beginStream — только после успешного окна ответов: endStream ниже
        // лежит в том же вложенном finally и поэтому вызывается ровно тогда,
        // когда был вызван beginStream, — счётчики парные без отдельного флага.
        this.chat?.beginStream();
        try {
          await this.runTurn(input, res, session, agent, message, guestEvent, limits.answersPerTrial);
        } finally {
          this.chat?.endStream();
        }
      } finally {
        this.inFlight--;
      }
    } finally {
      this.busy.delete(session.id);
    }
  }

  private async runTurn(
    input: GuestTurnInput,
    res: Response,
    session: GuestSessionRow,
    agent: GuestAgent,
    message: string,
    guestEvent: object,
    answersPerTrial: number,
  ): Promise<void> {
    const humanAt = new Date();
    this.startStream(res);
    this.write(res, guestEvent);
    this.write(res, { type: 'begin' });
    const ping = setInterval(() => this.write(res, { type: 'ping' }), PING_MS);
    try {
      try {
        const history = (session.answers > 0 ? await this.sessions.messages(session.id) : []).slice(-GUEST_PROMPT_HISTORY_MESSAGES);
        const system = buildGuestSystemPrompt({
          name: agent.name,
          description: agent.description,
          persona: agent.persona,
          lang: input.lang,
          tz: input.tz,
        });
        let text = '';
        let costUsd = 0;
        let hadChunks = false;
        try {
          const r = await this.claudeCli.textWithCost(buildGuestPrompt(history, message), {
            system,
            model: CHAT_MODEL,
            // Запасной Qwen гостям не положен: его квота — для платящих.
            noFallback: true,
            timeoutMs: GUEST_TURN_TIMEOUT_MS,
            onTextDelta: (t) => { hadChunks = true; this.write(res, { type: 'item', content: t }); },
          });
          text = (r.text || '').trim();
          costUsd = r.costUsd || 0;
        } catch (e: any) {
          this.log.warn(`guest turn failed (assistant ${agent.id}): ${String(e?.message ?? e).slice(0, 200)}`);
        }
        // Отказ CLI («лимит», «не вошёл») приходит обычным текстом — это не
        // ответ ассистента. Но если куски уже шли (onTextDelta) — слова
        // модели человек уже увидел, и финальный текст — её настоящий ответ,
        // даже если он похож на фразу отказа по форме (бывает у персон с
        // ролевым текстом). Проверку отказа применяем только когда кусков не было.
        if (!text || (!hadChunks && looksLikeCliRefusal(text))) {
          this.write(res, { type: 'error', code: 'model' });
          this.events?.track('guest_trial_error', { props: { reason: 'model', assistant_id: String(agent.id) } });
          return;
        }
        const answers = await this.sessions.recordExchange(session.id, message, text, humanAt, costUsd);
        if (answers === null) {
          // Перенесена в аккаунт посреди этого самого хода (другая
          // вкладка/устройство успела войти) — пара не записана в базе
          // (guest-sessions.service: recordExchange), answers не растёт.
          this.log.warn(`guest turn: проба перенесена во время хода (${session.id})`);
          this.write(res, { type: 'error', code: 'model' });
          this.events?.track('guest_trial_error', { props: { reason: 'claimed', assistant_id: String(agent.id) } });
          return;
        }
        this.write(res, { type: 'end', content: text });
        this.events?.track('guest_trial_answer', {
          sessionId: input.sid,
          source: input.source,
          props: { n: answers, trial: session.id, assistant_id: String(agent.id), lang: input.lang, cost_usd: Number(costUsd.toFixed(4)), preview: input.preview },
        });
        if (answers >= answersPerTrial) this.write(res, { type: 'wall', reason: 'limit' });
      } catch (e: any) {
        // Сбой уже ПОСЛЕ begin (messages()/recordExchange() и т.п. — поток уже
        // открыт, человек его ждёт): ответ гостю — такая же ошибка в потоке,
        // а не необработанное исключение наружу из handle() (поток к этому
        // моменту уже начат — молчаливо оборванное соединение хуже явного error).
        this.log.warn(`guest turn: сбой после начала ответа (проба ${session.id}): ${String(e?.message ?? e).slice(0, 200)}`);
        this.write(res, { type: 'error', code: 'model' });
        this.events?.track('guest_trial_error', { props: { reason: 'model', assistant_id: String(agent.id) } });
      }
    } finally {
      clearInterval(ping);
      this.end(res);
    }
  }

  /** Ассистент для пробы: тот же набор, что видит экран выбора (AgentsService.getAgents). */
  private async loadAgent(id: string, lang: string): Promise<GuestAgent | null> {
    if (!/^\d{1,6}$/.test(id)) return null;
    const r = await this.pg.query(
      `SELECT a.id,
              COALESCE(NULLIF(t.display_name, ''), NULLIF(a.display_name, ''), a.name) AS name,
              COALESCE(NULLIF(t.description, ''), a.description, '')                  AS description,
              COALESCE(a.system_prompt, '')                                            AS persona
         FROM agents a
         LEFT JOIN agent_translations t
                ON t.entity_type = 'agent' AND t.entity_id = a.id::text AND t.locale = $2
        WHERE a.id = $1 AND a.is_active AND a.name <> ALL($3::text[])`,
      [Number(id), lang, AgentsService.SERVICE_AGENTS],
    );
    const row = r.rows[0];
    return row ? { id: Number(row.id), name: row.name, description: row.description, persona: row.persona } : null;
  }

  private startStream(res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  /** Строка потока. Клиент ушёл — ход доводим: ответ ляжет в пробу и вернётся после перезагрузки. */
  private write(res: Response, ev: object): void {
    if (res.writableEnded || (res as any).destroyed) return;
    try { res.write(JSON.stringify(ev) + '\n'); } catch { /* клиент ушёл */ }
  }

  private end(res: Response): void {
    if (res.writableEnded) return;
    try { res.end(); } catch { /* клиент ушёл */ }
  }

  private closedStream(res: Response, q: GuestQuotaReply | null, token: string | null = null): void {
    if (q) {
      // Отчёт о закрытии — fire-and-forget: он не должен задерживать ответ
      // гостю. Но не void — непойманный отказ внутри (сеть, Redis, Telegram)
      // ушёл бы необработанным rejection'ом мимо собственных catch() метода.
      this.reportClosed(q).catch((e: any) => this.log.warn(`reportClosed failed: ${String(e?.message ?? e).slice(0, 200)}`));
    }
    this.startStream(res);
    this.write(res, { type: 'guest', ...(token ? { token } : {}), left: 0 });
    this.write(res, { type: 'wall', reason: 'closed' });
    this.end(res);
  }

  /** Событие на каждое закрытие; владельцу — раз за окно (как у лимитов SMS). */
  private async reportClosed(q: GuestQuotaReply): Promise<void> {
    if (q.redisDown) {
      this.events?.track('guest_trial_closed', { props: { scope: 'redis' } });
      if (Date.now() - this.lastRedisAlertAt < REDIS_ALERT_EVERY_MS) return;
      this.lastRedisAlertAt = Date.now();
      this.log.error('guest trial closed: Redis не ответил');
      await sendTelegramAlert(
        `<b>Linkeon: проба без входа закрыта</b>\n` +
          `Redis не ответил за ${Math.round(this.redisTimeoutMs / 1000)} с. Пока он не оживёт, новым посетителям сразу показывается вход.`,
      ).catch(() => undefined);
      return;
    }
    for (const hit of q.full) {
      this.events?.track('guest_trial_closed', { props: { scope: hit.scope } });
      let first = false;
      try {
        first = await withTimeout(firstInWindow(this.redis, `guest-lim:alerted:${hit.scope}`, hit.leftMs), this.redisTimeoutMs);
      } catch {
        continue;
      }
      if (!first) continue;
      this.log.error(`guest trial closed: ${hit.scope} (${hit.max})`);
      await sendTelegramAlert(
        `<b>Linkeon: проба без входа закрыта</b>\n` +
          `Потолок: <b>${hit.max} ${SCOPE_TEXT[hit.scope] ?? hit.scope}</b>\n` +
          `Откроется через ${humanLeft(hit.leftMs)}, в ${opensAtMsk(hit.leftMs)}.\n` +
          `Пока закрыто, новым посетителям сразу показывается вход. Поднять потолок — POST /webhook/admin/guest-trial {"action":"set"}.`,
      ).catch(() => undefined);
    }
  }
}
