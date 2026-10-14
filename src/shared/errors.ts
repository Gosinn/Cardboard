/**
 * Every error Cardboard returns has a stable `code`, a plain-English `message`
 * and, where we can tell, a `hint` saying how to fix it.
 */
export class CardboardError extends Error {
  readonly code: string;
  readonly status: number;
  /** The message without the hint. */
  readonly reason: string;
  readonly hint: string | undefined;

  constructor(code: string, status: number, reason: string, hint?: string) {
    super(hint ? `${reason} ${hint}` : reason);
    this.name = "CardboardError";
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.hint = hint;
  }

  toJSON() {
    return { code: this.code, message: this.reason, hint: this.hint };
  }
}

export function fail(code: string, status: number, message: string, hint?: string): CardboardError {
  return new CardboardError(code, status, message, hint);
}
