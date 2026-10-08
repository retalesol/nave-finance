/*
  # Create evm_indexer_cursors table

  The EVM event indexer (evm-indexer/) is a viem-based polling worker that reads
  Nave contract logs on Ethereum and Base (mainnets 1 / 8453 + testnets Sepolia
  11155111 / Base Sepolia 84532) and forwards normalized events to the
  index-events edge function — the same pipeline Helius feeds for Solana.

  To resume safely after restarts/crashes the worker persists the last fully
  processed block height per chain here (idempotent: index-events dedups by
  tx_signature = `${txHash}:${logIndex}`, so a small re-scan overlap is safe).

  Service-role only; never exposed to the browser.
*/

CREATE TABLE IF NOT EXISTS public.evm_indexer_cursors (
  chain_id bigint PRIMARY KEY CHECK (chain_id IN (1, 8453, 11155111, 84532)),
  chain text NOT NULL CHECK (chain IN ('ethereum', 'base')),
  last_block bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS (service-role writes/reads only; no public policy).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'evm_indexer_cursors' AND rowsecurity = true
  ) THEN
    ALTER TABLE public.evm_indexer_cursors ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evm_indexer_cursors' AND policyname = 'Service role manages evm indexer cursors'
  ) THEN
    CREATE POLICY "Service role manages evm indexer cursors"
      ON public.evm_indexer_cursors
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
