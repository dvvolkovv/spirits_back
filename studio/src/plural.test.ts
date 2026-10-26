import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantsLabel } from './plural';

test('форма слова — по категориям Intl.PluralRules', () => {
  assert.equal(assistantsLabel(1), '1 ассистент');
  assert.equal(assistantsLabel(3), '3 ассистента');
  assert.equal(assistantsLabel(5), '5 ассистентов');
  assert.equal(assistantsLabel(11), '11 ассистентов');
  assert.equal(assistantsLabel(18), '18 ассистентов');
  assert.equal(assistantsLabel(21), '21 ассистент');
  assert.equal(assistantsLabel(22), '22 ассистента');
});
