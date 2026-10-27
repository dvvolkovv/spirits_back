/**
 * СМЕНА КЛЮЧЕЙ ВЛАДЕЛЬЦА — задание `rekey` (очередь 2).
 *
 * Переменные окружения контейнера задаются один раз, при `docker run`, —
 * поменять их можно только пересозданием. Пересоздаётся с ТЕМ ЖЕ образом,
 * портом, каталогом, лимитами и переменными платформы; меняются только ключи
 * владельца: `dropNames` и имена нового набора уходят, новый набор приходит.
 *
 * ## Почему настройки — с живого контейнера, а не «как при заведении»
 *
 * В контейнере лежит RUNNER_TOKEN, и взять его второй раз негде: сервер хранит
 * только sha256 (см. шапку sleep.ts). Рядом с ним так же молча потерялись бы
 * порт, привязка каталога и лимиты. Поэтому всё снимается `docker inspect`
 * ДО первого разрушающего шага, а старый контейнер не удаляется, а
 * переименовывается в `<слаг>__rekey` и живёт, пока новый не доказал здоровье.
 * Та же форма, что у scripts/product-image-roll.sh (do_recreate/do_restore).
 *
 * ## Почему JSON, а не шаблоны по строке
 *
 * product-image-roll.sh читает `.Config.Env` построчно и потому сторожит
 * число строк против `{{len .Config.Env}}`: значение с переводом строки
 * (приватный ключ PEM) иначе разваливается на две переменные. Здесь
 * `{{json .}}` и разбор в коде — перевод строки внутри значения ничего не
 * ломает, а приватные ключи владельцы как раз и присылают. Контейнер
 * спрашивается с `--type container`: без него docker при отсутствии
 * контейнера отдал бы образ с тем же именем, и разбор пошёл бы по чужому
 * объекту.
 *
 * ## Образ — тот же, запуск — по метке
 *
 * Запуск по голому идентификатору выбросил бы контейнер из отбора
 * product-image-roll.sh НАВСЕГДА (отбор по `.Config.Image` с префиксом
 * `linkeon-product:`): раннер внутри перестал бы обновляться. Поэтому по
 * `.Config.Image`, если это метка `linkeon-product:` и она по-прежнему
 * указывает на образ контейнера. Иначе — метку передвинули (контейнер
 * пропущен прошлым обновлением образа) или контейнер запущен по
 * идентификатору либо чужой меткой — по стабильной метке
 * `linkeon-product:src-*` того же образа: так продукт заодно возвращается в
 * отбор. Нет такой — отказ ДО изменений: смена ключей не должна втихую
 * менять раннер. Метку могут передвинуть и между inspect и запуском, поэтому
 * после `docker run` образ нового контейнера сверяется по идентификатору
 * (как verify_image в product-image-roll.sh); не тот — откат.
 *
 * ## Здоровье
 *
 * `/health` спрашивается ИЗНУТРИ контейнера (`docker exec … node -e`) — у
 * бота порта наружу нет вовсе — по правилу раннера (`checkHealth` в
 * deploy.ts: 2xx, не HTML ни по заголовку, ни по телу) и строже него, как
 * probe заведения: JSON с непустым `sha` обязателен (см. HEALTH_INSIDE).
 * Одно правило на сайт и бота: «здоров» не должно значить разное в
 * зависимости от формы продукта. Сайту сверх того — `waitPort`, как при
 * заведении и пробуждении: опубликованный порт обязан ответить тоже, иначе
 * домен смотрел бы в пустоту.
 *
 * Здоров — это ДВА ответа через паузу, а не один: ключ, который код владельца
 * читает лениво (на первом запросе к своему API), валит процесс уже после
 * первого ответа. Убранный к тому моменту старый контейнер было бы не
 * вернуть. Второй взгляд — одной пробой, без нового ожидания: срок смены
 * ограничен. Нездоров — откат.
 *
 * ## Откат — по состоянию хоста, а не по тому, какой шаг отказал
 *
 * Снятый по сроку `docker rename` мог успеть переименовать, отказавший
 * `docker run` — успеть создать контейнер. Поэтому откат спрашивает хост, где
 * сейчас старый контейнер: есть `<слаг>__rekey` — под именем продукта лежит
 * новый (или никого), он снимается, старый получает имя обратно; нет —
 * старый так и стоит под своим именем, и его остаётся только поднять. Что
 * `<слаг>__rekey` до начала смены не было, проверено первым делом (остаток
 * прерванной смены — отказ до изменений). `docker start` отвечает 0, как
 * только процесс запущен, — упавший через секунду тоже; поэтому после него
 * пауза и состояние контейнера, как в do_restore. Не удержался — остаток, и
 * сервер узнаёт, что исход неизвестен.
 *
 * ## Не посреди обновления образа
 *
 * Страховка `<слаг>__pre_<12 hex>` на хосте значит, что product-image-roll.sh
 * пересоздаёт этот продукт прямо сейчас (или оборвался на нём) — отказ до
 * изменений, см. проверку в rekeyProduct.
 *
 * ## Чего здесь нет
 *
 * vhost не трогается: порт тот же. Командная строка в причину отказа не идёт:
 * в `message` execFile лежит весь argv, а в нём — RUNNER_TOKEN, токен Claude и
 * значения ключей, которые маска `redact` по известным значениям не знает
 * (ей известен только новый набор). См. reasonOf.
 */
