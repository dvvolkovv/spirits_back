/**
 * Командная строка product-vhost — одна на все места вызова (заведение, сон,
 * пробуждение, задание domain). Разъехавшись, они потеряли бы свой домен
 * ровно в том месте, где забыли дописать имена: первый же сон переписал бы
 * конфиг без них.
 *
 * Имена проверяются ЗДЕСЬ, хотя сервер их уже нормализовал: сервер и агент
 * выкатываются порознь, а платит за мусор эта машина. Шелла в цепочке нет
 * (execFile), но product-vhost кладёт имя в `server_name`, и битое имя роняет
 * `nginx -t` для ВСЕХ продуктов хоста — ни один больше не перечитается.
 */

/**
 * Потолок длины имени. Замерено 24.09.2026 на nginx 1.24 машин продуктов:
 * при корзине server_names_hash_bucket_size 64 имя от 47 знаков роняет
 * `nginx -t` всей машины; PHASE 4 ставит 128 (потолок 110). Та же граница —
 * в normalizeDomain на сервере и в самом product-vhost.
 */
export const MAX_DOMAIN_LENGTH = 100;

/** Имя домена: метки [a-z0-9-] без дефиса по краям, минимум две. Та же форма разбирается в product-vhost. */
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function assertDomainName(name: string): void {
  if (typeof name !== 'string' || name.length > MAX_DOMAIN_LENGTH || !DOMAIN_RE.test(name)) {
    throw new Error(`имя домена не годится для конфига nginx: ${JSON.stringify(name)}`);
  }
}

/**
 * argv вызова product-vhost: `<bin> <slug> <порт|--asleep> [--domain <имя>]…`.
 *
 * Имена проверяются ВСЕ до возврата: один мусорный элемент — отказ всей
 * строки, а не пропуск имени. Пропуск молча выпустил бы конфиг без домена с
 * тем же зелёным отчётом.
 */
export function vhostArgv(bin: string, slug: string, target: number | '--asleep', names: string[] = []): string[] {
  const argv = [bin, slug, String(target)];
  for (const name of names) {
    assertDomainName(name);
    argv.push('--domain', name);
  }
  return argv;
}
