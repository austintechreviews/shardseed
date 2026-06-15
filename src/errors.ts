export class ShardseedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShardseedError";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new ShardseedError(code, message);
}
