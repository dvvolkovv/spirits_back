import { finalLine } from './short-numbers';
import { WriterReply } from './short-parse';
import { ShortScript, ShortScriptLine } from './shorts.types';

/** Темп принятого образца (владелец, 25.10.2026). */
export const SPEECH_SPEED = 1.1;

/** Подпись реального кейса в кадре вопроса (спека, «Рубрики»). */
export const CASE_BADGE = 'Реальная история, разговор повторён на демо-аккаунте';

export interface ScriptOptions {
  /** Голос ассистента — им звучат зацепка, вопрос и ответ. */
  voice: string;
  /** Голос Linkeon для финала (short_settings.narrator_voice). */
  narratorVoice: string;
  assistantsCount: number;
  disclaimer?: string;
  badge?: string;
}

/** Ответ сценариста → `Script` студии: id реплик h, q, a1…, f — как у образца. */
export function buildScript(reply: Pick<WriterReply, 'hook' | 'hookBox' | 'question' | 'lines'>, o: ScriptOptions): ShortScript {
  const lines: ShortScriptLine[] = [
    { id: 'h', scene: 'hook', text: reply.hook },
    { id: 'q', scene: 'question', text: reply.question },
    ...reply.lines.map((l, i): ShortScriptLine => ({ id: `a${i + 1}`, scene: 'answer', box: l.box, text: l.text })),
    { id: 'f', scene: 'final', voice: o.narratorVoice, text: finalLine(o.assistantsCount) },
  ];
  return {
    hook: reply.hook,
    ...(reply.hookBox !== null && reply.hookBox !== undefined ? { hookBox: reply.hookBox } : {}),
    ...(o.badge ? { badge: o.badge } : {}),
    voice: o.voice,
    speed: SPEECH_SPEED,
    lines,
    final: { assistantsCount: o.assistantsCount, ...(o.disclaimer ? { disclaimer: o.disclaimer } : {}) },
  };
}
