/**
 * ЗАДАНИЕ СВОЕГО ДОМЕНА: привязка (выпуск сертификата по HTTP-01) и отвязка.
 *
 * Намерение задания читается по списку имён: непустой — привязать, пустой —
 * отвязать (у строки в removing и у задания-уборки сервер имён не шлёт, см.
 * ClaimedJob.customNames). Режим конфига (прокси или заглушка) считает сервер:
 * агенту нечем узнать статус продукта.
 *
 * ## Привязка: конфиг → certbot → конфиг
 *
 * Первый вызов product-vhost открывает имена по HTTP: ACME-вызов Let's
 * Encrypt ложится в общий webroot (ACME_WEBROOT). Второй — тот же вызов, но
 * сертификат уже на диске, и скрипт дописывает 443. Без второго домен так и
 * остался бы на HTTP; без первого certbot не прошёл бы проверку вовсе.
 *
 * Отказ certbot — ОТКАТ конфига к набору без своих имён. Сервер пометит заявку
 * отказавшей, а продукт обязан продолжить работать на своём адресе платформы;
 * чужое имя, открытое по HTTP без сертификата, — это имя, которое отвечает
 * нашим продуктом тому, кого мы не проверили. Откатывать на «пустые» имена,
 * а не на прежние, можно потому, что выпуск сервер начинает только из
 * awaiting_dns или failed: в обоих случаях своих имён в конфиге по мнению
 * сервера нет (customNames — только issuing/active), и ближайший сон всё
 * равно переписал бы конфиг без них.
 *
 * Отказ ВТОРОГО конфига (сертификат уже выпущен) откатывается так же: скрипт
 * вернул бы первую версию со своими именами на порту 80. Отказ ПЕРВОГО не
 * откатывается — прежний конфиг на место кладёт сам product-vhost.
 *
 * ## Отвязка: сначала конфиг, потом сертификат
 *
 * Обратный порядок оставил бы конфиг, ссылающийся на удалённые файлы
 * сертификата, — и следующий `nginx -t` упал бы для ВСЕЙ машины. «Сертификата
 * нет» при удалении — не отказ: повтор отвязки (потерянный отчёт, «Проверить
 * снова») обязан проходить.
 *
 * ## Причина отказа начинается с НАШЕГО текста
 *
 * Сервер по началу причины решает «агент устарел» (AGENT_OUTDATED_MARKER в
 * src/products/domain-name.ts) и возвращает попытку выпуска. Выдача certbot
 * цитирует ответ веб-сервера пользователя, то есть начало причины, отданное
 * certbot, пользователь выбирал бы сам. Поэтому каждое сообщение отсюда
 * начинается с фиксированной приставки, а выдача certbot ужимается: сервер
 * хранит лишь голову причины (DOMAIN_ERROR_MAX = 1000), а полезное у certbot —
 * Domain/Type/Detail/Hint — стоит в КОНЦЕ простыни.
 */
import { DEFAULTS, ProvisionDeps, SLUG_RE } from './provision';
import { ProductKind } from './skeleton';
import { vhostArgv } from './vhost';

/** Общий webroot ACME-вызовов на машине продуктов. Тот же путь — в product-vhost. */
export const ACME_WEBROOT = '/var/www/linkeon-acme';

/** Имя сертификата продукта в certbot. Одно на продукт: повторный выпуск расширяет его (--expand). */
export const certName = (slug: string): string => `linkeon-${slug}`;

/**
 * Задание domain — ВЫЖИМКА: ни токена раннера, ни секретов (сервер их не
 * присылает, и хостовому шагу они не нужны).
 */
export interface DomainJob {
  slug: string;
  kind: ProductKind;
  /** Порт сайта. Нужен режиму прокси; у заглушки не читается. */
  port?: number | null;
  /** Свои имена. Непустой — привязать, пустой — отвязать. */
  customNames: string[];
  /** Режим конфига. Не пришёл — прокси: так было до появления поля. */
  vhostMode?: 'proxy' | 'asleep';
}

/** Сколько знаков выдачи certbot уезжает в причину. С приставкой — заметно меньше 1000 сервера. */
const CERTBOT_DETAIL_MAX = 800;

/** Строки certbot, в которых сказано, ЧТО не так. Остальное — простыня про журналы. */
const CERTBOT_KEY_LINE = /^\s*(Domain|Type|Detail|Hint):/;

