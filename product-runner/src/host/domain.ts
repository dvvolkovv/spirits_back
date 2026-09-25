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
export function condenseCertbot(e: any): string {
  const message = e?.message ? String(e.message) : String(e);
  const stdout = typeof e?.stdout === 'string' ? e.stdout.trim() : '';
  const source = stdout && !message.includes(stdout) ? `${message}\n${stdout}` : message;

  const keys = source.split('\n').filter((line) => CERTBOT_KEY_LINE.test(line)).map((line) => line.trim());
  const text = (keys.length ? keys.join('\n') : source).trim();
  // Хвост, а не голова: у certbot важное в конце (см. шапку).
  return text.length > CERTBOT_DETAIL_MAX ? `…${text.slice(-CERTBOT_DETAIL_MAX)}` : text;
}

/** Хвост чужого сообщения для остатка — короткий, чтобы голова причины не уехала за 1000. */
const tail = (e: any, max = 300): string => {
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
  const names = Array.isArray(job.customNames) ? job.customNames : [];

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
      const text = `${e?.message ?? ''}\n${typeof e?.stdout === 'string' ? e.stdout : ''}`;
      if (/No certificate found/i.test(text)) return;
      throw new Error(`certbot не удалил сертификат ${cert}: ${condenseCertbot(e)}`);
    }
    return;
  }

  // Привязка.
  await deps.run(withNames);
  try {
    await deps.run([
      'certbot', 'certonly', '--webroot', '-w', ACME_WEBROOT, '--cert-name', cert,
      '--non-interactive', '--agree-tos', '--keep-until-expiring', '--expand',
      ...names.flatMap((name) => ['-d', name]),
    ]);
  } catch (e: any) {
    const failure = new Error(`certbot не выпустил сертификат: ${condenseCertbot(e)}`);
    try {
      await deps.run(withoutNames);
    } catch (rollback: any) {
      // Остаток уезжает ВПЕРЕДИ причины (describeFailure в index.ts): имена
      // открыты по HTTP без сертификата, и чинить это едет человек.
      (failure as any).leftovers = [
        `свои имена ${names.join(', ')} в конфиге nginx продукта ${job.slug} без сертификата — `
          + `откат конфига не удался: ${tail(rollback)}`,
      ];
    }
    throw failure;
  }
  await deps.run(withNames);
}