import {
  CONTAINER_PORT,
  DEFAULTS,
  ProvisionDeps,
  SLUG_RE,
  containerTaken,
  isReservedEnvName,
  ownerTgIdFor,
  validateSecrets,
} from './provision';
import { ProductKind } from './skeleton';

export interface RekeyJob {
  slug: string;
  kind: ProductKind;
  /** ПОЛНЫЙ новый набор ключей владельца (после замены, удаления и добавления). */
  secrets: Record<string, string>;
  /** Имена старых ключей, которых в новом наборе нет: уходят из окружения. */
  dropNames: string[];
  /**
   * Telegram владельца бота. Строка цифр — поставить OWNER_TG_ID; пустая
   * строка — снять (владелец отвязал Telegram); нет поля — не трогать (сервер
   * старше агента или не прочитал привязку). Сайту не ставится никогда.
   */
  ownerTgId?: string;
}

/** Имя старого контейнера на время смены. Не `__pre_`: то — страховка обновления образа. */
export const REKEY_BACKUP_SUFFIX = '__rekey';

/** Страховка scripts/product-image-roll.sh: `<слаг>__pre_<CTX12>` (PRE_SUFFIX там — 12 знаков хеша содержимого). */
const IMAGE_ROLL_BACKUP = '__pre_';
const IMAGE_ROLL_HASH_RE = /^[0-9a-f]{12}$/;

/**
 * Страховка ли это обновления образа ЭТОГО продукта. Форма точная, без масок
 * и префиксов: у `shop` нет права споткнуться о `shop-2__pre_…` или
 * `shop2__pre_…` (подчёркивания в слаге не бывает) и о `shop__pre_` с хвостом
 * не из 12 строчных шестнадцатеричных знаков. Спрашивают двое: смена ключей
 * (не начинать посреди обновления) и стирание (purge.ts — снять страховки
 * вместе с продуктом). Здесь, а не в purge.ts: тот и так берёт отсюда
 * REKEY_BACKUP_SUFFIX, а обратный импорт замкнул бы модули в кольцо.
 */
export function isImageRollBackup(slug: string, name: string): boolean {
  const prefix = `${slug}${IMAGE_ROLL_BACKUP}`;
  return name.startsWith(prefix) && IMAGE_ROLL_HASH_RE.test(name.slice(prefix.length));
}