/**
 * Выжимка отказа certbot: ключевые строки, а если их нет — хвост выдачи.
 *
 * Источник — `message` ошибки execFile («Command failed: <argv>\n<stderr>»):
 * certbot пишет отчёт об отказе в stderr. stdout подклеивается, если он
 * есть и в сообщение не попал, — на случай версии certbot, пишущей иначе.
 */
export function condenseCertbot(e: any, max = CERTBOT_DETAIL_MAX): string {
  const message = e?.message ? String(e.message) : String(e);
  const stdout = typeof e?.stdout === 'string' ? e.stdout.trim() : '';
  const source = stdout && !message.includes(stdout) ? `${message}\n${stdout}` : message;

  const keys = source.split('\n').filter((line) => CERTBOT_KEY_LINE.test(line)).map((line) => line.trim());
  if (keys.length) {
    // Не влезает — выбрасываются ЦЕЛЫЕ строки, от наименее ценной: Hint
    // (общий совет), Domain (имя есть и в Detail), Type. Detail — что ответил
    // сервер пользователя — уходит последним: подрезанный хвостом, он терял бы
    // ровно начало, где сказано, по какому адресу и что пришло.
    for (const drop of [[], ['Hint'], ['Hint', 'Domain'], ['Hint', 'Domain', 'Type']]) {
      const kept = keys.filter((line) => !drop.some((k) => line.startsWith(`${k}:`)));
      const text = kept.join('\n');
      if (kept.length && text.length <= max) return text;
    }
    const detail = keys.filter((line) => line.startsWith('Detail:')).join('\n') || keys.join('\n');
    return `${detail.slice(0, max)}…`;
  }
  const text = source.trim();
  // Без ключевых строк — хвост, а не голова: у certbot важное в конце (см. шапку).
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * Замок certbot: плановое продление (certbot.timer) держит его, и второй
 * запуск отвечает «Another instance of Certbot is already running». Это не
 * отказ Let's Encrypt и не ошибка пользователя — причина своя и узнаваемая,
 * без простыни certbot, чтобы человек понял: нажать ещё раз через минуту.
 */
const CERTBOT_BUSY = /Another instance of Certbot is already running/i;
export const CERTBOT_BUSY_REASON = 'certbot занят плановым продлением — повторите через минуту';

/** Полный текст отказа программы: message и, если есть, stdout. */
const fullText = (e: any): string =>
  `${e?.message ?? e ?? ''}\n${typeof e?.stdout === 'string' ? e.stdout : ''}`;

/** Длина префикса «НА ХОСТЕ ОСТАЛОСЬ: » и перевода строки в describeFailure (index.ts). */
const LEFTOVERS_FRAME = 'НА ХОСТЕ ОСТАЛОСЬ: \n'.length;
/** Голова причины, которую хранит сервер (DOMAIN_ERROR_MAX), с запасом на многоточие. */
const SERVER_HEAD = 980;

/** Хвост чужого сообщения — короткий, чтобы голова причины не уехала за 1000. */
const tail = (e: any, max: number): string => {
  const text = (e?.message ? String(e.message) : String(e)).trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
};

/**
 * Привязать или отвязать свои имена продукта. Бросает на любом отказе; все
 * проверки и обе командные строки собираются ДО первого действия на хосте.
 */
export async function applyDomain(job: DomainJob, deps: ProvisionDeps): Promise<void> {
  if (!SLUG_RE.test(job.slug)) throw new Error(`слаг не годится: ${JSON.stringify(job.slug)}`);
  // Своего домена у бота не бывает: у него нет vhost вовсе, и конфиг на его
  // слаг завёл бы в nginx имя, которого никогда не существовало.
  if (job.kind !== 'site') {
    throw new Error(`свой домен бывает только у сайта, а форма продукта ${JSON.stringify(job.kind)}`);
  }
  // Повторы — вон, порядок — как прислал сервер: повтор в `server_name`
  // nginx прощает предупреждением, а в `-d` certbot — нет, и лишняя пара в
  // argv только съедает голову причины.
  const names = [...new Set(Array.isArray(job.customNames) ? job.customNames : [])];

  let target: number | '--asleep';
  if (job.vhostMode === 'asleep') {
    target = '--asleep';
  } else {
    const port = job.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new Error(
        `у сайта ${job.slug} нет порта — конфиг своих имён в режиме прокси вести некуда`,
      );
    }
    target = port;
  }

  const bin = deps.vhostBin ?? DEFAULTS.vhostBin;
  // Обе строки — сейчас: мусорное имя отказывает здесь, до конфига и certbot.
  const withNames = vhostArgv(bin, job.slug, target, names);
  const withoutNames = vhostArgv(bin, job.slug, target, []);
  const cert = certName(job.slug);

  if (!names.length) {
    // Отвязка. Порядок — см. шапку.
    await deps.run(withoutNames);
    try {
      await deps.run(['certbot', 'delete', '--cert-name', cert, '--non-interactive']);
    } catch (e: any) {
      const text = fullText(e);
      if (/No certificate found/i.test(text)) return;
      if (CERTBOT_BUSY.test(text)) throw new Error(CERTBOT_BUSY_REASON);
      throw new Error(`certbot не удалил сертификат ${cert}: ${condenseCertbot(e)}`);
    }
    return;
  }

  // Привязка.
  //
  // Первый конфиг. Отказ здесь НЕ откатывается: product-vhost сам кладёт
  // прежний конфиг обратно байт в байт, когда `nginx -t` красный (exit 1), и
  // отказывает до записи на плохих аргументах (exit 2). Приставка своя — сырое
  // «Command failed: product-vhost …» в карточке не говорит, что случилось.
  try {
    await deps.run(withNames);
  } catch (e: any) {
    throw new Error(`конфиг своего домена не встал: ${tail(e, 600)}`);
  }

  try {
    await deps.run([
      'certbot', 'certonly', '--webroot', '-w', ACME_WEBROOT, '--cert-name', cert,
      '--non-interactive', '--agree-tos', '--keep-until-expiring', '--expand',
      ...names.flatMap((name) => ['-d', name]),
    ]);
  } catch (e: any) {
    const left = await rollback(deps, withoutNames, names, job.slug);
    if (CERTBOT_BUSY.test(fullText(e))) throw withLeftovers(new Error(CERTBOT_BUSY_REASON), left);
    // Бюджет выжимки — то, что осталось от головы сервера после остатка:
    // остаток стоит ВПЕРЕДИ причины и иначе вытолкнул бы Detail за 1000.
    const prefix = 'certbot не выпустил сертификат: ';
    const budget = left
      ? Math.max(200, SERVER_HEAD - LEFTOVERS_FRAME - left.length - prefix.length)
      : CERTBOT_DETAIL_MAX;
    throw withLeftovers(new Error(`${prefix}${condenseCertbot(e, budget)}`), left);
  }

  // Второй конфиг — тот же вызов, но сертификат уже на диске, и скрипт
  // дописывает 443. Красный `nginx -t` здесь скрипт откатывает к ПЕРВОЙ
  // версии — порт 80 со своими именами, — а сервер пометит заявку отказавшей:
  // имена жили бы на машине молча. Поэтому откат к набору без имён — как при
  // отказе certbot.
  //
  // Выпущенный сертификат НЕ удаляется: он безвреден (на него не ссылается ни
  // один конфиг), а следующий выпуск по тому же `--cert-name` с
  // `--keep-until-expiring` возьмёт его без похода в Let's Encrypt — то есть
  // не потратит лимит выпусков на домен. Удаление было бы ещё одним шагом,
  // способным отказать посреди отказа.
  try {
    await deps.run(withNames);
  } catch (e: any) {
    const left = await rollback(deps, withoutNames, names, job.slug);
    throw withLeftovers(new Error(`конфиг с сертификатом не встал: ${tail(e, 500)}`), left);
  }
}

/**
 * Откат конфига к набору без своих имён. Возвращает текст остатка, если откат
 * не удался, иначе undefined.
 *
 * Остаток КОРОТКИЙ и не перечисляет имена: он уезжает ВПЕРЕДИ причины
 * (describeFailure в index.ts), и два имени по 100 знаков плюс длинный хвост
 * ошибки вытолкнули бы строку Detail certbot за голову в 1000 знаков, которую
 * хранит сервер. Число имён и первое — достаточно, чтобы найти конфиг.
 */
async function rollback(
  deps: ProvisionDeps,
  withoutNames: string[],
  names: string[],
  slug: string,
): Promise<string | undefined> {
  try {
    await deps.run(withoutNames);
    return undefined;
  } catch (e: any) {
    const which = names.length > 1 ? `${names[0]} и ещё ${names.length - 1}` : names[0];
    return (
      `свои имена (${which}) остались в конфиге nginx продукта ${slug} — `
      + `откат конфига не удался: ${tail(e, 150)}`
    );
  }
}

function withLeftovers(error: Error, left: string | undefined): Error {
  if (left) (error as any).leftovers = [left];
  return error;
}
