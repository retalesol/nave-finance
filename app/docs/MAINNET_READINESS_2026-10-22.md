# Mainnet readiness — 22 October 2026

This is a product-journey review of Nave as it ships today. A third-party audit is still required and is left off the remaining-work list on purpose.

Reviewed against the repository at `4e56886` (`fix(app): use the live testnet factories and finish Arc treasury creation`, 22 Oct 2026 18:43 PT) and the production app at [nave.finance](https://www.nave.finance), which is that same commit. Chain reads below were taken on public RPCs during this review. No wallet was connected, and no transaction was sent.

## Verdict

Nave is a working **public testnet beta**, not a mainnet product.

A visitor on the live site can start a treasury on Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood testnet, or Arc testnet. They can deposit, vote, change the constitution by proposal, pause agents, freeze the treasury, and wind it down. Four agents are created and switched on with the treasury. They record drift and can advance a proposal a member already passed. They do not propose or move capital on their own.

Base and Robinhood already have mainnet DAO contracts, and those protocol contracts are unpaused. The shipped app does not create on them. Solana mainnet has no DAO programs. The old Solana bridge and staking programs have no bytecode, so locked NAVE and staked NAVE cannot move. EVM minting, lockboxes, and staking are paused. A wNAVE burn can still happen, and nothing on Solana can pay it.

A Base observe-only mainnet — create, deposit, govern, agents watch — is the launch shape the code already encodes. It is not what is deployed to users, and the operational pieces under it (multisig, yield scoring, indexer, signer posture, a rehearsed journey on that build) are still open.

## Where the product is

The live homepage says “launch a testnet treasury on Solana, Ethereum, Base, Robinhood, or Arc.” The network banner offers faucets. **Launch a Treasury** opens a Solana wallet prompt, because the app’s chain context starts on Solana even though the create form then offers every testnet. **Continue** on the first create step stays disabled until a wallet for the chosen chain is connected. The wizard that loads is About → Behaviour → Launch. There is no Quick setup step on the page.

| Step | What a user can do today | State |
| --- | --- | --- |
| Homepage | Read the product, connect a wallet, open docs, launch or view treasuries | Live. Several claims describe autonomy and venues the running system does not perform. |
| Create | Name, purpose, member-or-token voting, one of five testnets, then a constitution | Live on testnet. Advanced wizard only. Default posture is Balanced (35% stable reserve, 65% deployment cap, 40% per venue, 15% liquid), not Careful. |
| After create | Success screen, then Overview | Wired. Agent enable is attempted immediately and is non-fatal if it fails. |
| Overview | Balance, activity, add funds, propose a payment, reports | Wired to chain and indexed data. A new treasury has no chart history. |
| Money | Holdings, deposit, register a Solana asset | Deposit is a real transaction. Moving funds into a venue, and every Solana strategy move, waits 650ms and shows a success message without a transaction. EVM withdraw-to-available is a real transaction. |
| Decisions | Create, vote, finalize, execute proposals | Wired. Members execute passed proposals. The header says agents carry them out. |
| Rules | Edit the constitution and propose the change | Wired as a proposal. An empty treasury cannot propose. |
| Agents | Status, diary, pause, propose resume | Pause is a real transaction. Resume goes through a vote. The page still says agents are watching after they have been enabled. Manual dispatch is not on the page. |
| Bridge | Lock NAVE for wNAVE, or burn wNAVE | Present. It runs only when relayer and contract env are set. The closed Solana program cannot release. |
| Stake | Stake, unstake, claim | Present. Hidden when the staking program address is unset. Solana mainnet staking has no bytecode. |
| Settings | Guardians, privacy, review window, freeze, recovery, sister treasury, wind-down | Those controls send transactions. Profile and notification toggles save to the browser only. |
| Tokens | Mint and revoke, for token-governed treasuries | Wired. Hidden from the sidebar unless the treasury uses token voting. |
| Docs | In-app guides | Served. Several launch pages describe a product the code no longer implements. |

Formation is gas only. The contracts charge **15% of realized yield** on strategy withdrawal and **no management fee**. There is no NAVE stake to create a treasury.

The in-app network switcher on treasury pages still lists Base, Ethereum, Solana, Robinhood, and Arc. One build is one mode. The live build is testnet, so “Base” in that build is Base Sepolia.

### What the homepage promises beyond the running loop

The page is accurate that formation has no protocol fee and that the yield fee is 15% of realized gain. These lines describe a later product:

- “Governance occurs before autonomous execution,” and the protocol section’s claim that the four agents then operate the treasury. On the live flag set they watch. A member still has to create and pass the proposal.
- “3-key autonomous agent multisig” as a live operating mode. The user can see status and pause the team. The user does not drive three agent keys.
- The constitution card is the Balanced preset and lists **Jito, Kamino, and MarginFi**. MarginFi stays hidden unless `VITE_NAVE_MARGINFI_ENABLED` is set.
- Yield pricing lists Jito, Kamino, Aave, and Compound together. The testnet sentence above that card is narrower and matches the venues testers actually have: Sepolia Compound, Base Sepolia Aave, Solana devnet Jito. Robinhood and Arc are described as having no lending venue. The strategy catalog does offer Robinhood and Arc USDC vault adapters, and an Arc CCTP hop toward Sepolia Aave. Those are not Aave or Compound markets on Robinhood or Arc.
- Platform TVL on the hero counts mainnet `dao_registry` rows. A testnet treasury the user just created does not move that number.

## Agentic system

Agents are real software with a real signing path. Autonomy is off.

| Role on screen | Stored key | What it does |
| --- | --- | --- |
| Coordinator (Executive) | `executive` | First approval. |
| Investor (Financial) | `financial` | Second approval. |
| Guardrail (Operational) | `oversight` | Final approval signature. |
| Watcher (Oversight) | `operational` | Does not approve. Monitors, can halt, and on Solana signs strategy execution and venue deposits. |
| Planner | `planner` | Can draft a Strategy proposal only when autopilot is on. Never approves or executes. |

Order on chain: Pending → Executive approved → Financial approved → Oversight approved → review window → executed, halted, or expired. Create calls `setAgentsEnabled(true)` as soon as the treasury exists. The default review window in the app is 24 hours. The chains allow 60 seconds to 7 days, with a 1-hour floor on EVM.

What runs with the current defaults:

- `policy-evaluator` reads the constitution and writes drift as `observe`. It does not sign and does not create proposals.
- `proposal-creator` returns the candidate list and writes nothing unless `NAVE_AUTOPROPOSE_ENABLED=true`.
- `agent-orchestrator` can walk an execution request that already exists, call the signer, and advance approvals. A separate worker polls it about once a minute when `NAVE_AGENT_SECRET` is set.
- Before any signer HTTP call, `assessSignerPayload` loads the on-chain constitution and runs guardrails with `failClosedOnUnknown` and `requireCompleteConstitution`. A failed or indeterminate critical check is stored and the signer is not called. A zero cap, a missing NAV timestamp, or a missing agent gate fails closed.
- Compound is refused unless `NAVE_COMPOUND_ENABLED=true` and `min_out > 0`.
- Any withdraw the agents would sign must be `purpose: auto_withdraw` and `NAVE_AUTO_WITHDRAW_ENABLED=true`. A passed withdraw proposal that the orchestrator sends down that path does not move while the flag is false. A member can still withdraw on EVM from Money, because that button uses the member’s wallet.
- Swaps: the signer returns HTTP 501 for `jupiter_swap` even if `NAVE_SWAP_ENABLED=true`.
- MarginFi stays out of the constitution picker and is not auto-placed.
- Treasury USDC/ETH hops (CCTP, OP, Arbitrum) stay behind `NAVE_BRIDGE_OUTBOUND_ENABLED`, default false.
- GenLayer reviews can be submitted when the Bradbury session is configured. All three gates (`NAVE_GENLAYER_GATE`, `NAVE_GENLAYER_VENUE_GATE`, `NAVE_GENLAYER_HALT_GATE`) default false. A finished pass does not authorize a transfer. There is no GenLayer mainnet, and the result is not written back onto the treasury chain. Leave the gates off for launch.
- The model default is `claude-sonnet-4-6`. Guardrails decide `should_sign`. The model cannot override a failed check. Daily token budget defaults to 2,000,000 per treasury.

Yield scoring for the planner is Solana-only in any live sense. Every EVM family goes through `scoreEvmTestnetOpportunities`, which returns rates only for chain ids 11155111, 84532, 46630, and 5042002, and those rates are static. Ethereum mainnet and Base mainnet receive an empty list, so the planner has nothing to size there even after autopilot is turned on.

Eval scripts exist and run offline: `eval:guardrails`, `eval:decisions`, `eval:agent-contracts`, `eval:ft-scorecard`. The scorecard’s sample JSONL is not in the repo, so `eval:ci` fails until a trace file is passed. Fine-tuning is not a launch task.

## Chain posture, read during this review

| Network | DAO stack | Bridge and staking | Read this session |
| --- | --- | --- | --- |
| Solana mainnet | Not deployed. Program ids in the repo are the devnet stack. | `nave_bridge` `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6` and `nave_staking` `AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf` are upgradeable-loader shells. Program-data accounts are gone. | Confirmed. Custody **3,033.845 NAVE**. Stake vault **655 NAVE**. Neither program can move them. |
| Solana devnet | Core, governance, execution, Jito, Kamino, MarginFi adapters. Upgrade authority is still an EOA in the deployment record. | Same program ids, executable on devnet. | Not re-read. Deployment record. |
| Base mainnet (8453) | Protocol `0x377D976A31871060B4059fA244b76809A3Cc0C90`, factory `0x280470c7275d630f1a9Fc1C406D4754D1f523Dbb`. UUPS. | wNAVE `0xFc04710C3F310f6ed84b441cf897a05807312358`. v2 lockbox is the minter. | Protocol **unpaused**, owner is Safe `0xd338C8d0C3e28979D1cFec2f7C66769C796db89c`. That Safe is **threshold 1**, sole signer `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`. Factory has code. `mintPaused` **true**. Both lockboxes **paused**. Staking **paused**. Supply **1.488075 wNAVE**. |
| Robinhood mainnet (4663) | Protocol `0xaA1BDf23dc9995Aad2035B921E9699CB9d54F29A` has code and is **unpaused**, same Safe owner. | Same wNAVE token. v2 lockbox and staking deployed. | `mintPaused` **true**. v1 and v2 lockboxes **paused**. Staking **paused**. Supply **3,001.4875 wNAVE**. No local Aave or Compound market. |
| Ethereum mainnet (1) | The address in `contracts/ethereum/mainnet/1.json` has **0 bytes of code**. It is an Anvil fixture. | Immutable v1 lockbox and staking. Owner, relayer, and rewarder are the same EOA `0xFf888986b1e7Bf1ea2740825eeCB7fF98b484879`. | `mintPaused` **true**. Lockbox **paused**. Staking **paused**. Supply **13.37 wNAVE**. |
| Four EVM testnets plus Solana devnet | Factories are what the app pins. Today’s production commit retargeted the live testnet factories. | Testnet bridge and staking exist in the deployment records. Arc has no wNAVE. | Not re-read, except that the live create form offers all five testnets. |

Outstanding wNAVE across the three mainnets is **3,016.345575**. Together with the 655 NAVE in the stake vault, that is the redemption book. The closed programs cannot pay it. `mintPaused` stops new mints. It does not stop `bridgeBurn`. A holder can still burn wNAVE and receive nothing on Solana.

`bridgeCanRedeemNave()` in `app/src/lib/programConfig.ts` returns false for the closed program. Nothing in the app calls it. Mainnet create is limited by `MAINNET_USER_CHAINS`, which is **Base only**. Robinhood is not in that list. The live site never reaches that branch because `VITE_EVM_NETWORK` is testnet.

These older pages still say mainnet create is refused while `bridgeCanRedeemNave()` is false, and that Quick setup writes a Careful constitution with agents left off: `app/docs/portal/product-maturity.md`, `app/docs/MAINNET_PREFLIGHT.md`, `app/docs/portal/getting-started.md`. The code does the opposite on each point. Treat this note as the current picture.

## Already in place

- Testnet create, deposit, governance, constitution proposals, guardian edits, freeze, review window, moonlighting, and EVM guardian recovery.
- Agent keys, the four-step approval pipeline, a capital verdict that fails closed before the signer, and observe-only policy runs.
- Fee model in the contracts: 15% of realized yield, zero management fee, zero formation fee.
- Base and Robinhood mainnet DAO stacks, deployed and unpaused at the protocol.
- EVM mint, lockbox, and staking pauses on Base, Robinhood, and Ethereum. This changed after the 1 Oct 2026 reprobe, which found all of them unpaused.
- Signer code that refuses to boot on mainnet without a real RPC, refuses skipped simulation in production, and fail-closes the rate limiter when Redis is missing.
- Foundry, Anchor, signer, and frontend test suites in the repo, plus an offline guardrail eval. They were not re-run for this note. The July readiness write-ups are the last recorded green counts, and they disagree with each other because they are different dates.

## Remaining before mainnet, audit excluded

### 1. Ship the launch the code already chose

The allowlist for a mainnet or mixed build is Base only, observe-only. Robinhood mainnet contracts can create a DAO, and the non-testnet homepage copy still says “Base or Robinhood.” Pick one and make the copy, the picker, and the deploy match.

To put Base in front of users:

- Build with `VITE_EVM_NETWORK=mainnet` (or an explicit mixed mode if testnets must stay up beside it) and set `VITE_EVM_BASE_FACTORY_ADDRESS` to `0x280470c7275d630f1a9Fc1C406D4754D1f523Dbb`. An empty factory env throws on create.
- Set `VITE_EVM_PROTOCOL_REVENUE_WALLET` to a real funded wallet. It is fixed at `createDao` and there is no later setter. Provision its token accounts for every asset the treasury can withdraw (`npm run provision:revenue-atas`). A missing account fails the 15% skim on chain.
- Point the EVM indexer at Base and confirm snapshots land in Supabase. Hero TVL and the treasury chart read that index.
- Run the signer for that cluster with `NAVE_CLUSTER=mainnet`, distinct Solana and EVM KEKs, per-role signer secrets, Upstash Redis, simulation left on, and `NAVE_GUARDRAILS_FAIL_CLOSED` left on. This review did not read Railway or Supabase secrets, so treat the checklist in `app/docs/MAINNET_PREFLIGHT.md` as unverified operations, not as done.
- Confirm a NAV revalue keeper is actually running. Strategy execution hard-blocks on NAV older than 15 minutes.
- Keep `NAVE_AUTOPROPOSE_ENABLED`, auto-withdraw, compound, swaps, outbound treasury bridges, MarginFi, and the three GenLayer gates false.
- Replace the Base/Robinhood Safe. It owns the protocol, wNAVE, both lockboxes, and staking, and it is 1-of-1 with the deploy EOA. Move it to a multisig whose signers are not the relayer before outside deposits. Hand upgrade authority to that multisig and rehearse pause and freeze.
- Walk one founder journey on that build and keep the signatures: create, deposit, constitution, a vote, an agent poll that records drift and does not create a proposal, freeze, unfreeze. The 1 Oct journey smoke did not broadcast a create. Today’s factory retarget has not been smoked here either.

### 2. Do not open the NAVE bridge or staking with that launch

- Choose redemption for **3,016.345575 wNAVE** and **655 NAVE** of stuck stake before any new Solana program is initialized. The 3,688.845 NAVE in the closed token accounts cannot be signed out by the old program ids.
- Deploy new `nave_bridge` and `nave_staking` program ids. The closed ids cannot be reused. Initialize them paused, with a Squads owner that is not the relayer, a non-zero daily cap, and dest-chains 1, 8453, and 4663.
- Stop or hide `bridgeBurn` until a Solana `release` exists. Pausing the lockbox does not stop the burn.
- Move Ethereum bridge ownership off the hot EOA `0xFf88…4879`. That address is owner, relayer, and rewarder.
- Keep v1 lockboxes able to exit any supply they still hold. Leave the unused parallel wNAVE tokens unwired (`0xE73dCcAC…` on Base, `0xEccBfa0b…` on Robinhood).
- Add a monitor so the sum of wNAVE supply stays within Solana custody. Each chain’s `supplyCap` was 100,000 while custody was about 3,034.

Bridge and Stake can stay in the app as unavailable until that path is intentional.

### 3. Yield, if a mainnet treasury is supposed to earn

Base mainnet deployment records include Aave and Compound adapters. The planner will not use them until a live rate source exists for chain id 8453. Static testnet scoring returns an empty list there.

Also still open:

- Balancer on Base is the zero address. Curve is not deployed. Leave both out of constitutions.
- Ethereum mainnet has no DAO stack. Robinhood’s designed yield path is a bridge to an Ethereum sister treasury. That path cannot launch until a real chain-1 stack exists, adapters are approved, and `setLinkedTreasury` is set. Robinhood has no local lending market.
- Solana mainnet has no `nave_core`, `nave_governance`, `nave_execution`, Jito, or Kamino deployment. Devnet ids must not be copied into a mainnet build.
- The Money screen’s “move funds” control is a fake success for Solana and for deposits into a venue. An EVM mainnet user can withdraw to available. They cannot honestly be told that placing funds from that modal worked.
- Jupiter Lend is marked beta and its badge says it is off by default, but no flag hides it. Swaps are a 501. MarginFi’s governance deposit does not reach the venue.

### 4. Agentic work that is separate from opening the doors

Leave autonomy off for launch. Turning it on later, still without counting the audit, requires:

- A live Base (and Ethereum, if used) rate source, then an explicit `NAVE_AUTOPROPOSE_ENABLED=true` after the evals and a devnet end-to-end gate on the same code.
- A withdraw path for a passed governance withdrawal that is not the timed auto-withdraw flag. Today they share one gate, so agents cannot carry out a passed withdraw.
- `eval:ci` green, which needs a real trace file. The sample JSONL is missing. Do not fine-tune for launch.
- A second human control left in front of execution: guardian threshold and the review window. The worker must have `NAVE_AGENT_SECRET` or the pipeline does not poll.
- GenLayer left off. It can be recorded as an advisory review later. It cannot be required to sign.
- Operator docs rewritten to match the code: agents on at create, Balanced as the default preset, Base-only mainnet create, bridge pauses already applied, `bridgeCanRedeemNave()` unused.

### 5. Journey gaps that are already visible on the testnet users have

These are not mainnet deploys. They are places the current product tells the user something the transaction does not do.

- **Launch a Treasury** asks for a Solana wallet because the session starts on Solana.
- Quick setup is implemented and never rendered. The page hardcodes advanced mode.
- Solana strategy moves, and deposits into a venue from Money, show success without a transaction (`app/src/pages/Assets.tsx`).
- Settings profile and email notification toggles are `localStorage`.
- Agent copy says “watching” even when `agentsEnabled` is true, which is the state create tries to set.
- The in-app launch docs disagree with the wizard, the chain allowlist, and the bridge pause state.
- There is no first-party GitHub Actions workflow for the app or the Nave contracts. Vendor libraries under `contracts/evm/lib` have their own. Typecheck, guardrail eval, and Forge/Anchor tests are local scripts.

## Suggested order

```
Testnet beta (live now)
  → Base mainnet build, 1-of-n Safe, revenue wallet, indexer, signer, one rehearsed founder journey
  → Observe-only launch: create, deposit, vote, agents watch
  → Live Base yield rates, then Aave/Compound under the constitution
  → Redemption book settled, new Solana bridge and staking deployed paused, then a two-way smoke
  → Autonomy flags, one at a time, after evals
  → Audit and issue closure before calling any of this production custody
```

The audit stays the gate on calling the system production. The items above are what is still open besides that audit.
