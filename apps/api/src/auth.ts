/**
 * Operator authentication for the console surface.
 *
 * The console reads session policy and payment history and owns the kill
 * switch. Until now every one of those routes was open to anything that
 * could reach the port, which means an unauthenticated `POST
 * /v1/session/revoke` could end a paying agent's session.
 *
 * ## Why the seller routes are deliberately excluded
 *
 * A buyer is not an operator and must never hold the operator token. The
 * buyer authenticates by *paying* — a signed Permit2 authorization the
 * seller verifies on chain — which is a far stronger claim than a shared
 * secret. Requiring a token there would break every third-party b402
 * client and buy nothing.
 *
 * That split is not expressible as a path prefix, because the two
 * surfaces collide:
 *
 *   POST /v1/streams           buyer  — open a stream
 *   GET  /v1/streams           operator — list stream snapshots
 *   GET  /v1/streams/:id/next  buyer  — fetch a segment
 *
 * Same path, different audience, decided by method. So the guard is
 * mounted on the console router itself rather than as a global prefix
 * match, and this module exports the predicate so the split is stated
 * once and testable on its own.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getLog } from "./middleware.js";

/** The env var carrying the operator token. */
export const CONSOLE_TOKEN_ENV = "CONSOLE_API_TOKEN";

/**
 * How the process should treat console auth.
 *
 * `disabled` is a real, reachable state: a developer running against a
 * local ledger with no chain wiring should not need to mint a token. It
 * is loud rather than silent — the runtime logs a warning at boot — and
 * it is never chosen implicitly in a deployment, because
 * `requireConsoleAuth` makes an unset token fatal whenever the process
 * is not obviously local.
 */
export type ConsoleAuthMode =
  { kind: "enforced"; token: string } | { kind: "disabled"; reason: string };

/**
 * Minimum token length.
 *
 * Not a password-strength heuristic: a short shared secret on an
 * endpoint that revokes sessions is worth refusing outright, and 32
 * characters is what `openssl rand -hex 16` produces.
 */
export const MIN_TOKEN_LENGTH = 32;

export class WeakConsoleTokenError extends Error {
  constructor(length: number) {
    super(
      `${CONSOLE_TOKEN_ENV} is ${length} characters; at least ${MIN_TOKEN_LENGTH} are required. ` +
        `This token guards session revocation. Generate one with \`openssl rand -hex 32\`.`,
    );
    this.name = "WeakConsoleTokenError";
  }
}

/**
 * Resolve the auth mode from the environment.
 *
 * A token that is present but too short is an error rather than a
 * downgrade to `disabled`: an operator who set the variable meant to
 * turn auth on, and silently ignoring them would leave the kill switch
 * open while the config says otherwise.
 */
export function resolveConsoleAuth(
  env: NodeJS.ProcessEnv = process.env,
): ConsoleAuthMode {
  const raw = env[CONSOLE_TOKEN_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    return {
      kind: "disabled",
      reason: `${CONSOLE_TOKEN_ENV} is not set`,
    };
  }
  if (raw.length < MIN_TOKEN_LENGTH) {
    throw new WeakConsoleTokenError(raw.length);
  }
  return { kind: "enforced", token: raw };
}

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * length oracle, so both sides are hashed to a fixed width first. Using
 * the raw byte lengths and returning early would tell an attacker the
 * token's length one request at a time.
 */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still do the comparison, against a same-length buffer, so the
    // rejection path costs the same as a wrong-value rejection.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Read the bearer token from an `Authorization` header.
 *
 * Only the `Bearer` scheme is accepted. A token in a query string would
 * land in access logs and browser history, so it is not supported.
 */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Guard the console routes.
 *
 * Answers 401 with a `WWW-Authenticate` challenge when the token is
 * missing or wrong. The failure is logged at warn with the request id
 * and path but never with the presented token: logging a rejected
 * secret turns the log into a place attackers' guesses accumulate, and
 * a near-miss in a log file is a near-miss an insider can read.
 */
export function consoleAuth(mode: ConsoleAuthMode): MiddlewareHandler {
  return async (c, next) => {
    if (mode.kind === "disabled") {
      await next();
      return;
    }

    const presented = readBearerToken(c.req.header("authorization"));
    if (presented === null || !secretsMatch(presented, mode.token)) {
      getLog(c).warn(
        {
          method: c.req.method,
          path: c.req.path,
          reason: presented === null ? "no-bearer-token" : "token-mismatch",
        },
        "console request rejected: operator authentication failed",
      );
      c.header("WWW-Authenticate", 'Bearer realm="neuro-pay console"');
      return c.json(
        {
          error: {
            message: "Unauthorized",
            detail:
              "The operator console requires a bearer token. " +
              `Set ${CONSOLE_TOKEN_ENV} on the API and send it as \`Authorization: Bearer <token>\`.`,
            requestId: c.get("requestId"),
          },
        },
        401,
      );
    }

    await next();
  };
}
