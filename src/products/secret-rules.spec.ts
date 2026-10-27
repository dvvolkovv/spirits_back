import { isReservedSecretName, secretsProblem, SECRET_COUNT_MAX, SECRET_VALUE_MAX } from './secret-rules';
import { isReservedSecretName as fromProvisioning } from './provisioning.service';

describe('правила ключей владельца — одно место на сервере', () => {
  it('годный набор — null', () => {
    expect(secretsProblem({ BOT_TOKEN: 't', OZON_API_KEY: 'k' })).toBeNull();
    expect(secretsProblem({})).toBeNull();
  });

  it('тексты — дословно прежние тексты create()', () => {
    expect(secretsProblem({ 'A B': 'x' })).toEqual({ message: 'имя секрета "A B" не переменная окружения', field: 'A B' });
    expect(secretsProblem({ ['K'.repeat(65)]: 'x' })).toEqual({ message: 'имя секрета длиннее 64 символов', field: 'KKKKKKKK…' });
    expect(secretsProblem({ PORT: 'x' })).toEqual({ message: 'имя секрета PORT занято платформой — назовите ключ иначе', field: 'PORT' });
    expect(secretsProblem({ A: '' })).toEqual({ message: 'секрет A: значение должно быть непустой строкой', field: 'A' });
    expect(secretsProblem({ A: 'ы'.repeat(SECRET_VALUE_MAX + 1) })).toEqual({ message: 'секрет A: значение длиннее 8192 символов', field: 'A' });
    const many = Object.fromEntries(Array.from({ length: SECRET_COUNT_MAX + 1 }, (_, i) => [`K${i}`, 'v']));
    expect(secretsProblem(many)).toEqual({ message: 'секретов больше 64' });
  });

  it('порядок проверок: число раньше имён, имя раньше значения', () => {
    // Вызывающие (create, карточка ключей) различают отказ набора и отказ
    // ключа по наличию field — порядок здесь решает, что увидит человек.
    expect(secretsProblem({ 'A B': '' })).toEqual({ message: 'имя секрета "A B" не переменная окружения', field: 'A B' });
    const many = Object.fromEntries([
      ...Array.from({ length: SECRET_COUNT_MAX }, (_, i) => [`K${i}`, 'v']),
      ['A B', 'v'],
    ]);
    expect(secretsProblem(many)).toEqual({ message: 'секретов больше 64' });
  });

  it('пустое имя — отказ формы имени с field: "" (вызывающий проверяет field !== undefined, а не истинность)', () => {
    expect(secretsProblem({ '': 'x' })).toEqual({ message: 'имя секрета "" не переменная окружения', field: '' });
  });

  it('негодное имя — в тексте и field только обрезком: в поле имени вставляют само значение', () => {
    const pasted = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
    const p = secretsProblem({ [pasted]: 'x' })!;
    expect(p).toEqual({ message: 'имя секрета "sk-live-…" не переменная окружения', field: 'sk-live-…' });
    expect(JSON.stringify(p)).not.toContain('abcdefgh');
    // Слишком длинное, но годное по форме — тоже обрезком.
    expect(secretsProblem({ ['A'.repeat(64) + 'SECRETTAIL']: 'x' })!.field).toBe('AAAAAAAA…');
    // Управляющие и невидимые — «?»: перенос строки в тексте отказа не нужен.
    expect(secretsProblem({ ['A' + String.fromCharCode(10) + 'B']: 'x' })).toEqual({
      message: 'имя секрета "A?B" не переменная окружения', field: 'A?B',
    });
  });

  it('обрезок не длиннее 40 символов ни в тексте, ни в field — даже из кавычек и обратных косых', () => {
    const p = secretsProblem({ ['"\\'.repeat(100)]: 'x' })!;
    expect(p.field.length).toBeLessThanOrEqual(40);
    expect(p.message.length - 'имя секрета  не переменная окружения'.length).toBeLessThanOrEqual(40);
    // Суррогатная пара не рвётся пополам.
    expect(secretsProblem({ ['😀'.repeat(20)]: 'x' })!.field).toBe('😀'.repeat(8) + '…');
  });

  it('годное по форме, но занятое имя — целиком, как было', () => {
    expect(secretsProblem({ DOTENV_CONFIG_PATH: 'x' })).toEqual({
      message: 'имя секрета DOTENV_CONFIG_PATH занято платформой — назовите ключ иначе', field: 'DOTENV_CONFIG_PATH',
    });
  });

  it('нулевой байт в значении — отказ: агент машины такое значение отвергает', () => {
    const NUL = String.fromCharCode(0);
    expect(secretsProblem({ A: 'a' + NUL + 'b' })).toEqual({ message: 'секрет A: значение содержит недопустимый символ', field: 'A' });
    // Перенос строки — законен (PEM).
    expect(secretsProblem({ A: 'a' + String.fromCharCode(10) + 'b' })).toBeNull();
  });

  it('не-строка вместо значения — отказ, а не String()', () => {
    expect(secretsProblem({ A: 42 as unknown as string })?.message).toMatch(/непустой строкой/);
  });

  it('OWNER_TG_ID — переменная платформы (очередь 2): владельцу её не задать', () => {
    expect(isReservedSecretName('OWNER_TG_ID')).toBe(true);
    expect(isReservedSecretName('owner_tg_id')).toBe(true);
    expect(isReservedSecretName('OWNER_TG')).toBe(false);
  });

  it('provisioning.service отдаёт ту же функцию — старые импорты живы', () => {
    expect(fromProvisioning).toBe(isReservedSecretName);
  });
});
