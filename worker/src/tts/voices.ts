// worker/src/tts/voices.ts
import { config } from '../config';

export type Speaker = 'hero' | 'assistant';
export type AssistantRole = 'psy' | 'lawyer' | 'coach' | (string & {});
export type HeroGender = 'm' | 'f';

export interface YandexVoiceSelection {
  voice: string;
  emotion?: 'good' | 'neutral' | 'evil';
}

export interface ElevenlabsVoiceSelection {
  voiceId: string;
}

const YANDEX_MAP: Record<string, YandexVoiceSelection> = {
  hero_m: { voice: 'zahar', emotion: 'neutral' },
  hero_f: { voice: 'oksana', emotion: 'neutral' },
  assistant_psy: { voice: 'ermil', emotion: 'good' },
  assistant_lawyer: { voice: 'madirus', emotion: 'neutral' },
  assistant_coach: { voice: 'jane', emotion: 'good' },
  assistant_default: { voice: 'jane', emotion: 'neutral' },
};

export function pickYandexVoice(
  speaker: Speaker,
  role: AssistantRole,
  heroGender: HeroGender = 'm',
): YandexVoiceSelection {
  if (speaker === 'hero') return YANDEX_MAP[`hero_${heroGender}`];
  const key = `assistant_${role}`;
  return YANDEX_MAP[key] || YANDEX_MAP.assistant_default;
}

export function pickElevenlabsVoice(
  speaker: Speaker,
  role: AssistantRole,
  heroGender: HeroGender = 'm',
): ElevenlabsVoiceSelection {
  const v = config.tts.elevenlabsVoices;
  if (speaker === 'hero') {
    const id = heroGender === 'f' ? v.heroFemale : v.heroMale;
    if (!id) throw new Error(`ElevenLabs hero_${heroGender} voice id not configured`);
    return { voiceId: id };
  }
  const id = (v as Record<string, string>)[role] || v.psy;
  if (!id) throw new Error(`ElevenLabs voice for role=${role} not configured`);
  return { voiceId: id };
}
