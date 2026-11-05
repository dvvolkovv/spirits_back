export class AlertBotRetryableError extends Error {
  override readonly name = 'AlertBotRetryableError';

  constructor(readonly kind: string) {
    super('alert bot operation requires a durable retry');
    this.kind = /^[a-z][a-z0-9_.-]{0,40}$/i.test(kind) ? kind : 'error';
  }
}
