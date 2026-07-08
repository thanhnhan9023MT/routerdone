import bcrypt from "bcryptjs";
import { getSettings } from "@/lib/localDb";

const DEFAULT_PASSWORD = "123456";

// When PASSWORD_FROM_ENV=true, the dashboard password is always taken from the
// INITIAL_PASSWORD env var and any hash stored in the DB is ignored. This is
// intended for deployments (e.g. Dokploy / Docker) where the operator wants
// to control the admin password purely from .env on every redeploy, without
// the first-login-writeback in settings.password pinning an old value.
//
// Default (unset / false) keeps the legacy behavior: DB hash takes precedence,
// INITIAL_PASSWORD is only the bootstrap default when no hash is stored yet.
export function isPasswordFromEnvMode() {
  return process.env.PASSWORD_FROM_ENV === "true";
}

// Resolve the effective env password (env override or default), or null when
// no env override is configured.
export function getEnvPassword() {
  if (!isPasswordFromEnvMode()) return null;
  return process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
}

// Verify a candidate password against the active password policy.
// Returns true when the password matches.
export async function verifyPassword(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;

  // Env-precedence mode: always compare against INITIAL_PASSWORD, ignore DB.
  const envPassword = getEnvPassword();
  if (envPassword !== null) {
    return candidate === envPassword;
  }

  // Legacy: stored hash wins; fall back to INITIAL_PASSWORD (or default) when
  // no hash has been written yet.
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(candidate, storedHash);
  return candidate === (process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD);
}

// Whether the dashboard is still on the bootstrap default password (i.e. no
// hash stored AND no env override). Used to force a password change on remote
// clients before the dashboard is exposed.
export async function isUsingDefaultPassword() {
  if (isPasswordFromEnvMode()) return false;
  const settings = await getSettings();
  return !settings?.password;
}
