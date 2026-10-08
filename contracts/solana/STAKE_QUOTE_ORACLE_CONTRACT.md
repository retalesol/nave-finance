# DAO Creation Stake — Oracle ⇄ On-Chain Interface Contract

**Status:** Phase 2 (`price-oracle`) deliverable. This document defines the
interface the **core-contracts worker** (`stake-contracts` todo) must implement
on the Solana stake instruction and the EVM stake escrow. The off-chain oracle
(`nave-price-oracle`) and the app client/hook are already implemented; this is
the seam between them and the on-chain stake gate.

> Ownership note: the oracle worker owns the price/oracle service and config
> keys only. It does **not** edit `nave_core` / `nave_governance`. The numbers
> and binding rules below are the agreed contract the contract worker consumes.

---

## 1. Where the number comes from

There is exactly **one** canonical NAVE/USD creation price. It is published by
the Supabase edge function **`nave-price-oracle`** (source:
`nave-app/supabase/functions/nave-price-oracle/index.ts`, logic in
`nave-app/supabase/functions/_shared/naveOracle.ts`).

- **Devnet / testnet / localnet:** fixed price (default **$10/NAVE**), so a
  default **$99** stake == **9.9 NAVE**.
- **Mainnet:** live multi-chain sampling (Solana **Meteora** LP + EVM wrapped
  NAVE on Ethereum/Base), with min-liquidity + freshness filtering and a
  trimmed-mean/median aggregation. If too few healthy samples survive, the
  oracle **fails closed** (HTTP 503, no quote) — creation must be blocked, never
  defaulted.

The app reads it via `nave-app/src/lib/naveStakeOracle.ts`
(`fetchNaveStakeQuote`) and the `useNaveStakeQuote` hook. Server-side
transaction builders should call the same endpoint (GET, anon key) so the
amount they bind matches what the UI showed.

---

## 2. The quote payload (`StakeQuote`)

`GET /functions/v1/nave-price-oracle?stake_usd=99` returns:

```jsonc
{
  "ok": true,
  "network": "mainnet" | "devnet" | "testnet" | "localnet",
  "naveMint": "<base58 SPL mint for this cluster>",
  "priceUsd": 10.0,                       // canonical NAVE/USD
  "source": "fixed" | "multi-chain",
  "quote": {
    "network": "...",
    "naveMint": "...",
    "naveDecimals": 6,
    "priceUsd": 10.0,
    "stakeUsd": 99,
    "requiredNave": 9.9,                  // human-readable
    "requiredNaveBaseUnits": "9900000",   // u64 string — EXACT amount to transfer
    "minNaveBaseUnits": "9801000",        // u64 string — on-chain floor to enforce
    "quoteToleranceBps": 100,             // downward tolerance baked into the floor
    "source": "fixed",
    "issuedAt": "2026-06-29T00:00:00.000Z",
    "expiresAt": "2026-06-29T00:05:00.000Z"
  },
  "attestation": {
    "payloadHash": "<sha256 hex of canonical quote>",
    "signature": "<hmac-sha256 hex or null>",
    "signed": true,
    "algorithm": "HMAC-SHA256"
  }
}
```

### Field meanings (the part the contract worker cares about)

| Field | Type | Meaning for the stake instruction |
|---|---|---|
| `naveMint` | base58 | The SPL mint the escrow token account + founder ATA must use. Reject mismatches. |
| `naveDecimals` | int | Base-unit precision (NAVE = 6). Used only to interpret the strings below. |
| `requiredNaveBaseUnits` | u64 (string) | The amount the **client transfers** into escrow. |
| `minNaveBaseUnits` | u64 (string) | The amount the **on-chain instruction enforces** (`transferred >= min`). |
| `quoteToleranceBps` | int | Why `min < required`: a small downward tolerance (default 100 bps = 1%) so price drift between quote and confirmation does not reject an honestly-funded stake. |

`minNaveBaseUnits = floor(requiredNaveBaseUnits * (10000 - quoteToleranceBps) / 10000)`.

---

## 3. On-chain contract — Solana (`nave_core`)

