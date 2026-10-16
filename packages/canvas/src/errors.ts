/**
 * Every refusal this package makes goes through one error type.
 *
 * The `code` exists so a caller can tell "that document is not here" from
 * "those bytes failed their content check" without matching on prose. In a tool
 * the message *is* the API: the agent reads it, so each one has to be a sentence
 * it can act on rather than a bare "denied".
 */
export type CanvasErrorCode =
  | 'bad-request'
  | 'too-large'
  | 'limit'
  | 'not-found'
  | 'integrity'
  | 'forbidden'
  | 'closed';

export class CanvasError extends Error {
  readonly code: CanvasErrorCode;

  constructor(code: CanvasErrorCode, message: string) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
  }
}
