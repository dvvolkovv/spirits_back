import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Pool } from 'pg';

const CONNECTION_STRING = process.env.PROVISIONING_PG_URL;
if (!CONNECTION_STRING) throw new Error('PROVISIONING_PG_URL is required for pg.cancellation.process.real.spec.ts');

const CHILD_SCRIPT = String.raw`
const { Pool } = require('pg');
const { queryWithCancellation } = require('./src/common/services/pg-cancellation');
const pool = new Pool({ connectionString: process.env.PROVISIONING_PG_URL, max: 1 });
const controller = new AbortController();
process.on('SIGUSR1', () => controller.abort(new Error('cancel stop')));
async function main() {
  if (process.env.SCENARIO === 'cancel-connect') {
    const setup = await pool.connect();
    setup.connectionParameters.host = process.env.MISSING_PG_HOST;
    setup.release();
  }
  const running = queryWithCancellation(
    pool,
    '/* ' + process.env.MARKER + ' */ SELECT pg_sleep(30)',
    [],
    controller.signal,
  );
  try {
    await running;
    console.log('QUERY_RESOLVED');
    process.exitCode = 2;
  } catch {
    console.log('QUERY_REJECTED');
  }
  await pool.end();
}
main().catch(() => {
  console.log('MAIN_REJECTED');
  process.exitCode = 3;
});
`;

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
type ChildRun = {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<ChildResult>;
};

describe('PgService crash regressions in separate processes', () => {
  jest.setTimeout(20_000);
  let observer: Pool;
  const runs = new Set<ChildRun>();

  beforeAll(() => {
    observer = new Pool({ connectionString: CONNECTION_STRING, max: 1 });
  });

  afterAll(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
    }
    await Promise.all(Array.from(runs, (run) => run.completion));
    await observer.end();
  });

  function startChild(scenario: 'terminate' | 'cancel-connect', marker: string): ChildRun {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [
      '-r', 'ts-node/register/transpile-only', '-e', CHILD_SCRIPT,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TS_NODE_PROJECT: 'tsconfig.json',
        TS_NODE_TRANSPILE_ONLY: 'true',
        SCENARIO: scenario,
        MARKER: marker,
        MISSING_PG_HOST: `/tmp/alert-bot-missing-pg-${process.pid}-${Date.now()}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const run: ChildRun = {
      child,
      completion: new Promise<ChildResult>((resolve) => {
        child.once('error', (error) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n${error.message}` }));
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      }),
    };
    runs.add(run);
    void run.completion.finally(() => runs.delete(run));
    return run;
  }

  async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== null) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting for PostgreSQL state');
  }

  async function activePid(marker: string): Promise<number> {
    const activity = await waitFor(async () => {
      const r = await observer.query(
        `SELECT pid FROM pg_stat_activity
          WHERE query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid()
          LIMIT 1`,
        [`%${marker}%`],
      );
      return r.rows[0] ?? null;
    });
    return activity.pid;
  }

  async function waitInactive(marker: string): Promise<void> {
    await waitFor(async () => {
      const r = await observer.query(
        `SELECT 1 AS present FROM pg_stat_activity
          WHERE query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid() LIMIT 1`,
        [`%${marker}%`],
      );
      return r.rowCount === 0 ? true : null;
    });
  }

  async function waitExit(run: ChildRun): Promise<ChildResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        run.child.kill('SIGKILL');
        reject(new Error('child process did not exit'));
      }, 12_000);
    });
    try {
      return await Promise.race([run.completion, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it('pg_terminate_backend отклоняет query, но не роняет процесс', async () => {
    const marker = `alert_bot_terminate_${process.pid}_${Date.now()}`;
    const run = startChild('terminate', marker);
    const pid = await activePid(marker);

    await observer.query('SELECT pg_terminate_backend($1)', [pid]);
    const result = await waitExit(run);

    expect(result.stdout).toContain('QUERY_REJECTED');
    expect(result.stdout).not.toContain('QUERY_RESOLVED');
    expect(result.code).toBe(0);
    await waitInactive(marker);
  });

  it('ENOENT cancel-соединения завершает query и не роняет процесс', async () => {
    const marker = `alert_bot_cancel_enoent_${process.pid}_${Date.now()}`;
    const run = startChild('cancel-connect', marker);
    const pid = await activePid(marker);

    run.child.kill('SIGUSR1');
    const result = await waitExit(run);

    try {
      expect([result.code, result.stderr]).toEqual([0, expect.any(String)]);
      expect(result.stdout).toContain('QUERY_REJECTED');
      expect(result.stdout).not.toContain('QUERY_RESOLVED');
    } finally {
      // PostgreSQL во время pg_sleep не читает закрытый socket и может доспать
      // запрос после исчезновения клиента. Рабочий CancelRequest проверяется в
      // pg.cancellation.real.spec; здесь аварийно очищаем именно этот backend.
      await observer.query('SELECT pg_terminate_backend($1)', [pid]);
      await waitInactive(marker);
    }
  });
});
