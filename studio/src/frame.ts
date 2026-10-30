/**
 * Кадр ролика — один источник для съёмки и композиции. Съёмка: окно
 * CAPTURE_VIEWPORT при плотности CAPTURE_SCALE даёт снимок шириной ровно
 * FRAME.width. Композиция Remotion — FRAME целиком (remotion/theme.ts).
 * Проверка готового файла — тот же FRAME (ffprobe.ts, SHORT_LIMITS).
 */
export const FRAME = { width: 1080, height: 1920 } as const;
export const CAPTURE_SCALE = 3;
export const CAPTURE_VIEWPORT = { width: FRAME.width / CAPTURE_SCALE, height: FRAME.height / CAPTURE_SCALE } as const;

/**
 * Нижняя зона интерфейса площадок — подпись, канал, кнопки: у Shorts 18 % высоты
 * кадра, у Reels 20 %, у TikTok 22 % (таблица ffmpeg-skill, scripts/_platforms.py).
 * Текст ниже этой линии в ленте закрыт.
 */
export const UI_BOTTOM = Math.ceil(FRAME.height * 0.22);
