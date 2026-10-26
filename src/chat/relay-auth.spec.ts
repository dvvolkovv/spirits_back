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
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({});
    expect(relayAuthHeaders()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
