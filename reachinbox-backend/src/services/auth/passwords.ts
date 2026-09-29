import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import type { ScryptOptions } from "crypto";
import { promisify } from "util";

/**
 * Typed explicitly because promisify's overloads do not carry scrypt's options
 * argument, and the result would otherwise be inferred as Buffer.
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing for credential (email + password) sign-in.
 *
 * Uses scrypt from node:crypto rather than bcrypt/argon2 so the service gains
 * password login without a new dependency and without a native build step,
 * which on a container platform is a real deployment risk. scrypt is a
 * memory-hard KDF, which is the property that matters against GPU cracking.
 *
 * The stored format is self-describing:
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<derivedKeyBase64>
 *
 * Parameters travel with the hash so they can be raised later without
 * invalidating existing passwords: verify() re-derives using whatever the row
 * says, and only new hashes use the current constants below.
 */

/** Cost parameters for newly created hashes. */
const N = 16384; // CPU/memory cost
const R = 8; // block size
const P = 1; // parallelisation
const KEYLEN = 64; // derived key length in bytes
const SALT_BYTES = 16;

/**
 * 128 * N * r bytes of working memory, so the default 32 MB cap is nearly
 * exhausted. Stated explicitly because the limit is load-bearing: a scrypt
 * call that exceeds maxmem throws rather than degrading, and a future bump to N
 * would otherwise fail only at runtime in production.
 */
const MAXMEM = 64 * 1024 * 1024;

/**
 * Refuse to honour absurd cost parameters read back from a stored hash.
 *
 * The column is not attacker-writable, but verify() runs on the login path
 * where a pathological N would turn one request into an out-of-memory event.
 */
const MAX_N = 1 << 20;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * A fixed hash of a value nobody knows, used to spend the same CPU on a login
 * for an unknown email as on a real one.
 *
 * Without it, a missing account returns noticeably faster than a wrong
 * password, which is a user-enumeration oracle even though both paths return
 * the same message.
 *
 * Built on first use rather than at module load: top-level await would make
 * the whole module async, and paying for this at import time would tax every
 * process that merely reads a validation helper.
 */
let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHash ??= buildHash("decoy-password-for-constant-time-login");
  return dummyHash;
}

function encode(value: Buffer): string {
  return value.toString("base64");
}

async function buildHash(
  plain: string,
  n = N,
  r = R,
  p = P,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(plain.normalize("NFKC"), salt, KEYLEN, {
    N: n,
    r,
    p,
    maxmem: MAXMEM,
  }));

  return `scrypt$${n}$${r}$${p}$${encode(salt)}$${encode(derived)}`;
}

/**
 * Hash a plaintext password for storage.
 *
 * NFKC normalisation means a password typed with a different Unicode
 * composition still verifies, so users are not locked out by invisible
 * differences in how their keyboard or OS encodes the same visible string.
 */
export async function hashPassword(plain: string): Promise<string> {
  return buildHash(plain);
}

/**
 * Check a plaintext password against a stored hash.
 *
 * Returns false for any malformed or unrecognised stored value rather than
 * throwing: a corrupt row must read as "wrong password", not as a 500 that
 * tells an attacker they found something interesting.
 */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 2 || n > MAX_N) return false;
  if (!Number.isInteger(r) || r < 1) return false;
  if (!Number.isInteger(p) || p < 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = (await scryptAsync(plain.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    }));
  } catch {
    return false;
  }

  // Lengths already match by construction, but timingSafeEqual throws on a
  // mismatch, and a stored key of unexpected length is exactly the case where
  // an exception would be more informative than a false.
  if (derived.length !== expected.length) return false;

  return timingSafeEqual(derived, expected);
}

/**
 * Burn the same work as a real verification without a real account.
 *
 * Called on the login path when no user matches, so response time does not
 * reveal whether an email is registered.
 */
export async function fakeVerify(): Promise<void> {
  await verifyPassword("wrong-password", await getDummyHash());
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}
