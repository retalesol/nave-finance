# Constitution & Policy

The constitution is the on-chain rulebook that defines what a treasury and its agents are allowed to do. The policy engine is the continuous process that checks reality against that rulebook. Together they turn high-level intent ("stay liquid, diversify, don't chase risk") into enforceable limits.

## What the constitution governs

A ratified constitution encodes the parameters below. Each is enforced on-chain, so the interface and the agents both inherit the same boundaries.

| Parameter | Controls |
| --- | --- |
| Approved protocols | The allowlist of external protocols a strategy may target. |
| Allocation cap (per protocol) | Maximum share of NAV that may sit in any single protocol. |
| Global deployment cap | Maximum share of NAV that may be deployed across all strategies. |
| Liquidity floor | Minimum share of NAV that must remain liquid and undeployed. |
| Stablecoin reserve floor | Minimum reserved share intended to be held in stable assets. |
| Confidence threshold | Minimum model confidence required before an agent decision is eligible to sign. |
| Rebalance cadence | Minimum time that must elapse between rebalances. |

## Authoring a constitution

When you create a treasury you ratify an initial constitution. Treat the first draft as a policy statement, not a formality:

1. **Start conservative.** Lower caps and higher floors are easy to relax later and hard to walk back after capital is committed.
2. **Whitelist deliberately.** Only approve protocols you understand and are willing to hold exposure to.
3. **Set a confidence threshold you would defend.** This is the bar an AI recommendation must clear before it is even eligible to act.
4. **Choose a rebalance cadence that matches your strategy.** Frequent rebalancing increases activity and cost; infrequent rebalancing increases drift.

## The policy engine

Authoring rules is half the system; the other half is continuously checking that the live treasury still satisfies them. The policy engine reads authoritative on-chain state on a cadence and produces recommendations and drift flags, including:

- `deployment_cap_breached`
- `liquidity_floor_breached`
- `reserve_floor_breached`

These are observable in the Policy view before any corrective action is taken, and breaches are surfaced as alerts so an operator is never relying on the AI noticing.

## Observe-only versus acting

The continuous loop can run in two postures:

- **Observe-only (default).** The engine reports candidate actions and drift but does not create proposals on its own.
- **Auto-propose.** When explicitly enabled, the engine can create on-chain strategy proposals from its recommendations. Even then, proposals still flow through governance and guardrails before anything is signed.

Starting observe-only lets an operator build confidence in the recommendations before granting any autonomy.

## Separation of duties

Proposing, approving, and executing are deliberately separated. The role that creates proposals has no approval or execution authority, mirroring how a well-run fund separates the analyst who suggests a trade from the officer who authorizes it. This is why a single compromised role cannot move a treasury on its own.

## Changing the rules later

A constitution is not frozen, but changes are themselves governed actions. Tightening a cap or removing a protocol follows the DAO's governance model, leaving an auditable trail of who changed what and when.

## Where to go next

- How limits are enforced at signing time: [Risk & Controls](/docs/risk-and-controls).
- The math that proves limits held: [Treasury Reconciliation](/docs/reconciliation).
- The AI decision contract: [Agent Fine-Tuning](/docs/fine-tuning).
