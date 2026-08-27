import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import {
  CONSULT_CHARS_IN_DOC, DOC_GIST_CHARS, DOC_TIMEOUT_MS, DocumentResult,
  findSpecialist, HOST_AGENT_ID, MAX_CONSULT_IN_DOC,
} from './voice-call.types';

/**
 * Документы, надиктованные голосом.
 *
 * Владелец на звонке сказал «давай сделаем документ», и Роману оказалось
 * некуда его положить: тула для этого не было. В первой редакции спеки он был
 * (save_note), и я его снял, решив, что он дублирует резюме звонка. Решение
 * неверное: резюме — про что говорили, документ — результат работы.
 *
 * Устроено как мост к специалистам и по той же причине: Realtime исполняет тул
 * синхронно, а сочинение документа занимает десятки секунд. Роман диктует
 * задание и продолжает разговор, готовый текст приходит в чат сам.
 */
@Injectable()
export class VoiceDocumentService {
  private readonly logger = new Logger(VoiceDocumentService.name);
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly pg: PgService,
    private readonly chat: ChatService,
    private readonly livekit: LiveKitClient,
  ) {}

  create(
    callId: string,
    roomName: string,
    userId: string,
    title: string,
    instructions: string,
    specialist?: string,
  ): DocumentResult {
    const clean = (title || '').trim();
    if (!clean) return { status: 'rejected', reason: 'no_title' };

    // Кто оформляет документ — тот его и пишет, и в его чат документ ложится.
    //
    // Раньше документ всегда писался от лица Романа и всегда падал в его чат,
    // что бы он ни пообещал вслух. Владелец попросил Виталия подготовить
    // бумагу, Роман согласился — а документ уехал к Роману, и в чате Виталия
    // было пусто. Живой звонок 26.08.2026: «нужно документ класть в чат к
    // Виталию, если Виталий его готовил».
    //
    // Имени нет или оно не опознано — пишет ведущий, как и прежде.
    const agentId = (specialist && findSpecialist(specialist)) || HOST_AGENT_ID;
    const author = agentId === HOST_AGENT_ID ? undefined : specialist;

    const docId = randomUUID();

    const task = this.run(docId, callId, roomName, userId, clean, instructions, agentId, author)
      .catch((e) => this.logger.error(`документ ${docId} упал: ${e?.message}`))
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);

    return { status: 'accepted', docId, title: clean, specialist: author };
  }

  /**
   * Полные ответы специалистов, прозвучавшие в этом звонке.
   *
   * Обрезаем каждый: специалист мог проигнорировать просьбу о краткости и
   * написать трактат, а промпт документа не резиновый.
   */
  private async specialistContext(callId: string): Promise<string> {
    try {
      const res = await this.pg.query(
        `SELECT specialist_agent_id, question, answer FROM voice_call_jobs
         WHERE call_id = $1 AND status = 'done' AND answer IS NOT NULL
         ORDER BY created_at LIMIT $2`,
        [callId, MAX_CONSULT_IN_DOC],
      );
      return res.rows
        .map((r: any) => `Вопрос: ${r.question}\nОтвет: ${String(r.answer).slice(0, CONSULT_CHARS_IN_DOC)}`)
        .join('\n\n');
    } catch (e: any) {
      // Документ без разбора хуже, чем с разбором, но лучше, чем никакого.
      this.logger.warn(`не удалось собрать консультации звонка ${callId}: ${e?.message}`);
      return '';
    }
  }

  private async run(
    docId: string, callId: string, roomName: string,
    userId: string, title: string, instructions: string,
    agentId: number, author?: string,
  ): Promise<void> {
    await this.safeSend(roomName, { v: 1, type: 'document_pending', docId, title, specialist: author });

    try {
      // Консультации специалистов из этого же звонка — ЦЕЛИКОМ.
      //
      // Без них документ писался по тому, что знает Роман, а знает он только
      // сжатую выжимку ответа (700–1200 знаков). Полный разбор Виталия лежал
      // в базе и в его чате, но в документ не попадал: получалась бумага по
      // пересказу консультации вместо самой консультации. Замечено владельцем
      // на живом звонке 26.08.2026.
      const consult = await this.specialistContext(callId);

      const prompt =
        `Составь готовый документ по заданию, полученному в голосовом разговоре.\n\n` +
        `Заголовок: ${title}\n` +
        `Задание: ${instructions || 'без дополнительных указаний'}\n\n` +
        (consult ? `Разбор специалистов, прозвучавший в этом разговоре — опирайся на него:\n${consult}\n\n` : '') +
        `Выдай ТОЛЬКО текст документа в markdown, без вступлений вроде «вот ваш документ» ` +
        `и без вопросов в конце. Заголовок первой строкой не дублируй — он будет добавлен ` +
        `сверху. Пиши так, чтобы текст можно было отправить адресату как есть.`;

      // Изолированная сессия — как у вопросов специалистам: при коллизии с
      // живой сессией пользователя релей отдаёт пустой поток (инцидент 2026-07-12).
      const reply = await this.withTimeout(
        this.chat.generateAgentReplyWithCharge(userId, String(agentId), prompt, `voice_doc_${callId}_${docId}`),
        DOC_TIMEOUT_MS,
      );
      const body = (reply.text || '').trim();
      if (!body) throw new Error('пустой документ');

      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
         VALUES ($1, 'ai', $2, $3, 'text', $4)`,
        [`${userId}_${agentId}`, agentId, `## ${title}\n\n${body}`, reply.tokens],
      );

      await this.charge(userId, agentId, title, reply.tokens);
      // Текст уходит и Роману: без него он не знает, что в документе, и не
      // может ни сообщить о готовности, ни обсудить содержимое.
      await this.safeSend(roomName, {
        v: 1, type: 'document_ready', docId, title, tokens: reply.tokens,
        specialist: author, text: body.slice(0, DOC_GIST_CHARS),
      });
      this.logger.log(
        `документ «${title}» готов, ${body.length} знаков, ${reply.tokens} токенов, ` +
        `в чат ${author || 'Романа'} (agent=${agentId})`,
      );
    } catch (e: any) {
      const reason = e?.message === 'timeout' ? 'timeout' : 'error';
      this.logger.warn(`документ «${title}» не собран: ${e?.message}`);
      await this.safeSend(roomName, { v: 1, type: 'document_failed', docId, title, reason, specialist: author });
    }
  }

  /**
   * Списать токены за документ. Устроено так же, как у консультаций:
   * строка в 'pending' с расходом в output_tokens, дальше её подбирает
   * TokenAccountingService.
   */
  private async charge(userId: string, agentId: number, title: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    try {
      await this.pg.query(
        `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume, metadata)
         VALUES ($1, $2, 'pending', $3, 0, $4, 0, $5)`,
        [
          Math.floor(Math.random() * 2_000_000_000), userId, agentId, tokens,
          JSON.stringify({ kind: 'voice_document', title, tokens }),
        ],
      );
    } catch (e: any) {
      this.logger.warn(`не удалось записать списание за документ «${title}»: ${e?.message}`);
    }
  }

  /** Сбой доставки не должен ронять задачу: документ уже в чате. */
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
      // unref — иначе висящая задача держит event loop и jest уходит в force exit.
      t.unref?.();
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Только для тестов: дождаться всех фоновых задач. */
  async drainForTests(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}
