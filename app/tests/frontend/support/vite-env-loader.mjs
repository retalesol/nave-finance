// ─── Test-only ESM loader: shim Vite's `import.meta.env` under Node ───────────
// The frontend `src/` modules read configuration from Vite's `import.meta.env`,
// which only exists inside a Vite/Vitest transform. Under the repo's Node test
// runner (`node --test`, matching signer-service) `import.meta.env` is
// `undefined`, so importing `programConfig.ts` (and everything that transitively
// imports it) would throw at module load.
//
// This loader is chained AFTER tsx (see register.mjs). For each app source file
// it takes tsx's transpiled output and rewrites the literal `import.meta.env`
// into a reference to `globalThis.__NAVE_VITE_ENV__`, which the test harness
// populates in the main thread (register.mjs). Only files under `/src/` are
// touched; node_modules and the harness itself are left untouched.
//
// This is a TEST-ONLY utility — it never ships and never modifies `src/`.

const NEEDLE = 'import.meta.env';
const REPLACEMENT = 'globalThis.__NAVE_VITE_ENV__';

function shouldRewrite(url) {
  if (!url.startsWith('file:')) return false;
  if (url.includes('/node_modules/')) return false;
  // App source lives under `<repo>/src/…`. Keep the shim scoped to it.
  return url.includes('/src/');
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!shouldRewrite(url) || result.source == null) return result;

  const original =
    typeof result.source === 'string'
      ? result.source
      : Buffer.from(result.source).toString('utf8');

  if (!original.includes(NEEDLE)) return result;

  return { ...result, source: original.split(NEEDLE).join(REPLACEMENT) };
}
