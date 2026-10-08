# Chain reprobe — 2026-10-01

Phase 0 of the sell-readiness plan (`reprobe-and-contain`). Read-only. No transactions were sent, no contract was paused, and no signer or Railway environment variable was changed.

Probed at **2026-10-01T09:18:40Z**.

## Verdict

A burn can still lose funds. `bridgeBurn` on wNAVE is live on Base, Robinhood, and Ethereum. The Solana `release` that would pay the burner cannot run: both mainnet program-data accounts are gone. Lockboxes are unpaused and `mintPaused` is false, so the relayer can still mint new wNAVE against that closed release path.

**Locked NAVE (unreachable): 3,688.845000**

| Account | Raw (6 decimals) | NAVE |
|---|---:|---:|
| Bridge custody `Cww4xttTeD1qR6XVpSRZ5qitQmkJP8p2Tf2HUNdg2AmF` | 3,033,845,000 | 3,033.845000 |
| Stake vault `9xpDBgUDRVXL5W1j5kFZmoojqyXPWZSKxNVQ6Dxuk4jw` | 655,000,000 | 655.000000 |
| Reward vault `ERC6WdtvAieWNC1aEfm7Nu4sQMUPWaYex4GLW4CtCwCW` | 0 | 0.000000 |
| **Custody + stake vault** | **3,688,845,000** | **3,688.845000** |

Outstanding wNAVE that this custody was meant to back: **3,016.345575**. Stake-vault principal on top of that: **655.000000 NAVE**.

## Operator actions still required

This pass did not perform them.

1. **Pause mints and staking on EVM** (owner keys below).
   - `setMintPaused(true)` on wNAVE `0xFc04710C3F310f6ed84b441cf897a05807312358` on chains 8453, 4663, and 1.
   - `setPaused(true)` on both lockboxes on Base and Robinhood, and on the single Ethereum lockbox.
   - `setPaused(true)` on `NaveStaking` on chains 8453, 4663, and 1.
2. **Set `BRIDGE_RELAYER_ENABLED=false`** on the signer. Leave it false until a new bridge exists and a redemption choice is in force.
3. **Choose redemption before any new Solana bridge deploy.** Either pay outstanding wNAVE (3,016.345575) and stuck stake principal (655 NAVE) from protocol inventory, or snapshot holders and honor those balances on the new bridge. The 3,688.845000 NAVE in the closed-program token accounts cannot be moved by the old program ids.

Who can send the EVM pauses:

| Chain | Owner that must sign | What that owner is |
|---|---|---|
| Base 8453 and Robinhood 4663 | Safe `0xd338C8d0C3e28979D1cFec2f7C66769C796db89c` | Threshold **1**. Sole owner `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`. |
| Ethereum 1 | `0xFf888986b1e7Bf1ea2740825eeCB7fF98b484879` | EOA. Same address is wNAVE owner, lockbox owner, lockbox relayer, staking owner, and staking rewarder. |

Solana config still stores `paused = false` for bridge and staking. Those flags cannot be changed. The program-data accounts are gone, so `set_paused`, `release`, `lock`, and `unstake` have no bytecode to run. The stored Solana owner `GdRMR4nMKZDRNEauASa4JyRGptjQD6tEW4xtu5MfNave` has no account (0 lamports).

`setMintPaused(true)` stops `mint`. It does not stop `bridgeBurn`. After the pauses above, a holder can still burn wNAVE in one transaction and receive nothing on Solana.

## Why a burn loses funds

`WrappedNave.bridgeBurn` burns the caller's wNAVE and emits `BridgeBurnTo`. `mintPaused` only gates `mint` (`contracts/evm/src/WrappedNave.sol`). The relayer is supposed to call `release` on Solana `nave_bridge`. That program's bytecode account does not exist, confirmed on two public RPCs. Custody is owned by PDA `8d7Do6DWyueT72EWkSXTUHJEapX9HkZpXkuWijsTtrp3`, which only the closed bridge program can sign for.

The same is true in the other direction for new locks: Solana `lock` cannot run, while each chain's current minter is an unpaused lockbox, so `bridgeIn` can still mint wNAVE.

| Chain | wNAVE supply | Current minter (lockbox that can mint) | `mintPaused` |
|---|---:|---|---|
| Base 8453 | 1.488075 | v2 `0x4C06d8b71C16428D828F8d5bd05e21E0D1d81573` | false |
| Robinhood 4663 | 3,001.487500 | v2 `0xD6d361Cd70FCD82802646aA90c0BA2D6EDA5Bd71` | false |
| Ethereum 1 | 13.370000 | `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654` | false |
| **Sum** | **3,016.345575** | | |

