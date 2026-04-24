import { Injectable, Logger } from '@nestjs/common';
import { AgentDispatchClient } from 'livekit-server-sdk';

@Injectable()
export class VoiceAgentService {
  private readonly logger = new Logger(VoiceAgentService.name);

  private get httpUrl(): string {
    const url = process.env.LIVEKIT_URL || 'ws://localhost:7880';
    return url.replace('ws://', 'http://').replace('wss://', 'https://');
  }
  private get apiKey(): string { return process.env.LIVEKIT_API_KEY || ''; }
  private get apiSecret(): string { return process.env.LIVEKIT_API_SECRET || ''; }
  private get agentName(): string { return process.env.DOZVON_AGENT_NAME || 'outbound-call-agent'; }
  private get backendUrl(): string { return process.env.BACKEND_URL || 'https://my.linkeon.io'; }
  private get callbackSecret(): string { return process.env.OUTBOUND_CALLBACK_SECRET || ''; }

  /**
   * Dispatch a call to the shared Taler ID outbound-call-agent on DigitalOcean.
   * The agent joins the LiveKit room, waits for the SIP peer, conducts a dialog,
   * and POSTs a callback to `${BACKEND_URL}/webhook/dozvon/internal/taler-callback`.
   */
  async dispatchCall(payload: {
    call_id: number;
    campaign_id: number;
    room_name: string;
    agent_token: string;      // unused with shared agent (it uses its own creds)
    phone: string;
    voice_id: string;         // unused (shared agent uses ELEVENLABS_VOICE_ID env)
    system_prompt: string;
    agent_name: string;
    contact_name?: string;
  }): Promise<void> {
    const dispatcher = new AgentDispatchClient(this.httpUrl, this.apiKey, this.apiSecret);
    const metadata = JSON.stringify({
      businessName: payload.contact_name || payload.agent_name || 'Контакт',
      phoneNumber: payload.phone,
      questionsToAsk: [],
      taskContext: payload.system_prompt,
      agentPrompt: payload.system_prompt,
      ownerName: payload.agent_name,
      callId: String(payload.call_id),
      campaignId: String(payload.campaign_id),
      callbackUrl: `${this.backendUrl}/webhook/dozvon/internal/taler-callback`,
      callbackSecret: this.callbackSecret,
    });
    await dispatcher.createDispatch(payload.room_name, this.agentName, { metadata });
    this.logger.log(`[Dispatch] room=${payload.room_name} agent=${this.agentName} call=${payload.call_id}`);
  }

  async getStatus(): Promise<any> {
    return { status: 'shared', agent: this.agentName, host: this.httpUrl };
  }
}
