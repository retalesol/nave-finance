# Getting Started

This guide walks a first-time user from a wallet to a Base treasury that agents can watch. No prior DeFi or DAO experience is assumed.

## Launch posture

The founder path is **Base, observe-only**. Quick setup is the default. It writes the Conservative constitution: **60% stays in stablecoins, at most 40% can be deployed, 20% per venue, and 25% stays liquid.** Policy runs may record drift. They do not create proposals while `NAVE_AUTOPROPOSE_ENABLED` is false, which is the default.

Mainnet create is refused while `bridgeCanRedeemNave()` in `src/lib/programConfig.ts` is false. That function is false for the closed Solana `nave_bridge` program, so the app will not create a Base treasury until a replacement bridge can redeem locked NAVE for wNAVE. Do not send a lock or redeem against that closed program.

Capital moves are refused unless they pass the treasury’s on-chain constitution. `callSigner` in `supabase/functions/agent-orchestrator/index.ts` asks `assessSignerPayload` in `supabase/functions/_shared/constitutionVerdict.ts` before it contacts the signer. Capital checks run `evaluateGuardrails` with `requireCompleteConstitution: true`. A failed or indeterminate critical check is logged and the signer is not called.

## What you need

- An EVM wallet (MetaMask, Phantom’s EVM mode, or similar) on **Base** for the launch create flow.
- A Solana wallet only if you are inspecting a Solana devnet treasury. Solana DAO programs in this app are still the devnet deployment, and Solana is not a create network.
- A few minutes. Reading a treasury requires no deposit and no signature.

> Nave is unaudited. Agents watch; they do not move capital until a constitution check passes. Treat mainnet balances accordingly.

## Step 1 — Connect your wallet

1. Open the app and select **Connect Wallet**.
2. Approve the connection in your EVM wallet on Base.
3. Connecting shares your public address. Nave never asks for your seed phrase, and connecting alone never moves funds.

## Step 2 — Create a treasury

Open **Create DAO**. The flow opens on **Quick setup**.

- The network field is Base only. The copy names the Conservative constitution: 60% stable, 40% deployed, 20% per venue, 25% liquid.
- Aggressive and Custom are not on the constitution card. Advanced setup offers Conservative and Balanced only. Sliders stay on the amend flow.
- If the oracle quote, the on-chain stake, and `VITE_NAVE_DAO_CREATION_STAKE_USD` disagree, creation waits. The app does not invent a fallback price.
- While `bridgeCanRedeemNave()` is false, deploy stops with the closed-bridge message and does not broadcast a create transaction.

## Step 3 — Fund, then watch

After a treasury exists, Home shows one next step: **fund the treasury**. Once it is funded, the same card says agents are watching. They record drift and do not move capital until a check passes.

## Step 4 — Read the treasury

The left sidebar’s primary items are:

| View | What it shows |
| --- | --- |
| Dashboard | Headline NAV and the single next step (fund, then agents watching). |
| Activity | Proposals and votes. |
| Constitution | Three sentences from the on-chain rules (liquidity floor, deployment cap, per-venue cap) plus the approved venues. |

**Agents** lives under More. A real treasury shows **Watching**, or **Blocked** plus the failed check from `constitution_check`. It does not show demo pipeline dollars.

## Where to go next

- Readiness, the closed bridge, and the capital-verdict gate: [Product Maturity](/docs/product-maturity).
- Operator cutover checks: `docs/MAINNET_PREFLIGHT.md`.
- Terminology: [FAQ & Glossary](/docs/faq).
