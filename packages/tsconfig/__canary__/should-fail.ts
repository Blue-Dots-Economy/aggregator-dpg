/**
 * Canary fixture — must NOT compile under base.json strict rules.
 * Used by typecheck:canary to verify strict flags are active.
 * Never include this file in normal typecheck.
 */

// noUncheckedIndexedAccess: array[0] is string | undefined, not string
const arr: string[] = ['a', 'b'];
const first: string = arr[0]; // TS2322 — arr[0] is string | undefined

// strictNullChecks: null not assignable to string
const name: string = null; // TS2322

export {};
