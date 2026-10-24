import type { KbArticle } from '../kb.types';
import { start } from './start';
import { chat } from './chat';
import { speech } from './speech';

/** Все статьи справки. Порядок — порядок перечня в описании инструмента. */
export const KB_ARTICLES: readonly KbArticle[] = [start, chat, speech];
