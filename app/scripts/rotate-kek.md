# Master KEK rotation runbook

Rotating `NAVE_MASTER_KEK` re-wraps every agent DEK in `encrypted_agent_keys`. The
agent private key ciphertext is **not** touched — only the envelope around each DEK
changes — so on-chain agent pubkeys stay the same.

## Prerequisites

- Maintenance window: pause the signer worker (`npm run worker` in `signer-service`).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` with write access to `encrypted_agent_keys`.
- Current `NAVE_MASTER_KEK` (OLD) and a freshly generated NEW key:

```bash
openssl rand -base64 32
```

## Steps

1. **Dry run** — validates every active row unwraps with OLD and re-wraps with NEW:

```bash
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
NAVE_MASTER_KEK_OLD="<current base64 kek>" \
NAVE_MASTER_KEK_NEW="<new base64 kek>" \
DRY_RUN=true \
node scripts/rotate-kek.mjs
```

2. **Live re-wrap** — same command without `DRY_RUN`:

```bash
node scripts/rotate-kek.mjs
```

3. **Swap env** — set `NAVE_MASTER_KEK` to the NEW value in:
   - Supabase edge secrets (`supabase secrets set NAVE_MASTER_KEK=...`)
   - Signer service (Railway vars)

4. **Verify** — trigger one orchestrator cycle on a test DAO; confirm signer decrypts and submits.

5. **Resume worker** — restart `npm run worker`.

## Rollback

If the live re-wrap fails partway, do **not** swap the env KEK. Fix the reported
row failures and re-run. If you already swapped env but signing fails, re-wrap
again using the NEW key as OLD (if you still have both) or restore from backup.

See also [`docs/SECRETS.md`](../docs/SECRETS.md).