Custody 3,033.845000 minus that supply is 17.499425 NAVE. That surplus sits in the same unreachable custody account. NAVE mint `EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory` has mint authority and freeze authority both unset (supply 499,698.092330). Locked tokens cannot be re-minted.

## How the reads were taken

Public RPCs only. Chain id was checked on every EVM response.

| Network | RPC | Height | Time |
|---|---|---|---|
| Ethereum 1 | `https://ethereum.publicnode.com` (fallback `https://rpc.ankr.com/eth`, `https://eth.llamarpc.com`, `https://cloudflare-eth.com`) | block 26,096,517 | 2026-10-01T09:17:35Z |
| Base 8453 | `https://mainnet.base.org` (fallback `https://base.publicnode.com`, `https://base.llamarpc.com`) | block 52,028,463 | 2026-10-01T09:17:53Z |
| Robinhood 4663 | `https://rpc.mainnet.chain.robinhood.com` | block 77,261,276 | 2026-10-01T09:18:14Z |
| Solana mainnet | `https://api.mainnet-beta.solana.com` | slot 452,245,034 | 2026-10-01T09:18:34Z |
| Solana confirm | `https://solana-rpc.publicnode.com` | slot 452,245,423 | same balances and absent program-data |

All four RPCs answered. No balance below is filled in from the September 2026 note.

wNAVE on every chain is symbol `wNAVE`, 6 decimals, `pendingMinter` zero, `supplyCap` 100,000.000000 (raw 100,000,000,000). The token has `mintPaused`, and `paused()` reverts. Lockboxes and staking have `paused`, and `mintPaused()` / `minter()` revert. `NaveProtocol` is the same: `owner` and `paused` only.

Lockbox caps, where the view exists: per-tx **1,000** and daily **25,000** (raw 1,000,000,000 and 25,000,000,000). Ethereum's deployment file still says a 10,000 daily cap; the live value is 25,000.

## EVM

### Base 8453

| Contract | Address | Code | owner() | paused | mintPaused | minter | totalSupply |
|---|---|---:|---|---|---|---|---|
| wNAVE | `0xFc04710C3F310f6ed84b441cf897a05807312358` | 5,761 | Safe `0xd338…b89c` | no `paused()` | **false** | v2 lockbox `0x4C06…1573` | **1.488075** |
| Lockbox v1 | `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654` | 2,170 | Safe | **false** | not a function | not a function | — |
| Lockbox v2 | `0x4C06d8b71C16428D828F8d5bd05e21E0D1d81573` | 76 (proxy) | Safe | **false** | not a function | not a function | — |
| NaveStaking | `0x18E8F7b1c313D53FFC35b2b59F25Fada3B9CE5B2` | 76 (proxy) | Safe | **false** | not a function | not a function | — |
| NaveProtocol | `0x377D976A31871060B4059fA244b76809A3Cc0C90` | 76 (proxy) | Safe | **false** | not a function | not a function | — |

Lockbox relayer on both v1 and v2: `0x745899B98CCd065Abf23010511eDa8a23094a6E7`. Staking `rewarder()` is that same relayer.

### Robinhood 4663

| Contract | Address | Code | owner() | paused | mintPaused | minter | totalSupply |
|---|---|---:|---|---|---|---|---|
| wNAVE | `0xFc04710C3F310f6ed84b441cf897a05807312358` | 5,761 | Safe `0xd338…b89c` | no `paused()` | **false** | v2 lockbox `0xD6d3…Bd71` | **3,001.487500** |
| Lockbox v1 | `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654` | 2,170 | Safe | **false** | not a function | not a function | — |
| Lockbox v2 | `0xD6d361Cd70FCD82802646aA90c0BA2D6EDA5Bd71` | 76 (proxy) | Safe | **false** | not a function | not a function | — |
| NaveStaking | `0x4C06d8b71C16428D828F8d5bd05e21E0D1d81573` | 76 (proxy) | Safe | **false** | not a function | not a function | — |
| NaveProtocol | `0xaA1BDf23dc9995Aad2035B921E9699CB9d54F29A` | 76 (proxy) | Safe | **false** | not a function | not a function | — |

Lockbox relayer on both v1 and v2, and staking rewarder: `0x745899B98CCd065Abf23010511eDa8a23094a6E7`.

### Ethereum 1

Chain 1 has one lockbox in `hardened-bridge-1.json`. There is no second lockbox address on that artifact. `deployments/1.json` protocol `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` and factory `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` have **0 bytes of code**.

