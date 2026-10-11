# Product Maturity

An honest assessment of where Nave is today. Investors and operators should read this as the counterweight to the [Investment Overview](/docs/investment-overview): the thesis is only credible if the maturity is stated plainly.

## Current posture

**Unaudited public testnet beta.** A founder can create a treasury on Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, or Arc Testnet, fund it, and leave agents watching. Quick setup writes the Conservative constitution: 60% stablecoin reserve, 40% deployment cap, 20% per venue, and 25% liquid. `NAVE_AUTOPROPOSE_ENABLED` stays false, so policy drift is recorded and proposals are not created. A second guardian is required to close a proposal. New treasuries use a one-minute review window. Treasuries created before the timelock upgrade still have 24-hour delays. Nothing here has a published third-party audit. GenLayer, autonomous proposing, MarginFi, and swaps stay off.

The Solana mainnet `nave_bridge` program that accepted NAVE locks is closed (`Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`). `bridgeCanRedeemNave()` in `src/lib/programConfig.ts` returns false when the bridge flag is off, the program id is unset, or the id is that closed program. On EVM mainnet the create flow then refuses DAO creation, including Base, until a replacement bridge can redeem locked NAVE for wNAVE. Do not broadcast a lock against the closed program. The paired staking program is closed as well.

Capital signatures share one gate. `callSigner` in `supabase/functions/agent-orchestrator/index.ts` calls `assessSignerPayload` in `supabase/functions/_shared/constitutionVerdict.ts` before any signer request. Capital actions load the on-chain constitution and run `evaluateGuardrails` with `requireCompleteConstitution: true` and `failClosedOnUnknown: true`. A failed or indeterminate critical check is stored on `constitution_check` and the signer is not called. A cap or floor of 0, a missing NAV timestamp, a missing agent gate, or a missing freshness window fails closed under that flag.

## What works today

- Create on Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet, under quick setup (Conservative by default). Mainnet create stays refused while `bridgeCanRedeemNave()` is false.
- Yield for testers: Solana devnet Jito, Ethereum Sepolia Compound, and Base Sepolia Aave. Sepolia Aave is over the pool supply cap. Robinhood Testnet and Arc Testnet can create a treasury, deposit, and govern. They have no lending venue.
- Solana devnet DAO flows (formation, constitution, agent pipeline) against the checked-in program IDs. New treasuries start with the agent pipeline off until a proposal enables it. The four roles, in order, are Executive, Financial, Operational, and Oversight. Operational is the final signer (stored key oversight). Oversight monitors and does not sign (stored key operational). Leave those stored names as they are.
- Raw-webhook event decoding and indexing on Solana, plus a polling-based EVM indexer, and scheduled treasury snapshots.
- The signer relay and worker orchestration model, with keyed secret boundaries between services.
- A capital-verdict gate. `callSigner` calls `assessSignerPayload` before the signer. Capital actions (`execute_strategy`, `execute_strategy_direct`, `jupiter_deposit`, `withdraw_from_strategy`, `bundle_rebalance`, `compound`, and any action whose name contains `deposit`) load the on-chain constitution and run `evaluateGuardrails` with `failClosedOnUnknown` and `requireCompleteConstitution`. A failed or indeterminate critical check is written to `constitution_check` and the signer is skipped. `persistedConstitutionCheck` refuses a capital log with an empty check list. With `requireCompleteConstitution`, a cap or floor of 0, a strategy deploy missing `navLastRevaluedAt` or with `maxNavAgeSeconds <= 0`, and a missing agent gate all fail closed. Rebalance cadence also applies when policy intent is `rebalance`. Accounting actions are allowed with `accounting_only: true` and amount moved `0`. `clear_halt` needs a readable open agent gate and a constitution read. The agent `compound` action and auto-withdraw stay behind their default-off flags; `compound` also requires `min_out > 0`. That flag is separate from the Sepolia Compound lending venue. Naming `jupiter_deposit` in this gate does not turn swaps on. The guardrails eval harness still rejects known-bad scenarios.
- A trusted-relayer bridge design for moving NAVE between Solana and EVM (Ethereum, Base, Robinhood), with chain-specific confirmation depths. Do not lock or redeem against the closed Solana program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. Mainnet redeem is not live while that program is the bridge.
- EVM treasury capital bridges (CCTP USDC, OP StandardBridge ETH, Arbitrum Nitro ETH), gated behind `NAVE_BRIDGE_OUTBOUND_ENABLED`. They are not the public-beta yield path. Robinhood and Arc have no lending venue.
- Permission proposals that execute guardian set/threshold changes; EVM founder guardian edit is one-shot bootstrap only.
- EVM guardian recovery (queue/execute/cancel) wired in Settings when a DAO is frozen.
- The governed treasury wind-down ("moonlighting") lifecycle (Solana + EVM Settings wizard; EVM also hard-halts deposit / new strategy requests while moonlighting).
- EVM operator surfaces: live strategy positions, guardian M-of-N freeze, strategy withdraw + minOut, manual agent dispatch. Strategy withdrawal skims 15% of realized yield. There is no annual management-fee collect.

