import { RunnerConfig } from './config';
import { LinkeonApi, PollResult } from './api';
import { Git } from './git';
import { NDJsonEvent, runClaude as runClaudeReal } from './claude';
import { deploy as deployReal } from './deploy';

export interface ExecuteTurnInput {
  turn: NonNullable<PollResult['turn']>;
  product: PollResult['product'];
  config: RunnerConfig;
  git: Git;
  api: LinkeonApi;
  runClaude?: typeof runClaudeReal;
  deploy?: typeof deployReal;
}

/**
 * Выполняет один ход: обычный (прогон агента → коммит → деплой) или
 * служебный ход отката (сброс дерева на указанный sha без агента).
 */
export async function executeTurn(input: ExecuteTurnInput): Promise<void> {
  const { turn, product, git, api } = input;
  const runClaude = input.runClaude ?? runClaudeReal;
  const deploy = input.deploy ?? deployReal;

  // Чужие ручные правки коммитятся ДО снятия точки возврата: иначе sha_before
  // укажет на состояние без них, и откат их уничтожит.
  await git.commitPendingChanges();
  const shaBefore = await git.headSha();

  // Признак отката — отдельное поле, а не префикс промпта. Строковый контракт
  // между двумя репозиториями разъезжается молча, и его нечем охранять: тест
  // на стороне бэкенда не знает про парсер здесь, а тест здесь не знает про
  // формат там. Плюс prompt приходит от пользователя, и префикс внутри него
  // подделывался бы обычным запросом в чат.
  if (turn.revertToSha) {
    const target = turn.revertToSha;
    await api.sendEvents(turn.id, [{ type: 'begin' }, { type: 'item', content: `Возвращаю на ${target}` }]);
    await git.resetHard(target);
    await deploy({
      git,
      shaBefore: target,
      buildCmd: product.buildCmd,
      restartCmd: product.restartCmd,
      healthUrl: product.healthUrl,
      cwd: product.checkoutPath,
    });
    await api.sendEvents(turn.id, [{ type: 'end' }]);
    await api.complete(turn.id, { status: 'reverted', shaBefore: target });
    return;
  }

  let tokens = 0;
  const buffered: NDJsonEvent[] = [];
  const flush = async () => {
    const batch = buffered.splice(0, buffered.length);
    // Не смогли доставить — возвращаем в буфер и досылаем позже. Ход при этом
    // не прерывается: агент уже работает, обрывать его нельзя.
    if (!(await api.sendEvents(turn.id, batch))) buffered.unshift(...batch);
  };

  // Сборка и рестарт — самая долгая часть хода, и для сборщика зависших она
  // выглядит молчанием: события шлёт только claude, а он в этот момент уже
  // отработал. Ход, чья сборка идёт дольше получаса, снялся бы как мёртвый.
  // Поэтому фазы деплоя отчитываются сами — это и признак жизни, и то, что
  // клиент видит в чате вместо тишины.
  const outcome = await runClaude({
    claudeBin: input.config.claudeBin,
    cwd: product.checkoutPath,
    prompt: turn.prompt,
    sessionId: product.claudeSessionId,
    timeoutMs: input.config.turnTimeoutMs,
    onEvents: (events) => {
      for (const e of events) {
        if (e.type === 'end' && e.usage) tokens = e.usage.total;
      }
      buffered.push(...events);
      void flush();
    },
  });

  await flush();

  if (!outcome.ok) {
    await api.sendEvents(turn.id, [{ type: 'error', message: outcome.error ?? 'unknown' }]);
    await api.complete(turn.id, { status: 'failed', error: outcome.error, shaBefore, tokens });
    return;
  }

  const shaAfter = await git.commitAll(`linkeon: ${turn.prompt.slice(0, 60)}`);

  // Ход без единой правки — не успех. Коммита нет, sha не сдвинулся, собирать и
  // перезапускать нечего. Раньше такой ход закрывался «Готово» со списанием, и
  // клиент видел в истории выполненную работу, которой не было.
  if (shaAfter === shaBefore) {
    await api.complete(turn.id, {
      status: 'failed',
      error: 'агент не внёс изменений в код продукта',
      shaBefore,
      tokens,
    });
    return;
  }

  await git.push();

  await api.sendEvents(turn.id, [{ type: 'item', content: '\n\nСобираю и перезапускаю…' }]);

  const result = await deploy({
    git,
    shaBefore,
    buildCmd: product.buildCmd,
    restartCmd: product.restartCmd,
    healthUrl: product.healthUrl,
    cwd: product.checkoutPath,
    // Продукт обязан подтвердить, что поднялся ИМЕННО на этой правке.
    expectedSha: shaAfter,
    // Отчёт о фазах: без него сборка выглядит для сборщика зависших молчанием,
    // и ход длиннее получаса снимут как мёртвый — а он жив.
    onPhase: (phase) => void api.sendEvents(turn.id, [{ type: 'item', content: `\n${phase}` }]),
  });

  await api.complete(turn.id, {
    status: result.reverted ? 'reverted' : 'done',
    shaBefore,
    shaAfter: result.reverted ? undefined : shaAfter,
    tokens,
  });
}
