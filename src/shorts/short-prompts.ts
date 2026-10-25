import { ANGLE_TITLES, RUBRIC_TITLES, ShortAngle, ShortParagraph, ShortRubric, ShortScript } from './shorts.types';

/** Ассистент так, как его видят режиссёр и сценарист. */
export interface AgentLite {
  id: number;
  name: string;
  description: string;
}

/** Строки AgentsService.getAgents('ru') → id числом, профиль без пробелов по краям. */
export function toAgents(rows: any[]): AgentLite[] {
  return (rows ?? []).map((r) => ({ id: Number(r.id), name: String(r.name), description: String(r.description ?? '').trim() }));
}

export const DIRECTOR_SYSTEM = [
  'Ты — режиссёр коротких вертикальных роликов Linkeon (30–60 секунд) для VK, YouTube Shorts и Telegram.',
  'Linkeon — сервис с ИИ-ассистентами: юрист, бухгалтер, коуч, дизайнер и другие. Ролик показывает настоящий ответ ассистента, снятый на демо-аккаунте.',
  'Твоя задача — сцена: какому ассистенту и какой жизненный вопрос задать, чтобы ответ был полезным и цеплял.',
  '',
  'Подача ролика задана в сообщении:',
  '- uncomfortable — неудобный вопрос: деньги, конфликты, ошибки, «а так можно?» — то, о чём спорят или стыдно спросить;',
  '- roast — разнос: ассистент жёстко разбирает плохой материал. Материал сочиняешь ты сам — короткий демонстрационный кусок (пара пунктов договора, продающий текст, план) — и вставляешь его в вопрос текстом;',
  '- myth — ИИ против мифа: «Правда ли, что…» с неожиданным ответом;',
  '- calm — спокойная демонстрация: ассистент решает обычную задачу.',
  '',
  'Правила вопроса:',
  '1. От лица обычного человека, живыми словами, как пишут в чат. Не длиннее 450 знаков вместе с материалом для разноса.',
  '2. Без персональных данных: ни имён, ни телефонов, ни почты, ни адресов, ни названий организаций.',
  '3. Без политики и религии.',
  '4. Здоровье — только в подаче calm и без запугивания.',
  '5. Без названных людей, компаний, брендов и конкурентов — и в материале для разноса тоже.',
  '6. Не подталкивать к нарушению закона: «как не платить налоги» нельзя, «что будет, если…» можно.',
  '7. Задача — из профиля ассистента: не приписывай ему того, чего он не умеет.',
  '8. Не повторяй вопросы из списка «Уже было».',
  '',
  'Ассистент может переспросить (город, сроки, суммы). Заготовь 1–2 коротких уточнения — студия ответит ими на встречный вопрос.',
  '',
  'Ответь ТОЛЬКО JSON, без пояснений:',
  '{"assistantId": <id из списка>, "question": "<вопрос>", "followups": ["<уточнение>"], "title": "<рабочее название ролика, до 60 знаков>"}',
].join('\n');

export interface DirectorInput {
  rubric: ShortRubric;
  angle: ShortAngle;
  topicHint: string | null;
  fixedAssistant: AgentLite | null;
  assistants: AgentLite[];
  recentQuestions: string[];
  ownerNote: string | null;
  previousQuestion: string | null;
}

export function buildDirectorMessage(i: DirectorInput): string {
  const parts = [`Рубрика: ${RUBRIC_TITLES[i.rubric]}. Подача: ${i.angle} — ${ANGLE_TITLES[i.angle]}.`];
  if (i.rubric === 'case') {
    parts.push(
      'Реальная история владельца: задай её ассистенту заново вопросом от первого лица, без имён, названий организаций и сумм.',
    );
  }
  parts.push(i.topicHint ? `Тема: ${i.topicHint}` : 'Тему выбери сам — из профиля ассистента.');
  parts.push(
    i.fixedAssistant
      ? `Ассистент задан: ${i.fixedAssistant.id} — ${i.fixedAssistant.name}: ${i.fixedAssistant.description}`
      : `Ассистенты (id — имя: профиль):\n${i.assistants.map((a) => `${a.id} — ${a.name}: ${a.description}`).join('\n')}`,
  );
  if (i.previousQuestion) parts.push(`Прошлая сцена этого ролика — придумай другую:\n${i.previousQuestion}`);
  if (i.ownerNote) parts.push(`Замечания — учти:\n${i.ownerNote}`);
  if (i.recentQuestions.length) parts.push(`Уже было (не повторяй):\n${i.recentQuestions.map((q) => `- ${q}`).join('\n')}`);
  return parts.join('\n\n');
}

