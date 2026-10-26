import { Logger } from '@nestjs/common';

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
