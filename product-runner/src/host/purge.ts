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
 * ## Путь — дважды и по настоящей ФС
 *
 * Слаг — по SLUG_RE раннера (та же копия, что у заведения), каталог продуктов
 * — абсолютный и не ближе двух уровней к корню, путь — ровно
 * `<каталог>/<слаг>`. Этого мало: ссылка на месте каталога продукта (или на
 * месте самого каталога продуктов) увела бы `rm` туда, куда она смотрит.
 * Поэтому настоящий путь (`realpath`) обязан совпасть с собранным знак в знак.
 * Не совпал — отказ и разбор руками; по хосту с каталогом продуктов-ссылкой
 * стирание не идёт вовсе, и это намеренно: такой хост — не тот, под который
 * писался этот код. Сверка — первым делом (отказ до любых изменений) и ещё раз
 * вплотную к удалению. Ссылки ВНУТРИ каталога (их может завести код продукта:
 * каталог смонтирован в контейнер на запись) `rm` удаляет как ссылки и по ним
 * не ходит — это проверено на настоящей ФС в purge.spec.ts.
 *
 * ## Порядок — как у подчистки заведения
 *
 * vhost первым: снятый контейнер возвращает порт в оборот (`freePort` смотрит
 * в `docker ps`), и живой vhost стёртого продукта отдал бы его домен чужому
 * продукту. Не снялся vhost — дальше не идём. Каталог — последним: из-под
 * контейнера его не удаляют.
 *
 * ## Почему не product-vhost
 *
 * У скрипта нет режима удаления; файл конфига и перечитывание — ровно те, что
 * снимает подчистка заведения (cleanup в provision.ts). Сертификат своего
 * домена — `certbot delete`, «сертификата нет» не отказ (повтор, бот, сайт без
 * своего домена).
 *
 * ## Контейнеры — по точным именам
 *
 * Имя продукта, `<слаг>__rekey` (rekey.ts) и `<слаг>__pre_<12 hex>` —
 * страховки scripts/product-image-roll.sh (PRE_SUFFIX там — 12 знаков хеша
 * содержимого). Страховки снимаются не для красоты: найдя `<слаг>__pre_<хеш>`
 * без живого `<слаг>`, следующее обновление образа решит, что прошлый заход
 * оборвался, и ПОДНИМЕТ стёртый продукт. Хеша стирание не знает, поэтому
 * спрашивает перечень имён и сверяет каждое само, без масок и префиксов: у
 * `shop` нет права задеть `shop-2__rekey` или `shop2__pre_…`. Подчёркивания в
 * слаге не бывает (SLUG_RE), так что эти формы не совпадут ни с одним чужим
 * продуктом.
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

/**
 * Каталог продукта — или отказ. Чистая функция, проверки — до первого вызова:
 *   - слаг по SLUG_RE (нет `/`, `..`, пустоты, ведущего дефиса, заглавных);
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

/**
 * Есть ли что стирать по собранному пути — и нет ли по дороге ссылки.
 * false — пути нет (ENOENT: повтор; битая ссылка тоже — по ней нечего
 * стирать и некуда уйти). Настоящий путь не совпал или не прочитался по
 * другой причине — отказ: «не знаю, что там» не равно «там пусто».
 */
async function checkedOnDisk(dir: string, deps: ProvisionDeps): Promise<boolean> {
  let real: string;
  try {
    real = await deps.realpath(dir);
  } catch (e) {
    if ((e as { code?: unknown } | undefined)?.code === 'ENOENT') return false;
    throw new Error(`настоящий путь ${dir} не прочитан (${reasonOf(e)}) — каталог не тронут`);
  }
  if (real !== dir) {
    throw new Error(`${dir} ведёт в ${real}: по дороге ссылка — стирать не берусь, каталог не тронут, разобрать руками`);
  }
  return true;
}

/**
 * Контейнеры этого продукта из перечня имён хоста — только точные формы (см.
 * шапку). Порядок: сам продукт, остаток смены ключей, страховки образа.
 * Экспорт — ради теста формы.
 */
