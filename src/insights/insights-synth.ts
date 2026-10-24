import { cleanLine, parseModelJson, PEOPLE_COUNT_RE } from './insights-text';
import {
  FRICTION_TYPES,
  type FrictionType,
  type Label,
  type PriorFinding,
  type Signals,
  type SynthFinding,
} from './insights.types';

export const MAX_FINDINGS = 10;

export function synthModel(): string {
  return process.env.INSIGHTS_SYNTH_MODEL || 'sonnet';
}

export const SYNTH_SYSTEM = `Ты — продуктовый аналитик Linkeon. На входе JSON: разметка затыков за неделю (по пункту на затык в разговоре: номер человека внутри недели, ассистент, тип, суть, тяжесть), сигналы недели и находки прошлых недель со статусами.

Склей похожие пункты в находки — от 5 до 10, не больше 10 (если пунктов мало — сколько есть). Для каждой:
- prior_id — id прошлой находки, если это она же; иначе null;
- type — один из: missing, confused, assistant, failure, money, silent;
- title — до 80 знаков; description — до 300 знаков, что происходит у людей; proposal — до 300 знаков, что изменить в продукте;
- people — номера людей из разметки, у которых это было;
- severity — 1, 2 или 3.

Правила: без цитат и кавычек, без имён, без чисел о людях («N человек», «N раз»), без деталей, по которым можно узнать человека, его дело или здоровье; здоровье и психология — не глубже темы. Не выдумывай: каждая находка опирается на пункты разметки. Находку со статусом rejected повторяй, только если людей с ней стало заметно больше.

Ответь ТОЛЬКО JSON: {"findings": [{"prior_id": null, "type": "...", "title": "...", "description": "...", "proposal": "...", "people": [1, 2], "severity": 2}]}`;

export function buildSynthPrompt(input: {
  weekLabel: string;
  labels: readonly Label[];
  signals: Signals;
  prior: readonly PriorFinding[];
}): string {
  return JSON.stringify({
    week: input.weekLabel,
    labels: input.labels.map((l) => ({ person: l.person, assistant: l.assistant, type: l.type, about: l.about, severity: l.severity })),
    signals: input.signals,
    prior: input.prior.map((p) => ({
      id: p.id,
      type: p.type,
      title: p.title,
      status: p.status,
      weeks: p.weeks,
      last_people: p.lastPeople,
      rejected_people: p.rejectedPeople,
    })),
  });
}

function textField(raw: unknown, max: number): string | null {
  const s = cleanLine(raw, max);
  return s && !PEOPLE_COUNT_RE.test(s) ? s : null;
}

/**
 * Разбор и проверка сводки. Счётчики считаются здесь по разметке, а не
 * берутся у модели: людей в находке — только те, кто есть в разметке.
 * null — ответ не по форме.
 */
export function parseFindings(text: string, labels: readonly Label[], prior: readonly PriorFinding[]): SynthFinding[] | null {
  const data = parseModelJson(text) as any;
  const rows: any[] | null = Array.isArray(data?.findings) ? data.findings : Array.isArray(data) ? data : null;
  if (!rows) return null;
  const persons = new Set(labels.map((l) => l.person));
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const list: SynthFinding[] = [];
  for (const r of rows) {
    const type = r?.type as FrictionType;
    if (!FRICTION_TYPES.includes(type)) continue;
    const title = textField(r?.title, 80);
    const description = textField(r?.description, 300);
    const proposal = textField(r?.proposal, 300);
    if (!title || !description || !proposal) continue;
    const rawPeople: unknown[] = Array.isArray(r?.people) ? r.people : [];
    const people = [...new Set(rawPeople.map((x) => Number(x)))].filter((n) => persons.has(n));
    if (!people.length) continue;
    const own = labels.filter((l) => people.includes(l.person) && l.type === type);
    const basis = own.length ? own : labels.filter((l) => people.includes(l.person));
    const conversations = new Set(basis.map((l) => `${l.person}|${l.assistant}`)).size || people.length;
    const assistants = [...new Set(basis.map((l) => l.assistant))];
    const priorRow = typeof r?.prior_id === 'string' ? priorById.get(r.prior_id) : undefined;
    // Отклонённая находка всплывает, только если людей стало хотя бы вдвое больше.
    if (priorRow?.status === 'rejected' && people.length < 2 * Math.max(1, priorRow.rejectedPeople ?? 1)) continue;
    const sev = Number(r?.severity);
    list.push({
      priorId: priorRow?.id ?? null,
      type,
      title,
      description,
      proposal,
      people: people.length,
      conversations,
      assistants,
      severity: sev === 1 || sev === 3 ? sev : 2,
    });
  }
  list.sort((a, b) => b.people * b.severity - a.people * a.severity);
  const usedPrior = new Set<string>();
  const out: SynthFinding[] = [];
  for (const f of list) {
    if (f.priorId) {
      if (usedPrior.has(f.priorId)) continue;
      usedPrior.add(f.priorId);
    }
    out.push(f);
    if (out.length === MAX_FINDINGS) break;
  }
  return out;
}
