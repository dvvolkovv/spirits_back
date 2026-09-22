import { GitCommit } from './blog-git.source';
import { normalizeTopicKey } from './blog-topic.service';

/**
 * Единица новости — тема недели, а не коммит.
 *
 * Коммит новостью быть не может: фича размазана по десяткам коммитов, и
 * «тема на коммит» давала на проде ~30 тем в неделю, ни одна из которых не
 * годилась для канала. Скоуп conventional commit (`feat(meeting-bot): ...`)
 * — это готовая группировка, которую разработчики и так проставляют.
 */

/**
 * Куда складываются коммиты без скоупа (`fix: вход по почте`).
 *
 * Не выбрасываем их: заметная пользователю починка часто коммитится без
 * скоупа, и отсев по формату похоронил бы настоящую новость. Но и тему на
 * каждый такой коммит не заводим — это вернуло бы «коммит = новость». Все
 * они идут одной сборной темой, а решает по ней агент; в промпте прямо
 * сказано, что это солянка и брать её можно только ради одного конкретного
 * видимого изменения внутри.
 */
export const MISC_THEME = 'разное';

/**
 * Темы, невидимые пользователю по определению. Отсекаются до показа агенту:
 * даже самый строгий промпт не должен получать соблазн в виде темы с 27
 * коммитами, о которой рассказывать нечего.
 *
 * - `deploy`, `runner`, `ci` — инфраструктура: выкат, прогон, пайплайны;
 * - `blog`, `plan`, `spec` — наш собственный инструментарий: этот самый
 *   модуль блога, планы и спеки. Работа по ним настоящая и её много, но
 *   читатель канала не видит её вообще никогда.
 *
 * Список намеренно короткий и явный. Всё остальное — продуктовые темы, и
 * решение «интересно ли это» принимает агент, видящий тему целиком.
 */
export const THEME_STOPLIST: string[] = ['deploy', 'runner', 'ci', 'blog', 'plan', 'spec'];

export interface CommitTheme {
  theme: string;
  commits: GitCommit[];
}

/**
 * Заголовок conventional commit: тип, необязательный скоуп в скобках,
 * необязательный `!` (breaking change), двоеточие. Темой служит именно
 * скоуп, а не тип: тип отвечает на «что за работа», скоуп — на «о чём».
 */
const HEADER = /^[a-zа-яё]+\(([^)]*)\)!?\s*:/i;

export function themeOf(subject: string): string {
  const m = HEADER.exec(String(subject || '').trim());
  const scope = (m?.[1] || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return scope || MISC_THEME;
}

/** Коммиты недели, свёрнутые в темы: крупные сверху, солянка последней. */
export function groupCommitsByTheme(commits: GitCommit[]): CommitTheme[] {
  const byTheme = new Map<string, GitCommit[]>();
  for (const c of commits || []) {
    const theme = themeOf(c.subject);
    const list = byTheme.get(theme);
    if (list) list.push(c);
    else byTheme.set(theme, [c]);
  }

  return [...byTheme.entries()]
    .map(([theme, list]) => ({ theme, commits: list }))
    .sort((a, b) => {
      // Солянка без скоупа — не тема, а остаток. Наверху списка она читалась
      // бы как самое важное за неделю, хотя это ровно наоборот: содержимого,
      // по которому её можно было бы назвать, у неё нет.
      if (a.theme === MISC_THEME) return 1;
      if (b.theme === MISC_THEME) return -1;
      // Порядок детерминирован до конца: при равном числе коммитов — по
      // алфавиту, иначе один и тот же вход давал бы агенту разные списки.
      return b.commits.length - a.commits.length || a.theme.localeCompare(b.theme);
    });
}

export function isStopTheme(theme: string): boolean {
  return THEME_STOPLIST.includes(String(theme || '').trim().toLowerCase());
}

/** Темы недели, которые вообще имеет смысл показывать агенту. */
export function weeklyThemes(commits: GitCommit[]): CommitTheme[] {
  return groupCommitsByTheme(commits).filter((t) => !isStopTheme(t.theme));
}

/**
 * Ключ недели по ISO 8601 (`2026-W38`). Неделя начинается с понедельника, а
 * год недели определяет её четверг — поэтому 1 января может относиться к
 * 53-й неделе прошлого года, и наивное «год + номер недели по 1 января»
 * раз в несколько лет заводило бы дубль или, наоборот, гасило настоящую
 * новость.
 *
 * Считаем в UTC: крон новостей ходит раз в неделю, и сдвиг локальной зоны
 * сервера не должен молча переносить выкат в соседнюю неделю.
 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; // Пн=1 … Вс=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // четверг этой же недели
  const year = t.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((t.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Природный ключ анонса: источник, неделя, тема.
 *
 * Именно он делает повторный анонс той же темы в ту же неделю невозможным —
 * проверка по нему (`onceBySourceRef`) смотрит на все посты без оглядки на
 * статус. Обычной дедупликации по `topic_key` для этого мало: она нарочно
 * пропускает отклонённые темы, то есть повторный прогон крона воскресил бы
 * ровно тот анонс, который владелец только что отправил в мусор.
 *
 * Неделя в ключе — не украшение: без неё тема заводилась бы единожды за всё
 * время, и второй заход по «встречам» через месяц не состоялся бы никогда.
 */
export function newsSourceRef(weekKey: string, theme: string): string {
  return `git:${weekKey}:${theme}`;
}

/** Ключ темы: неделя внутри, чтобы окно дедупликации не запирало тему на 90 дней. */
export function newsTopicKey(weekKey: string, theme: string): string {
  return normalizeTopicKey(`${theme} ${weekKey}`);
}

/**
 * Подсказка редактору: строка агента про пользу плюс заголовки коммитов
 * темы. Одной строки мало — по ней редактор начнёт домысливать; заголовки
 * держат его на фактах.
 */
export function newsTopicHint(headline: string, theme: CommitTheme): string {
  const subjects = theme.commits.map((c) => `- ${c.subject}`).join('\n');
  return `${headline}\n\nКоммиты недели по теме «${theme.theme}»:\n${subjects}`;
}
