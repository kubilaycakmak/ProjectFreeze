export class Fault extends Error {
  /** @param {string} code @param {string} message @param {unknown} [details] */
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} error */
export function problem(error) {
  if (error instanceof Fault) return { code: error.code, message: error.message, details: error.details };
  return { code: 'INTERNAL', message: 'An internal operation failed. Inspect the operation journal.' };
}

/** @param {string} code */
export function exitCode(code) {
  return ({ USAGE: 2, NOT_FOUND: 3, DENIED: 4, UNSUPPORTED: 5, BUSY: 6, PARTIAL: 7,
    CANCELLED: 8, UNAVAILABLE: 9, INTERNAL: 1 })[code] ?? 1;
}
