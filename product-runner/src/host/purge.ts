/**
 * СТИРАНИЕ УДАЛЁННОГО ПРОДУКТА — задание `purge` (очередь 2).
 *
 * Через 30 дней после удаления продукт стирается насовсем: vhost и сертификат
 * своего домена, контейнеры (сам продукт, остаток прерванной смены ключей,
 * страховки обновления образа), каталог `/srv/products/<слаг>` с чекаутом и
 * данными. Это единственное место агента, где каталог продукта удаляется
 * целиком, — поэтому путь собирается и сверяется здесь, своей проверкой, ДО
 * любого вызова: слаг приехал по сети, а платит за ошибку эта машина (довод
 * шапки provision.ts про `rm -rf`).
 *
 * ## Путь — по настоящей ФС, дважды
 *
 * Слаг — по SLUG_RE раннера (та же копия, что у заведения), каталог продуктов
 * — абсолютный и не ближе двух уровней к корню, путь — ровно
 * `<каталог>/<слаг>`. Этого мало: ссылка увела бы `rm` туда, куда смотрит.
 * Поэтому:
 *   - настоящий путь каталога продуктов (`realpath`) обязан совпасть с ним
 *     знак в знак. Нет его — отказ, а не «стирать нечего»: битая ссылка по
 *     дороге — не повод отчитаться о стёртом продукте. По хосту с каталогом
 *     продуктов-ссылкой стирание не идёт вовсе, и это намеренно;
 *   - сам каталог продукта — `lstat`, без перехода по ссылке: нет — повтор
 *     (стирать нечего); ссылка, даже битая, или не каталог — отказ и разбор
 *     руками; каталог — ещё и `realpath` знак в знак.
 * Сверка — первым делом (отказ до любых изменений) и ещё раз вплотную к
 * удалению, вместе с вопросом к docker, не смонтирован ли каталог в
 * какой-нибудь контейнер (`--filter volume=` — точный источник bind,
 * замерено на docker 29.8.0). Ссылки ВНУТРИ каталога (их может завести код
 * продукта: каталог смонтирован в контейнер на запись) `rm` удаляет как
 * ссылки и по ним не ходит — проверено на настоящей ФС в purge.spec.ts.
 *
 * ## Порядок: rm конфига → reload nginx → certbot → docker rm → каталог
 *
 * vhost первым: снятый контейнер возвращает порт в оборот (`freePort` смотрит
 * в `docker ps`), и живой vhost стёртого продукта отдал бы его домен чужому
 * продукту. Не снялся vhost — дальше не идём. Сертификат — после vhost
 * (конфиг, ссылающийся на удалённые файлы, уронил бы `nginx -t` всей машины —
 * довод шапки domain.ts) и до контейнеров. Каталог — последним: из-под
 * контейнера его не удаляют. Конфиг снимается у любой формы продукта, если
 * файл есть: сервер, приславший «бот» вместо «сайт», не должен оставить
 * живой vhost на освобождённом порту.
 *
 * ## Сертификат — только свой
 *
 * Имя `linkeon-<слаг>` — то, под которым задание domain выпускает сертификат
 * своего домена. Но имя — не доказательство: общий подстановочный сертификат
 * машины, названный по неосторожности `linkeon-<слово>`, где слово — годный
 * слаг, снёсся бы вместе с TLS всех продуктов. Поэтому перед `certbot delete`
 * — `certbot certificates`: подстановочное имя (`*`) в сертификате — отказ.
 * Свой домен его не содержит никогда: vhostArgv отвергает такие имена.
 *
 * ## Почему не product-vhost
 *
 * У скрипта нет режима удаления; файл конфига и перечитывание — ровно те, что
 * снимает подчистка заведения (cleanup в provision.ts).
 *
 * ## Контейнеры — по точным именам, снятие — по полному id
 *
 * Имя продукта, `<слаг>__rekey` (rekey.ts) и `<слаг>__pre_<12 hex>` —
 * страховки scripts/product-image-roll.sh (PRE_SUFFIX там — 12 знаков хеша
 * содержимого). Страховки снимаются не для красоты: найдя `<слаг>__pre_<хеш>`
 * без живого `<слаг>`, следующее обновление образа решит, что прошлый заход
 * оборвался, и ПОДНИМЕТ стёртый продукт. Хеша стирание не знает, поэтому
 * берёт перечень `{{.ID}} {{.Names}}` и сверяет каждое имя само, без масок и
 * префиксов: у `shop` нет права задеть `shop-2__rekey` или `shop2__pre_…`
 * (подчёркивания в слаге не бывает, так что эти формы чужими не совпадут).
 * Снимается найденное по ПОЛНОМУ id (`docker rm -f -v`): docker ищет ссылку
 * «полный id → имя → начало id», и имя из одних шестнадцатеричных знаков,
 * исчезнувшее между перечнем и rm, нашло бы соседа, чей id с него
 * начинается. `-v` — анонимные тома контейнера вместе с ним.
 *
 * ## Повтор безопасен
 *
 * Каждый шаг спрашивает, есть ли что снимать: повторная выдача (потерянный
 * отчёт) проходит, а не превращается в вечный отказ стирания.
 */
