import { describe, expect, it } from "vitest";
import { generateReviewCode, hashReviewCode, signReviewSession, verifyReviewSession } from "../src/lib/reviews/crypto";

describe("department review access", () => {
  it("generates four uppercase letters/digits with both kinds present", () => {
    const codes = Array.from({ length: 100 }, generateReviewCode);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z0-9]{4}$/);
      expect(code).toMatch(/[A-Z]/);
      expect(code).toMatch(/[0-9]/);
    }
    expect(new Set(codes).size).toBeGreaterThan(90);
  });

  it("binds a code to its department and generation", () => {
    const hash = hashReviewCode("CM", "generation-1", "A7K2", "secret");
    expect(hash).toBe(hashReviewCode("CM", "generation-1", "a7k2", "secret"));
    expect(hash).not.toBe(hashReviewCode("VH", "generation-1", "A7K2", "secret"));
    expect(hash).not.toBe(hashReviewCode("CM", "generation-2", "A7K2", "secret"));
  });

  it("rejects tampered and expired sessions", () => {
    const token = signReviewSession({ department: "CM", generation: "g1", expires: Date.now() + 60000 }, "secret");
    expect(verifyReviewSession(token, "secret")?.department).toBe("CM");
    expect(verifyReviewSession(token + "x", "secret")).toBeNull();
    expect(verifyReviewSession(token, "wrong-secret")).toBeNull();
    const expired = signReviewSession({ department: "CM", generation: "g1", expires: Date.now() - 1 }, "secret");
    expect(verifyReviewSession(expired, "secret")).toBeNull();
    const nd = signReviewSession({ department: "ND", generation: "g2", expires: Date.now() + 60000 }, "secret");
    expect(verifyReviewSession(nd, "secret")?.department).toBe("ND");
  });
});
