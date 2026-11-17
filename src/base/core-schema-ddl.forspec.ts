import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * DDL легаси-таблиц из настоящего снимка src/base/migrations/001_core_schema.sql
 * (pg_dump) — для pg-спек, которым нужны таблицы без модульной миграции
 * (user_id, ai_profiles_consolidated, contact_requests, short_codes, …).
 *
 * Снимок целиком не исполняется: он выставляет search_path='' на всю сессию
 * (см. referral-accounting.integration.spec.ts) и создаёт сотни объектов,
 * которые спеке не нужны. Вместо этого берутся объекты pg_dump с заголовком
 * «-- Name: …; Type: …; Schema: public» для перечисленных таблиц:
 *   TABLE, SEQUENCE + SEQUENCE OWNED BY (последовательности, принадлежащие
 *   таблице), DEFAULT, CONSTRAINT (PK/UNIQUE/CHECK), INDEX.
 * FK CONSTRAINT, TRIGGER, COMMENT и прочее не берутся: они тянут чужие
 * таблицы и функции, которых в схеме спеки нет.
 *
 * Префикс «public.» снимается — объекты создаются в первой схеме search_path
 * (собственная схема спеки), nextval('…_seq') резолвится туда же.
 * Порядок — порядок снимка (таблицы и последовательности раньше DEFAULT/
 * CONSTRAINT/INDEX). Таблицы, которой нет в снимке, — ошибка, а не пустой DDL.
 */
const CORE_SCHEMA = join(__dirname, 'migrations', '001_core_schema.sql');

const HEADER_RE = /^-- Name: ([^;\n]+); Type: ([^;\n]+); Schema: public; Owner: [^\n]*\n--\n/gm;

interface DumpEntry {
  name: string;
  type: string;
  body: string;
}

function dumpEntries(): DumpEntry[] {
  const dump = readFileSync(CORE_SCHEMA, 'utf8');
  const marks: Array<{ name: string; type: string; start: number; headerStart: number }> = [];
  let m: RegExpExecArray | null;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(dump))) {
    marks.push({ name: m[1], type: m[2], start: HEADER_RE.lastIndex, headerStart: m.index });
  }
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].headerStart : dump.length;
    // Хвост куска — пустые строки и строка «--» перед следующим заголовком.
    const body = dump
      .slice(mark.start, end)
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .trim();
    return { name: mark.name, type: mark.type, body };
  });
}

export function coreTableDdl(tables: readonly string[]): string {
  const entries = dumpEntries();
  const wanted = new Set(tables);
  for (const table of tables) {
    if (!entries.some((e) => e.type === 'TABLE' && e.name === table)) {
      throw new Error(`core schema: таблица ${table} не найдена в 001_core_schema.sql`);
    }
  }
  const ownedSequences = new Set(
    entries
      .filter((e) => e.type === 'SEQUENCE OWNED BY')
      .filter((e) => tables.some((t) => e.body.includes(`OWNED BY public.${t}.`)))
      .map((e) => e.name),
  );
  const ownerOf = (name: string): string => name.split(' ')[0];
  const picked = entries.filter((e) => {
    switch (e.type) {
      case 'TABLE':
        return wanted.has(e.name);
      case 'SEQUENCE':
      case 'SEQUENCE OWNED BY':
        return ownedSequences.has(e.name);
      case 'DEFAULT':
      case 'CONSTRAINT':
        return wanted.has(ownerOf(e.name));
      case 'INDEX':
        return tables.some((t) => e.body.includes(` ON public.${t} USING `));
      default:
        return false;
    }
  });
  return picked.map((e) => e.body).join('\n\n').replace(/\bpublic\./g, '');
}
