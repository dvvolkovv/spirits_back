import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, AgentDispatchClient, DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
// ParticipantInfo_Kind живёт в @livekit/protocol, а не в livekit-server-sdk —
// последний его не реэкспортирует.
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { VOICE_DATA_TOPIC, VoiceDataMessage } from './voice-call.types';

@Injectable()
export class LiveKitClient {
  private readonly logger = new Logger(LiveKitClient.name);

  private get wsUrl(): string { return process.env.LIVEKIT_URL || 'ws://localhost:7880'; }
  private get httpUrl(): string {
    return this.wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  }
  private get apiKey(): string { return process.env.LIVEKIT_API_KEY || ''; }
  private get apiSecret(): string { return process.env.LIVEKIT_API_SECRET || ''; }

  /**
   * Токен участника-человека.
   *
   * TTL 3 часа: потолок звонка час, потолок встречи два, и токен обязан
   * пережить любой из них с запасом. Протухший посреди разговора означает
   * невозможность переподключиться после обрыва сети.
   *
   * name отдельно от identity: identity — ключ участника и обязана быть
   * уникальной, name — то, что видят люди в списке, и у тёзок совпадать
   * вправе. Без него в комнате видны служебные идентификаторы.
   */
  async userToken(roomName: string, identity: string, name?: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity, name, ttl: '3h' });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
  }

  /** Позвать воркера в комнату. metadata приезжает к нему в JobContext. */
  async dispatchAgent(roomName: string, metadata: Record<string, unknown>): Promise<void> {
    const agentName = process.env.VOICE_AGENT_NAME || 'linkeon-voice-host';
    const client = new AgentDispatchClient(this.httpUrl, this.apiKey, this.apiSecret);
    await client.createDispatch(roomName, agentName, { metadata: JSON.stringify(metadata) });
    this.logger.log(`[dispatch] room=${roomName} agent=${agentName}`);
  }

  /**
   * Закрыть комнату. Без этого воркер остаётся в ней один после того, как
   * браузер отключился, и Realtime-сессия продолжает тарифицироваться.
   */
  async closeRoom(roomName: string): Promise<void> {
    const client = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
    try {
      await client.deleteRoom(roomName);
    } catch (e: any) {
      // Комнаты уже нет — это нормальный исход, а не ошибка.
      this.logger.warn(`deleteRoom ${roomName}: ${e?.message}`);
    }
  }

  /**
   * Выгнать из комнаты только участников-агентов, комнату оставить.
   *
   * Для встречи closeRoom не годится: в комнате живые люди, и удаление комнаты
   * выкинет их всех из-за того, что завершилась наша половина. LiveKit метит
   * агентов отдельным kind — гадать по идентификатору не нужно.
   *
   * Best-effort: не выгнали — встреча продолжается, а воркера через два часа
   * добьёт собственный потолок сессии.
   */
  async removeAgents(roomName: string): Promise<void> {
    const client = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
    try {
      const participants = await client.listParticipants(roomName);
      for (const p of participants) {
        if (p.kind !== ParticipantInfo_Kind.AGENT) continue;
        await client.removeParticipant(roomName, p.identity).catch((e: any) => {
          this.logger.warn(`removeParticipant ${p.identity}: ${e?.message}`);
        });
      }
    } catch (e: any) {
      // Комнаты уже нет — нормальный исход, а не ошибка.
      this.logger.warn(`removeAgents ${roomName}: ${e?.message}`);
    }
  }

  /** Доставка сообщения в комнату. Слушают и воркер, и фронт. */
  async send(roomName: string, msg: VoiceDataMessage): Promise<void> {
    const client = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    await client.sendData(roomName, payload, DataPacket_Kind.RELIABLE, { topic: VOICE_DATA_TOPIC });
  }
}
