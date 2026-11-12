import * as http from 'http';
import { Socket } from 'net';
import { AlertBotAccess } from './alert-bot.access';
import { toolText } from './alert-bot.mask';
import { AlertBotOpsServer } from './alert-bot.ops-server';
import { signOpsToken, signRepairToken } from './alert-bot.ops-token';
import { AlertBotRepairAuth } from './alert-bot.repair-auth';
import { AlertBotRepairJobs } from './alert-bot.repair-jobs';
import { AlertBotRepairTools } from './alert-bot.repair-tools';
import { RepairJobRecord } from './alert-bot.repair-store';
import { OpsToolHandler, RepairIdentity } from './alert-bot.types';

const definitions = ['alerts', 'health', 'incidents', 'assign', 'sla'].map((name) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} },
}));

const repairIdentity: RepairIdentity = {
  scope: 'repair',
  adminUserId: 'tg:123',
  adminTgId: '123',
  chatId: '-1001',
  turnId: 'turn-1',
  repairId: 'repair-1',
};
const repairJobUuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const repairOutputPath = '/tmp/0123456789abcdef0123456789abcdef/a.docx';

describe('AlertBotOpsServer stateless MCP', () => {
  let server: AlertBotOpsServer;
  let access: AlertBotAccess;
  let isAdminUserId: jest.Mock;
  let execute: jest.Mock;
  let authorize: jest.Mock;
  let repairStart: jest.Mock;
  let repairWait: jest.Mock;
  let repairAuth: AlertBotRepairAuth;
  let repairTools: AlertBotRepairTools;
  let adminToken: string;
  let userToken: string;
  let repairToken: string;
  let sockets: Set<Socket>;

  beforeEach(async () => {
    sockets = new Set<Socket>();
    process.env.JWT_SECRET = 'ops-wire-spec-secret';
    isAdminUserId = jest.fn(async (userId: string) => userId === 'u-admin');
    access = { isAdminUserId } as unknown as AlertBotAccess;
    execute = jest.fn(async (name: string, args: Record<string, unknown>, _ctx: unknown, _signal?: AbortSignal) => (
      name.startsWith('repair_') ? toolText({ error: 'unknown_tool' }) : toolText({ ok: true, args })
    ));
    const tools: OpsToolHandler = { definitions: () => definitions, execute };
    authorize = jest.fn().mockResolvedValue(true);
    repairAuth = { authorize } as unknown as AlertBotRepairAuth;
    repairStart = jest.fn().mockResolvedValue({ jobId: 'job-1' });
    repairWait = jest.fn();
    repairTools = new AlertBotRepairTools(tools, { start: repairStart, wait: repairWait } as unknown as AlertBotRepairJobs);
    server = new AlertBotOpsServer(access, tools, repairAuth, repairTools);
    await server.start(0);
    trackSockets();
    adminToken = signOpsToken('u-admin', '1');
    userToken = signOpsToken('u-user', '2');
    repairToken = signRepairToken({
      adminUserId: repairIdentity.adminUserId,
      adminTgId: repairIdentity.adminTgId,
      chatId: repairIdentity.chatId,
      turnId: repairIdentity.turnId,
      repairId: repairIdentity.repairId,
    });
  });

  afterEach(async () => {
    const stopPromise = server.stop();
    if (!await settlesWithin(stopPromise, 200)) {
      for (const socket of sockets) socket.destroy();
      await stopPromise;
    }
    for (const socket of sockets) socket.destroy();
    jest.restoreAllMocks();
    delete process.env.JWT_SECRET;
  });

  function trackSockets(): void {
    const rawServer = (server as any).server as http.Server;
    rawServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  }

  async function restart(options: { toolTimeoutMs?: number; shutdownTimeoutMs?: number }): Promise<void> {
    await server.stop();
    const ConfigurableServer = AlertBotOpsServer as any;
    server = new ConfigurableServer(access, { definitions: () => definitions, execute }, repairAuth, repairTools, options);
    await server.start(0);
    trackSockets();
  }

  async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  async function waitForToolCall(): Promise<void> {
    for (let attempt = 0; attempt < 40 && execute.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(execute).toHaveBeenCalled();
  }

  function mockAbortableExecute(): { getSignal: () => AbortSignal | undefined; abortListener: jest.Mock } {
    let signal: AbortSignal | undefined;
    const abortListener = jest.fn();
    execute.mockImplementationOnce((_name: string, _args: Record<string, unknown>, _ctx: unknown, received?: AbortSignal) => {
      signal = received;
      return new Promise<string>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = () => { abortListener(); reject(new Error('aborted')); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    return { getSignal: () => signal, abortListener };
  }

  async function expectActualAbort(getSignal: () => AbortSignal | undefined, abortListener: jest.Mock): Promise<void> {
    for (let attempt = 0; attempt < 40 && !getSignal()?.aborted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(getSignal()?.aborted).toBe(true);
    expect(abortListener).toHaveBeenCalledTimes(1);
  }

  async function waitForSocketsClosed(): Promise<void> {
    for (let attempt = 0; attempt < 40 && sockets.size > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sockets.size).toBe(0);
  }

  async function post(payload: unknown, token: string | null = adminToken): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return fetch(server.url(), {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  async function rpc(method: string, params?: unknown, token: string | null = adminToken) {
    const response = await post({ jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) }, token);
    return { response, body: await response.json() };
  }

  it('слушает только loopback и сообщает фактический адрес', async () => {
    expect(server.host()).toBe('127.0.0.1');
    expect(new URL(server.origin()).hostname).toBe('127.0.0.1');
    expect(Number(new URL(server.origin()).port)).toBeGreaterThan(0);
    expect(server.url()).toBe(`${server.origin()}/mcp`);

    const unstarted = new AlertBotOpsServer(access, { definitions: () => definitions, execute }, repairAuth, repairTools);
    expect(() => unstarted.origin()).toThrow();
    await expect(unstarted.stop()).resolves.toBeUndefined();
  });

  it('отклоняет listen-ошибку', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = new AlertBotOpsServer(access, { definitions: () => definitions, execute }, repairAuth, repairTools);
    const port = Number(new URL(server.origin()).port);
    await expect(second.start(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.stop();
  });

  it('безопасно логирует ошибку сервера после старта и не падает', () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const rawServer = (server as any).server as http.Server;
    const observed: Error[] = [];
    rawServer.on('error', (error) => observed.push(error));
    const error = Object.assign(new Error('RAW-SOCKET-SECRET'), { code: 'ECONNRESET' });

    expect(() => rawServer.emit('error', error)).not.toThrow();
    expect(observed).toEqual([error]);
    expect(errorLog).toHaveBeenCalledWith('[alert-bot-ops] server error ECONNRESET');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('RAW-SOCKET-SECRET');
  });

  it('требует валидный ops-токен и права администратора на каждый запрос', async () => {
    const missing = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe('');

    const invalid = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'invalid');
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toBe('');

    const forbidden = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, userToken);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('');
    expect(isAdminUserId).toHaveBeenCalledWith('u-user');
    expect(isAdminUserId).not.toHaveBeenCalledWith('u-admin');

    await rpc('tools/list');
    await rpc('tools/list');
    expect(isAdminUserId).toHaveBeenCalledTimes(3);
  });

  it('ops scope не exposing repair capability и не запускает jobs', async () => {
    const listed = await rpc('tools/list');
    const names = listed.body.result.tools.map((tool: any) => tool.name);
    expect(names).not.toEqual(expect.arrayContaining(['repair_exec', 'repair_job', 'repair_verify']));

    const called = await rpc('tools/call', {
      name: 'repair_exec',
      arguments: { host: 'prod', command: 'systemctl restart linkeon-api' },
    });
    expect(JSON.parse(called.body.result.content[0].text)).toEqual({ error: 'unknown_tool' });
    expect(repairStart).not.toHaveBeenCalled();
    expect(repairWait).not.toHaveBeenCalled();
  });

  it('repair scope требует authorize на каждый запрос и отдаёт read-only + три repair tools', async () => {
    authorize.mockResolvedValueOnce(false);
    const forbidden = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, repairToken);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('');
    expect(authorize).toHaveBeenCalledWith(repairIdentity);
    expect(isAdminUserId).not.toHaveBeenCalledWith(repairIdentity.adminUserId);

    const { response, body } = await rpc('tools/list', undefined, repairToken);
    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      'alerts', 'repair_exec', 'repair_job', 'repair_verify',
    ]));
    expect(body.result.tools).toHaveLength(8);
  });

  it('отзыв repair authorization между tools/list и tools/call запрещает запуск', async () => {
    const listed = await rpc('tools/list', undefined, repairToken);
    expect(listed.response.status).toBe(200);
    authorize.mockResolvedValueOnce(false);

    const called = await post({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'repair_exec', arguments: { host: 'prod', command: 'true' } },
    }, repairToken);
    expect(called.status).toBe(403);
    expect(await called.text()).toBe('');
    expect(repairStart).not.toHaveBeenCalled();
  });

  it('repair_exec возвращает jobId через repair handler', async () => {
    const args = { host: 'prod', command: 'systemctl restart linkeon-api', interruptible: true };
    const { response, body } = await rpc('tools/call', { name: 'repair_exec', arguments: args }, repairToken);
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ jobId: 'job-1' });
    expect(repairStart).toHaveBeenCalledWith(repairIdentity, 'exec', args);
    expect(execute).not.toHaveBeenCalled();
  });

  it('repair_job возвращает terminal result с UUID и путём, маскируя только секреты', async () => {
    const terminal: RepairJobRecord = {
      id: repairJobUuid,
      repairId: repairIdentity.repairId,
      sequence: 2,
      host: 'prod',
      command: 'convert document',
      kind: 'verify',
      mutates: false,
      interruptible: true,
      timeoutMs: 120000,
      status: 'succeeded',
      exitCode: 0,
      stdout: `saved ${repairOutputPath}; TOKEN=raw-secret`,
      stderr: '',
      failureKind: null,
    };
    repairWait.mockResolvedValue(terminal);

    const { body } = await rpc('tools/call', {
      name: 'repair_job', arguments: { job_id: repairJobUuid, wait_seconds: 3 },
    }, repairToken);
    const text = body.result.content[0].text;
    expect(JSON.parse(text)).toEqual({ ...terminal, stdout: `saved ${repairOutputPath}; TOKEN=[скрыто]` });
    expect(text).toContain(repairJobUuid);
    expect(text).toContain(repairOutputPath);
    expect(text).not.toContain('raw-secret');
    expect(repairWait).toHaveBeenCalledWith(repairIdentity, repairJobUuid, 3);
  });

  it('wrong repair args возвращают typed errors', async () => {
    repairStart.mockRejectedValueOnce(new Error('unknown_host'));
    const unknownHost = await rpc('tools/call', {
      name: 'repair_exec', arguments: { host: 'unknown', command: 'true' },
    }, repairToken);
    expect(JSON.parse(unknownHost.body.result.content[0].text)).toEqual({ error: 'unknown_host' });

    repairStart.mockRejectedValueOnce(new Error('invalid_command'));
    const invalidCommand = await rpc('tools/call', {
      name: 'repair_exec', arguments: { host: 'prod', command: '' },
    }, repairToken);
    expect(JSON.parse(invalidCommand.body.result.content[0].text)).toEqual({ error: 'invalid_command' });

    const invalidJob = await rpc('tools/call', {
      name: 'repair_job', arguments: { job_id: 'not-a-job', wait_seconds: 0 },
    }, repairToken);
    expect(JSON.parse(invalidJob.body.result.content[0].text)).toEqual({ error: 'job_not_found' });
    expect(repairWait).not.toHaveBeenCalled();
  });

  it('repair tool не exposing исходный текст неизвестной ошибки', async () => {
    repairStart.mockRejectedValueOnce(new Error('RAW-REPAIR-SECRET'));
    const { body } = await rpc('tools/call', {
      name: 'repair_exec', arguments: { host: 'prod', command: 'true' },
    }, repairToken);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ error: 'tool_failed' });
    expect(JSON.stringify(body)).not.toContain('RAW-REPAIR-SECRET');
  });

  it('read-only alerts под repair scope делегируется базовому handler', async () => {
    const { body } = await rpc('tools/call', { name: 'alerts', arguments: { hours: 2 } }, repairToken);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true, args: { hours: 2 } });
    expect(execute).toHaveBeenCalledWith('alerts', { hours: 2 }, repairIdentity, expect.any(AbortSignal));
    expect(repairStart).not.toHaveBeenCalled();
  });

  it('отвечает на initialize и принимает notifications/initialized без тела', async () => {
    const { response, body } = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ops', version: '1.0.0' },
      },
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(JSON.stringify(body)));

    const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
  });

  it('поддерживает две версии протокола и выбирает 2025-06-18 по умолчанию', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['2025-03-26', '2025-03-26'],
      ['2099-01-01', '2025-06-18'],
      [undefined, '2025-06-18'],
    ];
    for (const [requested, expected] of cases) {
      const { body } = await rpc('initialize', requested === undefined ? undefined : { protocolVersion: requested });
      expect(body.result.protocolVersion).toBe(expected);
    }
  });

  it('возвращает пять инструментов с inputSchema', async () => {
    const { response, body } = await rpc('tools/list');
    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(5);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
      expect(tool).not.toHaveProperty('input_schema');
    }
  });

  it('вызывает инструмент с identity и одноразово отдаёт журнал имён', async () => {
    const { response, body } = await rpc('tools/call', { name: 'alerts', arguments: { hours: 24 } });
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].type).toBe('text');
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true, args: { hours: 24 } });
    expect(execute).toHaveBeenCalledWith('alerts', { hours: 24 }, { adminUserId: 'u-admin', chatId: '1' }, expect.any(AbortSignal));
    expect(server.consumeToolNames(adminToken)).toEqual(['alerts']);
    expect(server.consumeToolNames(adminToken)).toEqual([]);
  });

  it('возвращает JSON-RPC ошибки для неизвестного метода и другого пути', async () => {
    const unknown = await rpc('unknown/method');
    expect(unknown.response.status).toBe(200);
    expect(unknown.body.error.code).toBe(-32601);
    expect(unknown.body.id).toBe(7);

    const response = await fetch(`${server.origin()}/other`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32000 } });
  });

  it('помечает JSON с error как ошибку инструмента', async () => {
    execute.mockResolvedValueOnce(toolText({ error: 'x' }));
    const { body } = await rpc('tools/call', { name: 'alerts', arguments: {} });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ error: 'x' });
  });

  it('скрывает исходный текст выброшенной ошибки инструмента', async () => {
    execute.mockRejectedValueOnce(new Error('RAW-TOOL-SECRET'));
    const { body } = await rpc('tools/call', { name: 'alerts', arguments: {} });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ error: 'tool_failed' });
    expect(JSON.stringify(body)).not.toContain('RAW-TOOL-SECRET');
  });

  it('обрабатывает транспортные методы stateless', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const get = await fetch(server.url(), { method: 'GET', headers });
    expect(get.status).toBe(405);
    expect(await get.json()).toMatchObject({ id: null, error: { code: -32000 } });

    const remove = await fetch(server.url(), { method: 'DELETE', headers });
    expect(remove.status).toBe(204);
    expect(await remove.text()).toBe('');

    const put = await fetch(server.url(), { method: 'PUT', headers, body: '{}' });
    expect(put.status).toBe(405);
  });

  it('отклоняет слишком большое тело, битый JSON и запрос без id', async () => {
    const large = await post('x'.repeat(65_537));
    expect(large.status).toBe(413);

    const invalid = await post('{broken');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ id: null, error: { code: -32700 } });

    const missingId = await post({ jsonrpc: '2.0', method: 'tools/list' });
    expect(missingId.status).toBe(400);
    expect(await missingId.json()).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('подставляет пустой объект при необязательных arguments', async () => {
    const { body } = await rpc('tools/call', { name: 'alerts' });
    expect(body.result?.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith('alerts', {}, { adminUserId: 'u-admin', chatId: '1' }, expect.any(AbortSignal));
  });

  it('проверяет параметры tools/call', async () => {
    for (const params of [{ arguments: {} }, { name: 'alerts', arguments: null }, { name: 'alerts', arguments: [] }]) {
      const { body } = await rpc('tools/call', params);
      expect(body.error.code).toBe(-32602);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('отклоняет неверную версию JSON-RPC и не скалярный id', async () => {
    const wrongVersion = await post({ jsonrpc: '1.0', id: 1, method: 'tools/list' });
    expect(wrongVersion.status).toBe(400);
    expect(await wrongVersion.json()).toMatchObject({ id: null, error: { code: -32600 } });

    for (const id of [null, { nested: 1 }, [1], true]) {
      const response = await post({ jsonrpc: '2.0', id, method: 'tools/list' });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ id: null, error: { code: -32600 } });
    }
  });

  it('ограничивает зависший execute дедлайном и возвращает tool_failed', async () => {
    await restart({ toolTimeoutMs: 20, shutdownTimeoutMs: 20 });
    const { getSignal, abortListener } = mockAbortableExecute();
    const outcome = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'alerts', arguments: {} } })
      .then(async (response) => ({ response, body: await response.json() }), (error) => ({ error }));
    const completed = await settlesWithin(outcome, 150);
    if (!completed) {
      for (const socket of sockets) socket.destroy();
      await outcome;
    }
    expect(completed).toBe(true);
    const { body } = await outcome as any;
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ error: 'tool_failed' });
    await expectActualAbort(getSignal, abortListener);
  });

  it('stop завершается при активном зависшем вызове и закрывает соединения', async () => {
    await restart({ toolTimeoutMs: 60_000, shutdownTimeoutMs: 20 });
    const { getSignal, abortListener } = mockAbortableExecute();
    const outcome = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'alerts', arguments: {} } })
      .then((response) => ({ response }), (error) => ({ error }));
    await waitForToolCall();

    const stopPromise = server.stop();
    const stopped = await settlesWithin(stopPromise, 150);
    if (!stopped) {
      for (const socket of sockets) socket.destroy();
      await stopPromise;
    }
    await outcome;
    await waitForSocketsClosed();
    expect(stopped).toBe(true);
    await expectActualAbort(getSignal, abortListener);
  });

  it('обрыв клиента при зависшем execute не оставляет открытых соединений', async () => {
    await restart({ toolTimeoutMs: 60_000, shutdownTimeoutMs: 20 });
    const { getSignal, abortListener } = mockAbortableExecute();
    const controller = new AbortController();
    const outcome = fetch(server.url(), {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'alerts', arguments: {} } }),
      signal: controller.signal,
    }).then((response) => ({ response }), (error) => ({ error }));
    await waitForToolCall();
    controller.abort();
    await outcome;
    await expectActualAbort(getSignal, abortListener);

    const stopPromise = server.stop();
    const stopped = await settlesWithin(stopPromise, 150);
    if (!stopped) {
      for (const socket of sockets) socket.destroy();
      await stopPromise;
    }
    await waitForSocketsClosed();
    expect(stopped).toBe(true);
  });

  it('stop без активного HTTP server всё равно abort-ит зависший tool', async () => {
    const { getSignal, abortListener } = mockAbortableExecute();
    const outcome = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'alerts', arguments: {} } })
      .then((response) => ({ response }), (error) => ({ error }));
    await waitForToolCall();
    const rawServer = (server as any).server as http.Server;
    (server as any).server = null;

    await server.stop();

    await expectActualAbort(getSignal, abortListener);
    await outcome;
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });

  it('stop по backstop не ждёт Promise, игнорирующий AbortSignal', async () => {
    await restart({ toolTimeoutMs: 60_000, shutdownTimeoutMs: 20 });
    let signal: AbortSignal | undefined;
    execute.mockImplementationOnce((_name: string, _args: Record<string, unknown>, _ctx: unknown, received?: AbortSignal) => {
      signal = received;
      return new Promise<string>(() => {});
    });
    const outcome = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'alerts', arguments: {} } })
      .then((response) => ({ response }), (error) => ({ error }));
    await waitForToolCall();

    const stopPromise = server.stop();
    const stopped = await settlesWithin(stopPromise, 150);
    if (!stopped) {
      for (const socket of sockets) socket.destroy();
      await stopPromise;
    }
    await outcome;
    await waitForSocketsClosed();
    expect(stopped).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
