// Настройки multer для файлов хода (POST /chat).
//
// defParamCharset: busboy по умолчанию читает filename из Content-Disposition
// как latin1, а бэк (form-data) и браузеры шлют его в UTF-8. Без этой
// настройки кириллическое имя доезжало до промпта модели латинской мешаниной,
// и ассистент говорил человеку, что у файлов битые имена (17.11.2026).
// Имя с явной кодировкой (filename*=UTF-8''…) busboy декодирует по ней и так.
export function uploadOptions(dest) {
  return {
    dest,
    limits: { fileSize: 500 * 1024 * 1024 },
    defParamCharset: "utf8",
  };
}
