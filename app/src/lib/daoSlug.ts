import { supabase, type DaoRegistryRow } from './supabaseClient';

/** Slugs blocked to avoid route / product collisions. */
export const RESERVED_DAO_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'www',
  'create',
  'create-dao',
  'dashboard',
  'settings',
  'governance',
  'tokens',
  'agent',
  'policy',
  'treasuries',
  'dao',
  'dao-created',
  'login',
  'signup',
  'help',
  'support',
  'docs',
  'static',
  'assets',
]);

const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;

/** Strip `.dao`, lowercase, and keep only valid slug characters. */
export function normalizeDaoSlug(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const withoutSuffix = trimmed.endsWith('.dao') ? trimmed.slice(0, -4) : trimmed;
  return withoutSuffix
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function validateDaoSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug) {
    return { valid: false, error: 'Choose a DAO name (e.g. nave).' };
  }
  if (slug.length < 3) {
    return { valid: false, error: 'DAO name must be at least 3 characters.' };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      error: 'Use lowercase letters, numbers, and hyphens. Must start with a letter.',
    };
  }
  if (RESERVED_DAO_SLUGS.has(slug)) {
    return { valid: false, error: 'That name is reserved.' };
  }
  return { valid: true };
}

export function formatDaoSlugLabel(slug: string): string {
  return `${slug}.dao`;
}

export function getDaoPublicPath(slug: string): string {
  return `/dao/${encodeURIComponent(slug)}`;
}

export function getDaoPublicUrl(slug: string): string {
  const origin =
    import.meta.env.VITE_APP_ORIGIN ||
    (typeof window !== 'undefined' ? window.location.origin : 'https://nave.finance');
  return `${origin}${getDaoPublicPath(slug)}`;
}

/** Parse lobby join input — EVM/Solana address or slug / slug.dao */
export function parseJoinInput(raw: string): { type: 'address' | 'slug'; value: string } {
  const trimmed = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { type: 'address', value: trimmed };
  }
  if (trimmed.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
    return { type: 'address', value: trimmed };
  }
  return { type: 'slug', value: normalizeDaoSlug(trimmed) };
}

export type SlugAvailabilityResult = {
  available: boolean;
  error?: string;
};

export async function checkDaoSlugAvailability(slug: string): Promise<SlugAvailabilityResult> {
  const validation = validateDaoSlug(slug);
  if (!validation.valid) {
    return { available: false, error: validation.error };
  }

  const { data, error } = await supabase
    .from('dao_registry')
    .select('dao_onchain_address')
    .eq('slug', slug)
    .limit(1);

  if (error) {
    console.warn('Slug availability check failed:', error.message);
    return {
      available: false,
      error: 'Could not verify name availability. Check your connection and try again.',
    };
  }

  if (data && data.length > 0) {
    return { available: false, error: `${formatDaoSlugLabel(slug)} is already taken` };
  }

  return { available: true };
}

export async function isDaoSlugAvailable(slug: string): Promise<boolean> {
  const result = await checkDaoSlugAvailability(slug);
  return result.available;
}

export async function resolveDaoBySlug(slug: string, chainId?: number | null): Promise<DaoRegistryRow | null> {
  const normalized = normalizeDaoSlug(slug);
  const validation = validateDaoSlug(normalized);
  if (!validation.valid) return null;

  const { data, error } = await supabase
    .from('dao_registry')
    .select('*')
    .eq('slug', normalized);

  if (error || !data || data.length === 0) return null;
  const rows = data as DaoRegistryRow[];
  if (typeof chainId === 'number') {
    const match = rows.find((row) => row.chain_id === chainId);
    if (match) return match;
  }
  return rows[0];
}
