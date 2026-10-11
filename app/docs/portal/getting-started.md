# Getting Started

This guide walks a first-time user from a wallet to a testnet treasury that agents can watch. No prior DeFi or DAO experience is assumed.

## Launch posture

Public beta runs on five networks: **Solana devnet**, **Ethereum Sepolia**, **Base Sepolia**, **Robinhood Testnet**, and **Arc Testnet**. The programs and contracts are unaudited. No mainnet funds are involved.

Do not lock or redeem NAVE against the closed Solana bridge program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. That program cannot redeem locked NAVE for wNAVE. Mainnet create stays refused while `bridgeCanRedeemNave()` in `src/lib/programConfig.ts` is false for that program.

Quick setup is the default. It writes the Conservative constitution: **60% stays in stablecoins, at most 40% can be deployed, 20% per venue, and 25% stays liquid.** Policy runs may record drift. They do not create proposals while `NAVE_AUTOPROPOSE_ENABLED` is false, which is how this beta runs.

Yield a tester can use:

| Network | What you can do with capital |
| --- | --- |
| Solana devnet | Deposit to Jito, and withdraw. |
| Ethereum Sepolia | Deposit to Compound. Sepolia Aave is over the pool supply cap. |
| Base Sepolia | Deposit to Aave. |
| Robinhood Testnet | Create a treasury, deposit, and govern. No lending venue. |
| Arc Testnet | Create a treasury, deposit, and govern. No lending venue. |

MarginFi, swaps, autonomous proposing, and GenLayer are not part of this beta.

Agents watch. They do not open proposals on their own. A new treasury starts with the agent pipeline off. Funding it, then passing a proposal, is what turns the pipeline on. A second guardian is required to close a proposal. New treasuries use a one-minute review window before execution. Treasuries created before the timelock upgrade still have 24-hour delays.

The four roles, in order, are Executive, Financial, Operational, and Oversight. Operational is the final signer. Its stored key is named oversight. Oversight monitors and does not sign. Its stored key is named operational. Leave those stored names as they are.

Capital moves are refused unless they pass the treasury’s on-chain constitution. `callSigner` in `supabase/functions/agent-orchestrator/index.ts` asks `assessSignerPayload` in `supabase/functions/_shared/constitutionVerdict.ts` before it contacts the signer. Capital checks run `evaluateGuardrails` with `requireCompleteConstitution: true`. A failed or indeterminate critical check is logged and the signer is not called.

## What you need

- A wallet for the network you will use. Phantom in devnet mode for Solana. An EVM wallet for Ethereum Sepolia, Base Sepolia, Robinhood Testnet, or Arc Testnet. Arc gas is native USDC (18 decimals). Treasury USDC on Arc is a separate 6-decimal token.
- Testnet gas from the site banner. **Network** selects the chain and, on EVM, asks the wallet to add or switch to it. Solana Devnet opens Phantom’s devnet instructions. **Faucet** opens a QuickNode faucet for Solana devnet SOL, Ethereum Sepolia ETH, Base Sepolia ETH, or Robinhood Testnet ETH. Arc uses Circle’s faucet.
- Nothing else from the protocol. Forming a treasury costs only network gas (and account rent). There is no protocol formation fee and no NAVE or wNAVE creation stake on any chain. A founder may deposit their own assets as a seed. That deposit is their capital, not a fee. Value sent with creation is that seed, not a fee.

> Nave is unaudited. Agents watch. They do not move capital until a constitution check passes and a second guardian closes the proposal. Keep mainnet balances out of this beta.

## Step 1 — Connect and pick a network

1. Open the app. The banner names the five testnets.
2. Open **Network** and select the chain. Approve the wallet add or switch when it asks.
3. Select **Connect Wallet** and approve. Connecting shares your public address. Nave never asks for your seed phrase, and connecting alone never moves funds.
4. Open **Faucet** if the wallet needs gas.

## Step 2 — Create a treasury

Open **Create DAO**. The flow opens on **Quick setup**.

- The network field lists Solana, Ethereum, Base, Robinhood, and Arc.
- Quick setup uses wallet governance, with your connected wallet as a guardian, and writes the Conservative constitution: 60% stable, 40% deployed, 20% per venue, 25% liquid.
- Advanced setup offers Conservative, Balanced, and Yield 6%. The venues that can take a deposit in this beta are still only Jito, Sepolia Compound, and Base Sepolia Aave.
- Mainnet create stops with the closed-bridge message and does not broadcast. Testnet create on the five networks above proceeds.

## Step 3 — Fund, then govern

After a treasury exists, Home shows one next step: **fund the treasury**. Once it is funded, propose enabling the agents if the pipeline is still off. A second guardian has to vote before that proposal can close. After it passes, agents watch: they record drift, and they do not create proposals while `NAVE_AUTOPROPOSE_ENABLED` is false.

A yield deposit is available only on the venues in the table above. Robinhood and Arc stop at deposit and governance.

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
- Terminology: [FAQ & Glossary](/docs/faq).
- The yield fee, formation, and the closed bridge: [Tokenomics & Bridge](/docs/tokenomics).
