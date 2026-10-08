# Nave Signer / Relayer Service

A small Node.js service that holds the four AI-agent keypairs for each DAO and
submits their on-chain decisions (approvals, halts, strategy execution) to the
Nave Anchor programs.

It exists because the Supabase edge functions (Deno) orchestrate agent reasoning
but should not perform heavy Anchor transaction building/signing. The
`agent-orchestrator` function calls this service over HTTP when an agent decides
to sign.

## How it works

1. `agent-orchestrator` decides an agent should act and POSTs to `/sign` with the
   execution-request address, agent role, and the agent's AES decrypt key.
2. This service reads the agent's encrypted Ed25519 key from
   `encrypted_agent_keys` (Supabase), decrypts it with AES-256-GCM, and rebuilds
   the `Keypair`.
3. It builds the instruction via the Anchor client (the IDL is the source of
   truth) and submits it, paying fees from the agent keypair.

### Canonical `tx_payload_hash`

For `financial_approve` / `oversight_approve` the hash is computed as:

```
tx_payload_hash = SHA-256(proposal.payload[0 .. payload_len])
```

This matches what the on-chain `execute_strategy` path recomputes, so
`PayloadHashMismatch` cannot occur as long as the proposal payload is unchanged.

## Endpoints

- `GET /health` — returns config readiness (`supabase`, `signerSecret`), the RPC
  status, and the configured program IDs. Safe to use as a hosting platform's
  health check; it does not require Supabase credentials to respond.
- `POST /sign` — body:

```json
{
  "action": "executive_approve | financial_approve | oversight_approve | operational_halt | operational_clear | execute_strategy",
  "dao_address": "<DaoRegistry PDA>",
  "execution_request_address": "<ExecutionRequest PDA>",
  "agent_role": "executive | financial | oversight | operational",
  "aes_decrypt_key": "<base64 AES key>",
  "reasoning_hash": "<hex 32-byte>",
  "protocol_id": "jito | kamino | marginfi"
}
```

Requires header `X-Signer-Secret: $NAVE_SIGNER_SECRET`.

## Setup

```bash
cd signer-service
cp .env.example .env   # fill in SUPABASE_*, NAVE_SIGNER_SECRET, SOLANA_RPC_URL
npm install
npm run dev
```

The agent keypairs must be funded with SOL on the target cluster (they pay their
own transaction fees).

IDL resolution order: `IDL_DIR` env → vendored `./idl` (bundled for containers)
→ the monorepo frontend IDLs at `../src/idl` (local dev). The `./idl` copies are
committed so the container is self-contained.

## Hosting (devnet beta)

The service is container-ready (`Dockerfile` + `railway.json`, health check at
`/health`). No keypairs live on disk — agent keys are pulled from Supabase
(`encrypted_agent_keys`) and decrypted per request with the AES key supplied by
`agent-orchestrator`. The only secrets the host needs are env vars.

### 1. Deploy the container

Any container host works (Railway, Fly.io, Render, Cloud Run). Required env:

| Var | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key (reads `encrypted_agent_keys`) |
| `NAVE_SIGNER_SECRET` | shared secret; must equal the edge-function secret |
| `SOLANA_RPC_URL` | devnet Helius RPC |
| `PORT` | listen port (platforms usually inject this) |

Program-ID overrides are optional (canonical devnet IDs are the defaults).

### 2. Wire the orchestrator to the signer

Set these as Supabase **edge-function secrets** so `agent-orchestrator` can reach
the hosted signer:

```
NAVE_SIGNER_URL   = https://<your-signer-host>      # no trailing /sign
NAVE_SIGNER_SECRET = <same value as the service>
```

### 3. Verify the loop end-to-end on devnet

```bash
# a) the host is up
curl -s https://<your-signer-host>/health

# b) trigger one orchestration pass (poll mode finds eligible execution requests)
curl -s -X POST "$SUPABASE_URL/functions/v1/agent-orchestrator" \
  -H "X-Agent-Secret: $NAVE_AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"poll"}'
```

A successful signing pass writes an `agent_action_logs` row with
`action_type = "signing"`, `status = "completed"`, and a real `tx_signature`.
