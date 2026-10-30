import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { STALE_GENERATION_MS, StuckGenerationGuard, realtimeOf, type RealtimeInternals } from './stuck-generation.js';

/** Подставная сессия плагина: ровно те поля, которыми пользуется сторож. */
function fakeRt(gen?: RealtimeInternals['currentGeneration']) {
  const rt = {
    currentGeneration: gen,
    closed: [] as string[],
    closeCurrentGeneration(reason?: string) {
      this.closed.push(reason ?? '');
      this.currentGeneration = undefined;
    },
  };
  return rt;
}

function guardOf(rt: ReturnType<typeof fakeRt> | undefined) {
  const lines: string[] = [];
  const guard = new StuckGenerationGuard(() => rt, STALE_GENERATION_MS, (l) => lines.push(l));
  return { guard, lines };
}

test('ответа нет — делать нечего', () => {
  const { guard } = guardOf(fakeRt());
  assert.equal(guard.check(1_000_000), 'none');
});

test('свежий ответ не трогаем', () => {
  // Длинную реплику обрывать нельзя: сторож лечит зависание, а не болтливость.
  const rt = fakeRt({ _createdTimestamp: 1_000_000 });
  const { guard } = guardOf(rt);
  assert.equal(guard.check(1_000_000 + STALE_GENERATION_MS - 1), 'fresh');
  assert.deepEqual(rt.closed, []);
});

test('ответ без response.done дольше порога закрываем — иначе переоткрытие сокета ждёт его вечно', () => {
  // Встречи 20.10 и 27.10.2026: плагин на двадцатой минуте ждал конца ответа,
  // которого не было, и ассистент оглох до конца встречи.
  const rt = fakeRt({ _createdTimestamp: 1_000_000 });
  const { guard, lines } = guardOf(rt);
  assert.equal(guard.check(1_000_000 + STALE_GENERATION_MS), 'closed');
  assert.equal(rt.closed.length, 1);
  assert.match(lines.join('\n'), /ответ висит \d+с без response\.done — закрываю/);
});

test('отброшенный ответ — не наш случай, плагин разбирается с ним сам', () => {
  const rt = fakeRt({ discarded: true });
  const { guard } = guardOf(rt);
  assert.equal(guard.check(Number.MAX_SAFE_INTEGER), 'none');
  assert.deepEqual(rt.closed, []);
});

test('сессии плагина не видно — сторож не падает и говорит об этом один раз', () => {
  const { guard, lines } = guardOf(undefined);
  assert.equal(guard.check(1), 'unavailable');
  assert.equal(guard.check(2), 'unavailable');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /сторож ответа выключен/);
});

test('realtimeOf: достаёт сессию плагина через _activity', () => {
  const rt = fakeRt();
  assert.equal(realtimeOf({ _activity: { realtimeSession: rt } }), rt);
});

test('realtimeOf: чужая форма — undefined, а не исключение', () => {
  assert.equal(realtimeOf({}), undefined);
  assert.equal(realtimeOf({ _activity: { realtimeSession: {} } }), undefined);
  assert.equal(realtimeOf(null), undefined);
});

/**
 * Дальше — проверки не нашего кода, а установленного SDK.
 *
 * Сторож держится на внутренностях плагина: поле currentGeneration, метод
 * closeCurrentGeneration и метка _createdTimestamp. При обновлении любое из них
 * может исчезнуть молча — тогда сторож просто перестанет срабатывать, и
 * встреча снова оглохнет на двадцатой минуте. Падаем раньше.
 */
const req = createRequire(import.meta.url);
const pluginSrc = (): string =>
  readFileSync(join(dirname(req.resolve('@livekit/agents-plugin-openai')), 'realtime', 'realtime_model.js'), 'utf8');
const agentsSrc = (file: string): string =>
  readFileSync(join(dirname(req.resolve('@livekit/agents')), 'voice', file), 'utf8');

test('SDK: переоткрытие сокета ждёт конца текущего ответа без срока — причина сторожа', () => {
  // Исчезнет эта строка — возможно, плагин починили сами, и сторож лишний.
  assert.match(pluginSrc(), /await currentGeneration\._doneFut\.await;/);
});

test('SDK: closeCurrentGeneration завершает ожидание', () => {
  assert.match(
    pluginSrc(),
    /closeCurrentGeneration\(reason[^)]*\) \{[\s\S]*?this\.currentGeneration\._doneFut\.resolve\(\);/,
  );
});

test('SDK: у ответа есть метка создания', () => {
  assert.match(pluginSrc(), /_createdTimestamp: Date\.now\(\)/);
});

test('SDK: сессия плагина доступна через session._activity.realtimeSession', () => {
  assert.match(agentsSrc('agent_session.js'), /get _activity\(\)/);
  assert.match(agentsSrc('agent_activity.js'), /this\.realtimeSession = /);
});
