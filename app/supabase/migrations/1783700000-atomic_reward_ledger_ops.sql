/*
  Atomic, race-safe reward-ledger operations.

  The naive read-modify-write in the signer-service had a lost-update race:
  every accrual fold wrote back the `claimed_raw` it had READ, so a fold that
  started before a claim settled and finished after it silently reverted the
  settle — the user's claimable balance sprang back and the UI offered the
  same rewards again.

  Two SECURITY DEFINER functions (service-role only) replace it:

  • fold_evm_reward_accrual — compare-and-swap on anchor_ts: the delta only
    applies when the caller's read anchor still matches (two concurrent folds
    can never double-count an interval), and claimed_raw is NEVER touched.
    Returns the current row either way.

  • settle_evm_reward_claim — increments claimed_raw atomically (relative
    update, no absolute write), clamped so the claimed<=accrued constraint
    can never trip on a stale caller.
*/

CREATE OR REPLACE FUNCTION public.fold_evm_reward_accrual(
  p_chain_id bigint,
  p_staker text,
  p_delta numeric,
  p_staked numeric,
  p_expected_anchor timestamptz,
  p_new_anchor timestamptz
) RETURNS TABLE (accrued_raw numeric, claimed_raw numeric, anchor_ts timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- New account: start at zero accrual anchored now.
  INSERT INTO public.evm_reward_accounts AS a (chain_id, staker, accrued_raw, claimed_raw, staked_raw, anchor_ts, updated_at)
  VALUES (p_chain_id, lower(p_staker), 0, 0, p_staked, p_new_anchor, now())
  ON CONFLICT (chain_id, staker) DO UPDATE SET
    accrued_raw = CASE
      -- CAS: only apply the delta when the interval it was computed over is
      -- still the live one (nobody folded since the caller's read).
      WHEN a.anchor_ts = p_expected_anchor THEN a.accrued_raw + GREATEST(p_delta, 0)
      ELSE a.accrued_raw
    END,
    anchor_ts = CASE WHEN a.anchor_ts = p_expected_anchor THEN p_new_anchor ELSE a.anchor_ts END,
    staked_raw = p_staked,
    updated_at = now();

  RETURN QUERY
    SELECT a.accrued_raw, a.claimed_raw, a.anchor_ts
    FROM public.evm_reward_accounts a
    WHERE a.chain_id = p_chain_id AND a.staker = lower(p_staker);
END;
$$;

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
  SET claimed_raw = LEAST(claimed_raw + GREATEST(p_amount, 0), accrued_raw),
      updated_at = now()
  WHERE chain_id = p_chain_id AND staker = lower(p_staker);
$$;

-- Service-role (relayer) only — these move ledger state.
REVOKE ALL ON FUNCTION public.fold_evm_reward_accrual(bigint, text, numeric, numeric, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_evm_reward_claim(bigint, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fold_evm_reward_accrual(bigint, text, numeric, numeric, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_evm_reward_claim(bigint, text, numeric) TO service_role;
