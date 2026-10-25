import { spawnSync } from 'child_process';
import { MAX_PROMPT_BYTES, promptBytes } from './prompt-size';

describe('promptBytes', () => {
  it('кириллица — два байта на букву', () => {
    expect(promptBytes('абв')).toBe(6);
    expect(promptBytes('abc')).toBe(3);
  });

  it('@-упоминание считается после обезвреживания, как его получит CLI', () => {
    // Перед одиночной @ сервис CLI ставит WORD JOINER — три байта.
    expect(promptBytes('@x')).toBe(5);
    // Почту сервис не трогает.
    expect(promptBytes('a@b')).toBe(3);
  });

  it('бюджет с запасом ниже предела ядра 128 КБ — на склейку инструкции с текстом', () => {
    expect(MAX_PROMPT_BYTES + 16 * 1024).toBeLessThan(128 * 1024);
  });
});

/** Код ошибки запуска процесса с одним аргументом arg после -p. */
function execError(arg: string): string | undefined {
  try {
    return (spawnSync('/bin/true', ['-p', arg]).error as NodeJS.ErrnoException | undefined)?.code;
  } catch (e: any) {
    return e?.code;
  }
}

// Предел ядра, ради которого весь бюджет, есть на Linux (нода, прод); на маке его нет.
const onLinux = process.platform === 'linux' ? it : it.skip;

describe('предел аргумента Linux', () => {
  onLinux('запрос на пределе бюджета запускается, а за пределом ядра — E2BIG', () => {
    expect(execError('я'.repeat(MAX_PROMPT_BYTES / 2) + '\n\n---\n\nUSER REQUEST:\n')).toBeUndefined();
    expect(execError('я'.repeat(66_000))).toBe('E2BIG');
  });
});
