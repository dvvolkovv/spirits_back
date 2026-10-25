/**
 * Все статьи справки одним файлом — для вычитки владельцем и для глаз при правке.
 *   npx ts-node scripts/render-kb.ts [язык] [клиент] > kb.md
 * Клиент: web | app | store | telegram. По умолчанию ru, web.
 */
import { KB_ARTICLES } from '../src/platform-kb/articles';
import type { KbClient } from '../src/platform-kb/kb.types';
import { renderArticle } from '../src/platform-kb/render';

const lang = process.argv[2] || 'ru';
const client = (process.argv[3] || 'web') as KbClient;
for (const a of KB_ARTICLES) {
  if (client === 'store' && a.paidOnly) continue;
  process.stdout.write(`${renderArticle(a, lang, client)}\n\n---\n\n`);
}
