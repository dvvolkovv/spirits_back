import type { KbArticle } from '../kb.types';
import { start } from './start';
import { chat } from './chat';
import { call } from './call';
import { meetings } from './meetings';
import { networking } from './networking';
import { images } from './images';
import { video } from './video';
import { speech } from './speech';
import { studioAssistants } from './studio-assistants';
import { studioBots } from './studio-bots';
import { products } from './products';
import { profile } from './profile';
import { calendars } from './calendars';
import { routines } from './routines';
import { tokens } from './tokens';
import { payments } from './payments';
import { partners } from './partners';
import { apps } from './apps';

/** Все статьи справки. Порядок — порядок перечня в описании инструмента. */
export const KB_ARTICLES: readonly KbArticle[] = [
  start, chat, call, meetings, networking, images, video, speech, studioAssistants, studioBots, products, profile,
  calendars, routines, tokens, payments, partners, apps,
];
