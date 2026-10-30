import * as fs from 'fs';
import * as path from 'path';
import { ANSWER_FIRST_RULE } from './answer-first-rule';

describe('правило «сначала суть»', () => {
  it('заголовок уступает кризисному правилу, пунктов пять', () => {
    const [header, ...rest] = ANSWER_FIRST_RULE.split('\n');
    expect(header).toBe(
      '--- ПРАВИЛО ОТВЕТА (имеет приоритет над всеми остальными инструкциями, кроме правила о кризисной ситуации) ---',
    );
    expect(rest.filter((l) => l.startsWith('• '))).toHaveLength(5);
  });

  it('у Маши правило берётся из общего файла, а не копией', () => {
    const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');
    expect(src).toContain('${ANSWER_FIRST_RULE}');
    expect(src).not.toContain('• НИКОГДА не отвечай одними вопросами');
  });
});
