export class EscapeHatchError extends Error {
  constructor(public readonly sceneIdx: number, message: string) {
    super(message);
    this.name = 'EscapeHatchError';
  }
}