## What remains before calling this production

These are tracked, not hidden:

1. **External audit.** No formal third-party audit of the Solana programs, the EVM contracts, or the bridge relayer has been completed. Until a published audit says otherwise, treat all of it as unaudited.
2. **Replacement NAVE bridge.** The closed Solana mainnet bridge cannot redeem locked NAVE for wNAVE. A new bridge has to be deployed and left paused until that path is intentional.
3. **Capital verdict on the signer path.** `callSigner` refuses capital unless `assessSignerPayload` passes `evaluateGuardrails` with `requireCompleteConstitution`. That gate is not a substitute for an audit.
4. **CI coverage.** Baseline continuous-integration gates for both the application and the programs (type-checks, builds, tests, and the guardrails eval).
5. **Operational governance rollout.** Program upgrade authority behind a multisig, with runbooks and alerting fully live.
6. **Bridge trust model.** The `$NAVE` trusted relayer needs a stronger production trust model before large TVL. Treasury USDC/ETH bridges use canonical rails (CCTP / OP / Arbitrum) behind env gates and still need operational soak + audit.
7. **Documentation kept in sync** with the current cross-program, testing, and interface realities.

## Maturity by domain

| Domain | Status |
| --- | --- |
| Frontend and application backend | Create UI on Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet (Conservative quick setup). Mainnet create refused while the Solana bridge cannot redeem. Launch sign-off still pending. |
| On-chain programs (Solana) | Devnet DAO stack, with a broad test harness. Jito is the tester yield venue. Mainnet bridge/staking that locked NAVE is closed. Pre-audit. |
| EVM contracts (Ethereum, Base, Robinhood, Arc) | Create is on for the four testnets. Sepolia yield is Compound. Base Sepolia yield is Aave. Sepolia Aave is over the pool supply cap. Robinhood and Arc have no lending venue. Mainnet create is refused while `bridgeCanRedeemNave()` is false. Unaudited. NFT custody works; gallery unsupported (EIP-170 — permanent custody-only until an indexer is productized). |
| Bridge relayer | Trusted relayer with per-chain confirmations (Ethereum, Base, Robinhood). Do not lock or redeem against closed program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. Not audited. |
| AI guardrails | Capital moves go through `constitutionVerdict` (`requireCompleteConstitution`) inside `callSigner` before the signer. Eval harness covers the guardrail fixtures. |
| Reconciliation | Invariants defined; continuous enforcement being wired across all snapshots. |
| Operations | Runbooks drafted; multisig and alerting rollout outstanding. |

## The path from here

```
Five-testnet public beta (Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, Arc Testnet), unaudited, closed mainnet NAVE bridge, capital verdict before signer, agents watch (today)
   ──▶ Replacement bridge (paused) + stake redeem, then mainnet create
   ──▶ Hardening (CI, runbooks)
   ──▶ Independent audit + issue closure
   ──▶ Multisig upgrade authority live
   ──▶ Production posture
```

## How to verify maturity claims

Because the system is on-chain and indexed, maturity is observable rather than asserted. Treasury values reconcile to balances, and agent decisions carry on-chain reasoning hashes. The technical evidence lives in [Devnet E2E Gate](/docs/devnet-gate) and the cross-repo snapshot in [Final System Status](/docs/system-status). Those notes describe the Solana devnet gate. The public beta also includes Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. They are not a mainnet audit.

## Where to go next

- The trust model behind the claims: [Security & Trust](/docs/security-and-trust).
- The thesis this maturity supports: [Investment Overview](/docs/investment-overview).
- Execution evidence: [Devnet E2E Gate](/docs/devnet-gate).
