# Safe: wire NAVE DAO creation stake (Base + Robinhood)

Stake amount is **operator-adjustable** anytime via Safe
`setNaveStakeConfig(wNAVE, amount)` on each protocol. App label USD comes from
`VITE_NAVE_DAO_CREATION_STAKE_USD` (default **19**).

Shared wNAVE: `0xFc04710C3F310f6ed84b441cf897a05807312358`

| Chain | Protocol | daoStake module |
|-------|----------|-----------------|
| Base 8453 | `0x377D976A31871060B4059fA244b76809A3Cc0C90` | `0xA744784e186c549E490fE1c11F29Bc0aCd2277fd` |
| Robinhood 4663 | `0xaA1BDf23dc9995Aad2035B921E9699CB9d54F29A` | `0xC95D4214ca9711cEd6e4ad261c33BfB7775c79D1` |

## Current ($19 ≈ NAVE @ live price)

Recompute when changing USD target:

```bash
# amount = round(USD / price * 1e6)
# 2026-07-27: $19 @ ~$0.04025 → 472010724
```

Wired txs (set to $19):
- Base: `0x43042faf…a0581`
- RH: `0x8d51633e…b5658`

## Re-run

```bash
SAFE_OWNER_PRIVATE_KEY=0x… node scripts/wire-dao-stake-safe.mjs
```

Or only update amount (keep module): Safe Transaction Builder → protocol
`setNaveStakeConfig(wNAVE, <baseUnits>)`.

## Verify

```bash
cast call $PROTOCOL "daoStake()(address)" --rpc-url $RPC
cast call $PROTOCOL "requiredNaveStake()(uint256)" --rpc-url $RPC
cast call $PROTOCOL "naveStakeToken()(address)" --rpc-url $RPC
```
