import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  fakeVerify,
  passwordPolicyError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from "../services/auth/passwords.js";

describe("password hashing", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery");
    await expect(verifyPassword("correct horse battery", hash)).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    await expect(verifyPassword("correct horse battery ", hash)).resolves.toBe(false);
    await expect(verifyPassword("Correct horse battery", hash)).resolves.toBe(false);
  });

  it("never stores the plaintext", async () => {
    const hash = await hashPassword("hunter2-hunter2");
    expect(hash).not.toContain("hunter2");
    expect(hash.startsWith("scrypt$")).toBe(true);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("carries its cost parameters so they can be raised later", async () => {
    const hash = await hashPassword("parameterised");
    const [, n, r, p] = hash.split("$");
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBeGreaterThanOrEqual(8);
    expect(Number(p)).toBeGreaterThanOrEqual(1);
  });

  it("treats a missing hash as a failed verification", async () => {
    await expect(verifyPassword("anything", null)).resolves.toBe(false);
    await expect(verifyPassword("anything", undefined)).resolves.toBe(false);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
  });

  it("returns false for malformed stored values instead of throwing", async () => {
    const malformed = [
      "not-a-hash",
      "scrypt$16384$8",
      "scrypt$16384$8$1$onlyfour",
      "scrypt$a$b$c$ZGF0YQ$ZGF0YQ", // non-numeric params
      "scrypt$99999999$8$1$ZGF0YQ$ZGF0YQ", // absurd cost
      "bcrypt$16384$8$1$ZGF0YQ$ZGF0YQ", // wrong algorithm
      "scrypt$16384$8$1$$", // empty salt and key
    ];
    for (const stored of malformed) {
      await expect(verifyPassword("password", stored)).resolves.toBe(false);
    }
  });

  it("normalises unicode so equivalent input still verifies", async () => {
    // "e" + combining acute vs the precomposed character: same visible string.
    const precomposed = "café-password";
    const decomposed = "café-password";
    const hash = await hashPassword(precomposed);
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
  });

  it("fakeVerify completes without throwing", async () => {
    await expect(fakeVerify()).resolves.toBeUndefined();
  });
});

describe("password policy", () => {
  it("rejects anything under the minimum length", () => {
    expect(passwordPolicyError("a".repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
  });

  it("accepts the minimum length", () => {
    expect(passwordPolicyError("a".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it("rejects anything over the maximum length", () => {
    expect(passwordPolicyError("a".repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most/);
  });

  it("accepts the maximum length", () => {
    expect(passwordPolicyError("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });
});