The stake instruction must accept the **minimum NAVE amount** as an argument
and enforce it against the actual transfer into the DAO stake escrow. Keep the
on-chain rule simple (the plan's Phase 2 guidance): the chain does **not** read
a price feed; it trusts the founder-supplied `min_nave_amount` derived from the
accepted oracle quote and only enforces "at least this much NAVE landed in
escrow, using the expected NAVE mint."

**Required argument**

```rust
/// Minimum NAVE (base units, 6 decimals) that must be locked into the DAO
/// stake escrow. Sourced from the accepted oracle quote `minNaveBaseUnits`.
min_nave_amount: u64
```

**Required enforcement (suggested):**

1. The escrow token account + founder source ATA are for `global_config`/config
   NAVE mint (mainnet real mint, devnet replica). Reject any other mint.
2. `min_nave_amount > 0` (reject zero — a $0 stake is never valid).
3. Transfer NAVE from the founder ATA into the DAO stake escrow, then assert the
   escrow balance increased by **at least** `min_nave_amount`
   (`require!(transferred >= min_nave_amount, ...)`). Equivalent: transfer
   exactly `min_nave_amount` from the founder (client sends `requiredNaveBaseUnits`,
   which is `>= min_nave_amount`).
4. Record on the stake-lock PDA: `founder`, `dao`, `nave_mint`, `locked_amount`,
   and price-snapshot metadata (see §5) for later proof + the moonlight release.

**Naming:** expose this as part of the creation flow — either a dedicated
`stake_dao_creation(min_nave_amount: u64)` instruction invoked in the same
creation transaction, or a `min_nave_amount` argument added to the existing
`initialize_dao` path. The formation-fee SOL transfer is removed in the same
change (Phase 3); the protocol takes **no** profit — NAVE is locked, not spent.

---

## 4. On-chain contract — EVM (Ethereum / Base)

Mirror the same rule in the factory/treasury creation path once the bridge
testnet is live:

- `createDao(..., uint256 minNaveAmount)` (wrapped-NAVE base units for that chain).
- Pull `minNaveAmount` of wrapped NAVE from the founder into a DAO-bound escrow
  (`transferFrom`, requires prior `approve`), and `require(locked >= minNaveAmount)`.
- The wrapped NAVE token address per chain is the bridge's wrapped-NAVE contract
  (config keys `*_WRAPPED_NAVE_ADDRESS`); reject other tokens.

`minNaveAmount` is the EVM analog of `minNaveBaseUnits` for that chain's wrapped
NAVE decimals (use the oracle quote's `stakeUsd`/`priceUsd` with the wrapped
token decimals; the oracle exposes `priceUsd` + `stakeUsd` so the builder can
recompute base units at the correct precision per chain).

---

## 5. Proving the stake amount (attestation)

Each quote is persisted as a row in **`nave_price_attestations`**
(`nave-app/supabase/migrations/1781900000-create_nave_price_attestations.sql`)
with a SHA-256 `payload_hash` and an HMAC-SHA256 `signature`
(`NAVE_ORACLE_ATTESTATION_SECRET`). This lets DAO creation later **prove** which
price/amount the protocol issued.

The on-chain stake-lock account should store enough snapshot metadata to tie a
lock back to its attestation. Minimal recommendation:

- `locked_amount: u64` (always),
- `price_snapshot_micro_usd: u64` (= `round(priceUsd * 1_000_000)`), and/or
- `attestation_hash: [u8; 32]` (= `payload_hash` bytes) so the lock references
  the exact off-chain attestation row.

The chain does not verify the HMAC (it has no secret); the attestation is the
**off-chain** proof. On-chain enforcement remains the independent `>= min`
check, so a forged client value can only ever *increase* the required stake.

---

## 6. Config / env keys (oracle-owned, namespaced `NAVE_ORACLE_*`)

Server (edge function) keys — see `nave-app/.env.example`:

```
NAVE_ORACLE_STAKE_USD=99
NAVE_ORACLE_DEVNET_PRICE_USD=10
NAVE_ORACLE_NAVE_DECIMALS=6
NAVE_ORACLE_QUOTE_TTL_SECONDS=300
NAVE_ORACLE_QUOTE_TOLERANCE_BPS=100
NAVE_ORACLE_MAINNET_MINT=EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory
NAVE_ORACLE_DEVNET_MINT=GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa
NAVE_ORACLE_ATTESTATION_SECRET=...        # HMAC key for signed attestations
NAVE_ORACLE_MIN_LIQUIDITY_USD=25000       # mainnet: drop thin pools
NAVE_ORACLE_MAX_PRICE_AGE_SECONDS=900     # mainnet: drop stale samples
NAVE_ORACLE_MIN_SOURCES=1                 # mainnet: fail closed below this
NAVE_ORACLE_SOLANA_POOL=                  # GeckoTerminal Solana (Meteora) pool
NAVE_ORACLE_SOLANA_TOKEN=                 # defaults to active NAVE mint
NAVE_ORACLE_ETHEREUM_POOL= / NAVE_ORACLE_ETHEREUM_TOKEN=
NAVE_ORACLE_BASE_POOL=     / NAVE_ORACLE_BASE_TOKEN=
NAVE_ORACLE_METEORA_POOL=  / NAVE_ORACLE_METEORA_API_URL=https://dlmm-api.meteora.ag
```

Browser keys (app): `VITE_NAVE_ORACLE_ENDPOINT` (optional override),
`VITE_NAVE_ORACLE_NAVE_DECIMALS=6`, `VITE_NAVE_ORACLE_STAKE_USD=99`.

---

## 7. Worker handshake checklist (for `stake-contracts`)

1. Add `min_nave_amount: u64` to the Solana creation/stake instruction and the
   `>= min` escrow enforcement against the configured NAVE mint.
2. (When bridge testnet is live) add `minNaveAmount` to the EVM creation path.
3. Persist price-snapshot metadata on the stake-lock account (§5).
4. The client already sends `requiredNaveBaseUnits` (transfer) +
   `minNaveBaseUnits` (the value to pass as `min_nave_amount`). Do **not**
   recompute the price on-chain.
5. Keep formation-fee removal (no protocol profit) and management/yield fees
   unchanged, per the plan's Phase 3 scope.
