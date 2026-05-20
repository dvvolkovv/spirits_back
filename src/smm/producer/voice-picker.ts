// src/smm/producer/voice-picker.ts
// Yandex SpeechKit voice pool for creator-mode TTS.
// Voice IDs verified to work with our existing SpeechKit subscription.

const MALE_VOICES = ['ermil', 'filipp', 'madirus'];
const FEMALE_VOICES = ['alena', 'jane', 'omazh'];

export type VoiceGender = 'male' | 'female';

export function pickRandomVoice(gender: VoiceGender): string {
  const pool = gender === 'male' ? MALE_VOICES : FEMALE_VOICES;
  return pool[Math.floor(Math.random() * pool.length)];
}
