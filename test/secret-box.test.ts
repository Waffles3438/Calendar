import { describe, expect, it } from "vitest";

import { SecretBox } from "../src/persistence/secret-box.js";

describe("SecretBox", () => {
  it("round-trips a secret without exposing plaintext in the encrypted payload", () => {
    const box = new SecretBox("x".repeat(48));
    const plaintext = "refresh-token-that-must-not-be-stored-as-plaintext";

    const encrypted = box.encrypt(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(box.decrypt(encrypted)).toBe(plaintext);
  });

  it("rejects a tampered encrypted payload", () => {
    const box = new SecretBox("x".repeat(48));
    const payload = JSON.parse(box.encrypt("sensitive")) as { ciphertext: string };
    payload.ciphertext = `${payload.ciphertext.slice(0, -2)}aa`;

    expect(() => box.decrypt(JSON.stringify(payload))).toThrow(/decrypt/i);
  });

  it("requires a sufficiently strong secret", () => {
    expect(() => new SecretBox("too-short")).toThrow(/at least 32/i);
  });
});
