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
      const text = await this.withTimeout(
        this.chat.generateAgentReply(userId, String(HOST_AGENT_ID), prompt, `voice_doc_${callId}_${docId}`),
        DOC_TIMEOUT_MS,
      );
      const body = (text || '').trim();
      if (!body) throw new Error('пустой документ');

      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
         VALUES ($1, 'ai', $2, $3, 'text', 0)`,
        [`${userId}_${HOST_AGENT_ID}`, HOST_AGENT_ID, `## ${title}\n\n${body}`],
      );

      await this.safeSend(roomName, { v: 1, type: 'document_ready', docId, title });
      this.logger.log(`документ «${title}» готов, ${body.length} знаков`);
    } catch (e: any) {
      const reason = e?.message === 'timeout' ? 'timeout' : 'error';
      this.logger.warn(`документ «${title}» не собран: ${e?.message}`);
      await this.safeSend(roomName, { v: 1, type: 'document_failed', docId, title, reason });
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