| Contract | Address | Code | owner() | paused | mintPaused | minter | totalSupply |
|---|---|---:|---|---|---|---|---|
| wNAVE | `0xFc04710C3F310f6ed84b441cf897a05807312358` | 5,761 | `0xFf88…4879` | no `paused()` | **false** | lockbox `0x608c…4654` | **13.370000** |
| Lockbox | `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654` | 2,170 | `0xFf88…4879` | **false** | not a function | not a function | — |
| NaveStaking | `0xC8f3BD11a62D39133DdFb5D653789eAe9d8630ec` | 4,082 | `0xFf88…4879` | **false** | not a function | not a function | — |
| NaveProtocol (Anvil artifact) | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | **0** | — | — | — | — | — |

Lockbox relayer and staking rewarder: `0xFf888986b1e7Bf1ea2740825eeCB7fF98b484879` (same EOA as owner). That address has no code.

`hardened-bridge-8453.json` and `hardened-bridge-4663.json` still say owner `0xC00C1F6Bb6882bde84bbC8b9C4Dc4a3B24057586` and `status: primary-awaiting-minter-rotation`. Live chain has the Safe as owner and the v2 lockbox as minter, with `pendingMinter` zero.

## Solana mainnet

PDA seeds from `nave_bridge` / `nave_staking` constants: `bridge_config`, `bridge_custody_authority`, `bridge_custody`, `stake_pool`, `stake_pool_authority`, `stake_vault`, `reward_vault`.

### Programs

| Program | Program account | Program data | Bytecode |
|---|---|---|---|
| Bridge `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6` | Exists. Upgradeable loader, executable, 36 bytes, 1,141,440 lamports. Tag Program, data address `7UAwroUw7pRm1f21gwk9JPkw9dRbN83YtRDJphaVQ1o3`. | **Account does not exist** (both RPCs). | None. Id cannot be reused; the shell still occupies it. |
| Staking `AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf` | Exists. Same shape, 1,141,440 lamports. Data address `Cvc2ysQx5sp6bCytA5d3Myx6y8qfg1DpwmTXUEpsBRXX`. | **Account does not exist** (both RPCs). | None. Id cannot be reused. |

### Derived accounts

| Account | Address | State |
|---|---|---|
| Bridge config | `B7AEEMHQNvsiPGeKuEFWXhCPnexouXS1HuL6xRF8KLY7` (bump 253) | 347 bytes, owned by the bridge program. Owner `GdRMR4nMKZDRNEauASa4JyRGptjQD6tEW4xtu5MfNave`. Pending owner default (`11111111111111111111111111111111`). Relayer `ik4dEP4eh8FCXVttYYR4ByAABibji6bkWRihX9cbp5v`. NAVE mint matches `EGg56…`. Custody field matches the custody token account. `paused` byte **0**. Per-tx cap 1,000 NAVE. Daily cap 25,000 NAVE. Layout ends at the reserved region (no later allowlist fields). |
| Custody authority PDA | `8d7Do6DWyueT72EWkSXTUHJEapX9HkZpXkuWijsTtrp3` (bump 254) | No account of its own. It is the token-account owner of custody. |
| Custody | `Cww4xttTeD1qR6XVpSRZ5qitQmkJP8p2Tf2HUNdg2AmF` (bump 252) | SPL token account. Mint `EGg56…`. Balance **3,033.845000 NAVE**. |
| Stake pool | `ErPMXb4Z5yGzgsdh42i5MkLxWUrgL7b5KRoQC6qsEfxt` (bump 254) | 299 bytes, owned by the staking program. Same owner pubkey as the bridge. `total_staked` raw 655,000,000. `paused` byte **0**. Vault fields match the token accounts below. |
| Pool authority PDA | `5hyY47WbD9CodgMpZZtoR6kQ6aupQiorPcRmYBmAFDEo` (bump 255) | No account of its own. Token-account owner of the stake vault and reward vault. |
| Stake vault | `9xpDBgUDRVXL5W1j5kFZmoojqyXPWZSKxNVQ6Dxuk4jw` (bump 253) | **655.000000 NAVE**. Equals `total_staked`. |
| Reward vault | `ERC6WdtvAieWNC1aEfm7Nu4sQMUPWaYex4GLW4CtCwCW` (bump 255) | **0 NAVE**. |

### Mint and relayer SOL

| Item | Result |
|---|---|
| NAVE mint `EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory` | Initialized, 6 decimals, supply 499,698.092330. **Mint authority null. Freeze authority null.** |
| Relayer `ik4dEP4eh8FCXVttYYR4ByAABibji6bkWRihX9cbp5v` | **0 lamports.** `getBalance` on mainnet-beta returned 0. The account is absent on publicnode, which is the same fact. This key cannot pay a Solana fee. |

The staking fee collector is a token account created at init, not a program PDA, so it was not derived and its balance is not reported here.
