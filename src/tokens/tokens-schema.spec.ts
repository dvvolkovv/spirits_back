/**
 * Сторож накатки процедур баланса — БЕЗ базы.
 *
 * Поведение (что процедура действительно перестала терять зачисления)
 * измеряет add-tokens-race.integration.spec.ts на живом Postgres. Здесь
 * проверяется то, что живой прогон не видит вовсе: файл найден, применён при
 * старте модуля и перечислен в providers. Ровно эти три места — единственные,
 * где починку можно потерять целиком, не сломав ни одного вызова: без
 * providers сервис не создаётся, без onModuleInit ничего не накатывается, а
 * без строки в module.ts Nest его не знает, — и всё это остаётся зелёным в
 * любом тесте, который смотрит на поведение процедуры в базе, где схему
 * накатили руками.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TokensSchemaService } from './tokens-schema.service';

function makeService() {
  const queries: string[] = [];
  const pg = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    }),
  };
  return { svc: new TokensSchemaService(pg as any), queries };
}

describe('TokensSchemaService.onModuleInit', () => {
  it('накатывает процедуру add_user_tokens', async () => {
    const { svc, queries } = makeService();

    await svc.onModuleInit();

    expect(queries.join('\n')).toContain(
      'CREATE OR REPLACE FUNCTION public.add_user_tokens',
    );
  });

  it('не падает, если применение миграции бросает ошибку', async () => {
    const pg = {
      query: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const svc = new TokensSchemaService(pg as any);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('текст миграции 001', () => {
  /**
   * Читается через сервис, а не напрямую с диска: путь к файлу — часть
   * починки. Файл, лежащий в каталоге, но не находимый сервисом, на проде не
   * накатится, и проверка `fs.readFileSync(<путь, набранный в тесте>)`
   * осталась бы зелёной.
   */
  async function sql(): Promise<string> {
    const { svc, queries } = makeService();
    await svc.onModuleInit();
    const text = queries.find((q) => q.includes('add_user_tokens'));
    if (!text) throw new Error('миграция 001 не применена: ни один запрос не трогает add_user_tokens');
    // Комментарии вырезаются: шапка файла ЦИТИРУЕТ сломанный вариант (там есть
    // и «SELECT COALESCE(tokens, 0) INTO v_previous_balance», и слова про
    // FOR UPDATE). Проверка по сырому тексту зеленела бы на комментарии даже
    // если бы из тела процедуры FOR UPDATE исчез.
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  }

  it('читает баланс под FOR UPDATE', async () => {
    expect(await sql()).toMatch(
      /SELECT\s+COALESCE\(tokens,\s*0\)\s+INTO\s+v_previous_balance\s+FROM\s+ai_profiles_consolidated\s+WHERE\s+user_id\s*=\s*p_user_id\s+FOR\s+UPDATE/i,
    );
  });

  it('идемпотентна — CREATE OR REPLACE, а не CREATE', async () => {
    const text = await sql();
    expect(text).toContain('CREATE OR REPLACE FUNCTION public.add_user_tokens');
    expect(text).not.toMatch(/CREATE\s+FUNCTION\s+public\.add_user_tokens/i);
  });

  it('сохраняет форму ответа — все пять ключей', async () => {
    const text = await sql();
    for (const key of [
      'success',
      'transaction_id',
      'previous_balance',
      'new_balance',
      'tokens_added',
    ]) {
      expect(text).toContain(`'${key}'`);
    }
  });

  it('оставляет обрезку по нулю — баланс не уходит в минус', async () => {
    expect(await sql()).toMatch(/GREATEST\(0,\s*v_previous_balance\s*\+\s*p_amount\)/i);
  });

  it('по-прежнему пишет строку в token_transactions', async () => {
    expect(await sql()).toContain('INSERT INTO token_transactions');
  });
});

describe('провайдер зарегистрирован в модуле', () => {
  it('TokensSchemaService перечислен в providers', () => {
    const body = fs.readFileSync(path.join(__dirname, 'tokens.module.ts'), 'utf8');
    const providers = body.match(/providers:\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(providers).toContain('TokensSchemaService');
  });
});
