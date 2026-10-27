/**
 * Доступа к каналу нет: при обновлении токена Google ответил invalid_grant (доступ
 * отозван) или unauthorized_client, либо токен не расшифровался, либо канал не подключён
 * (строки аккаунта нет или она отозвана). Нужно переподключить.
 * pendingUpload — у ролика жива сессия прошлой загрузки: она могла дойти, и к набору
 * нужно предупреждение проверить канал.
 */
export class YoutubeAuthError extends Error {
  constructor(message: string, readonly pendingUpload = false) {
    super(message);
    this.name = 'YoutubeAuthError';
  }
}

/** Ролика на YouTube точно нет: отказ до или вместо загрузки. Повтор безопасен. */
export class YoutubeNotUploaded extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'YoutubeNotUploaded';
  }
}

/** Файл ушёл, а ответа нет: ролик мог загрузиться. Новая загрузка — только после вопроса о сессии. */
export class YoutubeMaybeUploaded extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'YoutubeMaybeUploaded';
  }
}

/**
 * YouTube больше не знает сессию прошлой загрузки (404/410 — истекла): дошла ли она,
 * спросить не у кого. Новую загрузку вслепую не начинаем — набор с просьбой проверить канал.
 */
export class YoutubeUploadExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeUploadExpired';
  }
}

/**
 * Попытка публикации уже не владеет строкой YouTube: пока она висела, сторож вернул
 * ролик в очередь, и строку захватила новая попытка (жетон — attempts захвата — не
 * совпал), или сторож уже перевёл строку в failed. Такая попытка ничего не пишет и не
 * шлёт: ни файла, ни отказа, ни набора, ни итога ролика — это теперь дело новой попытки.
 */
export class YoutubeAttemptSuperseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeAttemptSuperseded';
  }
}

/** Google отверг код входа (invalid_grant): код одноразовый и короткоживущий — чаще всего браузер повторил адрес возврата. */
export class YoutubeCodeRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeCodeRejected';
  }
}
