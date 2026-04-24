import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, RoomServiceClient, SipClient } from 'livekit-server-sdk';

@Injectable()
export class SipService {
  private readonly logger = new Logger(SipService.name);

  private get url(): string { return process.env.LIVEKIT_URL || 'ws://localhost:7880'; }
  private get httpUrl(): string { return this.url.replace('ws://', 'http://').replace('wss://', 'https://'); }
  private get apiKey(): string { return process.env.LIVEKIT_API_KEY || ''; }
  private get apiSecret(): string { return process.env.LIVEKIT_API_SECRET || ''; }
  private get trunkId(): string { return process.env.SIP_TRUNK_ID || process.env.NOVOFON_SIP_TRUNK_ID || ''; }

  async createAgentToken(roomName: string, identity: string): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity, ttl: 3600 });
    token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
    return token.toJwt();
  }

  async dialOutbound(roomName: string, phone: string): Promise<string> {
    this.logger.log(`[SIP] dial room=${roomName} phone=${phone} trunk=${this.trunkId}`);
    const sipClient = new SipClient(this.httpUrl, this.apiKey, this.apiSecret);
    const result = await sipClient.createSipParticipant(
      this.trunkId,
      phone,
      roomName,
      {
        participantIdentity: `sip-${phone}`,
        participantName: phone,
        waitUntilAnswered: true,
        timeout: 90,
      },
    );
    return result?.participantIdentity || `sip-${phone}`;
  }

  async deleteRoom(roomName: string): Promise<void> {
    try {
      const roomService = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
      await roomService.deleteRoom(roomName);
    } catch (e: any) {
      this.logger.warn(`deleteRoom ${roomName}: ${e.message}`);
    }
  }
}
