import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import { DOC_TIMEOUT_MS, DocumentResult, HOST_AGENT_ID } from './voice-call.types';

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
  ): DocumentResult {
    const clean = (title || '').trim();
    if (!clean) return { status: 'rejected', reason: 'no_title' };

    const docId = randomUUID();

    const task = this.run(docId, callId, roomName, userId, clean, instructions)
      .catch((e) => this.logger.error(`документ ${docId} упал: ${e?.message}`))
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);

    return { status: 'accepted', docId, title: clean };
  }

  private async run(
    docId: string, callId: string, roomName: string,
    userId: string, title: string, instructions: string,
  ): Promise<void> {
    await this.safeSend(roomName, { v: 1, type: 'document_pending', docId, title });

    try {
      const prompt =
        `Составь готовый документ по заданию, полученному в голосовом разговоре.\n\n` +
        `Заголовок: ${title}\n` +
        `Задание: ${instructions || 'без дополнительных указаний'}\n\n` +
        `Выдай ТОЛЬКО текст документа в markdown, без вступлений вроде «вот ваш документ» ` +
        `и без вопросов в конце. Заголовок первой строкой не дублируй — он будет добавлен ` +
        `сверху. Пиши так, чтобы текст можно было отправить адресату как есть.`;

      // Изолированная сессия — как у вопросов специалистам: при коллизии с
      // живой сессией пользователя релей отдаёт пустой поток (инцидент 2026-07-12).
      const reply = await this.withTimeout(
        this.chat.generateAgentReplyWithCharge(userId, String(HOST_AGENT_ID), prompt, `voice_doc_${callId}_${docId}`),
        DOC_TIMEOUT_MS,
      );
      const body = (reply.text || '').trim();
      if (!body) throw new Error('пустой документ');

      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
         VALUES ($1, 'ai', $2, $3, 'text', $4)`,
        [`${userId}_${HOST_AGENT_ID}`, HOST_AGENT_ID, `## ${title}\n\n${body}`, reply.tokens],
      );

      await this.charge(userId, title, reply.tokens);
      await this.safeSend(roomName, { v: 1, type: 'document_ready', docId, title, tokens: reply.tokens });
      this.logger.log(`документ «${title}» готов, ${body.length} знаков, ${reply.tokens} токенов`);
    } catch (e: any) {
      const reason = e?.message === 'timeout' ? 'timeout' : 'error';
      this.logger.warn(`документ «${title}» не собран: ${e?.message}`);
      await this.safeSend(roomName, { v: 1, type: 'document_failed', docId, title, reason });
    }
  }

  /**
   * Списать токены за документ. Устроено так же, как у консультаций:
   * строка в 'pending' с расходом в output_tokens, дальше её подбирает
   * TokenAccountingService.
   */
  private async charge(userId: string, title: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    try {
      await this.pg.query(
        `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume, metadata)
         VALUES ($1, $2, 'pending', $3, 0, $4, 0, $5)`,
        [
          Math.floor(Math.random() * 2_000_000_000), userId, HOST_AGENT_ID, tokens,
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
