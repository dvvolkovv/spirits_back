import { loadFont } from '@remotion/google-fonts/Nunito';

// Nunito — как в мультфильме Linkeon. Кириллица обязательна.
export const { fontFamily } = loadFont('normal', { weights: ['700', '800', '900'], subsets: ['cyrillic', 'latin'] });

export const W = 1080;
export const H = 1920;
/** Линия, на которую встаёт середина абзаца: выше субтитров и нижних кнопок площадок. */
export const ANCHOR_Y = 760;

/** Палитра кабинета (tailwind forest). */
export const C = {
  forest500: '#4ade80',
  forest600: '#2dd4bf',
  forest700: '#0d9488',
  forest900: '#134e4a',
  ink: '#0b1f1e',
  white: '#ffffff',
  shade: 'rgba(11, 31, 30, 0.78)',
};
