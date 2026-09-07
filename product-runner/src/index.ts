import 'dotenv/config';
import { loadConfig, RunnerConfig } from './config';
import { LinkeonApi } from './api';
import { Git } from './git';
import { executeTurn as executeTurnReal } from './turn';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TickDeps {
  config: RunnerConfig;
  api: LinkeonApi;
  git: Git;
  executeTurn?: typeof executeTurnReal;
  sleep?: (ms: number) => Promise<unknown>;
}

/**
 * Один проход цикла. Вынесен из `main` ради проверяемости: бесконечный цикл
 * тестировать нечем, а единицу работы — можно.
 */
export async function tick(deps: TickDeps): Promise<void> {
  const wait = deps.sleep ?? sleep;
  const run = deps.executeTurn ?? executeTurnReal;

  const poll = await deps.api.poll();

  if (!poll) {
    // Связи нет либо токен не принят. Не выходим: Linkeon может быть просто
    // на деплое, а падение процесса означает, что продукт клиента перестаёт
    // обслуживаться до ручного вмешательства. Ждём дольше обычного, чтобы не
    // молотить в стену.
    await wait(deps.config.pollIntervalMs * 3);
    return;
  }

  if (!poll.turn) {
    await wait(deps.config.pollIntervalMs);
    return;
  }

  console.log(`[runner] ход ${poll.turn.id}`);

  try {
    await run({ turn: poll.turn, product: poll.product, config: deps.config, git: deps.git, api: deps.api });
  } catch (e: any) {
    // Ни одно исключение не должно останавливать цикл: продукт останется с
    // ходом в running, и замок заблокирует его до серверного сборщика.
    console.error(`[runner] ход ${poll.turn.id} упал: ${e?.message}`);
    try {
      await deps.api.complete(poll.turn.id, { status: 'failed', error: String(e?.message ?? e) });
    } catch {
      // Связи нет — сборщик на сервере снимет ход сам через полчаса.
    }
  }
}

async function main() {
  const config = loadConfig();
  const api = new LinkeonApi(config);
  const git = new Git(config.checkoutPath);

  console.log(`[runner] старт, чекаут ${config.checkoutPath}, Linkeon ${config.linkeonUrl}`);

  for (;;) {
    await tick({ config, api, git });
  }
}

// Запускаем только когда файл исполняется напрямую: при импорте из теста
// бесконечный цикл стартовать не должен.
if (require.main === module) {
  main().catch((e) => {
    console.error(`[runner] фатально: ${e?.message}`);
    process.exit(1);
  });
}
