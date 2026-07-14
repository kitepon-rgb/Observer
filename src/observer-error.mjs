export class ObserverError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ObserverError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new ObserverError(code, message, details);
}
