// Per-connection in-flight gate: cap how many requests may occupy ONE credential
// at the same time.
//
// Why this cannot be done with the round-robin strategy alone: services/auth.js
// rotates on `lastUsedAt`, which is stamped when a connection is SELECTED and never
// cleared when the request ends. So rotation spreads load, but a key that is still
// streaming is simply "least recently used" again once every other key has had a
// turn — with more concurrent requests than connections, the same credential ends up
// carrying two streams. Upstreams that allow exactly one stream per key (measured on
// NVIDIA NIM, 38 keys) answer that with a concurrency 429, i.e. a customer-visible
// failure we chose to make impossible instead of retrying after the fact.
//
// Opt-in per provider via settings.providerStrategies[<providerId>].
// maxConcurrentPerConnection. Unset/0 → this module is inert and selection behaves
// exactly as before, so no other provider changes behaviour.
//
// State is per process and deliberately in memory: a lease describes an HTTP request
// this process is currently serving, so it is worthless to another process and must
// not outlive a restart.

// A lease older than this is treated as leaked and ignored. It MUST stay above the
// longest possible request: the stream deadline ceiling is 300s
// (combosRepo.normalizeNodeTimeouts clamps to 300000ms), so 15 minutes leaves a wide
// margin while still guaranteeing a missed release cannot wedge a credential forever.
const STALE_LEASE_MS = 15 * 60 * 1000;

/** @type {Map<string, Map<string, number>>} connectionId → (leaseId → acquiredAtMs) */
const leases = new Map();

let counter = 0;

// Drop leaked leases and the empty bucket they leave behind. Returns the live count.
function purge(connectionId, now) {
  const bucket = leases.get(connectionId);
  if (!bucket) return 0;
  for (const [leaseId, at] of bucket) {
    if (now - at > STALE_LEASE_MS) bucket.delete(leaseId);
  }
  if (bucket.size === 0) {
    leases.delete(connectionId);
    return 0;
  }
  return bucket.size;
}

/** Live (non-stale) request count for one connection. */
export function inFlight(connectionId) {
  if (!connectionId) return 0;
  return purge(connectionId, Date.now());
}

/**
 * True when this connection has room for one more request.
 * `limit` <= 0 or non-numeric means "no cap" → always true.
 */
export function hasCapacity(connectionId, limit) {
  const cap = Number(limit);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return inFlight(connectionId) < cap;
}

/**
 * Take a slot on `connectionId`. Returns a lease to hand to release(), or null when
 * the connection is already at `limit` — callers treat null as "this credential is
 * busy, pick another".
 *
 * With no cap configured a lease is still issued, so callers can release
 * unconditionally and inFlight() stays meaningful for diagnostics.
 */
export function acquire(connectionId, limit) {
  if (!connectionId) return null;
  const now = Date.now();
  const count = purge(connectionId, now);
  const cap = Number(limit);
  if (Number.isFinite(cap) && cap > 0 && count >= cap) return null;
  const leaseId = `${now.toString(36)}-${(++counter).toString(36)}`;
  let bucket = leases.get(connectionId);
  if (!bucket) { bucket = new Map(); leases.set(connectionId, bucket); }
  bucket.set(leaseId, now);
  return { connectionId, leaseId };
}

/**
 * Give the slot back. Safe to call with null/undefined and safe to call twice — the
 * release paths in handlers/chat.js overlap (a stream that both ends and is cancelled),
 * and double-release must not free somebody else's slot.
 */
export function release(lease) {
  if (!lease || !lease.connectionId || !lease.leaseId) return false;
  const bucket = leases.get(lease.connectionId);
  if (!bucket) return false;
  const had = bucket.delete(lease.leaseId);
  if (bucket.size === 0) leases.delete(lease.connectionId);
  return had;
}

/** Test-only: wipe all state. */
export function __resetForTests() {
  leases.clear();
  counter = 0;
}

/** Test-only: age a lease so purge() considers it leaked. */
export function __ageLeaseForTests(lease, ms) {
  const bucket = leases.get(lease?.connectionId);
  if (!bucket || !bucket.has(lease.leaseId)) return false;
  bucket.set(lease.leaseId, bucket.get(lease.leaseId) - ms);
  return true;
}

export const __STALE_LEASE_MS = STALE_LEASE_MS;
