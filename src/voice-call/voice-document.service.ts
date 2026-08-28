import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { ChatService } from '../chat/chat.service';
import { DEFAULT_LANGUAGE, LanguageService } from '../common/services/language.service';
import { LiveKitClient } from './livekit.client';
import {
  AUTHOR_GUESS_WINDOW_MIN, CONSULT_CHARS_IN_DOC, DOC_GIST_CHARS, DOC_LEAD_CHARS, DOC_TIMEOUT_MS,
  DOCS_BUCKET, DOC_TARGET_CHARS, DocumentResult, findSpecialist, HOST_AGENT_ID, MAX_CONSULT_IN_DOC,
  specialistName, VOICE_ASK_NOTE,
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
    private readonly storage: StorageService,
    private readonly language: LanguageService,
  ) {}

  /**
   * Задание на документ в чат того, кто его пишет.
   *
   * Пишется от лица пользователя: заказ исходит от него, Роман лишь передал
   * поручение голосом. Пометка про голос — та же, что у вопросов
   * специалистам, и на языке пользователя.
   */
  private async recordRequest(
    userId: string, agentId: number, title: string, instructions: string,
  ): Promise<void> {
    try {
      const lang = await this.language.resolveUserLanguage(userId);
      const note = VOICE_ASK_NOTE[lang] || VOICE_ASK_NOTE[DEFAULT_LANGUAGE];
      const body = instructions?.trim()
        ? `${note}\n\nПодготовить документ «${title}».\n\n${instructions.trim()}`
        : `${note}\n\nПодготовить документ «${title}».`;
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
         VALUES ($1, 'human', $2, $3, 'text')`,
        [`${userId}_${agentId}`, agentId, body],
      );
    } catch (e: any) {
      this.logger.warn(`задание на документ не записано в чат agent=${agentId}: ${e?.message}`);
    }
  }

  /**
   * Отметка о неудаче в чате автора.
   *
   * Без неё задание висело бы в чате без ответа, и было бы не отличить «не
   * получилось» от «ещё пишется». 27.08.2026 документ Шанкары упал по
   * таймауту, и владелец решил, что запрос вообще не дошёл.
   */
  private async recordFailure(
    userId: string, agentId: number, title: string, reason: string,
  ): Promise<void> {
    const text = reason === 'timeout'
      ? `Документ «${title}» подготовить не успел — задача оказалась слишком объёмной. Попроси ещё раз, можно короче.`
      : `Документ «${title}» подготовить не удалось.`;
    try {
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
         VALUES ($1, 'ai', $2, $3, 'text', 0)`,
        [`${userId}_${agentId}`, agentId, text],
      );
    } catch { /* и это не повод ронять задачу */ }
  }

  /**
   * Положить документ файлом и вернуть ссылку.
   *
   * text/plain, а не text/markdown: браузер показывает plain прямо в окне, а
   * markdown предлагает скачать. Документ, ради которого надо лезть в папку
   * «Загрузки», — это не «доступен по ссылке».
   *
   * Отдаётся как есть, без конвертации в HTML: готовой библиотеки в бэкенде
   * нет, а самодельный markdown-конвертер — известная яма (таблицы, вложенные
   * списки, экранирование).
   */
  private async publish(userId: string, docId: string, title: string, body: string): Promise<string | null> {
    try {
      return await this.storage.upload({
        bucket: DOCS_BUCKET,
        key: `documents/${userId}/${docId}.md`,
        body: Buffer.from(`# ${title}\n\n${body}`, 'utf8'),
        contentType: 'text/plain; charset=utf-8',
        cacheControl: 'public, max-age=31536000',
      });
    } catch (e: any) {
      // Без ссылки документ всё равно попадёт в чат текстом — это хуже, но
      // не потеря.
      this.logger.warn(`документ «${title}» не удалось выложить файлом: ${e?.message}`);
      return null;
    }
  }

  /**
   * Первые несколько абзацев — чтобы в ленте было видно, о чём документ, но
   * не лежала стена текста. Режем по границе абзаца, а не по символу.
   */
  private static lead(body: string): string {
    if (body.length <= DOC_LEAD_CHARS) return body;
    const cut = body.slice(0, DOC_LEAD_CHARS);
    const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
    return (lastBreak > DOC_LEAD_CHARS / 3 ? cut.slice(0, lastBreak + 1) : cut).trim() + '…';
  }

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

    const docId = randomUUID();

    const task = this.run(docId, callId, roomName, userId, clean, instructions, specialist)
      .catch((e) => this.logger.error(`документ ${docId} упал: ${e?.message}`))
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);

    return { status: 'accepted', docId, title: clean, specialist };
  }

  /**
   * Кто автор документа: явно названный специалист, а если не назвали —
   * тот, чья консультация в этом звонке была последней.
   *
   * Догадка нужна потому, что Роман параметр игнорирует. В промпте прямо
   * написано передавать имя коллеги, и он всё равно этого не делает: 27.08.2026
   * спросил Шанкару, назвал документ «по рекомендациям Шанкары» — и оформил
   * от себя, документ уехал в чат Романа.
   *
   * На послушание модели тут полагаться нельзя, а случай «спросили коллегу и
   * сделали документ по его ответу» — основной. Итог звонка Роман и так
   * оформляет карточкой, для этого create_document не нужен.
   *
   * Но догадка годится ТОЛЬКО по свежему следу — см. AUTHOR_GUESS_WINDOW_MIN.
   * Звонок короткий и об одном, а встреча идёт до двух часов и о разном:
   * «последняя консультация» там запросто относится к другой теме, и документ
   * уезжает человеку, который его не заказывал и не ждёт.
   */
  private async resolveAuthor(callId: string, specialist?: string): Promise<{ agentId: number; author?: string }> {
    const named = specialist && findSpecialist(specialist);
    if (named) return { agentId: named, author: specialist };

    try {
      const res = await this.pg.query(
        `SELECT specialist_agent_id FROM voice_call_jobs
         WHERE call_id = $1 AND status = 'done'
           AND finished_at IS NOT NULL
           AND finished_at > now() - make_interval(mins => $2)
         ORDER BY finished_at DESC LIMIT 1`,
        [callId, AUTHOR_GUESS_WINDOW_MIN],
      );
      const agentId = res.rows[0]?.specialist_agent_id;
      const author = agentId ? specialistName(Number(agentId)) : undefined;
      if (agentId && author) return { agentId: Number(agentId), author };
    } catch (e: any) {
      this.logger.warn(`не удалось определить автора документа для ${callId}: ${e?.message}`);
    }
    return { agentId: HOST_AGENT_ID };
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
    specialist?: string,
  ): Promise<void> {
    const { agentId, author } = await this.resolveAuthor(callId, specialist);
    await this.safeSend(roomName, { v: 1, type: 'document_pending', docId, title, specialist: author });

    // Задание — в чат автора СРАЗУ, до того как документ написан.
    //
    // Раньше в чате появлялся только готовый документ, а пока он сочинялся
    // (до пяти минут), там не было ничего. Со стороны выглядело так, будто
    // запрос не дошёл. Владелец 27.08.2026: «чтобы видно было, что он
    // работает и виден запрос от Романа».
    await this.recordRequest(userId, agentId, title, instructions);

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
        `сверху. Пиши так, чтобы текст можно было отправить адресату как есть.\n\n` +
        // Потолок объёма. Без него документы выходили на 16 тысяч знаков, и
        // второй такой не уложился в пятиминутный лимит — 27.08.2026 он
        // просто не дошёл до пользователя. Столько никто и не читает: нужен
        // документ, а не собрание сочинений.
        `Уложись примерно в ${DOC_TARGET_CHARS} знаков. Лучше плотно и по делу, чем длинно.`;

      // Изолированная сессия — как у вопросов специалистам: при коллизии с
      // живой сессией пользователя релей отдаёт пустой поток (инцидент 2026-07-12).
      const reply = await this.withTimeout(
        this.chat.generateAgentReplyWithCharge(userId, String(agentId), prompt, `voice_doc_${callId}_${docId}`),
        DOC_TIMEOUT_MS,
      );
      const body = (reply.text || '').trim();
      if (!body) throw new Error('пустой документ');

      // Файл + короткое вступление со ссылкой, а не весь текст в ленту.
      // Документ на шесть тысяч знаков в чате — стена, которую невозможно
      // читать. Владелец 26.08.2026: «документ должен быть доступен по ссылке
      // или прикреплён к чату».
      const url = await this.publish(userId, docId, title, body);
      const content = url
        ? `## ${title}\n\n${VoiceDocumentService.lead(body)}\n\n[Открыть документ полностью](${url})`
        : `## ${title}\n\n${body}`;

      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
         VALUES ($1, 'ai', $2, $3, 'text', $4)`,
        [`${userId}_${agentId}`, agentId, content, reply.tokens],
      );

      await this.charge(userId, agentId, title, reply.tokens);
      // Текст уходит и Роману: без него он не знает, что в документе, и не
      // может ни сообщить о готовности, ни обсудить содержимое.
      await this.safeSend(roomName, {
        v: 1, type: 'document_ready', docId, title, tokens: reply.tokens,
        specialist: author, text: body.slice(0, DOC_GIST_CHARS), url: url || undefined,
      });
      this.logger.log(
        `документ «${title}» готов, ${body.length} знаков, ${reply.tokens} токенов, ` +
        `в чат ${author || 'Романа'} (agent=${agentId})`,
      );
    } catch (e: any) {
      const reason = e?.message === 'timeout' ? 'timeout' : 'error';
      this.logger.warn(`документ «${title}» не собран: ${e?.message}`);
      await this.recordFailure(userId, agentId, title, reason);
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
