import { describe, expect, it } from "vitest";
import {
  streamStatusFromEndReason,
  type StreamEndReason,
} from "../src/stream.js";

describe("streamStatusFromEndReason", () => {
  it("is active while the stream is still delivering", () => {
    expect(streamStatusFromEndReason(null)).toBe("active");
  });

  it("projects the idle sweep as abandoned, not ended", () => {
    expect(streamStatusFromEndReason("abandoned")).toBe("abandoned");
  });

  it.each([
    "completed",
    "price-changed",
    "session-expired",
    "session-revoked",
    "budget-exhausted",
    "exposure-limit",
    "seller-error",
  ] satisfies StreamEndReason[])("projects %s as ended", (reason) => {
    expect(streamStatusFromEndReason(reason)).toBe("ended");
  });
});
