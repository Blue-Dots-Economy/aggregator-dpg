/**
 * Typed error hierarchy for the aggregator-dpg platform.
 *
 * All domain errors extend BaseError, enabling programmatic handling
 * via instanceof checks without string-matching error messages.
 *
 * @module @aggregator-dpg/shared-primitives/errors
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

export interface SerializedError {
  name: string;
  code: string;
  message: string;
  details?: ErrorDetails;
  cause?: string;
}

/**
 * Root of the aggregator-dpg error hierarchy.
 *
 * @param code - Machine-readable error code (e.g. "UPSTREAM_TIMEOUT").
 * @param message - Human-readable description.
 * @param options - Optional cause and structured details.
 */
export class BaseError extends Error {
  readonly code: string;
  readonly details?: ErrorDetails;

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; details?: ErrorDetails },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serializes the error to a plain object suitable for JSON logging.
   *
   * @returns SerializedError with name, code, message, and optional details/cause.
   */
  toJSON(): SerializedError {
    const result: SerializedError = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) result.details = this.details;
    if (this.cause !== undefined) result.cause = String(this.cause);
    return result;
  }
}

/**
 * Failure from an external upstream service (timeout, 5xx, network error).
 *
 * @param code - Error code (defaults to "UPSTREAM_ERROR").
 * @param message - Human-readable description.
 * @param options - Optional cause and details.
 */
export class UpstreamError extends BaseError {
  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: ErrorDetails },
  ) {
    super(options?.code ?? 'UPSTREAM_ERROR', message, options);
  }
}

/**
 * Invalid or missing configuration at startup or runtime.
 *
 * @param code - Error code (defaults to "CONFIG_ERROR").
 * @param message - Human-readable description.
 * @param options - Optional cause and details.
 */
export class ConfigError extends BaseError {
  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: ErrorDetails },
  ) {
    super(options?.code ?? 'CONFIG_ERROR', message, options);
  }
}

/**
 * Authentication or authorisation failure.
 *
 * @param code - Error code (defaults to "AUTH_ERROR").
 * @param message - Human-readable description.
 * @param options - Optional cause and details.
 */
export class AuthError extends BaseError {
  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: ErrorDetails },
  ) {
    super(options?.code ?? 'AUTH_ERROR', message, options);
  }
}

/**
 * Input validation failure — malformed or out-of-range data.
 *
 * @param code - Error code (defaults to "VALIDATION_ERROR").
 * @param message - Human-readable description.
 * @param options - Optional cause and details.
 */
export class ValidationError extends BaseError {
  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: ErrorDetails },
  ) {
    super(options?.code ?? 'VALIDATION_ERROR', message, options);
  }
}

/**
 * Business-logic invariant violation (domain rule broken).
 *
 * @param code - Error code (defaults to "DOMAIN_ERROR").
 * @param message - Human-readable description.
 * @param options - Optional cause and details.
 */
export class DomainError extends BaseError {
  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: ErrorDetails },
  ) {
    super(options?.code ?? 'DOMAIN_ERROR', message, options);
  }
}
