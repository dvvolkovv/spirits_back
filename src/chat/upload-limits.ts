/**
 * Потолок загрузки в чат — на файл и на всю пачку. Здесь, а не в
 * chat.controller.ts, чтобы справка (platform-kb/values.ts) брала то же число,
 * не загружая контроллер. Копия на фронте — utils/uploadLimits.ts.
 */
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
