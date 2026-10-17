# Devnet Public Beta — Go/No-Go Checklist

Use this after completing the code paths in the beta readiness plan. Pair with
[`docs/DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) for full E2E evidence and exit
criteria.

## E2E gate status (documentation)

| Gate | Doc | Status |
|------|-----|--------|
| Core devnet gate (autonomous agents, escrow SPL, withdraw, reconciliation, `agent_action_logs`, `expire_request` via localnet beta-path) | [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §5 | **Documented complete** — run records 2026-05-31 + `beta-path-scenarios.ts` |
| Extended autopolicy / auto-propose loop | [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §6 | **Deferred** — not required for minimal public devnet beta |

## Automated checks

```bash
# Distinct bearer secrets (copy output into Supabase / Railway — do not commit)
npm run secrets:generate

# Local contract beta-path tests (requires localnet validator)
cd ../contracts/solana && npm run test:localnet -- --grep "beta-path"

# Live devnet gate verifier (after indexing; uses Supabase service role)
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SOLANA_RPC_URL=… \
DAO_ADDRESS=<dao> npm run verify:e2e-gate

# Ops probe (edge health, signer, optional DAO gate) — run manually before launch
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
NAVE_SIGNER_URL=… npm run beta:go-no-go
```

These checks are manual. This repo does not use GitHub Actions. Run
`npm run typecheck` in `app/` before a deploy, and run `npm run beta:go-no-go`
against the live hosts before inviting testers. `npm run beta:health-report`
is the same kind of probe and is also run by hand.

## Repository & build defaults (verified in source)

These are **true in this repo**; production deploys must still confirm env vars on
the **host**.

- [x] **`VITE_USE_MOCKS=false`** in [`.env.example`](../.env.example) — public beta
  builds must keep mocks off or every treasury shows bundled demo data.
- [x] **Demo treasury CTAs** — hidden in production Vite builds (`import.meta.env.PROD`);
  optional `VITE_DEMO_TREASURY_NAV=true` for preview; see `DEMO_TREASURY_NAV_ENABLED`
  in `src/lib/mockData.ts`.
- [x] **Escrow PDA defaults** — [`.env.example`](../.env.example) documents
  `VITE_ESCROW_PDA_ENABLED=true`; `scripts/beta-go-no-go.mjs` warns if
  `VITE_ESCROW_PDA_ENABLED` or `NAVE_ESCROW_PDA_ENABLED` is explicitly `false`.

## Production deployment checklist (verify on each host)

Check each item on the **deployed** Supabase project, signer service, worker, and
frontend CDN/host. Do not check these off until values are confirmed live.

- [ ] `VITE_USE_MOCKS=false` on the **public** frontend build
- [ ] `VITE_ESCROW_PDA_ENABLED=true` and `NAVE_ESCROW_PDA_ENABLED=true` (or unset → signer default on)
- [ ] Three **distinct** `NAVE_*_SECRET` values set in Supabase + signer (see [`docs/SECRETS.md`](SECRETS.md))
- [ ] `NAVE_ALLOWED_ORIGINS` set for the deployed app origin
- [ ] `NAVE_SIGNER_URL` explicitly set (no implicit default host)
- [x] Solana event delivery: QuickNode stream `nave-solana-devnet` (`d41f57ba-0909-417d-bbd3-81fcb6557b7a`) posts Solana devnet program logs to `helius-webhook` with header auth only. The Helius plan has ended and that webhook stays off.
- [ ] Worker running (`signer-service` `npm run worker`) or founder-gated orchestrator proxy
- [ ] `init_strategy_escrow` called per approved protocol before first execute
- [ ] `npm run beta:go-no-go` passes against **this** deployment (no blockers)
- [ ] Optional live `expire_request` tx recorded in [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §5 if you require devnet redundancy beyond localnet `beta-path`

## Product copy

Tester-facing status. The production deployment checklist above is still open.
Engineering and Ops sign-off below stays blank until that checklist is confirmed
on the live hosts.

- Public beta covers all 5 testnet chains: **Solana Devnet (`solana`)**, **Ethereum Sepolia (`11155111`)**, **Base Sepolia (`84532`)**, **Robinhood Chain Testnet (`46630`)**, and **Arc Testnet (`5042002`)**. Unaudited. No mainnet funds.
- Do not lock or redeem NAVE against the closed Solana bridge `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. Mainnet create stays refused while that bridge cannot redeem.
- Yield testers can deploy across all 5 testnets: Solana Jito (`E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT`) & Kamino (`B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD`), Ethereum Sepolia Compound V3 (`0x845d8310A861A95Ed1644643D1BAe086944B1AA0` / `0xa675dC4A02304ce069D98760DcF64B0cf3530A80`) & Aave V3 (`0xA9183aB50EB70f5F271faB81E50b61a5B11b0a4B`), Base Sepolia Aave V3 (`0x33D19799EBac88FFDc4e5BF61c199c71963470A6` / `0xcA99d4A75A41C3aff5F3Fc2c2Dfd241129B1e093`), Robinhood Chain Testnet ERC-4626 USDC & WETH yield vaults (`0x31be55dCf50a71B42948408c9eFE7004f827BF0F` / `0xF16421BDD5B9D6418d3133c49f3Afc8cdf15b457`), and Arc Testnet ERC-4626 USDC yield vault (`0x12DA47672287c188C79c1504eE72E2aC8b446f7B`).
- Autonomous planner (`NAVE_AUTOPROPOSE_ENABLED=true`), 4-agent approval pipeline (`executive` → `financial` → `oversight` → `operational`), GenLayer Bradbury charter/venue/halt reviews, and `clear_halt` recovery (both autonomous Oversight clearing for model-only halts when all deterministic checks pass, and founder-signed `agent-admin` `clear_halt`) are live on all 5 testnets.
- Four roles, in order: Executive, Financial, Operational (final signer; stored key oversight), Oversight (monitor, does not sign; stored key operational). Leave the stored key names as they are.
- Forming a treasury costs only network gas (and account rent) on every beta chain. There is no protocol formation fee and no NAVE or wNAVE creation stake. A founder may deposit their own assets as a seed. That deposit is their capital, not a fee. The only protocol treasury fee is 15% of realized yield on strategy withdrawal. Principal is not charged. Frozen treasuries use the same 15%. There is no annual management fee.
- Testnet gas comes from the site banner. **Network** selects the chain. **Faucet** opens QuickNode for Solana, Sepolia, Base Sepolia, and Robinhood. Arc uses Circle’s faucet.

### What testers can do

Create a treasury on any of the five testnets, deposit testnet assets, govern with guardians, and run autonomous strategy proposals, 4-agent approvals, halt recovery, and yield deployments across Solana Devnet, Ethereum Sepolia, Base Sepolia, Robinhood Chain Testnet, and Arc Testnet. This note does not mark the host checklist complete.

## Five-Chain Autonomous E2E Verification Matrix (2026-10-17)

| Chain | Factory / Core Program | Oracle | Asset / Vault | Adapter / Venue | Verified DAO (`dao_registry`) | Planner / Strategy Proposal | Execution Request (`Executed`) | Execution Tx Hash |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Solana Devnet (`solana`)** | Core `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB`<br>Gov `CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M`<br>Exec `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` | Chainlink SOL/USD `99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR` | wSOL `So11111111111111111111111111111111111111112` | `jito` (`E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT`) | `8nUQ11yY2ybhMhs7h2zdkAxm3eoFvSLtteRsXr4Pa6N6` | `EuJ7DNLmS1WHwchZnurzy4wDoF4QMFzWp5zs1Wb1xW8y` | `HVcZhHaauS7RNvRxDrxmgfJnFErfYNJsmt3H43LwpMG5` | Execute: `UcUWiq64BxHpCawd2sgmqXdkQ1FoG4Xo7sWKp5CRH5jmcYmnYQwsbFnyeNHsa1tuLa82E8ytRyimZ3HfZDJAqQT`<br>Jito Deposit: `2XAc89tSUDNKN3tPMb8ZEDcVZdaZiPkPVZ5XZMVXPDoUF5HLVwhWpSHcuG4K7QC5dupHoRRQwziJiHSGk9RBvEpf` |
| **Ethereum Sepolia (`11155111`)** | Factory `0x4F01c9616A48F14009EC083Ff4bb6e47EdDE0890`<br>Protocol `0x6B9eD0D1c98B9a4C44F3dfC1ca7dEf52E101f2d5` | Chainlink USDC/USD `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E` | USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`<br>Comet `0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e` | `compound-v3` (`0x845d8310A861A95Ed1644643D1BAe086944B1AA0`) | `0xb97ed9858955fd69d89a7f23a1d96cd863141b04` | `evm:11155111:0x0D2dacc0D2BC10DE149e34C78Beaf7484Fda0a35:2` | `0xd7ed18c46c32eb65f76c7d539d7a47609ee4f01f#2` (also `#0` Executed) | Clear Halt: `0xd3a112cb0d306719e585f4cf9e445a5f1a5d3fbe38833492a47fed86640e2837`<br>Execute: `0x3209d358b941f4adb2074d0070468612ad29cf5a72b211bc091e097d5cf0bfb4` |
| **Base Sepolia (`84532`)** | Factory `0xF53dE95ae1Fed92FFd9C9305E1716FD48EFcB776`<br>Protocol `0xF37271a4A120eD904543bbE648D2f64Fa27b3bC6` | Oracle `0x985877AcDF01A21527E093bc4fCE513EB180C775`<br>Chainlink USDC/USD `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` | USDC `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`<br>Aave Pool `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` | `aave-v3` (`0x33D19799EBac88FFDc4e5BF61c199c71963470A6`) | `0xcb8083b1c226109f66c026e8a15230bd363fd2f8` | Planner: `evm:84532:0x1a83f8e75fD9bb3bD25b9a9e5695E96083423B58:0`<br>Fast-vote: `#4` | `0xf5596026ae14bc610bb5e60a59eb6690453f447f#4` | `0x317ae28b7896701b3465701b36a18523998264c4af35b77888fb5533df2eedb2` |
| **Robinhood Testnet (`46630`)** | Factory `0x303cE551De723cad43e1575C4D981C0E2b662b7F`<br>Protocol `0xcA99d4A75A41C3aff5F3Fc2c2Dfd241129B1e093` | `TestnetPegOracle` `0x47b76d227c11279Ebd24FBC370162F3A22c46e64` | USDC `0xAaaE26C5B891bF00D4cD6eF04148Bf1CB1CC96b1`<br>ERC-4626 Vault `0x7ED95FF3bF19f474b4885EbfbE94c18d3b7C72A8`<br>(WETH Vault `0x5526D13Df58aeB932FD5b1746d5FFD7B33887f3c`) | `morpho-steakhouse-usdg` (`0x31be55dCf50a71B42948408c9eFE7004f827BF0F`) | `0xfeb6fb288543b9a4e7151d2f31e7e48803a29d1f` | Planner: `evm:46630:0xd816dC35db68978F3Ae25aEdb22Bb0bd7dAd3990:0`<br>Fast-vote: `#1` | `0x0b4241de652c85440e031e14f990345017533b76#1` | `0xf86aab4845b965bd50fb27c9d5fc8c8af69998bd2b6acccc51e26ba6cf2abcad` |
| **Arc Testnet (`5042002`)** | Factory `0xa7bd919a5249DD1Da6E02a6716D2Db2B2e0A99f0`<br>Protocol `0x3334fBe32eEe1F9f34C047d90762b3030B5Fe255` | Oracle `0x333a522EBee72763cA1173F9D3C510753Fb49940`<br>Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43` | USDC `0x3600000000000000000000000000000000000000`<br>ERC-4626 Vault `0x6B737500895C4196E855198F7B8a02Bae87E2D72` | `morpho-steakhouse-usdc` (`0x12DA47672287c188C79c1504eE72E2aC8b446f7B`) | `0xb073c33d0e003646f9fb244f201bb862c5680043` | Planner: `evm:5042002:0x7AD40FAE8429354a5C0d2C96DF0861447e88d1fC:0`<br>Fast-vote: `#1` | `0x95ff1cb4765203659f5a3d4384b4b0f935da6bde#1` | `0x7e2943605a8df6461c09d7005b331365d564b4be50b11c1e338b8282a0858673` |

## Public-beta dry run evidence (2026-10-10)

Signatures and what each chain proved are in [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md), section "Public-beta live treasury dry run — 2026-10-10". Sepolia Compound, Base Sepolia Aave, Robinhood, and Arc completed on new treasuries. Solana completed create, stake, deposit, and a two-guardian close. After the `nave_execution` upgrade recorded in that gate, Jito deposit and withdraw also completed. That evidence does not check the production deployment list above and does not mark GO.

## Sign-off

Replace placeholders after Engineering and Ops validate the **production
deployment checklist** (not only repo defaults).

| Role | Name | Date | GO / NO-GO |
|------|------|------|------------|
| Engineering | | | |
| Ops | | | |
