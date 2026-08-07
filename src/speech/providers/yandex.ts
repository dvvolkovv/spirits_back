// src/speech/providers/yandex.ts
import axios from 'axios';

/**
 * Синтез через Yandex SpeechKit v1. Просим сразу mp3 (в отличие от
 * worker/src/tts/yandex.ts, которому нужен LPCM под ffmpeg-пайплайн Remotion).
 *
 * Лимит текста: SpeechKit режет тело запроса на 15 КБ, а кириллица в
 * `application/x-www-form-urlencoded` кодируется как `%XX` — по 6 байт на
 * символ вместо 1. Число символов, которое пролезет, зависит от алфавита;
 * не считать "символов" фиксированной величиной и не поднимать лимит здесь
 * без пересчёта в байтах после percent-encoding. Порог проверяется в
 * сервисе синтеза (следующая задача), не в адаптере.
 */
export async function synthesizeYandex(text: string, voice: string): Promise<Buffer> {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_TTS_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error('YANDEX_SPEECHKIT_API_KEY or YANDEX_TTS_FOLDER_ID not configured');
  }

  const params = new URLSearchParams();
  params.set('text', text);
  params.set('lang', 'ru-RU');
  params.set('voice', voice);
  params.set('format', 'mp3');
  params.set('folderId', folderId);

  let r;
  try {
    r = await axios.post(
      'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
      params.toString(),
      {
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true,
      },
    );
  } catch (err) {
    // validateStatus:true делает axios resolve'ящимся на любой HTTP-ответ —
    // сюда попадают только сетевые сбои (timeout, ECONNREFUSED, DNS). Ловим
    // отдельно и перевыбрасываем чистое сообщение: AxiosError.config несёт
    // заголовок Authorization с ключом и тело запроса с текстом пользователя,
    // и если этот объект где-то залогируют целиком (а не через err.message),
    // оба утекут в лог. Дальше наружу уходит только err.message.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Yandex TTS request failed: ${message}`);
  }
  if (r.status !== 200) {
    const errBody = Buffer.from(r.data).toString('utf8').slice(0, 200);
    throw new Error(`Yandex TTS ${r.status}: ${errBody}`);
  }
  const buf = Buffer.from(r.data);
  if (buf.length === 0) throw new Error('Yandex TTS returned empty body');
  return buf;
}
