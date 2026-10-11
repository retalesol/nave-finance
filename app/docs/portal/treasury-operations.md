# Treasury Operations

For the person responsible for a treasury — a DAO operator, a fund manager, or a finance lead. This page covers the operating lifecycle of a Nave treasury: formation, funding, deployment, monitoring, and withdrawal. Policy authoring and risk controls have dedicated pages; this is the operational spine that ties them together.

## The treasury lifecycle

```
Form DAO + ratify constitution
        ──▶ Fund the vault
        ──▶ Deploy capital into approved strategies
        ──▶ Monitor NAV, allocations, agents
        ──▶ Rebalance / withdraw within policy
        ↺  back to Monitor
```

## 1. Formation

A treasury begins with DAO creation: a name, a governance model, and an initial constitution. The constitution is not optional boilerplate — it is the enforceable rulebook that bounds every later action. Decide your approved protocols, allocation caps, liquidity floor, and confidence thresholds up front. See [Constitution & Policy](/docs/constitution-and-policy).

Forming a treasury costs only network gas (and account rent). There is no protocol formation fee and no NAVE or wNAVE creation stake on any chain. A founder may still deposit their own assets into the treasury as a seed. That deposit is their capital, not a fee.

The only protocol treasury fee is **15% of realized yield**: the gain above principal when a strategy position is withdrawn. Principal is not charged. Yield that is still deployed is charged when it is withdrawn. Frozen treasuries use the same 15%. There is no annual management fee. The skim is paid in-kind to the protocol revenue wallet. See [Tokenomics & Bridge](/docs/tokenomics) for what `$NAVE` is used for. Forming a treasury is not one of those uses.

## 2. Funding

Funding moves assets into the treasury's on-chain vault. From the moment assets land, NAV is computed from the real vault balance priced with live market data. There is no separate book to maintain; the vault is the ledger.

## 3. Deployment

Capital is put to work by executing strategies into approved protocols. Nave currently exercises real cross-program paths on devnet for staking, lending, and swap-based strategies. Deployment is always bounded:

- A strategy can only target a protocol on the constitution's allowlist.
- A single allocation cannot push a protocol above its allocation cap.
- Total deployment cannot breach the global deployment cap or drop liquidity below the floor.

These limits are enforced on-chain, not merely in the interface.

## 4. Monitoring

Day-to-day oversight happens across three views:

- **Dashboard** — headline NAV and deployed-capital ratio.
- **Assets** — per-asset composition and where capital is deployed.
- **Agent / Policy** — what the AI layer is recommending and whether recommendations cleared guardrails.

The policy engine runs continuously and flags drift — for example a protocol creeping past its cap, or liquidity approaching the floor — before it becomes a breach.

## 5. Rebalancing and withdrawal

Rebalances and withdrawals follow the same rules as deployment. A rebalance is only eligible once the constitution's cadence has elapsed since the last one. Withdrawals return capital from a strategy escrow back to the vault, and a full round-trip is expected to return balances to their pre-deployment state. The accounting that proves this holds is in [Treasury Reconciliation](/docs/reconciliation).

## Winding a treasury down (moonlighting)

A treasury that has run its course can be wound down through governance rather than abandoned mid-state. The lifecycle, managed from the **DAO** tab in Settings, has five stages:

```
Active
   ──▶ Moonlight requested   (a governance proposal passes; agents halt)
   ──▶ Distribution pending  (the proposer sets a recipient wallet, bound into a second proposal)
   ──▶ Distributing          (an existing locked creation stake, if this treasury has one, is released to the recipient)
   ──▶ Moonlighted           (the DAO is hidden until the founder reopens it)
```

Two separate governance proposals gate the two points where assets actually move — one to authorize winding down at all, one to bind the specific recipient — so no single signer can redirect a treasury's assets unilaterally. A moonlighted DAO is not destroyed: the founder can reopen it at any time without a new stake, returning it to **Active** with agents still disabled until explicitly re-enabled. An existing locked creation stake, from a treasury formed before this change, is still returned. New treasuries have nothing to return.

## How autonomy is bounded

A common question from fund managers is "how much can the AI actually do on its own?" The answer is: only what the constitution permits, and only when deterministic checks agree.

- Agents **propose** and **review**; they do not hold unilateral authority.
- A proposal becomes a signed transaction only after passing every applicable guardrail.
- The on-chain programs are the final gate — even a fully confident agent cannot exceed a cap or breach a floor.

This is the core operating guarantee: the model can be wrong without the treasury being harmed, because eligibility to sign is decided by rules, not by the model. Details in [Risk & Controls](/docs/risk-and-controls).

## Reporting

Because every figure derives from on-chain state and indexed events, treasury reporting is reproducible. Activity is timestamped and linkable to on-chain transactions, and reconciliation alerts are written to the activity log so anomalies are visible in-app and queryable.

## Where to go next

- Author the rulebook: [Constitution & Policy](/docs/constitution-and-policy).
- Understand the safety model: [Risk & Controls](/docs/risk-and-controls).
- Verify the numbers: [Treasury Reconciliation](/docs/reconciliation).
- `$NAVE`, voting, and the closed bridge: [Tokenomics & Bridge](/docs/tokenomics).
