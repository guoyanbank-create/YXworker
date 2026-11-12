/** HTTP 错误：统一 JSON 错误体 { error: { code, message, details? } }。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(400, code, message, details);
}

export function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(409, code, message, details);
}

export function unprocessable(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(422, code, message, details);
}