export function productContainers(slug: string, names: string[]): string[] {
  const own = [slug, `${slug}${REKEY_BACKUP_SUFFIX}`].filter((n) => names.includes(n));
  const prefix = `${slug}${IMAGE_ROLL_BACKUP}`;
  const backups = names
    .filter((n) => n.startsWith(prefix) && IMAGE_ROLL_HASH_RE.test(n.slice(prefix.length)))
    .sort();
  return [...own, ...new Set(backups)];
}

const fullText = (e: any): string => `${e?.message ?? e ?? ''}\n${typeof e?.stdout === 'string' ? e.stdout : ''}`;

export async function purgeProduct(job: PurgeJob, deps: ProvisionDeps): Promise<void> {
  const phase = deps.onPhase ?? (() => {});

  // --- Всё, что может отказать, — до первого изменения на хосте. ---
  // Путь — первым делом: слаг не по форме не доходит ни до одного вызова.
  const dir = productDirFor(deps.productsDir ?? DEFAULTS.productsDir, job.slug);
  if (job.kind !== 'site' && job.kind !== 'bot') throw new Error(`неизвестная форма продукта: ${JSON.stringify(job.kind)}`);
  const nginxConfDir = deps.nginxConfDir ?? DEFAULTS.nginxConfDir;
  if (job.kind === 'site' && (typeof nginxConfDir !== 'string' || !isAbsolute(nginxConfDir))) {
    throw new Error(`каталог конфигов nginx ${JSON.stringify(nginxConfDir)} не абсолютный — ничего не тронуто`);
  }
  // Ссылка по дороге — отказ ДО vhost и контейнеров: продукт остаётся целым,
  // пока человек не разберётся, что лежит по этому пути.
  await checkedOnDisk(dir, deps);

  // --- vhost и сертификат (только у сайта). ---
  if (job.kind === 'site') {
    // Имя файла — из проверенного слага, ровно то, что пишет product-vhost
    // и снимает подчистка заведения.
    for (const argv of [['rm', '-f', `${resolve(nginxConfDir)}/${job.slug}.conf`], ['systemctl', 'reload', 'nginx']]) {
      try {
        await deps.run(argv);
      } catch (e) {
        throw new Error(
          `конфиг nginx продукта ${job.slug} не снят (${reasonOf(e, argv)}) — контейнер и каталог не тронуты: порт держит живой домен`,
        );
      }
    }
    phase(`vhost ${job.slug} снят`);
    const cert = certName(job.slug);
    try {
      await deps.run(['certbot', 'delete', '--cert-name', cert, '--non-interactive']);
    } catch (e: any) {
      if (!/No certificate found/i.test(fullText(e))) {
        throw new Error(`certbot не удалил сертификат ${cert}: ${condenseCertbot(e, 300)} — контейнер и каталог не тронуты`);
      }
    }
  }

  // --- Контейнеры. ---
  const list = ['docker', 'ps', '-a', '--format', '{{.Names}}'];
  let names: string[];
  try {
    names = (await deps.run(list)).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (e) {
    throw new Error(`перечень контейнеров не прочитан (${reasonOf(e, list)}) — контейнеры и каталог не тронуты`);
  }
  for (const name of productContainers(job.slug, names)) {
    const rm = ['docker', 'rm', '-f', name];
    try {
      await deps.run(rm);
    } catch (e) {
      // Исчез между перечнем и rm — снимать уже нечего.
      if (/No such container/i.test(fullText(e))) continue;
      throw new Error(`контейнер ${name} не снят (${reasonOf(e, rm)}) — каталог не тронут: из-под контейнера его не удаляют`);
    }
    phase(`контейнер ${name} снят`);
  }

  // --- Каталог: сверка вплотную к удалению. ---
  if (await checkedOnDisk(dir, deps)) {
    await deps.removeDir(dir);
    phase(`каталог ${dir} удалён`);
  }
  phase(`продукт ${job.slug} стёрт`);
}
