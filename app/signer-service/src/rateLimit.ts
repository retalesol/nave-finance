// Rate limiter + circuit breaker for the signer service.
//
// The signer is the highest-trust surface in the stack (it decrypts agent keys
// and submits treasury transactions), so /sign must throttle abuse even though
// it is already secret-gated.
//
// Backing store:
//   • Distributed (Upstash Redis) when UPSTASH_REDIS_REST_URL +
//     UPSTASH_REDIS_REST_TOKEN are set. This is REQUIRED for correctness across
//     replicas — an in-memory limiter gives an effective limit of
//     `limit × replicas`, which a horizontally-scaled signer would silently blow
//     past.
//   • In-memory per-process fallback ONLY on non-mainnet (dev/devnet) for
//     convenience.
//   • On mainnet WITHOUT Redis configured we FAIL CLOSED: every limited request
//     is rejected, because we cannot enforce a correct global limit.
//
// Dimensions: callers compose limit specs across IP / DAO / action / role /
// global so a single compromised secret cannot fan out across many DAOs, hammer
// one DAO, or spam one action class.
//
// Circuit breaker: per-DAO failure/rejection bursts trip a breaker that pauses
// that DAO's signer actions for a cooldown window, containing a stuck or
// adversarial loop (e.g. repeated on-chain rejections) instead of retrying
// unbounded.

import { Redis } from '@upstash/redis';
import { isMainnetCluster } from './programs.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const memBuckets = new Map<string, Bucket>();

export interface LimitSpec {
  key: string;
  limit: number;
  windowMs: number;
}

export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  key: string;
}

let _redis: Redis | null | undefined; // undefined = uninitialized, null = not configured

function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

export type LimiterMode = 'redis' | 'memory' | 'fail-closed';

/** Which backing the limiter will use given current env + cluster. */
export function limiterMode(): LimiterMode {
  if (getRedis()) return 'redis';
  return isMainnetCluster() ? 'fail-closed' : 'memory';
}

// ─── Fixed-window counters ────────────────────────────────────────────────────

function consumeMemory(spec: LimitSpec): LimitResult {
  const now = Date.now();
  const bucket = memBuckets.get(spec.key);
  if (!bucket || now >= bucket.resetAt) {
    memBuckets.set(spec.key, { count: 1, resetAt: now + spec.windowMs });
    return { allowed: true, retryAfterSeconds: 0, key: spec.key };
  }
  if (bucket.count >= spec.limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000), key: spec.key };
  }
  bucket.count += 1;
  if (memBuckets.size > 10_000) {
    for (const [k, v] of memBuckets) if (now >= v.resetAt) memBuckets.delete(k);
  }
  return { allowed: true, retryAfterSeconds: 0, key: spec.key };
}