/** Пауза перед повторным взглядом — как `sleep 3` в do_restore. См. ProvisionDeps.settleMs. */
const SETTLE_MS = 3_000;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STABLE_TAG_RE = /^linkeon-product:src-[0-9a-f]{12}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * /health изнутри контейнера. Правило — checkHealth раннера (deploy.ts): 2xx,
 * не text/html, в теле нет HTML. И СТРОЖЕ него, как probe заведения
 * (provision.ts): JSON с непустым sha обязателен. checkHealth требует sha
 * только когда есть с чем сверить; здесь сверять не с чем, но 2xx без sha —
 * не ответ продукта, и здоровьем не считается. Выход 0 — здоров.
 * Без регэкспов с обратными слэшами: строка уходит в argv как есть.
 * Экспорт — ради теста самого правила (rekey.spec.ts): симулятор хоста
 * скрипт только компилирует.
 */
export const HEALTH_INSIDE =
  `fetch('http://127.0.0.1:${CONTAINER_PORT}/health',{redirect:'manual',signal:AbortSignal.timeout(${DEFAULTS.probeTimeoutMs})})` +
  ".then(async(r)=>{const ct=(r.headers.get('content-type')||'').toLowerCase();const b=await r.text();" +
  'let sha;try{sha=JSON.parse(b).sha}catch(e){}' +
  "const html=ct.includes('text/html')||/<!doctype html|<html/i.test(b);" +
  "process.exit(r.status>=200&&r.status<300&&!html&&typeof sha==='string'&&sha.length>0?0:1)})" +
  '.catch(()=>process.exit(1))';

/** Ожидание /health изнутри — по умолчанию для ProvisionDeps.waitInside. Срок 0 — одна проба. */
export function waitInsideVia(deps: ProvisionDeps): (slug: string, timeoutMs: number) => Promise<boolean> {
  return async (slug, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await deps.run(['docker', 'exec', slug, 'node', '-e', HEALTH_INSIDE]);
        return true;
      } catch {
        // Ещё не поднялся или нездоров — спросим снова до срока.
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, DEFAULTS.probeEveryMs));
    }
  };
}

/**
 * Причина отказа программы без командной строки.
 *
 * execFile кладёт в message «Command failed: <argv через пробел>\n<stderr>»,
 * а hostDeps.run, сняв шаг по сроку, приписывает к этому свою приставку
 * («docker не уложился в N с и снят по сроку: Command failed: …»). Командная
 * строка вырезается ЦЕЛИКОМ по известному argv, а не до первого перевода
 * строки: перевод строки бывает и внутри значения (приватный ключ PEM), и
 * обрезка по нему выдала бы остаток командной строки со всеми значениями за
 * ним. argv не сошёлся или не передан — после «Command failed:» не берётся
 * ничего: без stderr диагностика хуже, но значения наружу не идут. Без этой
 * приставки (наш собственный throw) — текст как есть.
 */
export function reasonOf(e: unknown, argv?: string[]): string {
  const m = String((e as { message?: unknown } | undefined)?.message ?? e ?? '');
  const at = m.indexOf('Command failed:');
  if (at < 0) return clip(m);
  const cmd = argv ? `Command failed: ${argv.join(' ')}` : undefined;
  const stderr = cmd !== undefined && m.startsWith(cmd, at) ? m.slice(at + cmd.length).trim() : '';
  const head = m.slice(0, at).trim().replace(/:$/, '');
  return clip([head, stderr].filter(Boolean).join(': '));
}

function clip(text: string): string {
  const t = text.trim();
  return t ? t.slice(0, 300) : 'без причины';
}

const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** `docker inspect` именно контейнера (см. шапку: «Почему JSON»). */
function containerInspect(name: string): string[] {
  return ['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', name];
}

/**
 * inspect с разбором JSON. `what` — что читали, словами: «контейнер shop»,
 * «образ sha256:…». Вывод в текст отказа не идёт: в нём окружение с ключами.
 */
