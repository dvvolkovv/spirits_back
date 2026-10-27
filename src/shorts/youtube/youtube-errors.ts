/** Доступа к каналу нет: Google ответил invalid_grant (доступ отозван) или 401 на свежий токен. Нужно переподключить. */
export class YoutubeAuthError extends Error {
  constructor(message: string) {
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
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeMaybeUploaded';
  }
}
