import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { DEFAULT_LANGUAGE, LanguageService } from '../common/services/language.service';
import { LiveKitClient } from './livekit.client';
import {
  AskResult, HOST_AGENT_ID, JOB_TIMEOUT_MS, MAX_PENDING_JOBS, SPECIALISTS,
  VOICE_ASK_NOTE, VOICE_BRIEF,
} from './voice-call.types';

/**
 * Мост между быстрым голосовым ведущим и медленными профильными ассистентами.
 *
 * Весь смысл в том, что ask() не ждёт ответа: OpenAI Realtime исполняет тул
 * синхронно и держит разговор, пока тот не вернётся. Поэтому ask() пишет job,
 * отдаёт jobId и уходит, а ответ доставляется отдельным data-сообщением.
 */
/** Столько символов не стыдно произнести вслух: примерно 20–25 секунд речи. */
const SPOKEN_ANSWER_LIMIT = 700;
/** Сжатие не должно тянуться дольше, чем сам ответ ждали. */
const CONDENSE_TIMEOUT_MS = 45_000;

@Injectable()
export class SpecialistJobService {
  private readonly logger = new Logger(SpecialistJobService.name);
  /** Незавершённые фоновые задачи — нужны только тестам, чтобы дождаться. */
  private readonly inflight = new Set<Promise<void>>();
  /**
   * Лимит параллельности по звонку держим в памяти, а не через
   * `SELECT count(*) ... WHERE status IN ('queued','running')`.
   *
   * Проверка-и-бронь обязана быть одним синхронным шагом. DB-вариант делает
   * между чтением счётчика и записью новой строки минимум один await —
   * окно, где два вызова ask(), пришедшие почти одновременно, оба увидят
   * старый счётчик и оба проскочат лимит. Синхронный Set.add() сразу после
   * проверки размера закрывает это окно: между чтением size и добавлением
   * jobId нет ни одного await.
   */
  private readonly pendingByCall = new Map<string, Set<string>>();

  constructor(
    private readonly pg: PgService,
    private readonly chat: ChatService,
    private readonly livekit: LiveKitClient,
    private readonly language: LanguageService,
  ) {}

