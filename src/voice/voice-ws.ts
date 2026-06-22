import { INestApplication, Logger } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { JwtService } from '../common/services/jwt.service';
import { SpeechkitSttService } from './speechkit-stt.service';

const WS_PATH = '/voice/stream';
const logger = new Logger('VoiceWs');

/**
 * Поднимает WebSocket-шлюз потоковой диктовки поверх HTTP-сервера Nest.
 * Клиент (iOS Safari и пр.) шлёт LPCM16/16k/mono бинарными фреймами, получает
 * partial/final текст. Авторизация — JWT в query (?token=). STT не биллится.
 */
export function attachVoiceWs(app: INestApplication): void {
  const jwt = app.get(JwtService, { strict: false });
  const stt = app.get(SpeechkitSttService, { strict: false });
  const server = app.getHttpServer();

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let pathname = '';
    try { pathname = new URL(req.url || '', 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== WS_PATH) return; // не наш путь — не трогаем (другие upgrade-листенеры разрулят)

    // Авторизация по JWT из query
    let userId: string | null = null;
    try {
      const token = new URL(req.url || '', 'http://localhost').searchParams.get('token') || '';
      const payload: any = jwt.verify(token);
      userId = payload?.userId || payload?.sub || null;
    } catch { userId = null; }

    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, userId as string, stt);
    });
  });

  logger.log(`Voice WS attached at ${WS_PATH}`);
}

function handleConnection(ws: WebSocket, userId: string, stt: SpeechkitSttService): void {
  if (!stt.available) {
    ws.send(JSON.stringify({ type: 'error', message: 'voice not configured' }));
    ws.close();
    return;
  }

  const send = (obj: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  const handle = stt.openStream({
    onPartial: (text) => send({ type: 'partial', text }),
    onFinal: (text) => send({ type: 'final', text }),
    onError: (err) => { logger.warn(`STT error u=${userId}: ${err.message}`); send({ type: 'error', message: 'stt_error' }); try { ws.close(); } catch {} },
    onEnd: () => { send({ type: 'done' }); try { ws.close(); } catch {} },
  });

  send({ type: 'ready' });

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      handle.push(data);
    } else {
      // текстовый фрейм — управляющее сообщение
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === 'stop') handle.end();
      } catch { /* ignore */ }
    }
  });

  ws.on('close', () => { handle.end(); });
  ws.on('error', () => { handle.end(); });
}
