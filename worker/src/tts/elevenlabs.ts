// worker/src/tts/elevenlabs.ts
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { ElevenlabsVoiceSelection } from './voices';

export interface ElevenlabsSynthInput {
  text: string;
  voice: ElevenlabsVoiceSelection;
}

export async function synthesizeElevenlabs(input: ElevenlabsSynthInput): Promise<Buffer> {
  const apiKey = config.tts.elevenlabsApiKey;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');

  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${input.voice.voiceId}`,
    {
      text: input.text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.4,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
      validateStatus: () => true,
    },
  );
  if (r.status !== 200) {
    const errBody = Buffer.from(r.data).toString('utf8').slice(0, 200);
    throw new Error(`ElevenLabs TTS ${r.status}: ${errBody}`);
  }
  const buf = Buffer.from(r.data);
  logger.debug({ voiceId: input.voice.voiceId, bytes: buf.length }, 'elevenlabs synth ok');
  return buf;
}
