# Using Nave

A screen-by-screen tour of the Nave application for day-to-day use. This page focuses on what each view does and how to read it; deeper operational and governance topics live in the fund-manager and developer tracks.

## The application shell

Once you open a treasury, Nave switches from the marketing site into the application shell: a persistent left sidebar for navigation and a top bar showing the active treasury and your connected wallet. Every view below is reachable from the sidebar.

## Dashboard

The dashboard is the treasury's at-a-glance summary.

- **Net asset value (NAV)** — the total value of everything the treasury holds, priced from live market data.
- **Deployed capital** — the portion of NAV currently working in strategies versus held as liquid reserve.
- **Recent activity** — a reverse-chronological feed of indexed on-chain events: deposits, proposals, approvals, executions, and agent decisions.
- **Charter check** — when a move has been reviewed, the treasury header and the proposal card show Checked, Needs a closer look, or Still checking. An empty treasury shows nothing. Ask for another check asks for a second look. It does not move funds.

Use the dashboard to answer "what is this treasury worth, and what has it done lately?"

## Assets

The assets view breaks NAV down into its components.

- Per-asset balances held by the treasury vault.
- Current valuation of each holding.
- Where capital is deployed across approved strategies.

This is the authoritative picture of composition. The numbers reconcile against on-chain balances; the invariants behind that reconciliation are documented in [Treasury Reconciliation](/docs/reconciliation).

## Governance

Governance is where treasury decisions are ratified.

- **Proposals** — strategy, configuration, and treasury-action proposals, each with their current status.
- **Voting** — cast and track votes according to the DAO's governance model.
- **Constitution** — the ratified rules that bound what the treasury and its agents may do.

For how a constitution is authored and what each parameter controls, see [Constitution & Policy](/docs/constitution-and-policy).

## Agent

The agent view surfaces the AI decision layer in real time.

- The current decision, the model's confidence, and whether it cleared the deterministic guardrails.
- The live execution pipeline as a proposal moves toward signing.
- Per-action detail: constitution checks, risk flags, the payload hash, the reasoning hash, and the on-chain signer signature.

Crucially, the model is advisory. A decision only results in a signed transaction if it also passes the deterministic guardrails described in [Agent Fine-Tuning](/docs/fine-tuning).

## Policy

The policy engine continuously evaluates the treasury against its constitution and surfaces recommendations — for example, when an allocation drifts past a cap or liquidity falls toward a floor. Recommendations are observable here before any action is taken.

## Settings

Settings holds treasury configuration and operator preferences across four tabs — **Team**, **Security**, **Activity**, and **DAO**. The controls available depend on your role within the DAO and the governance model in effect.

The **DAO** tab is where a treasury's wind-down lifecycle ("moonlighting") lives: a single **Begin Moonlighting** action creates a governance proposal, and once members vote it through, the same tab walks the founder/proposer through setting a distribution wallet and finalizing the wind-down. See [Treasury Operations](/docs/treasury-operations#winding-a-treasury-down-moonlighting) for the full lifecycle.

## Bridge

The bridge is a standalone page outside the treasury application shell (it does not require an active treasury) for moving `$NAVE` between Solana and the supported EVM testnets. It always asks for an explicit destination address — never silently inferring one from whatever wallet happens to be connected — and shows a confirmation dialog with the fee breakdown before anything is signed. A non-dismissible banner on this page links to a small devnet faucet for test NAVE. Full mechanics, fees, and the faucet's rate limits are in [Tokenomics & Bridge](/docs/tokenomics).

## Reading on-chain truth

Across every screen, Nave's display values come from two places: direct reads of Solana accounts, and an indexed event history populated from on-chain logs. There is no hidden off-chain ledger. If you want to verify a figure independently, the activity feed links transactions you can inspect on a block explorer.

## Where to go next

- Terms and acronyms: [FAQ & Glossary](/docs/faq).
- Operating a treasury: [Treasury Operations](/docs/treasury-operations).
- The token, the bridge, and the faucet: [Tokenomics & Bridge](/docs/tokenomics).
- How the data pipeline works: [Architecture](/docs/architecture).
