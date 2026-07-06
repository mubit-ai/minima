/**
 * linkbox — typed error hierarchy.
 *
 * Store and persistence code throw these; the app shell maps them onto HTTP
 * status codes in exactly one place (see app.ts) so individual handlers can
 * stay small and mostly declarative.
 */

/** Base class so `instanceof AppError` catches every typed failure. */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A uniqueness constraint would be violated (mapped to HTTP 409). */
export class ConflictError extends AppError {}

/** Input failed validation (mapped to HTTP 400). */
export class ValidationError extends AppError {}

/** Referenced entity does not exist (mapped to HTTP 404). */
export class NotFoundError extends AppError {}

/** A snapshot payload could not be decoded or failed shape checks (HTTP 400). */
export class SnapshotError extends AppError {}