  async ask(
    callId: string,
    roomName: string,
    userId: string,
    specialist: string,
    question: string,
  ): Promise<AskResult> {
    const agentId = SPECIALISTS[specialist];
    if (!agentId) return { status: 'rejected', reason: 'unknown_specialist' };

    let pending = this.pendingByCall.get(callId);
    if (!pending) {
      pending = new Set<string>();
      this.pendingByCall.set(callId, pending);
    }
    if (pending.size >= MAX_PENDING_JOBS) {
      return { status: 'rejected', reason: 'too_many_pending' };
    }

    const jobId = randomUUID();
    // Бронируем место синхронно, до первого await — иначе гонка выше вернётся.
    pending.add(jobId);

    try {
      await this.pg.query(
        `INSERT INTO voice_call_jobs (id, call_id, specialist_agent_id, question, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [jobId, callId, agentId, question],
      );
    } catch (e) {
      this.releasePending(callId, jobId);
      throw e;
    }

    // Фоновая часть. Промис намеренно не ждём.
    const task = this.run(jobId, callId, roomName, userId, specialist, agentId, question)
      .catch((e) => this.logger.error(`job ${jobId} crashed: ${e?.message}`))
      .finally(() => {
        this.inflight.delete(task);
        this.releasePending(callId, jobId);
      });
    this.inflight.add(task);

    return { status: 'asked', jobId, specialist };
  }

  /** Снять бронь слота job'а; пустой набор по звонку не держим в карте. */
  private releasePending(callId: string, jobId: string): void {
    const pending = this.pendingByCall.get(callId);
    if (!pending) return;
    pending.delete(jobId);
    if (pending.size === 0) this.pendingByCall.delete(callId);
  }

  private async run(
    jobId: string, callId: string, roomName: string, userId: string,
    specialist: string, agentId: number, question: string,
  ): Promise<void> {
    const started = Date.now();
    await this.pg.query(`UPDATE voice_call_jobs SET status = 'running' WHERE id = $1`, [jobId]);
    await this.safeSend(roomName, { v: 1, type: 'specialist_pending', jobId, specialist });

    try {
      // Изолированная эфемерная сессия обязательна: при коллизии с реальной
      // сессией пользователя релей отдаёт пустой поток — инцидент 2026-07-12,
      // см. quality-monitor.service.ts:probeOnce.
      const sessionId = `voice_${callId}_${jobId}`;
      // К вопросу приписываем требование краткости: ответ пойдёт в голос.
      // В voice_call_jobs и в чат специалиста кладём вопрос БЕЗ приписки —
      // там нужен тот вопрос, который задал Роман, а не наша служебка.
      const text = await this.withTimeout(
        this.chat.generateAgentReply(userId, String(agentId), `${VOICE_BRIEF}\n\n${question}`, sessionId),
        JOB_TIMEOUT_MS,
      );

      const answer = (text || '').trim();
      if (!answer) throw new Error('пустой ответ специалиста');

      // В БД кладём ответ целиком: он попадёт в транскрипт и карточку звонка,
      // где длина не мешает и текст можно перечитать.
      await this.pg.query(
        `UPDATE voice_call_jobs SET status = 'done', answer = $1, finished_at = now(), latency_ms = $2 WHERE id = $3`,
        [answer, Date.now() - started, jobId],
      );

      await this.recordInSpecialistChat(userId, agentId, question, answer);

      // А в голос уходит короткая выжимка.
      //
      // Раньше отправляли ответ целиком, и это ломало разговор: 26.08.2026
      // Роман получил два ответа на 9 274 и 11 210 символов — 20 тысяч разом
      // в контекст realtime-сессии, которая переотправляется модели на каждом
      // ходу. Через пару минут он замолчал совсем. Да и зачитывать вслух
      // многостраничный разбор бессмысленно: голосом нужен смысл, а не текст.
      const spoken = await this.condense(userId, specialist, answer);
      await this.safeSend(roomName, { v: 1, type: 'specialist_answer', jobId, specialist, text: spoken });
    } catch (e: any) {
      const reason = e?.message === 'timeout' ? 'timeout' : 'error';
      this.logger.warn(`job ${jobId} (${specialist}) failed: ${e?.message}`);
      await this.pg.query(
        `UPDATE voice_call_jobs SET status = 'failed', finished_at = now(), latency_ms = $1 WHERE id = $2`,
        [Date.now() - started, jobId],
      );
      await this.safeSend(roomName, { v: 1, type: 'specialist_failed', jobId, specialist, reason });
    }
  }

  /**
   * Записать консультацию в обычный чат со специалистом.
   *
   * До этого голосовые консультации не оставляли следа нигде, кроме
   * voice_call_jobs, которую не отдаёт ни один эндпоинт: пользователь слышал
   * ответ Алексея, а назавтра в чате с Алексеем не было ни вопроса, ни ответа —
   * и сам Алексей ничего не помнил, потому что контекст следующего хода
   * строится из custom_chat_history (chat.service.ts:431).
   *
   * Исполняем job в изолированной сессии (иначе релей отдаёт пустой поток при
   * коллизии), а записываем в обычную `<userId>_<agentId>` — где исполнять и
   * где хранить это разные вопросы, и разводить их правильно.
   *
   * Сбой записи job не роняет: ответ уже прозвучал, разговор идёт дальше.
   */
  private async recordInSpecialistChat(
    userId: string, agentId: number, question: string, answer: string,
  ): Promise<void> {
    try {
      const lang = await this.language.resolveUserLanguage(userId);
      const note = VOICE_ASK_NOTE[lang] || VOICE_ASK_NOTE[DEFAULT_LANGUAGE];
      const sessionId = `${userId}_${agentId}`;
      // Двумя отдельными запросами, а не одним INSERT на две строки: история
      // сортируется по created_at, а внутри одного оператора он у обеих строк
      // одинаковый (это время транзакции) — вопрос и ответ могли бы
      // перевернуться местами. Так же устроен и основной путь чата.
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
         VALUES ($1, 'human', $2, $3, 'text')`,
        [sessionId, agentId, `${note}\n\n${question}`],
      );
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
         VALUES ($1, 'ai', $2, $3, 'text', 0)`,
        [sessionId, agentId, answer],
      );
    } catch (e: any) {
      this.logger.warn(`консультация не записана в чат agent=${agentId}: ${e?.message}`);
    }
  }

  /**
   * Сжать ответ специалиста до пары фраз, которые не стыдно произнести вслух.
   *
   * Короткие ответы отдаём как есть — гонять LLM ради трёх строк незачем.
   * Если сжатие не удалось, лучше отдать обрезанный оригинал, чем промолчать:
   * пользователь ждёт ответа, а не тишины.
   */
  private async condense(userId: string, specialist: string, answer: string): Promise<string> {
    if (answer.length <= SPOKEN_ANSWER_LIMIT) return answer;

    const prompt =
      `Ниже ответ специалиста по имени ${specialist}. Перескажи его для произнесения ` +
      `ВСЛУХ: 2–3 коротких предложения, только суть и главный вывод, без списков, ` +
      `заголовков и markdown. До ${SPOKEN_ANSWER_LIMIT} символов.\n\n${answer}`;
    try {
      const short = await this.withTimeout(
        this.chat.generateAgentReply(userId, String(HOST_AGENT_ID), prompt, `voice_condense_${randomUUID()}`),
        CONDENSE_TIMEOUT_MS,
      );
      const trimmed = (short || '').trim();
      if (trimmed) return trimmed.slice(0, SPOKEN_ANSWER_LIMIT);
    } catch (e: any) {
      this.logger.warn(`не удалось сжать ответ ${specialist}: ${e?.message}`);
    }
    return answer.slice(0, SPOKEN_ANSWER_LIMIT) + '…';
  }

  /** Сбой доставки не должен ронять job: он уже записан в БД. */
  private async safeSend(roomName: string, msg: any): Promise<void> {
    try {
      await this.livekit.send(roomName, msg);
    } catch (e: any) {
      this.logger.warn(`sendData failed room=${roomName}: ${e?.message}`);
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      // Сторожевой таймер не должен сам по себе держать event loop живым:
      // в сервере петлю держит HTTP-сервер, а в тестах три висящих job'а
      // иначе заставляют jest ждать все 180 секунд и уходить в force exit.
      t.unref?.();
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Только для тестов: дождаться всех фоновых job. */
  async drainForTests(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}
