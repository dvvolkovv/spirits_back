import axios from 'axios';

/**
 * Ответ без исключения на статус: решения по статусам принимает вызывающий.
 * Имена заголовков — в нижнем регистре, как их отдаёт Node: `headers.location`, `headers.range`.
 */
export interface HttpResponse {
  status: number;
  headers: Record<string, any>;
  data: any;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: any;
  /** Общий срок запроса, мс: от начала до ответа, включая выгрузку тела. */
  timeout: number;
}

/** Обрыв сети, таймаут, DNS — исключение; любой статус — ответ. Тесты подставляют свою функцию. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** Обрезка до n знаков, не разрезая суррогатную пару: одинокий суррогат ломает JSON Telegram. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, n - 1) : s.slice(0, n);
}

/** Свой экземпляр: глобальные умолчания и перехватчики axios других модулей сюда не попадают. */
const client = axios.create();

export const axiosHttp: Http = async (req) => {
  // timeout у axios в Node — срок простоя сокета, а не всего запроса; общий срок держит AbortController.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), req.timeout);
  try {
    const r = await client.request({
      method: req.method,
      url: req.url,
      headers: req.headers,
      params: req.params,
      data: req.data,
      responseType: 'json',
      timeout: req.timeout,
      signal: abort.signal,
      // 308 у Google — «Resume Incomplete», а не редирект; за редиректами не ходим вовсе.
      maxRedirects: 0,
      // Файл ролика — десятки МБ: пределы снимаем явно, не полагаясь на умолчания версии axios.
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    return { status: r.status, headers: r.headers as Record<string, any>, data: r.data };
  } catch (e: any) {
    // AxiosError несёт config — форму с client_secret и refresh-токеном, Bearer, адрес сессии.
    // Наружу — только код и сообщение: они уходят в логи, в last_error и владельцу.
    throw new Error(clip([e?.code, e?.message].filter(Boolean).join(': ') || 'сетевая ошибка', 200));
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Причина отказа Google коротко, не длиннее 300 знаков. Тело ошибки API —
 * `{error: {message, errors: [{reason}]}}`, тело OAuth — `{error, error_description}`;
 * токенов в них нет. Строковые тела (HTML) не берём намеренно: страница Google с
 * ошибкой 404 содержит путь с upload_id — ключом сессии загрузки.
 */
export function googleReason(r: HttpResponse): string {
  const d = r.data;
  const err = d && typeof d === 'object' ? d.error : undefined;
  const reason =
    typeof err === 'string'
      ? [err, d.error_description].filter(Boolean).join(': ')
      : [err?.errors?.[0]?.reason, err?.message].filter(Boolean).join(': ');
  return clip(`HTTP ${r.status}${reason ? ` ${reason}` : ''}`, 300);
}
