const fs = require('fs');
const path = require('path');

const deploy = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');

function section(startMarker, endMarker, from = 0) {
  const start = deploy.indexOf(startMarker, from);
  const end = deploy.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`section not found: ${startMarker}`);
  return deploy.slice(start, end);
}

describe('PHASE 4: репетиция образа перед боевым rollout', () => {
  const image = section('ensure_product_image() {', '\n# Наблюдение за ЖИВЫМ агентом');
  const checkOnlyAt = image.indexOf('if [[ -n "${PH_CHECK_ONLY:-}" ]]');
  const writeAt = image.indexOf('\n  else', checkOnlyAt);
  const write = image.slice(writeAt);

  it('после доставки исходников делает dry-run, rehearsal и только затем боевой roll', () => {
    const dry = write.indexOf('\n      DRY_RUN=1 SOURCE_SHA="$PH_PROD_SHA" bash "$roll" "$PH_TARGET"');
    const rehearsal = write.indexOf('\n      REHEARSE="$PRODUCT_IMAGE_REHEARSE" SOURCE_SHA="$PH_PROD_SHA" bash "$roll" "$PH_TARGET" || {');
    const actual = write.indexOf('\n    SOURCE_SHA="$PH_PROD_SHA" bash "$roll" "$PH_TARGET" || rc=$?');

    expect(checkOnlyAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(checkOnlyAt);
    expect(dry).toBeGreaterThan(-1);
    expect(rehearsal).toBeGreaterThan(dry);
    expect(actual).toBeGreaterThan(rehearsal);
  });

  it('красная репетиция прерывает машину до боевого roll', () => {
    const rehearsal = write.indexOf('\n      REHEARSE="$PRODUCT_IMAGE_REHEARSE" SOURCE_SHA="$PH_PROD_SHA" bash "$roll" "$PH_TARGET" || {');
    const close = write.indexOf('\n      }', rehearsal);
    const actual = write.indexOf('\n    SOURCE_SHA="$PH_PROD_SHA" bash "$roll" "$PH_TARGET" || rc=$?', close);
    const onFailure = write.slice(rehearsal, close);

    expect(rehearsal).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(rehearsal);
    expect(actual).toBeGreaterThan(close);
    expect(onFailure).toContain('Репетиция product image не прошла');
    expect(onFailure).toContain('return 1');
  });

  it('без PRODUCT_IMAGE_REHEARSE write-ветка безопасна при set -u', () => {
    const guard = write.indexOf('if [[ -n "${PRODUCT_IMAGE_REHEARSE:-}" ]]');
    const dry = write.indexOf('\n      DRY_RUN=1 SOURCE_SHA="$PH_PROD_SHA" bash "$roll" "$PH_TARGET"');

    expect(guard).toBeGreaterThan(-1);
    expect(dry).toBeGreaterThan(guard);
  });

  it('check-only остаётся read-only и не заводит rehearsal-контейнер', () => {
    expect(image.slice(0, writeAt)).not.toMatch(/\n\s*REHEARSE=/);
  });

  it('ensure_product_image вызывается только после успешного ensure_host_agent', () => {
    const one = section('products_host_one() {', '\nrun_products_host_phase() {');
    const agent = one.indexOf('elif ensure_host_agent; then');
    const imageAfterAgent = one.indexOf('ensure_product_image || fails=', agent);
    const imageCalls = one.split('ensure_product_image || fails=').length - 1;
    expect(agent).toBeGreaterThan(-1);
    expect(imageAfterAgent).toBeGreaterThan(agent);
    expect(imageCalls).toBe(1);
  });

  it('новый режим описан в шапке deploy.sh', () => {
    const header = deploy.slice(0, deploy.indexOf('set -uo pipefail'));
    expect(header).toContain('PRODUCT_IMAGE_REHEARSE=<имя>');
  });
});
