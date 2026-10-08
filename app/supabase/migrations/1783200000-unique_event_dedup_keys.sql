/*
  # FN-M2: race-proof event dedup keys

  index-events previously deduplicated with a check-then-insert against a
  NON-unique index on activity_logs(tx_signature), which double-counts under
  concurrent Helius retries, and used the bare tx signature as the dedup key,
  which drops every event after the first when one transaction emits several
  events (VoteCast + VoteEscrowLocked, ProposalCreated + ProposalCountRecorded, …).

  New scheme: the dedup key is `${signature}:${eventIndex}` (index of the event
  within its transaction, matching the EVM indexer's existing
  `${txHash}:${logIndex}` convention), enforced by a UNIQUE constraint, with
  inserts switched to upsert(..., ignoreDuplicates).

  1. Backfill: suffix existing bare (no-colon) signatures with `:N` per
     signature so the constraint can be added WITHOUT deleting or merging any
     rows. Rows that already contain ':' (EVM `${txHash}:${logIndex}` rows and
     snapshot-treasury `recon:…` rows) are left untouched.
  2. UNIQUE constraint on activity_logs(tx_signature); the old non-unique
     dedup index becomes redundant and is dropped.
  3. agent_action_logs: partial unique index for the index-events cross-ref
     rows (status = 'on_chain_confirmed', which index-events alone writes).
     Scoped so orchestrator/signer rows (other statuses, possibly repeated or
     empty signatures) are unaffected.

  Idempotent: backfill only touches colon-less signatures; constraint/index
  adds are guarded.
*/

-- 1) Backfill per-event suffixes on existing bare Solana signatures.
WITH numbered AS (
  SELECT
    id,
    tx_signature,
    row_number() OVER (PARTITION BY tx_signature ORDER BY created_at, id) - 1 AS ev_idx
  FROM activity_logs
  WHERE tx_signature <> '' AND position(':' IN tx_signature) = 0
)
UPDATE activity_logs a
SET tx_signature = n.tx_signature || ':' || n.ev_idx
FROM numbered n
WHERE a.id = n.id;

-- 2) Unique constraint on the dedup key (arbiter for upsert ON CONFLICT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'activity_logs_tx_signature_unique'
      AND conrelid = 'public.activity_logs'::regclass
  ) THEN
    ALTER TABLE activity_logs
      ADD CONSTRAINT activity_logs_tx_signature_unique UNIQUE (tx_signature);
  END IF;
END $$;

-- The unique constraint's backing index supersedes the old non-unique one.
DROP INDEX IF EXISTS idx_activity_logs_tx;

-- 3) FN-M3: the EVM indexer now records the hash of the last scanned block so
--    it can detect reorgs across its cursor and rewind instead of scanning
--    monotonically past replaced blocks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evm_indexer_cursors'
      AND column_name = 'last_block_hash'
  ) THEN
    ALTER TABLE public.evm_indexer_cursors ADD COLUMN last_block_hash text;
  END IF;
END $$;

-- 4) Backstop for the agent_action_logs cross-reference rows written by
--    index-events (which now stamps them with the same per-event dedup key).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_action_logs'
      AND indexname = 'uniq_agent_action_logs_event_dedup'
  ) THEN
    CREATE UNIQUE INDEX uniq_agent_action_logs_event_dedup
      ON agent_action_logs(tx_signature)
      WHERE tx_signature <> '' AND status = 'on_chain_confirmed';
  END IF;
END $$;
