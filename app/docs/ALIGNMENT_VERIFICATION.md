# Nave Alignment Verification Matrix

Acceptance checklist proving the frontend, backend, signer service, and on-chain
programs are aligned. Generated during the frontend/backend/contract alignment
work. The Anchor IDL (`src/idl/*.json`, synced from `nave-contracts`) is the
single source of truth; everything below is cross-referenced against it.

Last verified against localnet (`solana-test-validator`) with all six programs
deployed and `global_config` initialized (authority/treasury = local wallet,
formation fee = 2 SOL).

---

## 1. Program IDs

All three sources agree (Anchor.toml ↔ IDL `address` ↔ frontend default).

| Program | ID |
| --- | --- |
| nave_core | `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB` |
| nave_governance | `CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M` |
| nave_execution | `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` |
| nave_jito_adapter | `E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT` |
| nave_kamino_adapter | `B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD` |
| nave_marginfi_adapter | `Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7` |

Source: `src/lib/programConfig.ts` (`DEFAULT_PROGRAM_IDS`), overridable via
`VITE_NAVE_*_PROGRAM_ID`. Identical on localnet and devnet.

---

## 2. Instruction matrix — frontend builders → on-chain instructions

`src/lib/transactionBuilders.ts`. Every builder uses
`program.methods.<ix>().accountsPartial({...}).instruction()`, so Anchor
resolves PDAs/programs from the IDL; only the signer-specific and external
accounts are supplied. ✅ = builder present and arguments match IDL.

### nave_core

| Builder | Instruction | Status |
| --- | --- | --- |
| buildInitializeGlobalConfig | initialize_global_config | ✅ |
| buildUpdateGlobalConfig | update_global_config | ✅ |
| buildInitializeDao | initialize_dao | ✅ |
| buildInitializeDaoExtensions | initialize_dao_extensions | ✅ |
| buildInitializeDaoGovernance | initialize_dao_governance | ✅ |
| buildRegisterDaoToken | register_dao_token | ✅ |
| buildRevokeTokenAuthority | revoke_token_authority | ✅ |
| buildUpdateTokenMetadata | update_token_metadata | ✅ |
| buildUpdateConstitution | update_constitution | ✅ |
| buildUpdateGuardianConfig | update_guardian_config | ✅ |
| buildUpdateAgentSet | update_agent_set | ✅ |
| buildApplyAgentRotation | apply_agent_rotation | ✅ |
| buildToggleAgents | toggle_agents | ✅ |
| buildNullifyAgent | nullify_agent | ✅ |
| buildRestoreAgent | restore_agent | ✅ |
| buildUpdateAgentStatus | update_agent_status | ✅ |
| buildRotateAgentKey | rotate_agent_key | ✅ |
| buildEmergencyFreeze | emergency_freeze | ✅ |
| buildEmergencyUnfreeze | emergency_unfreeze | ✅ |
| buildSetDaoPrivacy | set_dao_privacy | ✅ |
| buildArchiveProposals | archive_proposals | ✅ |
| buildDepositToVault | deposit_to_vault | ✅ |
| buildCollectManagementFee | collect_management_fee | ✅ |
| buildCollectPerformanceFee | collect_performance_fee | ✅ |
| buildSetHolderAnnotation | set_holder_annotation | ✅ |
| buildApproveHolderAnnotation | approve_holder_annotation | ✅ |
| buildDenyHolderAnnotation | deny_holder_annotation | ✅ |
| buildInitStrategyPosition | init_strategy_position | ✅ |

CPI-only / not user-facing (intentionally **not** exposed as builders):
`record_proposal_creation`, `record_strategy_deposit`,
`record_strategy_withdrawal` (invoked by governance/execution via CPI),
`withdraw_from_vault` (treasury withdrawals flow through execution +
fee-collection paths).

### nave_governance

| Builder | Instruction | Status |
| --- | --- | --- |
| buildCreateProposal | create_proposal | ✅ |
| buildCastVoteWallet | cast_vote_wallet | ✅ |
| buildLockTokensAndVote | lock_tokens_and_vote | ✅ |
| buildReleaseVoteEscrow | release_vote_escrow | ✅ |
| buildFinalizeProposal | finalize_proposal | ✅ |
| buildCancelProposal | cancel_proposal | ✅ |
| buildMintAdditionalTokens | mint_additional_tokens | ✅ |

### nave_execution

| Builder | Instruction | Status |
| --- | --- | --- |
| buildCreateExecutionRequest | create_execution_request | ✅ |
| buildExecutiveApprove | executive_approve | ✅ |
| buildFinancialApprove | financial_approve | ✅ |
| buildOversightApprove | oversight_approve | ✅ |
| buildOperationalHalt | operational_halt | ✅ |
| buildOperationalClear | operational_clear | ✅ |
| buildExecuteStrategy | execute_strategy | ✅ |
| buildExecuteStrategyDirect | execute_strategy_direct | ✅ |
| buildWithdrawFromStrategy | withdraw_from_strategy | ✅ |

---

## 3. Signer service → agent-signed instructions

`signer-service/src/index.ts` holds the four agent keypairs and submits the
on-chain approvals/halts and strategy execution. Builds via Anchor with the
agent `Keypair` as signer.

| Signer action | Instruction | Program |
| --- | --- | --- |
| executive approve | executive_approve | nave_execution |
| financial approve | financial_approve | nave_execution |
| oversight approve | oversight_approve | nave_execution |
| operational halt | operational_halt | nave_execution |
| operational clear | operational_clear | nave_execution |
| execute strategy | execute_strategy | nave_execution |

