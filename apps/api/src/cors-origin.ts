/**
 * CORS origin for the API.
 *
 * Restricted to one configured web origin. `*` is never a default and is
 * refused even if an operator writes it — a wildcard would let any page
 * read session policy and payment history.
 */
export const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

export function resolveCorsOrigin(
  raw: string | undefined = process.env.CORS_ORIGIN,
): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed === "*") {
    return DEFAULT_CORS_ORIGIN;
  }
  return trimmed;
}
