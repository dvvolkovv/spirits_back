import type { KbArticle } from '../kb.types';
import { start } from './start';
import { chat } from './chat';
import { call } from './call';
import { meetings } from './meetings';
import { speech } from './speech';

/** Все статьи справки. Порядок — порядок перечня в описании инструмента. */
export const KB_ARTICLES: readonly KbArticle[] = [start, chat, call, meetings, speech];
