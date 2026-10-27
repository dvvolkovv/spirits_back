import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMO_OVERLAYS, hidePromoCss } from './promo';

test('баннер оффера кабинета скрывается стилем на время съёмки', () => {
  assert.ok(PROMO_OVERLAYS.includes('[data-testid="offer-banner"]'));
  assert.equal(hidePromoCss(), '[data-testid="offer-banner"]{display:none!important}');
});

test('несколько плашек — по правилу на каждую', () => {
  assert.equal(hidePromoCss(['.a', '#b']), '.a{display:none!important}\n#b{display:none!important}');
});
