import * as fs from 'fs';
import * as path from 'path';

describe('relayAuthHeaders', () => {
  const OLD = process.env.RELAY_SECRET;
  afterEach(() => {
    if (OLD === undefined) delete process.env.RELAY_SECRET;
    else process.env.RELAY_SECRET = OLD;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('секрет задан — заголовок X-Agent-Secret с ним', () => {
    process.env.RELAY_SECRET = 's3cr3t';
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({ 'X-Agent-Secret': 's3cr3t' });
  });

  it('пробелы по краям значения не уходят в заголовок', () => {
    process.env.RELAY_SECRET = '  s3cr3t\n';
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({ 'X-Agent-Secret': 's3cr3t' });
  });

  it('секрета нет — пустой объект и одно предупреждение на процесс', () => {
    delete process.env.RELAY_SECRET;
    // jest.resetModules() в afterEach сбрасывает кеш не только './relay-auth',
    // но и '@nestjs/common': к этому тесту relay-auth.ts получит СВОЙ, заново
    // вычисленный класс Logger, отличный от того, что импортирован статически
    // в начале файла. Шпионим на актуальном классе — том же, что увидит
    // require('./relay-auth') ниже (тот же вызов require прогревает кеш).
    const { Logger: CurrentLogger } = require('@nestjs/common');
    const warn = jest.spyOn(CurrentLogger.prototype, 'warn').mockImplementation(() => undefined);
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({});
    expect(relayAuthHeaders()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * Каждый вызов релея (адрес из AGENT_URL / agentUrl, пути /chat и /session/)
 * обязан нести relayAuthHeaders(): в режиме enforce релей без него отвечает 401.
 * Проверка статическая: ищем вызов и смотрим, что заголовок стоит в той же
 * конструкции (в пределах 400 символов после адреса).
 */
describe('сторож: все вызовы релея — с секретом', () => {
  const SRC = path.join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) files.push(full);
    }
  };
  walk(SRC);

  const CALL = /\$\{(AGENT_URL|agentUrl)\}\/(chat|session\/)/g;

  it('находит все шесть известных вызовов', () => {
    const total = files.reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(CALL) || []).length, 0);
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it('у каждого вызова есть relayAuthHeaders()', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(CALL)) {
        const window = src.slice(m.index!, m.index! + 400);
        if (!window.includes('relayAuthHeaders()')) {
          const line = src.slice(0, m.index!).split('\n').length;
          missing.push(`${path.relative(SRC, f)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