import { dirname, isAbsolute, resolve } from 'path';
import { DEFAULTS, ProvisionDeps, SLUG_RE } from './provision';
import { certName, condenseCertbot } from './domain';
import { REKEY_BACKUP_SUFFIX, reasonOf } from './rekey';
import { ProductKind } from './skeleton';

export interface PurgeJob {
  slug: string;
  kind: ProductKind;
}

/** Страховка product-image-roll.sh: `<имя>__pre_<CTX12>`. */
const IMAGE_ROLL_BACKUP = '__pre_';
const IMAGE_ROLL_HASH_RE = /^[0-9a-f]{12}$/;
const FULL_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Каталог продукта — или отказ. Чистая функция, проверки — до первого вызова:
 *   - слаг по SLUG_RE (нет `/`, `..`, пустоты, ведущего дефиса, заглавных,
 *     подчёркиваний);
 *   - каталог продуктов абсолютный и не ближе двух уровней к корню (`/` и
 *     `/srv` целиком — не «каталог продуктов»);
 *   - нормализованный путь лежит РОВНО на уровень ниже каталога продуктов и
 *     равен `<каталог>/<слаг>` — `resolve` снимает `..` и лишние слэши, и
 *     сверяется уже результат.
 * Ссылки здесь не видны — их сверяет checkedOnDisk.
 */
export function productDirFor(productsDir: string, slug: string): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new Error(`слаг не годится: ${JSON.stringify(slug)}`);
  if (typeof productsDir !== 'string' || !productsDir || !isAbsolute(productsDir)) {
    throw new Error(`каталог продуктов ${JSON.stringify(productsDir)} не абсолютный — стирать нечего`);
  }
  const root = resolve(productsDir);
  if (root.split('/').filter(Boolean).length < 2) {
    throw new Error(`каталог продуктов ${JSON.stringify(productsDir)} слишком близко к корню — стирать из него нельзя`);
  }
  const dir = resolve(root, slug);
  if (dir === root || dirname(dir) !== root || dir !== `${root}/${slug}`) {
    throw new Error(`путь ${dir} вне каталога продуктов ${root} — ничего не тронуто`);
  }
  return dir;
}

/** Код ошибки ФС (`EACCES`) — или общее слово. Сообщение fs несёт имена файлов продукта. */
function fsCode(e: unknown): string {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'ошибка ФС';
}

/**
 * Есть ли что стирать по собранному пути — и нет ли по дороге ссылки (см.
 * шапку). true — каталог на месте и сверен; false — его нет (повтор).
 * Остальное — отказ: «не знаю, что там» не равно «там пусто».
 */
async function checkedOnDisk(root: string, dir: string, deps: ProvisionDeps): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await deps.realpath(root);
  } catch (e) {
    throw new Error(`каталог продуктов ${root} не прочитан (${reasonOf(e)}) — стирать не берусь, каталог не тронут`);
  }
  if (realRoot !== root) {
    throw new Error(`каталог продуктов ${root} на деле ${realRoot} — по дороге ссылка, стирать не берусь, каталог не тронут`);
  }
  let kind: string;
  try {
    kind = await deps.pathKind(dir);
  } catch (e) {
    throw new Error(`${dir} не прочитан (${fsCode(e)}) — стирать не берусь, каталог не тронут`);
  }
  if (kind === 'absent') return false;
  if (kind === 'symlink') throw new Error(`${dir} — ссылка, а не каталог продукта: стирать не берусь, разобрать руками`);
  if (kind !== 'dir') throw new Error(`${dir} не каталог — стирать не берусь, разобрать руками`);
  let real: string;
  try {
    real = await deps.realpath(dir);
  } catch (e) {
    throw new Error(`настоящий путь ${dir} не прочитан (${fsCode(e)}) — каталог не тронут`);
  }
  if (real !== dir) throw new Error(`${dir} на деле ${real} — по дороге ссылка, стирать не берусь, каталог не тронут`);
  return true;
}

