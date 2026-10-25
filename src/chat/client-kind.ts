import type { ClientUi } from './client-ui';
import type { ProductToolClient } from '../products/product-tool.token';

/**
 * Сборка из App Store или Google Play — по заголовку x-linkeon-distribution,
 * который мобильное приложение шлёт в каждом запросе. Неизвестное или пустое
 * значение — НЕ магазин: так ведут себя веб и старые сборки, где оплата
 * разрешена. В магазинной сборке нельзя ни ссылок на оплату, ни баланса
 * (balance-context.service.ts: правило 3.1.1, отказы Apple).
 */
export function isStoreBuild(header: unknown): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const d = typeof raw === 'string' ? raw.toLowerCase() : '';
  return d === 'appstore' || d === 'play';
}

/**
 * Клиент хода — для справки (platform-kb). Веб и Capacitor-приложение (тот же
 * React) шлют поле ui; Flutter не шлёт ничего; сборка из стора — по заголовку.
 * Ходы Telegram сюда не попадают: там клиент — 'telegram' по месту.
 */
export function clientKind(storeBuild: boolean, ui: ClientUi): Exclude<ProductToolClient, 'telegram'> {
  if (storeBuild) return 'store';
  if (ui.activity || ui.ask) return 'web';
  return 'app';
}
