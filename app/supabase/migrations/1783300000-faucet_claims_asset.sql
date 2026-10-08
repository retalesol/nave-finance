/*
  # Add asset column to faucet_claims

  The devnet faucet now dispenses two assets from the same wallet: NAVE
  (`/faucet-claim`) and SOL (`/faucet-claim-sol`). Tag each audit row with the
  asset so ops can tell claims apart. Existing rows are all NAVE claims.
*/

ALTER TABLE public.faucet_claims
  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'NAVE';
