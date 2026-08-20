/**
 * Баланс меняется только через add_user_tokens / consume_user_tokens.
 *
 * Обе процедуры берут строку под FOR UPDATE и пишут строку в
 * token_transactions. Прямой `tokens = tokens ± N` не делает ни того, ни
 * другого, и каждый такой обход стоил нам по инциденту:
 *
 *   08.08.2026 — параллельные списания читали один и тот же достаточный
 *   баланс, пользователь ушёл в −7 363.
 *
 *   20.08.2026 — сверка показала: у 10 пользователей баланс расходится с
 *   реестром на 333 тыс. токенов. Деньги не потерялись, но «История
 *   пополнений» и прогноз расхода видели неполную картину: возврат из
 *   поддержки, видео, речь и SMM вели свои приватные реестры.
 *
 * Поэтому сторож на исходниках, а не на поведении: поведенческий тест ловит
 * только те места, которые кто-то вспомнил покрыть, а обход добавляют как раз
 * не вспомнив. Здесь падает любой новый.
 *
 * Если прямой UPDATE действительно нужен (условное списание в SpeechService —
 * такой случай), он обязан лежать в ALLOWED с объяснением, почему процедура не
 * подходит, и сам писать строку в token_transactions.
 */
import * as fs from 'fs';
import * as path from 'path';

/** `tokens = tokens + N` / `tokens = tokens - N` в любом регистре и с любыми пробелами. */
const DIRECT_BALANCE_WRITE = /tokens\s*=\s*tokens\s*[-+]/i;

/**
 * Осознанные исключения: файл → почему.
 * Пустой список — цель; каждая строка здесь это долг.
 */
const ALLOWED: Record<string, string> = {
  'speech/speech.service.ts':
    'Условное списание `WHERE tokens >= $1`: процедура при нехватке списывает ' +
    'остаток, а синтез речи должен получить отказ целиком. Строку в ' +
    'token_transactions пишет сам, в той же транзакции.',
};

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'migrations') continue;
      collectSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Прямые изменения баланса', () => {
  const srcRoot = path.join(__dirname, '..');

  it('нигде не обходят add_user_tokens / consume_user_tokens', () => {
    const offenders: string[] = [];

    for (const file of collectSources(srcRoot)) {
      const rel = path.relative(srcRoot, file).split(path.sep).join('/');
      if (ALLOWED[rel]) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Комментарии не считаем: в них разбор прошлых инцидентов.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        if (DIRECT_BALANCE_WRITE.test(code)) offenders.push(`${rel}:${i + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('исключения не протухли — файл из ALLOWED существует и правда пишет в реестр', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const full = path.join(srcRoot, rel);
      expect(fs.existsSync(full)).toBe(true);

      const body = fs.readFileSync(full, 'utf8');
      expect(body).toMatch(DIRECT_BALANCE_WRITE);
      expect(body).toMatch(/token_transactions/);
    }
  });
});