async function consumeRedis(redis: Redis, spec: LimitSpec): Promise<LimitResult> {
  const now = Date.now();
  const windowId = Math.floor(now / spec.windowMs);
  const redisKey = `rl:${spec.key}:${windowId}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    // First hit in this window — set the TTL so the counter self-expires.
    await redis.pexpire(redisKey, spec.windowMs);
  }
  if (count > spec.limit) {
    const windowEnd = (windowId + 1) * spec.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)), key: spec.key };
  }
  return { allowed: true, retryAfterSeconds: 0, key: spec.key };
}

/**
 * Roll back one consumed unit for `spec` in its CURRENT fixed window
 * (best-effort, non-throwing). Used when a caller consumes multiple
 * independent dimensions one at a time (e.g. address THEN ip) and a LATER
 * dimension fails — without this, the earlier (passing) dimension would stay
 * wrongly "spent" even though the overall request was rejected and nothing
 * was actually sent/done.
 */
export async function releaseLimit(spec: Pick<LimitSpec, 'key' | 'windowMs'>): Promise<void> {
  const mode = limiterMode();
  const redis = mode === 'redis' ? getRedis() : null;
  if (redis) {
    try {
      const windowId = Math.floor(Date.now() / spec.windowMs);
      const redisKey = `rl:${spec.key}:${windowId}`;
      const newVal = await redis.decr(redisKey);
      if (newVal <= 0) await redis.del(redisKey);
      return;
    } catch (err) {
      console.error('[signer] rate-limit release error:', err instanceof Error ? err.message : err);
      // Fall through to the in-memory bucket as a best-effort fallback.
    }
  }
  const bucket = memBuckets.get(spec.key);
  if (bucket && bucket.count > 0) bucket.count -= 1;
}

/**
 * Enforce all supplied limits. Every spec must pass; returns the first failing
 * result, or null when allowed. On mainnet without a distributed store this
 * fails closed (returns a synthetic rejection) rather than silently relying on
 * an incorrect per-replica counter.
 */
export async function enforceLimits(specs: LimitSpec[]): Promise<LimitResult | null> {
  const mode = limiterMode();
  if (mode === 'fail-closed') {
    return {
      allowed: false,
      retryAfterSeconds: 60,
      key: 'limiter:distributed-store-unconfigured-on-mainnet',
    };
  }
  const redis = mode === 'redis' ? getRedis() : null;
  for (const spec of specs) {
    try {
      const res = redis ? await consumeRedis(redis, spec) : consumeMemory(spec);
      if (!res.allowed) return res;
    } catch (err) {
      // Redis I/O failure: fail closed on mainnet, degrade to memory otherwise.
      console.error('[signer] rate-limit backend error:', err instanceof Error ? err.message : err);
      if (isMainnetCluster()) {
        return { allowed: false, retryAfterSeconds: 30, key: 'limiter:backend-error-mainnet' };
      }
      const res = consumeMemory(spec);
      if (!res.allowed) return res;
    }
  }
  return null;
}

// ─── Circuit breaker (per DAO) ────────────────────────────────────────────────

export interface CircuitConfig {
  /** Failures within `windowMs` that trip the breaker. */
  failureThreshold: number;
  windowMs: number;
  /** How long the breaker stays open once tripped. */
  cooldownMs: number;
}

const CIRCUIT: CircuitConfig = {
  failureThreshold: Number(process.env.NAVE_SIGNER_CB_THRESHOLD || 5),
  windowMs: Number(process.env.NAVE_SIGNER_CB_WINDOW_MS || 60_000),
  cooldownMs: Number(process.env.NAVE_SIGNER_CB_COOLDOWN_MS || 120_000),
};

export interface CircuitState {
  open: boolean;
  retryAfterSeconds: number;
  failures: number;
}

interface MemCircuit {
  failures: number;
  windowResetAt: number;
  openUntil: number;
}
const memCircuits = new Map<string, MemCircuit>();

function memCircuitStatus(dao: string): CircuitState {
  const now = Date.now();
  const c = memCircuits.get(dao);
  if (c && now < c.openUntil) {
    return { open: true, retryAfterSeconds: Math.ceil((c.openUntil - now) / 1000), failures: c.failures };
  }
  return { open: false, retryAfterSeconds: 0, failures: c?.failures ?? 0 };
}

function memRecord(dao: string, ok: boolean): void {
  const now = Date.now();
  let c = memCircuits.get(dao);
  if (!c || now >= c.windowResetAt) {
    c = { failures: 0, windowResetAt: now + CIRCUIT.windowMs, openUntil: c?.openUntil ?? 0 };
    memCircuits.set(dao, c);
  }
  if (ok) {
    c.failures = 0;
    c.openUntil = 0;
    return;
  }
  c.failures += 1;
  if (c.failures >= CIRCUIT.failureThreshold) {
    c.openUntil = now + CIRCUIT.cooldownMs;
  }
}

/**
 * Whether the DAO's signer circuit is currently open (paused). On mainnet
 * without a distributed store this returns open (fail closed) so a paused state
 * cannot be lost across replicas.
 */
export async function circuitStatus(dao: string): Promise<CircuitState> {
  const mode = limiterMode();
  if (mode === 'fail-closed') {
    return { open: true, retryAfterSeconds: 60, failures: CIRCUIT.failureThreshold };
  }
  const redis = mode === 'redis' ? getRedis() : null;
  if (!redis) return memCircuitStatus(dao);
  try {
    const openUntil = await redis.get<number>(`cb:open:${dao}`);
    if (openUntil && Date.now() < Number(openUntil)) {
      return { open: true, retryAfterSeconds: Math.max(1, Math.ceil((Number(openUntil) - Date.now()) / 1000)), failures: CIRCUIT.failureThreshold };
    }
    return { open: false, retryAfterSeconds: 0, failures: 0 };
  } catch (err) {
    console.error('[signer] circuit-breaker read error:', err instanceof Error ? err.message : err);
    return isMainnetCluster()
      ? { open: true, retryAfterSeconds: 30, failures: CIRCUIT.failureThreshold }
      : memCircuitStatus(dao);
  }
}

/**
 * Record the outcome of a signer attempt for the DAO. A burst of failures
 * (rejections / errors) within the window trips the breaker. A success clears
 * the running failure count.
 */
export async function recordSignerOutcome(dao: string, ok: boolean): Promise<void> {
  const mode = limiterMode();
  const redis = mode === 'redis' ? getRedis() : null;
  if (!redis) {
    memRecord(dao, ok);
    return;
  }
  try {
    if (ok) {
      await redis.del(`cb:fail:${dao}`);
      return;
    }
    const failures = await redis.incr(`cb:fail:${dao}`);
    if (failures === 1) await redis.pexpire(`cb:fail:${dao}`, CIRCUIT.windowMs);
    if (failures >= CIRCUIT.failureThreshold) {
      const openUntil = Date.now() + CIRCUIT.cooldownMs;
      await redis.set(`cb:open:${dao}`, openUntil, { px: CIRCUIT.cooldownMs });
    }
  } catch (err) {
    console.error('[signer] circuit-breaker write error:', err instanceof Error ? err.message : err);
    memRecord(dao, ok);
  }
}
