/*
  Refund-capable claim settlement.

  The claim flow now settles the ledger BEFORE moving funds (settle → wrap →
  mint) so a claim that outlives its cross-replica lease can never be paid
  twice — the second attempt folds a ledger that already shows the payout as
  claimed. When the payout then definitely fails (wrap failed, or the mint tx
  landed and REVERTED), the relayer refunds the ledger by settling a NEGATIVE
  amount. Ambiguous outcomes (mint tx broadcast but receipt unknown) are NOT
  refunded — under-crediting the user is reconcilable, double-paying is not.

  This replaces settle_evm_reward_claim to accept negative p_amount, clamped
  to [0, accrued_raw] so neither direction can violate claimed<=accrued or
  push claimed below zero.
*/

CREATE OR REPLACE FUNCTION public.settle_evm_reward_claim(
  p_chain_id bigint,
  p_staker text,
  p_amount numeric
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.evm_reward_accounts
  SET claimed_raw = GREATEST(LEAST(claimed_raw + p_amount, accrued_raw), 0),
      updated_at = now()
  WHERE chain_id = p_chain_id AND staker = lower(p_staker);
$$;

-- Service-role (relayer) only — unchanged posture.
REVOKE ALL ON FUNCTION public.settle_evm_reward_claim(bigint, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_evm_reward_claim(bigint, text, numeric) TO service_role;
