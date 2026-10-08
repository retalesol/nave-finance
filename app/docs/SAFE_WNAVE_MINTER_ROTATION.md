# Safe: rotate wNAVE minter + accept UUPS ownership

Safe: `0xd338C8d0C3e28979D1cFec2f7C66769C796db89c`  
Shared wNAVE (both chains): `0xFc04710C3F310f6ed84b441cf897a05807312358`  
v1 lockbox (still live — do **not** pause): `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654`  
Deploy wallet (current owner of pending UUPS): `0xC00C1F6Bb6882bde84bbC8b9C4Dc4a3B24057586`

| Role | Base 8453 | Robinhood 4663 |
|------|-----------|----------------|
| v2 lockbox | `0x4C06d8b71C16428D828F8d5bd05e21E0D1d81573` | `0xD6d361Cd70FCD82802646aA90c0BA2D6EDA5Bd71` |
| v2 staking | `0x18E8F7b1c313D53FFC35b2b59F25Fada3B9CE5B2` | `0x4C06d8b71C16428D828F8d5bd05e21E0D1d81573` |
| protocol | `0x377D976A31871060B4059fA244b76809A3Cc0C90` | `0xaA1BDf23dc9995Aad2035B921E9699CB9d54F29A` |
| factory | `0x280470c7275d630f1a9Fc1C406D4754D1f523Dbb` | `0xd35a2652aDff2EFC5515eAC3e4055B81fE4533f8` |
| oracle | `0x6D9d565320a75998862eE8e677A68bA74F6A7d66` | `0x3a0Ef5de726e7056FA863C673D30Af06C58f80ce` |

On-chain today: `wnave.minter() == v1 lockbox`. Relayer follows on-chain minter, so mints stay on v1 until rotation completes. Burns always use shared wNAVE.

---

## Recommended order (do Base first, then Robinhood)

### A. Accept ownership (Safe — both chains)

In Safe Transaction Builder, for **each** address below call `acceptOwnership()` (no args):

1. protocol  
2. factory  
3. oracle  
4. v2 lockbox  
5. v2 staking  

Verify after batch: `owner() == Safe` and `pendingOwner() == 0x0` on each.

### B. Rotate minter to v2 lockbox (Safe — both chains)

1. On **wNAVE**: `setMinter(v2Lockbox)`  
   - Base: `setMinter(0x4C06d8b71C16428D828F8d5bd05e21E0D1d81573)`  
   - RH: `setMinter(0xD6d361Cd70FCD82802646aA90c0BA2D6EDA5Bd71)`
2. On **v2 lockbox** (now Safe-owned): `acceptMinterRole()` (no args)
3. Verify: `wnave.minter() == v2Lockbox`

### C. Do **not**

- Do not pause or unown the v1 lockbox while RH/Base still hold v1-minted wNAVE (~3,001 on RH).
- Do not point app/relayer at archived parallel-wNAVE stacks.

### D. Smoke after rotation

1. Burn / unwrap existing wNAVE (shared token) → Solana.  
2. Solana → EVM mint should land via **v2** lockbox (`resolveMintLockbox` reads `wnave.minter()`).  
3. Confirm Relayer / Railway healthy.

---

## Cast helpers (read-only checks)

```bash
# Base
cast call 0xFc04710C3F310f6ed84b441cf897a05807312358 "minter()(address)" --rpc-url $EVM_BASE_RPC_URL
cast call 0xFc04710C3F310f6ed84b441cf897a05807312358 "owner()(address)" --rpc-url $EVM_BASE_RPC_URL

# Robinhood
cast call 0xFc04710C3F310f6ed84b441cf897a05807312358 "minter()(address)" --rpc-url $EVM_ROBINHOOD_RPC_URL
```

Until step B.3, the signer keeps minting via v1 automatically.
