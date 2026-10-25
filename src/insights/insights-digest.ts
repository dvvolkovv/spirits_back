import { weekLabel } from './insights-week';
import { FRICTION_LABELS, type FindingStatus, type Signals, type SynthFinding } from './insights.types';

export const DIGEST_MAX_CHARS = 3500;

export interface DigestFinding extends SynthFinding {
  id: string;
  status: FindingStatus;
  /** Сколько недель находка встречается, включая эту. */
  weeksSeen: number;
  /** Людей на прошлой неделе — для «стало меньше». */
  prevPeople: number | null;
}

export interface DigestInput {
  weekStart: string;
  conversations: number;
  people: number;
  crisis: number;
  signals: Signals;
  findings: readonly DigestFinding[];
  /** Пачки разговоров, которые модель не разметила: без этой строки сводка выглядела бы полной. */
  failedBatches?: { failed: number; total: number };
  /** Пункты разметки, вошедшие в запрос сводки (см. fitSynthPrompt). */
  labelsInSynth?: { used: number; total: number };
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export function insightsChatId(): number | null {
  const raw = process.env.INSIGHTS_TG_CHAT_ID || process.env.BLOG_APPROVER_TG_ID;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function trend(f: DigestFinding): string {
  if (f.weeksSeen <= 1) return 'новое';
  if (f.prevPeople !== null && f.people < f.prevPeople) return 'стало меньше';
  return `держится ${f.weeksSeen} нед.`;
}

function block(n: number, f: DigestFinding): string {
  const who = f.people === 1 ? '1 человек' : `${f.people} чел., ${f.conversations} разг.`;
  const head = `${n}. ${FRICTION_LABELS[f.type]} · ${who} · ${f.assistants.join(', ') || '—'} · ${trend(f)}`;
  return `${head}\n${f.title}. ${f.description}\n→ ${f.proposal}`;
}

/** Что из недели до сводки не дошло. */
function gapLines(input: DigestInput): string[] {
  const out: string[] = [];
  const fb = input.failedBatches;
  if (fb && fb.failed > 0) out.push(`Не разобрано пачек разговоров: ${fb.failed} из ${fb.total} — модель не разметила их и со второй попытки.`);
  const ls = input.labelsInSynth;
  if (ls && ls.used < ls.total) out.push(`В сводку вошло пунктов разметки: ${ls.used} из ${ls.total}, сначала тяжёлые — запрос не вместил все.`);
  return out;
}

/** Сначала находки нескольких людей по важности, потом «1 человек». */
export function orderFindings(list: readonly DigestFinding[]): DigestFinding[] {
  const score = (f: DigestFinding) => f.people * f.severity;
  const many = list.filter((f) => f.people > 1).sort((a, b) => score(b) - score(a));
  const one = list.filter((f) => f.people <= 1).sort((a, b) => b.severity - a.severity);
  return [...many, ...one];
}

export function buildDigest(input: DigestInput): { text: string; shown: DigestFinding[] } {
  const s = input.signals;
  const header = [
    `Затыки недели · ${weekLabel(input.weekStart)}`,
    `Разговоров: ${input.conversations} · людей: ${input.people} · кризисных: ${input.crisis}`,
    `Без ответа: ${s.unansweredRuns} · «?» в тишину: ${s.silentQuestionMarks} · пустых и упавших ответов: ${s.emptyOrFailedTurns}` +
      (s.meetingsTotal ? ` · встреч: ${s.meetingsTotal}, оборвалось: ${s.meetingsFailed}` : ''),
    ...gapLines(input),
  ].join('\n');
  const ordered = orderFindings(input.findings);
  if (!ordered.length) return { text: `${header}\n\nЗатыков на этой неделе не нашлось.`, shown: [] };
  const parts = [header];
  const shown: DigestFinding[] = [];
  for (const f of ordered) {
    const candidate = [...parts, block(shown.length + 1, f)].join('\n\n');
    const rest = ordered.length - shown.length - 1;
    const note = rest > 0 ? `\n\nНе вошло: ${rest}.` : '';
    if (candidate.length + note.length > DIGEST_MAX_CHARS) break;
    parts.push(block(shown.length + 1, f));
    shown.push(f);
  }
  const cut = ordered.length - shown.length;
  return { text: parts.join('\n\n') + (cut > 0 ? `\n\nНе вошло: ${cut}.` : ''), shown };
}

/** Кнопки по строке на находку, номер — как в тексте сводки. */
export function buildKeyboard(items: ReadonlyArray<{ id: string; status: FindingStatus }>): InlineKeyboard {
  return {
    inline_keyboard: items.map((it, i) => {
      const n = i + 1;
      if (it.status === 'backlog') return [{ text: `${n} ✓ В бэклоге`, callback_data: `ins:noop:${it.id}` }];
      if (it.status === 'rejected') return [{ text: `${n} ✗ Отклонено`, callback_data: `ins:noop:${it.id}` }];
      return [
        { text: `${n} → В бэклог`, callback_data: `ins:b:${it.id}` },
        { text: `${n} ✗ Отклонить`, callback_data: `ins:r:${it.id}` },
      ];
    }),
  };
}