async function inspectJson(deps: ProvisionDeps, argv: string[], what: string): Promise<any> {
  let out: string;
  try {
    out = await deps.run(argv);
  } catch (e) {
    throw new Error(`не прочитать ${what}: ${reasonOf(e, argv)}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`не прочитать ${what}: docker inspect ответил не JSON`);
  }
}

/** То же до первого изменения: отказ называет, что хост не тронут. */
async function inspectBefore(deps: ProvisionDeps, argv: string[], what: string): Promise<any> {
  try {
    return await inspectJson(deps, argv, what);
  } catch (e) {
    throw new Error(`${(e as Error).message} — ничего не тронуто`);
  }
}

/**
 * Страховка обновления образа этого продукта на хосте — первая по имени — или
 * undefined. `-a`: страховка обычно погашена (обновление гасит старый
 * контейнер и переименовывает его). Хеша смена ключей не знает, поэтому —
 * перечень имён и сверка каждого (тот же приём, что у стирания, purge.ts).
 */
async function imageRollBackupOf(slug: string, deps: ProvisionDeps): Promise<string | undefined> {
  const ps = ['docker', 'ps', '-a', '--format', '{{.Names}}'];
  let out: string;
  try {
    out = await deps.run(ps);
  } catch (e) {
    throw new Error(`перечень контейнеров не прочитан (${reasonOf(e, ps)}) — ничего не тронуто`);
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => isImageRollBackup(slug, name))
    .sort()[0];
}

/** Запущен и не в петле перезапусков (у docker Restarting идёт вместе с Running=true). */
function upAndSteady(c: any): boolean {
  return c?.State?.Running === true && c?.State?.Restarting !== true;
}

function statusOf(c: any): string {
  return String(c?.State?.Status ?? 'состояние неизвестно').slice(0, 40);
}

function envName(entry: string): string {
  const i = entry.indexOf('=');
  return i >= 0 ? entry.slice(0, i) : entry;
}

function validateDropNames(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('dropNames — не список');
  for (const n of raw) {
    if (typeof n !== 'string' || !ENV_NAME_RE.test(n)) throw new Error(`имя снимаемого ключа не годится: ${JSON.stringify(n)}`);
    // Сервер шлёт только имена ключей владельца. Переменная платформы здесь —
    // поломка на сервере, а снять её значило бы остаться без раннера.
    if (isReservedEnvName(n)) throw new Error(`снимать переменную платформы нельзя: ${n}`);
  }
  return raw as string[];
}

/** Что снято с живого контейнера ДО любого разрушения. */
export interface Captured {
  /** Чем запускать новый: метка `linkeon-product:` того же образа. */
  imageRef: string;
  /** Идентификатор образа старого контейнера — с ним сверяется новый. */
  imageId: string;
  ownEnv: string[];
  publish: string[];
  mounts: string[];
  /** Значение `--restart` или пустая строка (политики нет). */
  restart: string;
  memory: number;
  nanoCpus: number;
  /** Порт хоста для /health сайта. */
  port?: number;
}

function nonNegativeInt(value: unknown, what: string): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} контейнера не разобран — ничего не тронуто`);
  return n;
}

/**
 * Снять настройки с живого контейнера. Только чтение; любой отказ — до
 * изменений на хосте. Экспорт — ради теста по рукописному inspect.
 */
export async function capture(job: RekeyJob, deps: ProvisionDeps): Promise<Captured> {
  const c = await inspectBefore(deps, containerInspect(job.slug), `контейнер ${job.slug}`);
  if (c?.State?.Running !== true) {
    throw new Error(`контейнер ${job.slug} не запущен (спит или прервана прошлая смена ключей) — ничего не тронуто`);
  }
  const net = c?.HostConfig?.NetworkMode;
  if (net !== 'bridge' && net !== 'default') throw new Error(`сеть контейнера ${JSON.stringify(net)} воспроизвести не умею — ничего не тронуто`);
  if (c?.HostConfig?.Privileged === true) throw new Error('контейнер privileged — воспроизвести не умею, ничего не тронуто');

  const imageId = String(c?.Image ?? '');
  const configImage = String(c?.Config?.Image ?? '');
  if (!imageId) throw new Error(`у контейнера ${job.slug} нет образа — ничего не тронуто`);
  const img = await inspectBefore(deps, ['docker', 'image', 'inspect', '--format', '{{json .}}', imageId], `образ ${imageId}`);

  let imageRef: string | undefined;
  // Своя метка годится, только пока указывает на образ контейнера. Идентификатор
  // и чужая метка не годятся вовсе: запуск по ним выбросил бы продукт из
  // отбора обновления образа (см. шапку).
  if (configImage.startsWith('linkeon-product:')) {
    try {
      const byTag = await inspectJson(deps, ['docker', 'image', 'inspect', '--format', '{{json .}}', configImage], `метку ${configImage}`);
      if (byTag?.Id === imageId) imageRef = configImage;
    } catch {
      // Метки больше нет — ищем стабильную ниже.
    }
  }
  if (!imageRef) {
    const tags: unknown[] = Array.isArray(img?.RepoTags) ? img.RepoTags : [];
    imageRef = tags.find((t): t is string => typeof t === 'string' && STABLE_TAG_RE.test(t));
  }
  if (!imageRef) {
    throw new Error(
      `образ контейнера ${job.slug} больше не помечен — смена ключей сменила бы и раннер; ` +
        'ключи сменятся после обновления образа (product-image-roll.sh), ничего не тронуто',
    );
  }

  // Свои переменные = контейнерные МИНУС пришедшие из ТОГО образа, с которого
  // контейнер запущен: вернуть переменные образа флагом -e значило бы
  // законсервировать старое значение по умолчанию (довод product-image-roll.sh).
  const imageEnv = new Set<string>(Array.isArray(img?.Config?.Env) ? img.Config.Env : []);
  const env: unknown[] = Array.isArray(c?.Config?.Env) ? c.Config.Env : [];
  const ownEnv: string[] = [];
  for (const e of env) {
    if (typeof e === 'string' && imageEnv.has(e)) continue;
    // `-e ИМЯ` без `=` docker дополнил бы значением из окружения АГЕНТА —
    // такую запись воспроизводить нельзя ни в каком виде.
    if (typeof e !== 'string' || !ENV_NAME_RE.test(envName(e)) || e.indexOf('=') < 1) {
      throw new Error(`переменную окружения ${job.slug} воспроизвести не умею — ничего не тронуто`);
    }
    ownEnv.push(e);
  }
  const filled = (name: string) => ownEnv.some((e) => envName(e) === name && e.length > name.length + 1);
  if (!filled('RUNNER_TOKEN') || !filled('LINKEON_URL')) {
    throw new Error(`в окружении ${job.slug} нет RUNNER_TOKEN или LINKEON_URL — пересоздание потеряло бы раннер, ничего не тронуто`);
  }

  const publish: string[] = [];
  let port: number | undefined;
  for (const [key, binds] of Object.entries(c?.HostConfig?.PortBindings ?? {})) {
    const m = /^(\d+)\/tcp$/.exec(key);
    if (!m || !Array.isArray(binds)) throw new Error(`публикацию ${key} воспроизвести не умею — ничего не тронуто`);
    for (const b of binds as any[]) {
      const hostPort = String(b?.HostPort ?? '');
      const hostIp = String(b?.HostIp ?? '');
      // Форма заведения — `IP:ПОРТ:ПОРТ` (provision.ts, dockerRunArgv). IPv6
      // в этой форме docker без скобок не разберёт, а угадывать — значит
      // опубликовать продукт не туда.
      if (!/^\d+$/.test(hostPort) || (hostIp !== '' && !IPV4_RE.test(hostIp))) {
        throw new Error(`публикацию ${key} воспроизвести не умею — ничего не тронуто`);
      }
      publish.push(`${hostIp ? `${hostIp}:` : ''}${hostPort}:${m[1]}`);
      if (Number(m[1]) === CONTAINER_PORT) port = Number(hostPort);
    }
  }

  const mounts: string[] = [];
  for (const m of Array.isArray(c?.Mounts) ? c.Mounts : []) {
    if (m?.Type !== 'bind' || typeof m?.Source !== 'string' || typeof m?.Destination !== 'string' || !m.Source || !m.Destination) {
      throw new Error('монтирование не bind — воспроизвести не умею, ничего не тронуто');
    }
    // `-v` режет по двоеточию: путь с ним уехал бы в docker run другим
    // монтированием — и всплыл бы отказом уже ПОСЛЕ остановки старого.
    if (m.Source.includes(':') || m.Destination.includes(':')) {
      throw new Error('монтирование с «:» в пути воспроизвести не умею — ничего не тронуто');
    }
    mounts.push(`${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  }

  const policy = String(c?.HostConfig?.RestartPolicy?.Name ?? '');
  const retries = nonNegativeInt(c?.HostConfig?.RestartPolicy?.MaximumRetryCount, 'MaximumRetryCount');
  const restart = policy === '' || policy === 'no' ? '' : policy === 'on-failure' && retries > 0 ? `on-failure:${retries}` : policy;

  return {
    imageRef,
    imageId,
    ownEnv,
    publish,
    mounts,
    restart,
    memory: nonNegativeInt(c?.HostConfig?.Memory, 'лимит памяти'),
    nanoCpus: nonNegativeInt(c?.HostConfig?.NanoCpus, 'лимит CPU'),
    port,
  };
}

/**
 * Окружение нового контейнера: свои переменные без заменяемых имён + новый
 * набор. owner: строка — поставить OWNER_TG_ID; null — снять (владелец
 * отвязал Telegram); undefined — не трогать.
 */
export function rekeyEnv(
  ownEnv: string[],
  secrets: Array<[string, string]>,
  dropNames: string[],
  owner?: string | null,
): string[] {
  const replaced = new Set<string>([...dropNames, ...secrets.map(([k]) => k)]);
  if (owner !== undefined) replaced.add('OWNER_TG_ID');
  const kept = ownEnv.filter((e) => !replaced.has(envName(e)));
  const added = secrets.map(([k, v]) => `${k}=${v}`);
  return typeof owner === 'string' ? [...kept, ...added, `OWNER_TG_ID=${owner}`] : [...kept, ...added];
}

/**
 * Байты HostConfig.Memory → `--memory=1g`, ровно форма заведения. Не делится
 * на единицу нацело — байтами: docker примет и так, а округление молча
 * поменяло бы потолок.
 */
function memoryFlag(bytes: number): string {
  for (const [unit, size] of [['g', 1024 ** 3], ['m', 1024 ** 2], ['k', 1024]] as const) {
    if (bytes % size === 0) return `--memory=${bytes / size}${unit}`;
  }
  return `--memory=${bytes}`;
}

/** argv нового `docker run` — в формах заведения. Экспорт — ради теста по рукописному inspect. */
export function runArgv(slug: string, cap: Captured, env: string[]): string[] {
  const argv = ['docker', 'run', '-d', '--name', slug];
  if (cap.restart) argv.push('--restart', cap.restart);
  for (const m of cap.mounts) argv.push('-v', m);
  for (const p of cap.publish) argv.push('-p', p);
  for (const e of env) argv.push('-e', e);
  if (cap.memory > 0) argv.push(memoryFlag(cap.memory));
  // Точное число (1e9 → `--cpus=1`, как у заведения), а не `%.3f`
  // product-image-roll.sh: округление молча поменяло бы лимит.
  if (cap.nanoCpus > 0) argv.push(`--cpus=${cap.nanoCpus / 1e9}`);
  argv.push(cap.imageRef);
  return argv;
}

/**
 * Вернуть старый контейнер в работу — по состоянию хоста (см. шапку).
 * Пустой список — продукт снова со старыми ключами и держится запущенным.
 */
async function restore(slug: string, backup: string, deps: ProvisionDeps): Promise<string[]> {
  let renamed: boolean;
  try {
    renamed = await containerTaken(deps, backup);
  } catch (e) {
    return [`не узнать, где старый контейнер (${reasonOf(e)}); он под именем ${slug} или ${backup}`];
  }
  if (renamed) {
    // Под именем продукта — новый контейнер или никого: старый уже под
    // резервным именем.
    const rmNew = ['docker', 'rm', '-f', slug];
    try {
      if (await containerTaken(deps, slug)) await deps.run(rmNew);
    } catch (e) {
      return [`новый контейнер ${slug} не снят (${reasonOf(e, rmNew)}); старый лежит под именем ${backup}`];
    }
    const back = ['docker', 'rename', backup, slug];
    try {
      await deps.run(back);
    } catch (e) {
      return [`старый контейнер не вернул имя и лежит под ${backup} (${reasonOf(e, back)})`];
    }
  }
  const start = ['docker', 'start', slug];
  try {
    await deps.run(start);
  } catch (e) {
    return [`старый контейнер ${slug} не поднялся (${reasonOf(e, start)})`];
  }
  // Пауза и состояние, как do_restore; без полного ожидания /health — срок
  // смены ограничен, а «не удержался» и так отдаёт исход на ручной разбор.
  await pause(deps.settleMs ?? SETTLE_MS);
  try {
    const c = await inspectJson(deps, containerInspect(slug), `старый контейнер ${slug}`);
    if (!upAndSteady(c)) return [`старый контейнер не поднялся после отката: ${slug} — ${statusOf(c)}`];
  } catch (e) {
    return [`старый контейнер не поднялся после отката: ${reasonOf(e)}`];
  }
  return [];
}

/**
 * Поднять новый контейнер и убедиться, что он тот и здоров. undefined — да;
 * строка — причина отката.
 */
async function startNew(job: RekeyJob, cap: Captured, argv: string[], deps: ProvisionDeps): Promise<string | undefined> {
  try {
    await deps.run(argv);
  } catch (e) {
    return `docker run с новыми ключами отказал: ${reasonOf(e, argv)}`;
  }
  const timeoutMs = deps.waitPortTimeoutMs ?? DEFAULTS.waitPortTimeoutMs;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const inside = deps.waitInside ?? waitInsideVia(deps);
  const what = `новый контейнер ${job.slug}`;
  try {
    // Тот ли образ: метку могли передвинуть между inspect и запуском.
    const fresh = await inspectJson(deps, containerInspect(job.slug), what);
    if (String(fresh?.Image ?? '') !== cap.imageId) {
      return `новый контейнер поднят не на образе старого: метку ${cap.imageRef} передвинули на ходу`;
    }
    const sec = Math.round(timeoutMs / 1000);
    if (!(await inside(job.slug, timeoutMs))) return `продукт не ответил на /health за ${sec} с с новыми ключами`;
    if (job.kind === 'site' && !(await deps.waitPort(cap.port as number, timeoutMs))) {
      return `сайт не ответил на порту ${cap.port} за ${sec} с с новыми ключами`;
    }
    // Второй взгляд — через паузу и одной пробой (см. шапку: «Здоровье»).
    await pause(settleMs);
    const later = await inspectJson(deps, containerInspect(job.slug), what);
    const again =
      upAndSteady(later) &&
      (await inside(job.slug, 0)) &&
      (job.kind !== 'site' || (await deps.waitPort(cap.port as number, 0)));
    if (!again) {
      return `продукт ответил на /health, а через ${Math.round(settleMs / 1000)} с — нет (${statusOf(later)})`;
    }
  } catch (e) {
    return `проверка нового контейнера отказала: ${reasonOf(e)}`;
  }
  return undefined;
}

/** Сменить ключи владельца. Бросает на любом отказе; до `docker stop` — без изменений на хосте. */
export async function rekeyProduct(job: RekeyJob, deps: ProvisionDeps): Promise<void> {
  const phase = deps.onPhase ?? (() => {});

  // --- Всё, что может отказать, — до первого изменения на хосте. ---
  if (!SLUG_RE.test(job.slug)) throw new Error(`слаг не годится: ${JSON.stringify(job.slug)}`);
  if (job.kind !== 'site' && job.kind !== 'bot') throw new Error(`неизвестная форма продукта: ${JSON.stringify(job.kind)}`);
  const secrets = validateSecrets(job.secrets);
  if (job.kind === 'bot' && !secrets.some(([k]) => k === 'BOT_TOKEN')) {
    throw new Error('в новом наборе нет BOT_TOKEN — бот остался бы без токена, ничего не тронуто');
  }
  const dropNames = validateDropNames(job.dropNames);
  // Пустая строка у бота — «снять OWNER_TG_ID». Своя ветка ДО ownerTgIdFor:
  // тот читает '' как «нет поля» (заведению снимать нечего), а здесь это
  // разные вещи — снять и не трогать.
  const owner = job.kind === 'bot' && job.ownerTgId === '' ? null : ownerTgIdFor(job);
  const backup = `${job.slug}${REKEY_BACKUP_SUFFIX}`;
  if (await containerTaken(deps, backup)) {
    throw new Error(`на хосте остался ${backup} от прерванной смены ключей — сверить руками, ничего не тронуто`);
  }
  // Обновление образа переименовывает продукт в страховку, поднимает новый
  // <слаг> и снимает страховку только после успеха, а занятость продукта
  // спрашивает один раз — до `docker stop`. Смена ключей посреди захода
  // сняла бы настройки со свежего контейнера, а её откат полез бы в чужое
  // пересоздание. Страховка на хосте — обновление идёт или оборвалось: ждать
  // его, а не соревноваться. Текст — без признаков REKEY_UNKNOWN_RE сервера:
  // хост не тронут, продукт на прежних ключах, повтор после обновления
  // пройдёт (rekey_failed, «попробуйте через несколько минут»).
  const roll = await imageRollBackupOf(job.slug, deps);
  if (roll !== undefined) {
    throw new Error(`на хосте есть ${roll} — идёт или оборвалось обновление образа; сменить ключи после него, ничего не тронуто`);
  }
  const cap = await capture(job, deps);
  if (job.kind === 'site' && cap.port === undefined) {
    throw new Error(`у сайта ${job.slug} нет опубликованного порта — проверить здоровье нечем, ничего не тронуто`);
  }
  const argv = runArgv(job.slug, cap, rekeyEnv(cap.ownEnv, secrets, dropNames, owner));

  // --- Дальше — разрушающая часть: любой отказ кончается откатом. ---
  const failed = async (reason: string): Promise<Error> => {
    const left = await restore(job.slug, backup, deps);
    if (left.length) phase(`ВНИМАНИЕ, откат смены ключей ${job.slug} не удался: ${left.join('; ')}`);
    else phase(`смена ключей ${job.slug} отменена, продукт со старыми ключами: ${reason}`);
    const err = new Error(
      `ключи не применены: ${reason}; ` + (left.length ? 'откат не удался' : 'продукт возвращён со старыми ключами'),
    );
    if (left.length) (err as Error & { leftovers?: string[] }).leftovers = left;
    return err;
  };

  const stop = ['docker', 'stop', job.slug];
  try {
    await deps.run(stop);
  } catch (e) {
    throw await failed(`docker stop отказал: ${reasonOf(e, stop)}`);
  }
  const rename = ['docker', 'rename', job.slug, backup];
  try {
    await deps.run(rename);
  } catch (e) {
    throw await failed(`docker rename отказал: ${reasonOf(e, rename)}`);
  }

  const unhealthy = await startNew(job, cap, argv, deps);
  if (unhealthy !== undefined) throw await failed(unhealthy);

  phase(`ключи ${job.slug} сменены`);
  const rmOld = ['docker', 'rm', '-f', backup];
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.run(rmOld);
      return;
    } catch (e) {
      if (attempt < 2) {
        await pause(deps.settleMs ?? SETTLE_MS);
        continue;
      }
      // Ключи уже новые, отказывать поздно: отчёт об успехе — правда. Но в
      // старом контейнере лежат СТАРЫЕ ключи, и следующая смена откажет на нём
      // (остаток прерванной смены). Поля для заметки в отчёте об успехе нет
      // (JobReport `{ ok: true, port? }`), поэтому — громкая фаза в журнал.
      phase(
        `ВНИМАНИЕ: ключи ${job.slug} сменены, но старый контейнер ${backup} со старыми ключами не убран ` +
          `(${reasonOf(e, rmOld)}) — убрать руками: пока он есть, следующая смена ключей откажет`,
      );
      return;
    }
  }
}
