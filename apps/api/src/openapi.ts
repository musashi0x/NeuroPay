/**
 * OpenAPI 3.1 document for the seller and console HTTP surface.
 *
 * Types in `@neuro-pay/types` remain the source of truth. This is a
 * documented projection so a client generator (or an operator) can see
 * the routes without reading the Hono source. Amounts travel as decimal
 * strings because JSON cannot carry `bigint`.
 */

const amount = {
  type: "string",
  pattern: "^-?\\d+$",
  description:
    "Token amount in smallest units, encoded as a decimal string so 18-decimal values survive JSON.",
} as const;

const errorBody = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
        requestId: { type: "string" },
      },
    },
  },
} as const;

const bearer = [{ bearerAuth: [] }];

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "NeuroPay API",
    version: "0.0.0",
    description:
      "Metered x402 seller, operator console, and readiness surface. Token amounts are decimal strings.",
  },
  servers: [{ url: "/", description: "This process" }],
  tags: [
    {
      name: "buyer",
      description: "Unauthenticated; a buyer proves itself by paying.",
    },
    { name: "console", description: "Operator token." },
    {
      name: "ops",
      description:
        "Readiness, metrics, audit. Operator token except /ready and /openapi.json.",
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "CONSOLE_API_TOKEN. Unset locally means the console is open.",
      },
    },
    schemas: {
      Amount: amount,
      HealthResponse: {
        type: "object",
        required: ["status", "service", "timestamp"],
        properties: {
          status: { type: "string", const: "ok" },
          service: { type: "string", const: "api" },
          timestamp: { type: "string", format: "date-time" },
        },
      },
      StreamOpenResponse: {
        type: "object",
        required: [
          "streamId",
          "priceSheet",
          "chainId",
          "token",
          "tokenDecimals",
          "payTo",
          "openedAt",
          "expiresAt",
          "maxSecondsPerSegment",
          "maxUnitsPerSegment",
        ],
        properties: {
          streamId: { type: "string" },
          chainId: { type: "integer" },
          token: { type: "string" },
          tokenDecimals: { type: "integer" },
          payTo: { type: "string" },
          openedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          maxSecondsPerSegment: { type: "integer" },
          maxUnitsPerSegment: { type: "integer" },
          priceSheet: {
            type: "object",
            properties: {
              perCall: amount,
              perSecond: amount,
              perUnit: amount,
              unitName: { type: "string" },
              tokenDecimals: { type: "integer" },
            },
          },
        },
      },
      SegmentResponse: {
        type: "object",
        properties: {
          streamId: { type: "string" },
          sequence: { type: "integer" },
          data: { type: "string" },
          secondsDelivered: { type: "integer" },
          unitsDelivered: { type: "integer" },
          accruedUnpaid: amount,
          totalAccrued: amount,
          streamEnded: { type: "boolean" },
          endReason: { type: ["string", "null"] },
        },
      },
      Error: errorBody,
      AutoRevokeOnFailureView: {
        type: "object",
        required: ["enabled", "lastFiredAt"],
        properties: {
          enabled: {
            type: "boolean",
            description:
              "Whether the runtime auto-revoke safety net is armed. Process-local; defaults to false on restart.",
          },
          lastFiredAt: {
            type: ["string", "null"],
            format: "date-time",
            description:
              "ISO-8601 wall-clock time of the most recent threshold crossing, or null if the watcher has never fired.",
          },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["buyer"],
        summary: "Liveness",
        responses: {
          "200": {
            description: "Process is running",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/ready": {
      get: {
        tags: ["ops"],
        summary: "Readiness (unauthenticated, verdicts only)",
        responses: {
          "200": { description: "Ready or degraded" },
          "503": { description: "A probe is down" },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["ops"],
        summary: "This document",
        responses: {
          "200": {
            description: "OpenAPI 3.1",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/v1/streams": {
      post: {
        tags: ["buyer"],
        summary: "Open a metered stream",
        responses: {
          "200": {
            description: "Stream opened",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StreamOpenResponse" },
              },
            },
          },
          "503": { description: "At the concurrent-stream ceiling" },
        },
      },
      get: {
        tags: ["console"],
        summary: "List streams",
        security: bearer,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["active", "ended", "abandoned"] },
          },
        ],
        responses: {
          "200": { description: "{ streams, nextCursor }" },
          "401": { description: "Missing or wrong operator token" },
        },
      },
    },
    "/v1/streams/{id}/next": {
      get: {
        tags: ["buyer"],
        summary: "Next segment (may 402)",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Segment delivered",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SegmentResponse" },
              },
            },
          },
          "402": { description: "Payment required; body is x402 accepts[]" },
          "404": { description: "Unknown or ended stream" },
        },
      },
    },
    "/v1/session": {
      get: {
        tags: ["console"],
        summary: "Active session policy",
        security: bearer,
        responses: {
          "200": { description: "SessionPolicyView" },
          "404": { description: "No session" },
        },
      },
    },
    "/v1/payments": {
      get: {
        tags: ["console"],
        summary: "Ledger history, newest first",
        security: bearer,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "event", in: "query", schema: { type: "string" } },
          { name: "streamId", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "{ payments, nextCursor }" },
        },
      },
    },
    "/v1/budget": {
      get: {
        tags: ["console"],
        summary: "Window spend vs both limits",
        security: bearer,
        responses: { "200": { description: "BudgetState" } },
      },
    },
    "/v1/events": {
      get: {
        tags: ["console"],
        summary: "SSE console snapshots",
        security: bearer,
        responses: { "200": { description: "text/event-stream" } },
      },
    },
    "/v1/session/revoke": {
      post: {
        tags: ["console"],
        summary: "Two-stage kill switch",
        security: bearer,
        responses: { "200": { description: "RevokeResult" } },
      },
    },
    "/v1/session/revoke/retry": {
      post: {
        tags: ["console"],
        summary: "Retry on-chain revoke",
        security: bearer,
        responses: { "200": { description: "RevokeResult" } },
      },
    },
    "/v1/session/auto-revoke": {
      get: {
        tags: ["console"],
        summary: "Read the auto-revoke-on-failure flag state",
        security: bearer,
        responses: {
          "200": {
            description: "AutoRevokeOnFailureView",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AutoRevokeOnFailureView",
                },
              },
            },
          },
          "401": { description: "Missing or wrong operator token" },
        },
      },
      put: {
        tags: ["console"],
        summary: "Arm or disarm the auto-revoke-on-failure safety net",
        security: bearer,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["enabled"],
                properties: {
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "New AutoRevokeOnFailureView",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AutoRevokeOnFailureView",
                },
              },
            },
          },
          "400": { description: "Body is not { enabled: boolean }" },
          "401": { description: "Missing or wrong operator token" },
        },
      },
    },
    "/v1/settlements/{nonce}/retry": {
      post: {
        tags: ["console"],
        summary: "Retry a failed settlement",
        security: bearer,
        parameters: [
          {
            name: "nonce",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Resubmitted" },
          "404": { description: "Unknown nonce" },
          "409": { description: "Not retryable" },
        },
      },
    },
    "/v1/health": {
      get: {
        tags: ["ops"],
        summary: "Readiness with probe messages and alerts",
        security: bearer,
        responses: { "200": { description: "Health report" } },
      },
    },
    "/metrics": {
      get: {
        tags: ["ops"],
        summary: "Prometheus exposition",
        security: bearer,
        responses: { "200": { description: "text/plain" } },
      },
    },
    "/v1/metrics": {
      get: {
        tags: ["ops"],
        summary: "Metrics as JSON",
        security: bearer,
        responses: { "200": { description: "JSON metrics" } },
      },
    },
    "/v1/audit": {
      get: {
        tags: ["ops"],
        summary: "Administrative audit trail",
        security: bearer,
        responses: { "200": { description: "Audit events" } },
      },
    },
  },
} as const;

/** Paths this document claims to cover, for the contract test. */
export function documentedPaths(): string[] {
  return Object.keys(openApiDocument.paths);
}
