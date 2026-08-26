import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import { AskResult, HOST_AGENT_ID, JOB_TIMEOUT_MS, MAX_PENDING_JOBS, SPECIALISTS } from './voice-call.types';

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
      const text = await this.withTimeout(
        this.chat.generateAgentReply(userId, String(agentId), question, sessionId),
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