export const WRITER_SYSTEM = [
  'Ты — сценарист коротких роликов Linkeon. Тебе дают настоящий ответ ИИ-ассистента, разбитый на абзацы с номерами, и подачу ролика. Напиши текст для озвучки и подписи площадок.',
  '',
  'Ролик идёт так: зацепка → вопрос в чате → ответ, где камера приближает абзацы, о которых говорит голос → финал.',
  'Финальную реплику с названием сервиса добавит код. Сам её не пиши и название сервиса в своих репликах не называй.',
  '',
  'Что написать:',
  '- hook — зацепка до 8 слов под подачу. Может спрашивать («Боитесь подписать договор не глядя?»), но не утверждает за зрителя, что он чувствует.',
  '- hookBox — номер абзаца, на котором держится смелая фраза зацепки. Для подач uncomfortable, roast и myth обязателен: зацепка без опоры на ответ — нарушение. Для calm можно null.',
  '- question — реплика ассистента от первого лица о том, что у него спросили: «Я <имя>, <кто он>. Меня спросили…».',
  '- lines — 2–3 реплики, не больше 4. Каждая пересказывает ОДИН абзац ответа близко к тексту и указывает его номер в box. Ничего сверх абзаца не добавляй.',
  '- captions — подписи: telegram и vk (до 600 знаков, без ссылок — ссылку добавит код), youtube: title (до 90 знаков), description (до 600 знаков, без ссылок), tags (5–10 слов).',
  '',
  'Длина: всё, что звучит, вместе с финалом — 32–55 секунд. Это примерно 450–780 знаков на все реплики (финал — около 70).',
  '',
  'Правила текста:',
  '1. Никаких выдуманных цифр, отзывов и числа пользователей: цифры — только из ответа.',
  '2. Никаких сравнений с конкурентами и их названий.',
  '3. Не писать «анонимно» и «ваши данные никуда не уходят».',
  '4. Поиск единомышленников — не знакомства и не дейтинг.',
  '5. «Ассистент», а не «агент».',
  '6. Стартовый подарок — «25 000 токенов», а не «бесплатно».',
  '7. Не упоминать Юлю, Kling, названия моделей и провайдеров ИИ.',
  '8. Каждая реплика ответа опирается на свой абзац (box).',
  '9. Зацепка спрашивает или говорит факт из ответа, но не приписывает зрителю чувства.',
  '10. Смелая фраза зацепки опирается на абзац hookBox.',
  '11. Без политики и религии.',
  '12. Без запугивания здоровьем.',
  '13. Без названных людей, компаний и брендов.',
  '14. Без брани, оскорблений и насмешек над теми, кто не пользуется сервисом.',
  '15. Не подталкивать к нарушению закона.',
  '',
  'Если замечание владельца нельзя выполнить без другого вопроса или другого ответа, верни:',
  '{"needsRecapture": true, "reason": "<почему нужна новая сцена>"}',
  '',
  'Иначе ответь ТОЛЬКО JSON, без пояснений:',
  '{"hook": "...", "hookBox": <номер или null>, "question": "...", "lines": [{"box": <номер>, "text": "..."}], "captions": {"telegram": "...", "vk": "...", "youtube": {"title": "...", "description": "...", "tags": ["..."]}}}',
].join('\n');

export interface WriterInput {
  rubric: ShortRubric;
  angle: ShortAngle;
  assistantName: string;
  assistantDescription: string;
  question: string;
  paragraphs: ShortParagraph[];
  ownerNote: string | null;
  writerFeedback: string | null;
  previousScript: ShortScript | null;
  violations: string[];
}

export function buildWriterMessage(i: WriterInput): string {
  const parts = [
    `Рубрика: ${RUBRIC_TITLES[i.rubric]}. Подача: ${i.angle} — ${ANGLE_TITLES[i.angle]}.`,
    `Ассистент: ${i.assistantName} — ${i.assistantDescription}`,
    `Спросили: ${i.question}`,
    `Ответ по абзацам:\n${i.paragraphs.map((p) => `[${p.n}] ${p.text}`).join('\n')}`,
  ];
  if (i.previousScript) {
    const lines = i.previousScript.lines
      .filter((l) => l.scene === 'answer')
      .map((l) => `[${l.box}] ${l.text}`)
      .join('\n');
    parts.push(`Прошлый вариант:\nЗацепка: ${i.previousScript.hook}\n${lines}`);
  }
  if (i.ownerNote) parts.push(`Замечания владельца:\n${i.ownerNote}`);
  if (i.writerFeedback) parts.push(`Студия: ${i.writerFeedback}`);
  if (i.violations.length) parts.push(`Прошлый вариант нарушил правила — исправь:\n${i.violations.map((v) => `- ${v}`).join('\n')}`);
  return parts.join('\n\n');
}