/**
 * Имена сертификата из вывода `certbot certificates` — только из блока с
 * ТОЧНО этим «Certificate Name». undefined — такого сертификата нет;
 * пустой список — блок есть, а имён в нём не прочитать (отказ у вызывающего).
 * Экспорт — ради теста разбора.
 */
export function certDomainsFrom(out: string, cert: string): string[] | undefined {
  let current: string | undefined;
  let found: string[] | undefined;
  for (const line of out.split('\n')) {
    const name = /^\s*Certificate Name:\s*(\S+)\s*$/.exec(line);
    if (name) {
      current = name[1];
      if (current === cert && found === undefined) found = [];
      continue;
    }
    const domains = /^\s*Domains:\s*(.*)$/.exec(line);
    if (domains && current === cert) found = domains[1].split(/\s+/).filter(Boolean);
  }
  return found;
}

/**
 * Контейнеры этого продукта из перечня `{{.ID}} {{.Names}}` — только точные
 * формы имён (см. шапку). Порядок: сам продукт, остаток смены ключей,
 * страховки образа.
 */
function productContainers(slug: string, listing: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> {
  const prefix = `${slug}${IMAGE_ROLL_BACKUP}`;
  const rank = (name: string): number => {
    if (name === slug) return 0;
    if (name === `${slug}${REKEY_BACKUP_SUFFIX}`) return 1;
    if (name.startsWith(prefix) && IMAGE_ROLL_HASH_RE.test(name.slice(prefix.length))) return 2;
    return -1;
  };
  return listing
    .filter((c) => rank(c.name) >= 0)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

const fullText = (e: any): string => `${e?.message ?? e ?? ''}\n${typeof e?.stdout === 'string' ? e.stdout : ''}`;

export async function purgeProduct(job: PurgeJob, deps: ProvisionDeps): Promise<void> {
  const phase = deps.onPhase ?? (() => {});

  // --- Всё, что может отказать, — до первого изменения на хосте. ---
  // Путь — первым делом: слаг не по форме не доходит ни до одного вызова.
  const dir = productDirFor(deps.productsDir ?? DEFAULTS.productsDir, job.slug);
  const root = dirname(dir);
  if (job.kind !== 'site' && job.kind !== 'bot') throw new Error(`неизвестная форма продукта: ${JSON.stringify(job.kind)}`);
  const nginxConfDir = deps.nginxConfDir ?? DEFAULTS.nginxConfDir;
  if (typeof nginxConfDir !== 'string' || !isAbsolute(nginxConfDir)) {
    throw new Error(`каталог конфигов nginx ${JSON.stringify(nginxConfDir)} не абсолютный — ничего не тронуто`);
  }
  // Имя файла — из проверенного слага, ровно то, что пишет product-vhost и
  // снимает подчистка заведения.
  const conf = `${resolve(nginxConfDir)}/${job.slug}.conf`;
  // Ссылка по дороге — отказ ДО vhost и контейнеров: продукт остаётся целым,
  // пока человек не разберётся, что лежит по этому пути.
  await checkedOnDisk(root, dir, deps);
  let hasVhost = job.kind === 'site';
  if (!hasVhost) {
    try {
      hasVhost = (await deps.pathKind(conf)) !== 'absent';
    } catch (e) {
      throw new Error(`конфиг nginx ${conf} не прочитан (${fsCode(e)}) — ничего не тронуто`);
    }
  }

  // --- vhost и сертификат. ---
  if (hasVhost) {
    const rmConf = ['rm', '-f', conf];
    try {
      await deps.run(rmConf);
    } catch (e) {
      throw new Error(
        `конфиг nginx продукта ${job.slug} не удалён (${reasonOf(e, rmConf)}) — vhost жив; сертификат, контейнер и каталог не тронуты`,
      );
    }
    const reload = ['systemctl', 'reload', 'nginx'];
    try {
      await deps.run(reload);
    } catch (e) {
      throw new Error(
        `конфиг nginx продукта ${job.slug} удалён, но nginx не перечитан (${reasonOf(e, reload)}) — ` +
          'домен ещё смотрит на порт; сертификат, контейнер и каталог не тронуты',
      );
    }
    phase(`vhost ${job.slug} снят`);

    const cert = certName(job.slug);
    const list = ['certbot', 'certificates', '--cert-name', cert];
    let out: string;
    try {
      out = await deps.run(list);
    } catch (e) {
      throw new Error(`certbot не показал сертификат ${cert}: ${condenseCertbot(e, 300)} — контейнер и каталог не тронуты`);
    }
    const domains = certDomainsFrom(out, cert);
    if (domains !== undefined) {
      if (!domains.length) throw new Error(`имена сертификата ${cert} не прочитаны — не удаляю его; контейнер и каталог не тронуты`);
      const wild = domains.filter((d) => d.includes('*'));
      if (wild.length) {
        throw new Error(
          `сертификат ${cert} подстановочный (${wild.slice(0, 3).join(' ')}) — общий, а не своего домена продукта: ` +
            'не удаляю, разобрать руками; контейнер и каталог не тронуты',
        );
      }
      try {
        await deps.run(['certbot', 'delete', '--cert-name', cert, '--non-interactive']);
      } catch (e: any) {
        if (!/No certificate found/i.test(fullText(e))) {
          throw new Error(`certbot не удалил сертификат ${cert}: ${condenseCertbot(e, 300)} — контейнер и каталог не тронуты`);
        }
      }
      phase(`сертификат ${cert} удалён`);
    }
  }

  // --- Контейнеры. ---
  const ps = ['docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}'];
  let listing: Array<{ id: string; name: string }>;
  try {
    const out = await deps.run(ps);
    listing = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(' ');
        const id = sp > 0 ? line.slice(0, sp) : '';
        if (!FULL_ID_RE.test(id)) throw new Error('docker ps ответил не «<полный id> <имя>»');
        return { id, name: line.slice(sp + 1).trim() };
      });
  } catch (e) {
    throw new Error(`перечень контейнеров не прочитан (${reasonOf(e, ps)}) — контейнеры и каталог не тронуты`);
  }
  for (const { id, name } of productContainers(job.slug, listing)) {
    const rm = ['docker', 'rm', '-f', '-v', id];
    try {
      await deps.run(rm);
    } catch (e) {
      // Исчез между перечнем и rm — снимать уже нечего (docker 29 на `-f`
      // отвечает 0 и сам; более старый — «No such container»).
      if (/No such container/i.test(fullText(e))) continue;
      throw new Error(`контейнер ${name} не снят (${reasonOf(e, rm)}) — каталог не тронут: из-под контейнера его не удаляют`);
    }
    phase(`контейнер ${name} снят`);
  }

  // --- Каталог: сверка вплотную к удалению. ---
  if (await checkedOnDisk(root, dir, deps)) {
    const mounted = ['docker', 'ps', '-a', '--filter', `volume=${dir}`, '--format', '{{.Names}}'];
    let holders: string[];
    try {
      holders = (await deps.run(mounted)).split('\n').map((line) => line.trim()).filter(Boolean);
    } catch (e) {
      throw new Error(`не узнать, смонтирован ли ${dir} в контейнер (${reasonOf(e, mounted)}) — каталог не тронут`);
    }
    if (holders.length) {
      throw new Error(
        `${dir} смонтирован в контейнер ${holders.slice(0, 3).join(', ')} — из-под контейнера каталог не удаляют, разобрать руками`,
      );
    }
    try {
      await deps.removeDir(dir);
    } catch (e) {
      // Сообщение fs называет файл внутри каталога — а это данные клиента.
      throw new Error(`каталог ${dir} удалён не целиком (${fsCode(e)}) — контейнеры уже сняты, повтор стирания доделает`);
    }
    phase(`каталог ${dir} удалён`);
  }
  phase(`продукт ${job.slug} стёрт`);
}
