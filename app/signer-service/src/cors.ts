import type { Request, Response, NextFunction } from 'express';

const ALLOWED_ORIGINS = (process.env.NAVE_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const ALLOWED_ORIGIN_SET = new Set(ALLOWED_ORIGINS);

const DEV_ALLOW_ALL_ORIGINS =
  (process.env.NAVE_CORS_DEV_ALLOW_ALL ?? '').toLowerCase() === 'true';

function isBrowserOrigin(origin: string | undefined): origin is string {
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function originWithWwwAlias(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname.startsWith('www.')) {
      u.hostname = u.hostname.slice(4);
      return u.toString().replace(/\/$/, '');
    }
    u.hostname = `www.${u.hostname}`;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGIN_SET.has('*') || ALLOWED_ORIGIN_SET.has(origin)) return true;
  const alias = originWithWwwAlias(origin);
  return Boolean(alias && ALLOWED_ORIGIN_SET.has(alias));
}

function resolveAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.length === 0) {
    if (DEV_ALLOW_ALL_ORIGINS) return origin;
    return isBrowserOrigin(origin) ? origin : null;
  }
  return isAllowedOrigin(origin) ? origin : null;
}

/**
 * CORS for browser-callable public endpoints (/bridge-relay, /faucet-claim,
 * /faucet-claim-sol).
 * Mirrors supabase/functions/_shared/http.ts allow-list behavior.
 */
export function publicCorsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const allowed = resolveAllowedOrigin(origin);

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
