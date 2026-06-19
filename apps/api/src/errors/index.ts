export { ERR, type ErrorCode, type ErrorCatalogueEntry } from './codes.js';
export { HttpError, httpError, type HttpErrorOptions } from './http-error.js';
export {
  toEnvelope,
  toLogPayload,
  coerceToHttpError,
  type ErrorEnvelope,
  type ErrorLogPayload,
} from './serialize.js';
