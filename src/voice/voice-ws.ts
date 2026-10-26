import { INestApplication, Logger } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { JwtService } from '../common/services/jwt.service';
import { DEFAULT_LANGUAGE, LanguageService } from '../common/services/language.service';
import { SpeechkitSttService, SttStreamHandle, isSttLanguageSupported } from './speechkit-stt.service';

const WS_PATH = '/voice/stream';
const logger = new Logger('VoiceWs');

/** Сколько ждать язык из профиля, прежде чем слушать на языке по умолчанию. */
export const LANGUAGE_RESOLVE_TIMEOUT_MS = 2000;

/**
 * Потолок одного фрейма. Ворклет шлёт 100 мс PCM16/16 кГц — 3200 байт;
 * 64 КБ — запас в двадцать раз. Без потолка ws принимал фрейм до 100 МБ.
 */
export const VOICE_WS_MAX_PAYLOAD = 64 * 1024;

/**
 * Потолок аудио, накопленного до открытия стрима (пока читается язык).
 * За LANGUAGE_RESOLVE_TIMEOUT_MS честный клиент шлёт около 64 КБ; больше
 * мегабайта — не речь, сокет закрывается.
 */
export const VOICE_WS_MAX_PENDING_BYTES = 1024 * 1024;

type LanguageResolver = Pick<LanguageService, 'resolveUserLanguage'>;

/**
 * Поднимает WebSocket-шлюз потоковой диктовки поверх HTTP-сервера Nest.
 * Клиент (iOS Safari и пр.) шлёт LPCM16/16k/mono бинарными фреймами, получает
 * partial/final текст. Авторизация — JWT в query (?token=). STT не биллится.
 * Язык распознавания — из профиля (profile_data.language); языка без поддержки
 * SpeechKit — ответ { type: 'error', message: 'lang_unsupported' } и закрытие.
 */
export function attachVoiceWs(app: INestApplication): void {
  const jwt = app.get(JwtService, { strict: false });
  const stt = app.get(SpeechkitSttService, { strict: false });
  let languages: LanguageService | null = null;
  try { languages = app.get(LanguageService, { strict: false }); } catch {
    logger.warn('LanguageService недоступен — диктовка слушает на языке по умолчанию');
  }
  const server = app.getHttpServer();

  const wss = new WebSocketServer({ noServer: true, maxPayload: VOICE_WS_MAX_PAYLOAD });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let pathname = '';
    try { pathname = new URL(req.url || '', 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== WS_PATH) return; // не наш путь — не трогаем (другие upgrade-листенеры разрулят)

    // Авторизация по JWT из query
    let userId: string | null = null;
    try {
      const token = new URL(req.url || '', 'http://localhost').searchParams.get('token') || '';
      const payload: any = jwt.verifyAccess(token);
      userId = payload?.userId || payload?.sub || null;
    } catch { userId = null; }

    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Асинхронный обработчик: необработанный reject в Node 22 роняет процесс.
      handleConnection(ws, userId as string, stt, languages).catch((e: any) => {
        logger.error(`voice ws u=${userId}: ${e?.message}`);
        try { ws.close(); } catch {}
      });
    });
  });

  logger.log(`Voice WS attached at ${WS_PATH}`);
}

/** Язык профиля; при ошибке, пустом ответе или молчании базы — язык по умолчанию. */
async function resolveDictationLanguage(userId: string, languages?: LanguageResolver | null): Promise<string> {
  if (!languages) return DEFAULT_LANGUAGE;
  const TIMEOUT = Symbol('timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), LANGUAGE_RESOLVE_TIMEOUT_MS);
    });
    const lang = await Promise.race([languages.resolveUserLanguage(userId), timeout]);
    if (lang === TIMEOUT) {
      logger.warn(`dictation: язык профиля не прочитан за ${LANGUAGE_RESOLVE_TIMEOUT_MS} мс u=${userId} — слушаю на «${DEFAULT_LANGUAGE}»`);
      return DEFAULT_LANGUAGE;
    }
    return lang || DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleConnection(
  ws: WebSocket,
  userId: string,
  stt: SpeechkitSttService,
  languages?: LanguageResolver | null,
): Promise<void> {
  if (!stt.available) {
    ws.send(JSON.stringify({ type: 'error', message: 'voice not configured' }));
    ws.close();
    return;
  }

  const send = (obj: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  // Язык читается из базы уже после апгрейда, а клиент (voiceDictation.ts)
  // шлёт аудио сразу при открытии сокета, не дожидаясь ready. Ранние фреймы
  // и stop копим до открытия стрима — иначе пропадёт начало фразы.
  let handle: SttStreamHandle | null = null;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let stopRequested = false;
  let gone = false;

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (gone) return;
    if (isBinary) {
      if (handle) { handle.push(data); return; }
      pendingBytes += data.length;
      if (pendingBytes > VOICE_WS_MAX_PENDING_BYTES) {
        logger.warn(`dictation: до открытия стрима пришло больше ${VOICE_WS_MAX_PENDING_BYTES} байт u=${userId} — закрываю`);
        gone = true;
        pending.length = 0;
        try { ws.close(1009); } catch {}
        return;
      }
      pending.push(data);
      return;
    }
    // текстовый фрейм — управляющее сообщение
    try {
      const msg = JSON.parse(data.toString());
      if (msg?.type === 'stop') { if (handle) handle.end(); else stopRequested = true; }
    } catch { /* ignore */ }
  });

  const onGone = () => { gone = true; handle?.end(); };
  ws.on('close', onGone);
  ws.on('error', onGone);

  const language = await resolveDictationLanguage(userId, languages);
  // Клиент ушёл или сокет уже закрывается, пока читался язык, — стрим не нужен.
  if (gone || ws.readyState !== WebSocket.OPEN) return;

  if (!isSttLanguageSupported(language)) {
    logger.log(`dictation: язык «${language}» без распознавания u=${userId}`);
    send({ type: 'error', message: 'lang_unsupported' });
    try { ws.close(); } catch {}
    return;
  }

  const opened = stt.openStream({
    onPartial: (text) => send({ type: 'partial', text }),
    onFinal: (text) => send({ type: 'final', text }),
    onError: (err) => { logger.warn(`STT error u=${userId}: ${err.message}`); send({ type: 'error', message: 'stt_error' }); try { ws.close(); } catch {} },
    onEnd: () => { send({ type: 'done' }); try { ws.close(); } catch {} },
  }, language);
  handle = opened;

  send({ type: 'ready' });

  for (const chunk of pending.splice(0)) opened.push(chunk);
  if (stopRequested) opened.end();
}
