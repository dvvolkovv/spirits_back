import * as fs from 'fs';
import * as path from 'path';

/**
 * Проверка секрета (relay-agent/relay-auth.mjs) должна стоять ДО всего, что
 * может прочитать тело запроса или отдать ответ: после cors() (тому можно
 * доверять — preflight), но раньше express.json(), статики /files и любого
 * маршрута. Сдвинут порядок — и enforce либо не защищает часть путей, либо
 * ломает что-то выше по цепочке.
 */
const src = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');

describe('релей: порядок подключения проверки секрета в server.mjs', () => {
  const corsAt = src.indexOf('app.use(cors()');
  const relayAuthAt = src.indexOf('app.use(createRelayAuth');

  it('app.use(cors()) и app.use(createRelayAuth — есть в файле', () => {
    expect(corsAt).toBeGreaterThan(-1);
    expect(relayAuthAt).toBeGreaterThan(-1);
  });

  it('createRelayAuth подключён после cors()', () => {
    expect(relayAuthAt).toBeGreaterThan(corsAt);
  });

  it('createRelayAuth подключён раньше любого express.json/статики/маршрута', () => {
    const after = [
      ['app.use(express.json', /app\.use\(express\.json/],
      ['app.use("/files"', /app\.use\("\/files"/],
      ['app.post(', /app\.post\(/],
      ['app.get(', /app\.get\(/],
    ] as const;
    for (const [label, re] of after) {
      const m = re.exec(src);
      expect(m).not.toBeNull();
      expect(relayAuthAt).toBeLessThan(m!.index);
      if (relayAuthAt >= m!.index) throw new Error(`${label} раньше createRelayAuth`);
    }
  });
});
