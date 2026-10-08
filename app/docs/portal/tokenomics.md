# Tokenomics & Bridge

What `$NAVE` (Nave Shares) does, how it is used in the protocol, and how it moves between chains. This page covers the token model and the cross-chain bridge; treasury-level fees are covered in [Treasury Operations](/docs/treasury-operations).

## Nave Shares ($NAVE)

`$NAVE` is the protocol token. Three facts define it:

| Property | Value |
| --- | --- |
| Ticker | `$NAVE` |
| Max supply | Fixed at **500,000 $NAVE** |
| Launch | Fully fair launched — **no team allocation, no team supply** |
| Decimals | 6 |

There is no team or insider allocation carved out of supply, and no vesting schedule to track — distribution is open to the community from day one.

## What $NAVE is used for

| Use | Mechanics |
| --- | --- |
| **Form a DAO** | A founder stakes the USD-equivalent of **$99 in $NAVE** to create a treasury and activate its on-chain infrastructure. |
| **Vote** | Where a DAO enables token governance, $NAVE (or that DAO's own governance token) is the voting weight for proposals and treasury decisions. |
| **Bridge** | $NAVE can move between Solana and supported EVM testnets (see below). |

### The DAO-formation stake is recoverable, not a fee

Forming a DAO requires staking $99 of $NAVE — this **replaces** an earlier flat SOL creation fee. The key difference: the stake is **recoverable**, not spent. It is locked against the DAO while it is active and is returned to the founder if the DAO winds down (moonlights) and the founder later wants to reopen it, or distributed as part of a moonlight wind-down. See [Treasury Operations](/docs/treasury-operations#winding-a-treasury-down-moonlighting) for the full lifecycle.

The USD price of the stake is resolved by a central price oracle (a Supabase edge function) so the NAVE amount required tracks the live NAVE/USD price rather than a stale on-chain constant. Devnet uses a fixed test price; mainnet samples live market pools and fails closed if too few healthy price sources are available.

## The cross-chain bridge

Nave is multi-chain: treasuries can be created on **Solana**, **Ethereum**, or **Base**. `$NAVE` itself lives natively on Solana (an SPL token) and is represented on supported EVM chains by **WrappedNAVE**, an ERC-20 minted and burned exclusively by the bridge relayer.

> **Status: testnet-only trusted-relayer MVP.** The bridge currently runs between Solana **devnet** and Ethereum **Sepolia** / Base **Sepolia**. It has not been extended to mainnet and has not been independently audited — treat it the same as the rest of the devnet beta. See [Product Maturity](/docs/product-maturity) and [Security & Trust](/docs/security-and-trust).

### How a transfer works

```
Solana → EVM                              EVM → Solana
─────────────                             ─────────────
1. User locks NAVE into a                 1. User burns WrappedNAVE on the
   Solana custody token account              EVM chain
2. Browser notifies the relayer           2. Browser notifies the relayer
3. Relayer independently re-verifies      3. Relayer independently re-verifies
   the lock on-chain                         the burn on-chain
4. Relayer mints WrappedNAVE to the       4. Relayer releases NAVE from
   destination address                       custody to the destination address
```

The relayer is "public-but-verifying": the browser never holds a privileged secret to call it. Instead, the relayer independently re-derives and checks the source-chain transaction before minting or releasing anything, and a unique constraint on the source transaction makes replays idempotent (the same lock/burn can never be paid out twice).

### Fees

A flat **2% bridge fee** is charged on every transfer, taken from the gross amount and routed to the protocol's configured fee wallet on the destination chain. There is no separate network/gas surcharge — the 2% is the only fee, covering the relayer's operating cost on both legs.

### Explicit destination, every time

The bridge form always requires you to type (or confirm a pre-filled, fully editable) destination address before signing anything — it never silently infers a recipient from whichever wallet happens to be connected. A confirmation dialog shows the exact destination and fee breakdown before you sign. Only the **source-side** wallet (the one signing the lock or burn) needs to be connected at all.

### Pending transfers

Once the source-chain lock or burn confirms, the Bridge page shows a **pending** card immediately and polls for completion every 5 seconds — it does not wait for the relayer's full round trip to resolve before giving you feedback. The pending state is persisted locally, so refreshing the page or reconnecting your wallet resumes monitoring instead of losing track of an in-flight transfer.

## The devnet faucet

To make it possible to actually try the bridge without already holding NAVE (or the SOL to pay fees), the Bridge page includes a small devnet faucet that dispenses two assets:

- **NAVE claim:** 0.1 NAVE per claim. The receiving address must already hold at least 0.01 devnet SOL — a lightweight proof that it's a real, already-funded wallet rather than a disposable address spun up purely to drain the faucet.
- **SOL claim:** 0.05 devnet SOL per claim, for transaction fees. No minimum-balance requirement (the whole point is to fund addresses that have no SOL yet).
- **Rate limit:** one claim per asset per 24 hours, enforced on **two independent dimensions at once** — the receiving address and the caller's IP address. Both must pass; rotating IPs cannot bypass the per-address cooldown, and claiming to many addresses from one IP cannot bypass the per-IP cooldown. The NAVE and SOL cooldowns are tracked separately, so claiming one doesn't block the other.

The faucet is a dedicated, separately-funded wallet — distinct from the bridge's own custody authority and from any deployment/ops wallet — so a faucet running low on funds never affects bridge custody.

## Where to go next

- The treasury-level operating lifecycle, including DAO formation and wind-down: [Treasury Operations](/docs/treasury-operations).
- Architecture of the EVM contracts and the bridge/faucet relayer: [Architecture](/docs/architecture).
- Honest current limitations: [Product Maturity](/docs/product-maturity).
