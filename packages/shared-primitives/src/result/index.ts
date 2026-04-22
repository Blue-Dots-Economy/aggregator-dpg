/**
 * Result<T, E> — a discriminated union for explicit error propagation.
 *
 * Prefer Result over thrown exceptions for expected failure paths.
 * Use ok() and err() to construct, and match()/map()/flatMap() to consume.
 *
 * @module @aggregator-dpg/shared-primitives/result
 */

/** Successful variant of Result. */
export interface Ok<T> {
  readonly success: true;
  readonly value: T;
}

/** Failure variant of Result. */
export interface Err<E> {
  readonly success: false;
  readonly error: E;
}

/** Discriminated union representing either a success value or a failure error. */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Constructs a successful Result wrapping the given value.
 *
 * @param value - The success value.
 * @returns Ok<T>
 */
export function ok<T>(value: T): Ok<T> {
  return { success: true, value };
}

/**
 * Constructs a failure Result wrapping the given error.
 *
 * @param error - The failure value.
 * @returns Err<E>
 */
export function err<E>(error: E): Err<E> {
  return { success: false, error };
}

/**
 * Exhaustive pattern-match over a Result.
 *
 * @param result - The Result to inspect.
 * @param handlers - Object with onOk and onErr callbacks.
 * @returns The return value of whichever handler was invoked.
 */
export function match<T, E, R>(
  result: Result<T, E>,
  handlers: { onOk: (value: T) => R; onErr: (error: E) => R },
): R {
  return result.success ? handlers.onOk(result.value) : handlers.onErr(result.error);
}

/**
 * Transforms the success value of a Result, leaving errors unchanged.
 *
 * @param result - Input Result.
 * @param fn - Mapping function applied to the success value.
 * @returns A new Result with the transformed value, or the original error.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.success ? ok(fn(result.value)) : result;
}

/**
 * Chains a Result-returning function over a success value.
 *
 * @param result - Input Result.
 * @param fn - Function that receives the success value and returns a new Result.
 * @returns The inner Result if the input was Ok, or the original error.
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.success ? fn(result.value) : result;
}

/**
 * Transforms the error of a Result, leaving successes unchanged.
 *
 * @param result - Input Result.
 * @param fn - Mapping function applied to the error value.
 * @returns A new Result with the transformed error, or the original success.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.success ? result : err(fn(result.error));
}

/**
 * Returns the success value or throws the error.
 *
 * @param result - Input Result.
 * @returns The success value.
 * @throws The error value if the Result is Err.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.success) return result.value;
  throw result.error;
}

/**
 * Returns the success value or a provided fallback.
 *
 * @param result - Input Result.
 * @param fallback - Value to return if the Result is Err.
 * @returns The success value or the fallback.
 */
export function getOrElse<T, E>(result: Result<T, E>, fallback: T): T {
  return result.success ? result.value : fallback;
}
