import { RunnerConfig } from './config';
import { LinkeonApi, PollResult } from './api';
import { Git } from './git';
import { NDJsonEvent, runClaude as runClaudeReal } from './claude';
import { deploy as deployReal, DeployInput } from './deploy';
import { freeProductPort as freeProductPortReal, PM2_RESTART_CMD } from './orphans';

export interface ExecuteTurnInput {
  turn: NonNullable<PollResult['turn']>;
  product: PollResult['product'];
  config: RunnerConfig;
  git: Git;
  api: LinkeonApi;
  runClaude?: typeof runClaudeReal;
  deploy?: typeof deployReal;
  freeProductPort?: typeof freeProductPortReal;
}

/**
 * Как поднимать продукт: общее для обычного хода и служебного отката.
 *
 * Продукт под pm2 (задан PRODUCT_START_SCRIPT) раннер умеет перезапустить сам и
 * знает, кто законно держит его порт. Отсюда две вещи:
 *
 * - Пустой restart_cmd заменяется на `pm2 restart product`. Самообслуживание
 *   заводит продукты с NULL в build_cmd и restart_cmd (реестр 22.09.2026,
 *   dmitryvolkov) — и раннер после правки не перезапускал ничего. Проверка
 *   здоровья тогда сверяла sha новой правки со СТАРЫМ процессом, и ход
 *   откатывался всегда, если только агент сам не перезапустил pm2 после своего
 *   коммита. build_cmd не подставляется: сборки у каркаса нет, а выдуманная
 *   команда на продукте без скрипта build роняла бы каждый ход.
 * - Перед каждым перезапуском порт освобождается от процессов вне pm2.
 *
 * Не под pm2 — раннер не знает ни команды, ни законного держателя, и не
 * трогает ни того ни другого.
 */
function productRuntime(
  product: PollResult['product'],
  config: RunnerConfig,
  freeProductPort: typeof freeProductPortReal,
): Pick<DeployInput, 'buildCmd' | 'restartCmd' | 'healthUrl' | 'cwd' | 'freePort'> {
  const underPm2 = Boolean(config.productStartScript);
  const restartCmd = product.restartCmd?.trim() ? product.restartCmd : underPm2 ? PM2_RESTART_CMD : null;
  return {
    buildCmd: product.buildCmd,
    restartCmd,
    healthUrl: product.healthUrl,
    cwd: product.checkoutPath,
    freePort: underPm2
      ? (report) => freeProductPort({ healthUrl: product.healthUrl, onPhase: report })
      : undefined,
  };
}

/**
 * Выполняет один ход: обычный (прогон агента → коммит → деплой) или
 * служебный ход отката (сброс дерева на указанный sha без агента).
 */
export async function executeTurn(input: ExecuteTurnInput): Promise<void> {
  const { turn, product, git, api } = input;
  const runClaude = input.runClaude ?? runClaudeReal;
  const deploy = input.deploy ?? deployReal;
  const runtime = productRuntime(product, input.config, input.freeProductPort ?? freeProductPortReal);

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
      ...runtime,
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

  await api.sendEvents(turn.id, [{ type: 'item', content: '\n\nСобираю и перезапускаю…' }]);

  const result = await deploy({
    git,
    shaBefore,
    ...runtime,
    // Продукт обязан подтвердить, что поднялся ИМЕННО на этой правке.
    expectedSha: shaAfter,
    // Отчёт о фазах: без него сборка выглядит для сборщика зависших молчанием,
    // и ход длиннее получаса снимут как мёртвый — а он жив.
    onPhase: (phase) => void api.sendEvents(turn.id, [{ type: 'item', content: `\n${phase}` }]),
  });

  // Резервная копия — последним шагом и без права уронить ход.
  //
  // Раньше push стоял сразу после коммита, до сборки. Его падение обрывало ход
  // ДО проверки здоровья и автоотката: продукт оставался жить изменённым, а
  // клиенту докладывали «failed», то есть «ничего не изменилось» о сайте,
  // который изменился. Так и вышло на проде 23.09.2026.
  //
  // Здесь правка уже собрана, проверена здоровьем и работает. Объявить такой
  // ход упавшим значит соврать клиенту, что его работа не применена. Но и
  // проглотить отказ молча нельзя: копия — единственный второй экземпляр кода
  // клиента, и её потеря обязана быть видимой, а не тихой.
  //
  // На откате не пушим вовсе: дерево вернулось на прежний коммит, посылать в
  // резерв нечего.
  if (!result.reverted) {
    try {
      await git.push();
    } catch (e: any) {
      const message = e?.message ?? String(e);
      console.error(`[runner] ход ${turn.id}: резервная копия не обновлена: ${message}`);
      await api.sendEvents(turn.id, [
        {
          type: 'item',
          content: `\nПравка применена и работает, но резервную копию обновить не удалось: ${message}`,
        },
      ]);
    }
  }

  await api.complete(turn.id, {
    status: result.reverted ? 'reverted' : 'done',
    shaBefore,
    shaAfter: result.reverted ? undefined : shaAfter,
    tokens,
  });
}
