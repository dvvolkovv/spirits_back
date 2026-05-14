// src/smm/billing/insufficient-tokens.error.ts
export class InsufficientTokensError extends Error {
  readonly status = 402;
  constructor(public balance: number, public required: number) {
    super('insufficient_tokens');
    this.name = 'InsufficientTokensError';
  }
}
