// Настройки multer для файлов хода (POST /chat).
export function uploadOptions(dest) {
  return {
    dest,
    limits: { fileSize: 500 * 1024 * 1024 },
  };
}
