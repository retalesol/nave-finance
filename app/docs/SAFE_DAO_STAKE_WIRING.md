# Safe: DAO creation stake is zero (Base + Robinhood)

New treasuries do not lock NAVE or wNAVE. Forming a treasury costs only network gas (and account rent). There is no protocol formation fee.

`NaveDAOFactory.createDao` does not lock a stake, even if an older protocol config still stores a non-zero `requiredNaveStake`. The follow-up owner transaction on each live chain sets that stored amount to **0**:

`setNaveStakeConfig(wNAVE, 0)`

`formationFee` stays 0. Any value a founder sends with creation is their own treasury seed, not a protocol charge.

An existing locked creation stake, from a treasury formed before this change, is still returned when that treasury moonlights. New treasuries have nothing to return. Reopening does not require a new stake.

Shared wNAVE: `0xFc04710C3F310f6ed84b441cf897a05807312358`

| Chain | Protocol | daoStake module |
|-------|----------|-----------------|
| Base 8453 | `0x377D976A31871060B4059fA244b76809A3Cc0C90` | `0xA744784e186c549E490fE1c11F29Bc0aCd2277fd` |
| Robinhood 4663 | `0xaA1BDf23dc9995Aad2035B921E9699CB9d54F29A` | `0xC95D4214ca9711cEd6e4ad261c33BfB7775c79D1` |

The `daoStake` module stays in place so moonlight can release a lock that already exists. It is not a gate on new treasuries.

## Previous configuration (do not restore)

These transactions set a **$19** stake on 2026-07-27 (about 472.010724 wNAVE at roughly $0.04025). That amount is not the current product. Do not re-send it.

- Base: `0x43042faf…a0581`
- Robinhood: `0x8d51633e…b5658`

`app/scripts/wire-dao-stake-safe.mjs` still submits that old non-zero amount. Do not run it to apply this change.

## Set the stored amount to zero

From the Safe Transaction Builder, on each protocol above, call `setNaveStakeConfig(wNAVE, 0)`. Keep the existing module address.

## Verify

```bash
cast call $PROTOCOL "daoStake()(address)" --rpc-url $RPC
cast call $PROTOCOL "requiredNaveStake()(uint256)" --rpc-url $RPC
cast call $PROTOCOL "naveStakeToken()(address)" --rpc-url $RPC
```

`requiredNaveStake()` must be `0`.
