import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TalerIdNotesConnector } from '../talerid/talerid-notes.connector';
import { RecallCandidate, RecallItem, RecallKind, capRecall, rankRecall } from './recall';

/** Сколько прошлых разговоров просматриваем. Больше полусотни человек не помнит и сам. */
const TALKS_LIMIT = 50;
/** Сколько строк каждого вида показываем в преамбуле звонка. */
const DIGEST_EACH = 5;
/** Потолок темы разговора в витрине: это подпись, а не пересказ. */
const DIGEST_TITLE_CHARS = 60;

/**
 * Что ассистент может вспомнить: заметки человека и резюме его прошлых разговоров.
 *
 * ⚠️ `userId` сюда приходит ТОЛЬКО со стороны сервера — из звонка по `callId`.
 * Аргументом инструмента его подменил бы кто угодно, у кого есть подпись
 * воркера; то же правило, что у ходового токена MCP («пользователь из
 * подписи, аргумента userId нет», `src/mcp/linkeon-tool.token.ts`).
 *
 * Спека: `docs/superpowers/specs/2026-11-14-roman-recall-design.md`.
 */
@Injectable()
export class RecallService {
  private readonly logger = new Logger(RecallService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly notes?: TalerIdNotesConnector,
  ) {}

  /** Найти не больше трёх кусков записанного по запросу, сказанному вслух. */
  async search(userId: string, query: string, kind?: RecallKind): Promise<RecallItem[]> {
    const [notes, talks] = await Promise.all([
      kind === 'talk' ? Promise.resolve([]) : this.noteCandidates(userId),
      kind === 'note' ? Promise.resolve([]) : this.talkCandidates(userId),
    ]);
    return capRecall(rankRecall([...notes, ...talks], query));
  }

  /**
   * Витрина для преамбулы: только заголовки и даты.
   *
   * Без неё инструмент не позовут. Модель не ищет там, где не знает, что
   * что-то есть, — и вместо поиска честно отвечает «у меня нет доступа»
   * (живой звонок 13.11.2026). Текста здесь нет намеренно: преамбула едет в
   * каждый звонок и платится аудио-токенами.
   */
  async digest(userId: string): Promise<string> {
    const [notes, talks] = await Promise.all([
      this.noteCandidates(userId),
      this.talkCandidates(userId),
    ]);
    const line = (c: RecallCandidate) => {
      const d = c.at ? new Date(c.at) : null;
      const when = d ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}` : '';
      const title = c.title.length > DIGEST_TITLE_CHARS
        ? c.title.slice(0, DIGEST_TITLE_CHARS - 1) + '…'
        : c.title;
      return when ? `${when} ${title}` : title;
    };
    const fresh = (list: RecallCandidate[]) =>
      [...list].sort((a, b) => b.at - a.at).slice(0, DIGEST_EACH).map(line).filter(Boolean);

    const parts: string[] = [];
    const n = fresh(notes);
    const t = fresh(talks);
    if (n.length) parts.push(`Заметки: ${n.join('; ')}`);
    if (t.length) parts.push(`Прошлые разговоры: ${t.join('; ')}`);
    if (!parts.length) return '';
    return (
      '--- Что уже записано ---\n' +
      'Это только заголовки. Текст доставай инструментом recall, не придумывай по заголовку.\n' +
      parts.join('\n')
    );
  }

  /**
   * Заметки живут в TalerID через MCP. Его падение не повод отвечать «ничего
   * не помню»: разговоры лежат в нашей базе и возвращаются в любом случае.
   */
  private async noteCandidates(userId: string): Promise<RecallCandidate[]> {
    if (!this.notes) return [];
    try {
      const list = await this.notes.listNotes(userId);
      return (list || []).map((n) => ({
        kind: 'note' as const,
        title: String(n.title || '').trim() || 'Заметка',
        text: String(n.content || ''),
        at: n.updatedAt ? new Date(n.updatedAt).getTime() || 0 : 0,
      }));
    } catch (e: any) {
      this.logger.warn(`заметки для ${userId} не прочитались: ${e?.message}`);
      return [];
    }
  }

  /**
   * Резюме прошлых разговоров — настоящая нить тем.
   *
   * Заметка появляется, только если ассистент предложил, а человек
   * подтвердил (14.11.2026: предложил, подтверждения не было, портрет остался
   * бы нигде). Резюме пишется после каждого завершённого звонка.
   */
  private async talkCandidates(userId: string): Promise<RecallCandidate[]> {
    try {
      const res = await this.pg.query(
        `SELECT started_at, summary FROM voice_calls
          WHERE user_id = $1 AND status = 'completed'
            AND summary IS NOT NULL AND btrim(summary) <> ''
          ORDER BY started_at DESC LIMIT ${TALKS_LIMIT}`,
        [userId],
      );
      return (res.rows || []).map((r: any) => {
        const summary = String(r.summary || '');
        return {
          kind: 'talk' as const,
          title: RecallService.topicOf(summary),
          text: summary,
          at: new Date(r.started_at).getTime() || 0,
        };
      });
    } catch (e: any) {
      this.logger.warn(`прошлые разговоры для ${userId} не прочитались: ${e?.message}`);
      return [];
    }
  }

  /**
   * Тема разговора — первая строка резюме без разметки.
   *
   * Резюме начинается с «**О чём говорили:** …», поэтому звёздочки и служебный
   * зачин снимаются: подпись в витрине должна читаться вслух как тема.
   */
  private static topicOf(summary: string): string {
    const first = summary.split('\n').map((s) => s.trim()).find(Boolean) || 'Разговор';
    const clean = first
      .replace(/\*\*/g, '')
      .replace(/^о чём говорили:\s*/i, '')
      .trim();
    return clean.length > 120 ? clean.slice(0, 119) + '…' : clean;
  }
}
