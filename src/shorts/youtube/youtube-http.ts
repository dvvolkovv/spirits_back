import axios from 'axios';

/** Ответ без исключения на статус: решения по статусам принимает вызывающий. */
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
  /** Таймаут, мс. */
  timeout: number;
}

/** Обрыв сети, таймаут, DNS — исключение; любой статус — ответ. Тесты подставляют свою функцию. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const axiosHttp: Http = async (req) => {
  const r = await axios.request({
    method: req.method,
    url: req.url,
    headers: req.headers,
    params: req.params,
    data: req.data,
    timeout: req.timeout,
    // Файл ролика — десятки МБ: без снятия пределов axios отказал бы до отправки.
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  return { status: r.status, headers: r.headers as Record<string, any>, data: r.data };
};

/**
 * Причина отказа Google коротко, не длиннее 300 знаков. Тело ошибки API —
 * `{error: {message, errors: [{reason}]}}`, тело OAuth — `{error, error_description}`.
 * Токенов в этих телах нет.
 */
export function googleReason(r: HttpResponse): string {
  const d = r.data;
  const err = d && typeof d === 'object' ? d.error : undefined;
  const reason =
    typeof err === 'string'
      ? [err, d.error_description].filter(Boolean).join(': ')
      : [err?.errors?.[0]?.reason, err?.message].filter(Boolean).join(': ');
  return `HTTP ${r.status}${reason ? ` ${reason}` : ''}`.slice(0, 300);
}
