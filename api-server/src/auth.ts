import { randomBytes, createHash } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import { query } from "./database.js";

const SESSION_DAYS = 14;
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export const cookieName = "gx_session";

// Pure-WASM Argon2id (no native .node binary). Produces standard PHC-format
// hashes, so existing argon2-native hashes remain verifiable.
const hashPassword = (password: string) =>
  argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 4,
    iterations: 3,
    memorySize: 65_536,
    hashLength: 32,
    outputType: "encoded",
  });
const verifyPassword = (hash: string, password: string) => argon2Verify({ password, hash });

export async function createOwner(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized) || password.length < 8) throw new Error("Use a valid email and a password of at least 8 characters.");
  const existing = await query("SELECT id FROM users LIMIT 1");
  if (existing.rowCount) throw new Error("An owner account already exists.");
  const passwordHash = await hashPassword(password);
  await query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'owner')", [normalized, passwordHash]);
}

export async function login(email: string, password: string) {
  const result = await query<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = $1", [email.trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(user.password_hash, password))) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [user.id, hashToken(token), expiresAt]);
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  return { token, expiresAt, userId: user.id };
}

export async function sessionUser(token: string | undefined) {
  if (!token) return null;
  const result = await query<{ id: string; email: string }>("SELECT u.id, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()", [hashToken(token)]);
  return result.rows[0] ?? null;
}

export async function logout(token: string | undefined) {
  if (token) await query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [hashToken(token)]);
}

export async function resetOwnerPassword(password: string) {
  if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
  const passwordHash = await hashPassword(password);
  const owner = await query<{ id: string }>("UPDATE users SET password_hash=$1 WHERE role='owner' RETURNING id", [passwordHash]);
  const user = owner.rows[0];
  if (!user) throw new Error("No owner account exists.");
  await query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [user.id]);
}