`tx_payload_hash` is computed canonically and matched on-chain by
`financial_approve` / `oversight_approve` (IDL field `tx_payload_hash`,
32 bytes). Reasoning hashes are SHA-256 of the Claude structured output.

---

## 4. Account fetch matrix — onChainFetcher → IDL accounts

`src/lib/onChainFetcher.ts` uses `program.account.<X>.fetch()/fetchNullable()`.
Confirmed: the Anchor `Program` client returns **camelCase** fields (verified
live against `NaveGlobalConfig` on localnet → `formationFeeLamports`,
`daoCount`). `src/lib/onChainTypes.ts` mirrors these structs.

| Fetched account | IDL account |
| --- | --- |
| NaveGlobalConfig | nave_core::NaveGlobalConfig |
| DaoRegistry | nave_core::DaoRegistry |
| AgentSet | nave_core::AgentSet |
| GuardianConfig | nave_core::GuardianConfig |
| TreasuryConstitution | nave_core::TreasuryConstitution |
| TokenRegistry | nave_core::TokenRegistry |
| TreasuryVault | nave_core::TreasuryVault |
| FeeConfig | nave_core::FeeConfig |
| StrategyPosition | nave_core::StrategyPosition |
| HolderAnnotation | nave_core::HolderAnnotation |
| Proposal | nave_governance::Proposal |
| VoteRecord / VoteEscrow | nave_governance::VoteRecord / VoteEscrow |
| ExecutionRequest | nave_execution::ExecutionRequest |

---

## 5. Indexer / event matrix

`supabase/functions/helius-webhook` decodes Anchor `Program data:` logs with a
raw `BorshEventCoder` (event-only IDL slices embedded as gzip+base64). The raw
coder returns **snake_case** keys (verified by decoding a synthesized
`DaoInitialized` event with the deployed blob → `dao`, `dao_id`, `name_len`).

Pipeline: Helius (raw webhook) → `helius-webhook` (decode) → `index-events`
(insert) → `activity_logs` + treasury-snapshot flags + `agent_action_logs`
cross-reference.

- Webhook → index-events payload shape matches (`events[]` + `indexer_secret`). ✅
- `index-events` resolves execution-request / reasoning hash from both snake and
  camel keys (`execution_request`, `request`, `reasoning_hash`). ✅
- `activity_logs` schema matches the insert shape; `dao_onchain_address` NOT NULL
  satisfied by empty-string fallback for events without a `dao` field. ✅
- `agent_action_logs.tx_signature` column added (migration
  `add_tx_signature_to_agent_action_logs`). ✅

Deployed functions (project `your-project-ref`): `helius-webhook` v1,
`index-events` v5, `snapshot-treasury`, `agent-orchestrator`, `agent-health`,
`agent-dispatcher`, `generate-agent-keys` — all ACTIVE. Bad-secret requests
return 401 (auth configured), CORS preflight 200.

---

## 6. Validation performed

| Check | Result |
| --- | --- |
| Frontend typecheck (`npm run typecheck`) — alignment files | ✅ clean (`transactionBuilders`, `onChainFetcher`, `naveProgram`, `pdaDerivation`, `onChainTypes`, `edgeFunctionClient`, `mockData`, `PolicyEngine`) |
| Signer service typecheck (`tsc --noEmit`) | ✅ clean |
| Localnet validator + 6 programs deployed | ✅ |
| `global_config` initialized + decodes | ✅ |
| `Program.account.fetch` casing (camelCase) | ✅ verified live |
| `BorshEventCoder` decode w/ deployed IDL blob (snake_case) | ✅ verified |
| Edge functions deployed, healthy, auth-gated | ✅ |
| DB schema ↔ insert shape | ✅ |

### Pre-existing issues (out of scope, not introduced by alignment)

The app historically only transpiled via SWC and never ran `tsc`, so latent
type issues exist independent of alignment: framer-motion `ease: number[]`
Variants, recharts JSX-component types (React 19), `useRef()` no-arg
(`@types/react` 19), missing `input-otp` dep, and a few inline mock types in
`Dashboard.tsx`. These do not affect on-chain alignment.

---

## 7. Localnet limitations & devnet promotion checklist

Cloud components **cannot reach `127.0.0.1:8899`**, so these are exercised on
devnet, not localnet:

- **Helius webhook** watches devnet/mainnet only.
- **Edge functions** (`snapshot-treasury`, `agent-orchestrator` → signer,
  `helius-webhook`) need a public RPC.

Devnet promotion steps:

1. Deploy programs to devnet from `contracts/solana`
   (see `nave-contracts/README.md` deployment section), then initialize
   `global_config`.
2. Set `VITE_SOLANA_RPC_URL` to the Helius devnet endpoint in the frontend env.
3. Set edge-function secrets: `SOLANA_RPC_URL` (Helius), `NAVE_INDEXER_SECRET`,
   `NAVE_SIGNER_SECRET`, `NAVE_AGENT_SECRET`, signer `SUPABASE_SERVICE_ROLE_KEY`.
4. Run the signer service with its `.env` (RPC, Supabase service role, signer
   secret).
5. **Register the Helius webhook** (raw type) — see
   `supabase/functions/helius-webhook/SETUP.md` and `README.md`
   ("Helius webhook setup"). Required settings:
   - Network: devnet
   - Webhook type: **raw** (enhanced omits program logs)
   - URL: `https://your-project-ref.supabase.co/functions/v1/helius-webhook`
   - Auth header: `X-Indexer-Secret: <NAVE_INDEXER_SECRET>`
  - Account addresses: all six program IDs (core + adapters, §1).
