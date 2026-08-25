import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, AgentDispatchClient, DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
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

  /** Токен участника-человека. TTL с запасом на 60-минутный потолок сессии. */
  async userToken(roomName: string, identity: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity, ttl: '2h' });
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

  /** Доставка сообщения в комнату. Слушают и воркер, и фронт. */
  async send(roomName: string, msg: VoiceDataMessage): Promise<void> {
    const client = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    await client.sendData(roomName, payload, DataPacket_Kind.RELIABLE, { topic: VOICE_DATA_TOPIC });
  }
}
