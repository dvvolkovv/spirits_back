import { RunnerConfig, DEFAULT_POLL_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from './config';
import { NDJsonEvent } from './claude';

export interface PollResult {
  /** `revertToSha` непустое => это служебный ход отката, а не запрос к агенту. */
  turn: { id: string; prompt: string; userId: string; revertToSha: string | null } | null;
  product: {
    checkoutPath: string;
    buildCmd: string | null;
    restartCmd: string | null;
    healthUrl: string | null;
    repoUrl: string | null;
    claudeSessionId: string | null;
  };
}

export interface CompletePayload {
  status: 'done' | 'failed' | 'reverted';
  result?: string;
  error?: string;
  shaBefore?: string;
  shaAfter?: string;
  tokens?: number;
}

/**
 * HTTP-клиент раннера к Linkeon — единственная связь клиентской VM с нами.
 *
 * Никакая ошибка связи не должна ронять раннер: он живёт на чужой машине,
 * сеть между ней и Linkeon не наша, а падение процесса означает, что продукт
 * клиента перестаёт обслуживаться до ручного вмешательства. Поэтому каждый
 * метод схлопывает любой отказ (сетевая ошибка, не-2xx, битый JSON) в
 * null/false — цикл раннера просто пробует снова на следующем poll.
 */
export class LinkeonApi {
  constructor(
    private readonly config: RunnerConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.config.linkeonUrl}/webhook/${path}`;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.runnerToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * turnId приходит от бэкенда (из ответа poll), не набирается клиентом
   * продукта напрямую — но подставлять его в путь без экранирования всё
   * равно не стоит: слэш или `..` в значении незаметно перенаправят запрос
   * на чужой маршрут. encodeURIComponent — та же защита в духе execFile в
   * git.ts, только для URL вместо шелла.
   */
  private turnUrl(turnId: string, suffix: string) {
    return this.url(`products/runner/turns/${encodeURIComponent(turnId)}/${suffix}`);
  }

  /**
   * Таймаут обязателен: без него повисший запрос блокирует цикл раннера
   * навсегда. Restart=always в systemd не спасает — процесс жив, просто
   * ничего не делает, и продукт клиента перестаёт обслуживаться молча.
   *
   * Реальная сеть виснет не так, как падает: заглохший TCP, обрыв без RST,
   * прокси, принявший соединение и замолчавший. Мок в тестах этого не умеет,
   * поэтому явление не видно на юнит-уровне вовсе.
   */
  private async withTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async poll(): Promise<PollResult | null> {
    try {
      const res = await this.withTimeout(
        this.url('products/runner/poll'),
        { method: 'POST', headers: this.headers() },
        this.config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      return (await res.json()) as PollResult;
    } catch {
      // Сеть легла, таймаут (в т.ч. наш собственный abort), DNS — что
      // угодно. Раннер попробует на следующем цикле, падать здесь нельзя.
      return null;
    }
  }

  async sendEvents(turnId: string, events: NDJsonEvent[]): Promise<boolean> {
    // Пустой пакет отправлять незачем — это не ошибка, а обычный вызов между
    // порциями событий, когда накопить ещё ничего не успели.
    if (events.length === 0) return true;
    try {
      const res = await this.withTimeout(
        this.turnUrl(turnId, 'events'),
        { method: 'POST', headers: this.headers(), body: JSON.stringify({ events }) },
        this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(turnId: string, payload: CompletePayload): Promise<boolean> {
    try {
      const res = await this.withTimeout(
        this.turnUrl(turnId, 'complete'),
        { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) },
        this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
