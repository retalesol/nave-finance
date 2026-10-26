-- pay_ensure_one_asset declared a PL/pgSQL variable named contract and also
-- inserted into pay_crypto_assets.contract. Postgres treats that name as
-- ambiguous, so Treasury activity refresh failed with
-- column reference "contract" is ambiguous.

CREATE OR REPLACE FUNCTION public.pay_ensure_one_asset(
  p_treasury uuid,
  p_chain text,
  p_symbol text,
  p_name text,
  p_contract text,
  p_decimals integer,
  p_stable boolean,
  p_gl uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  asset uuid;
  sym text := left(btrim(coalesce(p_symbol, '')), 32);
  asset_contract text := btrim(coalesce(p_contract, ''));
BEGIN
  IF sym = '' OR p_decimals IS NULL OR p_decimals < 0 OR p_decimals > 18 THEN
    RETURN NULL;
  END IF;
  IF p_chain <> 'solana' THEN
    asset_contract := lower(asset_contract);
  END IF;
  IF upper(sym) = 'USDC' THEN
    p_stable := true;
  END IF;

  INSERT INTO public.pay_crypto_assets (
    treasury_group_id, chain, symbol, name, contract, decimals, is_stable, gl_account_id
  ) VALUES (
    p_treasury, p_chain, sym, left(coalesce(p_name, sym), 200), asset_contract, p_decimals, coalesce(p_stable, false), p_gl
  )
  ON CONFLICT (treasury_group_id, chain, contract) DO UPDATE
    SET is_stable = public.pay_crypto_assets.is_stable OR EXCLUDED.is_stable,
        gl_account_id = COALESCE(public.pay_crypto_assets.gl_account_id, EXCLUDED.gl_account_id)
  RETURNING id INTO asset;

  RETURN asset;
END;
$fn$;
