-- Nave Pay lots for non-invoice treasury activity.
--
-- The nave_treasury wallet is watch-only. This migration stores no seed,
-- private key, or xpub. Spending still leaves through governance.
--
-- Invoice settlements in pay_settlements are not copied into pay_crypto_events
-- and are not journaled again. pay_sync_journals keeps deleting only
-- source_type invoice and payment. This module deletes only crypto_event.
--
-- Lots replay like nave-books treasury.php: FIFO by default, HIFO per wallet,
-- internal transfers carry basis, gas is a disposal, USDC is at par.

-- ---------------------------------------------------------------------------
-- Journal source. Keep every source type already allowed, and add crypto_event.
-- ---------------------------------------------------------------------------

DO $widen$
DECLARE
  cname text;
  def text;
  body text;
BEGIN
  SELECT con.conname, pg_get_constraintdef(con.oid)
  INTO cname, def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'pay_journal_entries'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%source_type%'
  ORDER BY con.conname
  LIMIT 1;

  IF cname IS NULL THEN
    ALTER TABLE public.pay_journal_entries
      ADD CONSTRAINT pay_journal_entries_source_type_check
      CHECK (source_type IN ('invoice', 'payment', 'crypto_event'));
    RETURN;
  END IF;

  IF def ILIKE '%crypto_event%' THEN
    RETURN;
  END IF;

  body := regexp_replace(def, '^\s*CHECK\s*\((.*)\)\s*$', '\1', 'i');
  EXECUTE format('ALTER TABLE public.pay_journal_entries DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE public.pay_journal_entries ADD CONSTRAINT pay_journal_entries_source_type_check CHECK ((%s) OR source_type = %L)',
    body,
    'crypto_event'
  );
END
$widen$;

ALTER TABLE public.pay_wallets
  ADD COLUMN IF NOT EXISTS lot_method text NOT NULL DEFAULT 'FIFO';

DO $lot_method$
BEGIN
  ALTER TABLE public.pay_wallets
    ADD CONSTRAINT pay_wallets_lot_method_check
    CHECK (lot_method IN ('FIFO', 'HIFO'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$lot_method$;

COMMENT ON COLUMN public.pay_wallets.lot_method IS
  'Cost-basis method for this watch-only treasury wallet. FIFO is the default. HIFO is optional. No signing key is stored.';

-- ---------------------------------------------------------------------------
-- Books tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_crypto_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  chain text NOT NULL,
  symbol text NOT NULL,
  name text NOT NULL DEFAULT '',
  contract text NOT NULL DEFAULT '',
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  is_stable boolean NOT NULL DEFAULT false,
  gl_account_id uuid REFERENCES public.pay_accounts (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_crypto_assets_symbol_len CHECK (char_length(symbol) BETWEEN 1 AND 32),
  CONSTRAINT pay_crypto_assets_identity UNIQUE (treasury_group_id, chain, contract)
);

COMMENT ON TABLE public.pay_crypto_assets IS
  'Digital assets held by one treasury. USDC is stable at par. contract is empty for the chain native asset. No key material.';

CREATE INDEX IF NOT EXISTS pay_crypto_assets_group_idx
  ON public.pay_crypto_assets (treasury_group_id, chain, symbol);

CREATE TABLE IF NOT EXISTS public.pay_crypto_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  wallet_address_id uuid NOT NULL REFERENCES public.pay_wallet_addresses (id) ON DELETE CASCADE,
  chain text NOT NULL,
  tx_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  event_date date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  asset_id uuid NOT NULL REFERENCES public.pay_crypto_assets (id),
  qty_atomic numeric NOT NULL CHECK (qty_atomic > 0 AND qty_atomic = trunc(qty_atomic)),
  counterparty text NOT NULL DEFAULT '',
  price_usd numeric,
  usd_cents bigint,
  fee_asset_id uuid REFERENCES public.pay_crypto_assets (id),
  fee_qty_atomic numeric NOT NULL DEFAULT 0 CHECK (fee_qty_atomic >= 0 AND fee_qty_atomic = trunc(fee_qty_atomic)),
  fee_usd_cents bigint NOT NULL DEFAULT 0 CHECK (fee_usd_cents >= 0),
  kind text NOT NULL DEFAULT 'unclassified' CHECK (kind IN ('income', 'capital', 'transfer', 'expense', 'unclassified')),
  account_id uuid REFERENCES public.pay_accounts (id),
  memo text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'failed')),
  source text NOT NULL DEFAULT 'operator' CHECK (source IN ('operator', 'observed')),
  pair_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_crypto_events_kind_direction CHECK (
    (direction = 'in' AND kind IN ('income', 'capital', 'transfer', 'unclassified'))
    OR (direction = 'out' AND kind IN ('expense', 'transfer', 'unclassified'))
  ),
  CONSTRAINT pay_crypto_events_tx_len CHECK (char_length(tx_hash) BETWEEN 1 AND 200),
  CONSTRAINT pay_crypto_events_memo_len CHECK (char_length(memo) <= 500),
  CONSTRAINT pay_crypto_events_flow UNIQUE (
    treasury_group_id, chain, tx_hash, wallet_address_id, asset_id, direction
  )
);

COMMENT ON TABLE public.pay_crypto_events IS
  'Inflows and outflows on nave_treasury addresses that are not pay_settlements. Invoice payments stay on the invoice.';

CREATE INDEX IF NOT EXISTS pay_crypto_events_unclassified_idx
  ON public.pay_crypto_events (treasury_group_id, occurred_at DESC)
  WHERE kind = 'unclassified' AND status = 'confirmed';

CREATE TABLE IF NOT EXISTS public.pay_crypto_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  wallet_address_id uuid NOT NULL REFERENCES public.pay_wallet_addresses (id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.pay_crypto_assets (id),
  acquired date NOT NULL,
  qty_atomic numeric NOT NULL CHECK (qty_atomic >= 0),
  remaining_atomic numeric NOT NULL CHECK (remaining_atomic >= 0),
  cost_cents bigint NOT NULL CHECK (cost_cents >= 0),
  remaining_cost_cents bigint NOT NULL CHECK (remaining_cost_cents >= 0),
  origin_event_id uuid NOT NULL REFERENCES public.pay_crypto_events (id) ON DELETE CASCADE,
  via_event_id uuid REFERENCES public.pay_crypto_events (id) ON DELETE SET NULL,
  flags text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS pay_crypto_lots_asset_idx
  ON public.pay_crypto_lots (treasury_group_id, wallet_address_id, asset_id);

CREATE TABLE IF NOT EXISTS public.pay_crypto_disposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES public.pay_crypto_events (id) ON DELETE CASCADE,
  lot_id uuid REFERENCES public.pay_crypto_lots (id) ON DELETE SET NULL,
  wallet_address_id uuid NOT NULL REFERENCES public.pay_wallet_addresses (id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.pay_crypto_assets (id),
  role text NOT NULL CHECK (role IN ('disposal', 'transfer', 'fee')),
  qty_atomic numeric NOT NULL CHECK (qty_atomic >= 0),
  basis_cents bigint NOT NULL,
  proceeds_cents bigint NOT NULL,
  gain_cents bigint NOT NULL,
  acquired date,
  disposed date NOT NULL,
  term text NOT NULL DEFAULT '',
  flags text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS pay_crypto_disposals_event_idx
  ON public.pay_crypto_disposals (event_id);

CREATE TABLE IF NOT EXISTS public.pay_crypto_chain_balances (
  wallet_address_id uuid NOT NULL REFERENCES public.pay_wallet_addresses (id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.pay_crypto_assets (id) ON DELETE CASCADE,
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  qty_atomic numeric NOT NULL CHECK (qty_atomic >= 0),
  source text NOT NULL DEFAULT 'snapshot' CHECK (source = 'snapshot'),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address_id, asset_id)
);

COMMENT ON TABLE public.pay_crypto_chain_balances IS
  'Latest snapshot quantity for tie-out when the live treasury read is on another chain. Not a signing balance.';

-- Rebuild scratch. Operators do not read these. RLS with no policy.
CREATE TABLE IF NOT EXISTS public.pay_crypto_build_state (
  build_id uuid PRIMARY KEY,
  seq integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_lot (
  build_id uuid NOT NULL,
  seq integer NOT NULL,
  lot_id uuid NOT NULL,
  container uuid NOT NULL,
  asset_id uuid NOT NULL,
  acquired date NOT NULL,
  qty numeric NOT NULL,
  rem numeric NOT NULL,
  cost_cents bigint NOT NULL,
  rem_cost bigint NOT NULL,
  origin_event_id uuid NOT NULL,
  via_event_id uuid,
  flags text NOT NULL DEFAULT '',
  PRIMARY KEY (build_id, lot_id)
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_piece (
  build_id uuid NOT NULL,
  piece_no integer NOT NULL,
  lot_id uuid,
  qty numeric NOT NULL,
  basis_cents bigint NOT NULL,
  acquired date,
  origin_event_id uuid,
  missing boolean NOT NULL DEFAULT false,
  PRIMARY KEY (build_id, piece_no)
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_move (
  build_id uuid NOT NULL,
  out_event_id uuid NOT NULL,
  piece_no integer NOT NULL,
  lot_id uuid,
  qty numeric NOT NULL,
  basis_cents bigint NOT NULL,
  acquired date,
  origin_event_id uuid,
  missing boolean NOT NULL DEFAULT false,
  PRIMARY KEY (build_id, out_event_id, piece_no)
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_moved (
  build_id uuid NOT NULL,
  out_event_id uuid NOT NULL,
  PRIMARY KEY (build_id, out_event_id)
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_defer (
  build_id uuid NOT NULL,
  out_event_id uuid NOT NULL,
  in_event_id uuid NOT NULL,
  PRIMARY KEY (build_id, out_event_id, in_event_id)
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_done (
  build_id uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (build_id, event_id)
);

CREATE TABLE IF NOT EXISTS public.pay_crypto_build_disposal (
  build_id uuid NOT NULL,
  disposal_no integer NOT NULL,
  event_id uuid NOT NULL,
  lot_id uuid,
  container uuid NOT NULL,
  asset_id uuid NOT NULL,
  role text NOT NULL,
  qty numeric NOT NULL,
  basis_cents bigint NOT NULL,
  proceeds_cents bigint NOT NULL,
  gain_cents bigint NOT NULL,
  acquired date,
  disposed date NOT NULL,
  term text NOT NULL DEFAULT '',
  flags text NOT NULL DEFAULT '',
  PRIMARY KEY (build_id, disposal_no)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_tx_base(p_tx text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT regexp_replace(btrim(coalesce(p_tx, '')), ':[0-9]+$', '');
$fn$;

CREATE OR REPLACE FUNCTION public.pay_prorate_cents(total bigint, part numeric, whole numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN whole = 0 OR total = 0 OR part = 0 THEN 0
    ELSE (
      sign(total)::numeric * trunc(trunc(abs(total)::numeric * part / whole, 4) + 0.5, 0)
    )::bigint
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_par_cents(qty numeric, decimals integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN qty IS NULL OR decimals IS NULL OR decimals < 0 THEN 0
    ELSE trunc(
      (qty * 100 + div(power(10::numeric, decimals), 2)) / power(10::numeric, decimals)
    )::bigint
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_atomic_from_decimal(raw text, decimals integer)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  s text := replace(btrim(coalesce(raw, '')), ',', '');
  whole text;
  frac text;
BEGIN
  IF decimals IS NULL OR decimals < 0 OR decimals > 18 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  IF s !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  whole := split_part(s, '.', 1);
  frac := split_part(s, '.', 2);
  IF length(frac) > decimals THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  RETURN (whole || rpad(frac, decimals, '0'))::numeric;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_settlement_asset_matches(
  p_asset text,
  p_symbol text,
  p_contract text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT
    lower(btrim(coalesce(p_asset, ''))) = lower(btrim(coalesce(p_symbol, '')))
    OR (
      btrim(coalesce(p_contract, '')) <> ''
      AND lower(btrim(p_asset)) = lower(btrim(p_contract))
    )
    OR (
      upper(btrim(coalesce(p_symbol, ''))) = 'SOL'
      AND btrim(coalesce(p_contract, '')) = ''
      AND lower(btrim(coalesce(p_asset, ''))) IN ('sol', '11111111111111111111111111111111')
    )
    OR (
      upper(btrim(coalesce(p_symbol, ''))) = 'ETH'
      AND btrim(coalesce(p_contract, '')) = ''
      AND lower(btrim(coalesce(p_asset, ''))) IN ('eth', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    );
$fn$;

CREATE OR REPLACE FUNCTION public.pay_flow_is_invoice_settlement(
  p_treasury uuid,
  p_chain text,
  p_tx text,
  p_symbol text,
  p_contract text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.pay_settlements AS settlement
    WHERE settlement.treasury_group_id = p_treasury
      AND lower(settlement.chain) = lower(btrim(coalesce(p_chain, '')))
      AND public.pay_tx_base(settlement.tx_hash) = public.pay_tx_base(p_tx)
      AND public.pay_settlement_asset_matches(settlement.asset, p_symbol, p_contract)
  );
$fn$;

COMMENT ON FUNCTION public.pay_flow_is_invoice_settlement(uuid, text, text, text, text) IS
  'True when this chain transfer is already a pay_settlements row. Those stay on the invoice and are not re-booked here.';

CREATE OR REPLACE FUNCTION public.pay_ensure_realized_gain_account(p_treasury uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  acct uuid;
BEGIN
  SELECT id
  INTO acct
  FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury
    AND archived = false
    AND (system_key = 'realized_gain' OR code = '7100')
  ORDER BY (system_key = 'realized_gain') DESC, code
  LIMIT 1;

  IF acct IS NOT NULL THEN
    UPDATE public.pay_accounts
    SET system_key = 'realized_gain'
    WHERE id = acct
      AND system_key IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.pay_accounts
        WHERE treasury_group_id = p_treasury
          AND system_key = 'realized_gain'
      );
    RETURN acct;
  END IF;

  INSERT INTO public.pay_accounts (
    treasury_group_id, code, name, account_type, subtype, system_key, tax_line
  ) VALUES (
    p_treasury,
    '7100',
    'Realized gain/loss on digital assets',
    'income',
    'other_income',
    'realized_gain',
    '1120 L8/L9 (Sch D / 4797)'
  )
  ON CONFLICT (treasury_group_id, code) DO UPDATE
    SET system_key = COALESCE(public.pay_accounts.system_key, EXCLUDED.system_key)
  RETURNING id INTO acct;

  RETURN acct;
END;
$fn$;

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
  contract text := btrim(coalesce(p_contract, ''));
BEGIN
  IF sym = '' OR p_decimals IS NULL OR p_decimals < 0 OR p_decimals > 18 THEN
    RETURN NULL;
  END IF;
  IF p_chain <> 'solana' THEN
    contract := lower(contract);
  END IF;
  IF upper(sym) = 'USDC' THEN
    p_stable := true;
  END IF;

  INSERT INTO public.pay_crypto_assets (
    treasury_group_id, chain, symbol, name, contract, decimals, is_stable, gl_account_id
  ) VALUES (
    p_treasury, p_chain, sym, left(coalesce(p_name, sym), 200), contract, p_decimals, coalesce(p_stable, false), p_gl
  )
  ON CONFLICT (treasury_group_id, chain, contract) DO UPDATE
    SET is_stable = public.pay_crypto_assets.is_stable OR EXCLUDED.is_stable,
        gl_account_id = COALESCE(public.pay_crypto_assets.gl_account_id, EXCLUDED.gl_account_id)
  RETURNING id INTO asset;

  RETURN asset;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_ensure_crypto_assets(p_treasury uuid, p_held jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  gl uuid;
  addr record;
  held jsonb;
  snap record;
  elem jsonb;
  mint text;
  sym text;
  decs integer;
  stable boolean;
  contract text;
  qty numeric;
  asset uuid;
BEGIN
  SELECT id INTO gl
  FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury
    AND code = '1200'
    AND archived = false
  LIMIT 1;
  IF gl IS NULL THEN
    RETURN;
  END IF;

  FOR addr IN
    SELECT id, chain, chain_id
    FROM public.pay_wallet_addresses
    WHERE treasury_group_id = p_treasury
  LOOP
    IF addr.chain = 'solana' THEN
      PERFORM public.pay_ensure_one_asset(p_treasury, 'solana', 'SOL', 'Solana', '', 9, false, gl);
      PERFORM public.pay_ensure_one_asset(
        p_treasury, 'solana', 'USDC', 'USD Coin',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, true, gl
      );
      PERFORM public.pay_ensure_one_asset(
        p_treasury, 'solana', 'USDC', 'USD Coin (devnet)',
        'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', 6, true, gl
      );
    ELSIF addr.chain = 'arc' THEN
      PERFORM public.pay_ensure_one_asset(p_treasury, 'arc', 'USDC', 'USD Coin', '', 18, true, gl);
      PERFORM public.pay_ensure_one_asset(
        p_treasury, 'arc', 'USDC', 'USD Coin',
        '0x3600000000000000000000000000000000000000', 6, true, gl
      );
    ELSE
      PERFORM public.pay_ensure_one_asset(p_treasury, addr.chain, 'ETH', 'Ether', '', 18, false, gl);
      IF addr.chain_id = 1 THEN
        PERFORM public.pay_ensure_one_asset(p_treasury, addr.chain, 'USDC', 'USD Coin', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, true, gl);
      ELSIF addr.chain_id = 11155111 THEN
        PERFORM public.pay_ensure_one_asset(p_treasury, addr.chain, 'USDC', 'USD Coin', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 6, true, gl);
      ELSIF addr.chain_id = 8453 THEN
        PERFORM public.pay_ensure_one_asset(p_treasury, addr.chain, 'USDC', 'USD Coin', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6, true, gl);
      ELSIF addr.chain_id = 84532 THEN
        PERFORM public.pay_ensure_one_asset(p_treasury, addr.chain, 'USDC', 'USD Coin', '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 6, true, gl);
      ELSIF addr.chain_id = 46630 THEN
        PERFORM public.pay_ensure_one_asset(p_treasury, addr.chain, 'USDC', 'USD Coin', '0xaaae26c5b891bf00d4cd6ef04148bf1cb1cc96b1', 6, true, gl);
      END IF;
    END IF;

    SELECT token_balances, sol_balance, usdc_balance
    INTO snap
    FROM public.treasury_snapshots
    WHERE dao_onchain_address = (
      SELECT dao_onchain_address FROM public.pay_wallet_addresses WHERE id = addr.id
    )
       OR (
         dao_onchain_address ~* '^0x[0-9a-f]{40}$'
         AND lower(dao_onchain_address) = lower((
           SELECT dao_onchain_address FROM public.pay_wallet_addresses WHERE id = addr.id
         ))
       )
    ORDER BY snapshot_at DESC
    LIMIT 1;

    IF snap.token_balances IS NOT NULL AND jsonb_typeof(snap.token_balances) = 'array' THEN
      FOR elem IN SELECT value FROM jsonb_array_elements(snap.token_balances)
      LOOP
        IF coalesce(elem->>'kind', '') IN ('reconciliation_meta', 'evm_native_eth') THEN
          CONTINUE;
        END IF;
        mint := btrim(coalesce(elem->>'mint', ''));
        IF mint = '' OR mint IN ('SOL', 'ETH') THEN
          CONTINUE;
        END IF;
        decs := CASE
          WHEN coalesce(elem->>'decimals', '') ~ '^[0-9]+$' THEN (elem->>'decimals')::integer
          ELSE NULL
        END;
        stable := coalesce(elem->>'is_stablecoin', '') = 'true'
          OR coalesce(elem->>'is_usdc', '') = 'true'
          OR upper(coalesce(elem->>'symbol', '')) = 'USDC';
        sym := coalesce(NULLIF(elem->>'symbol', ''), CASE WHEN stable THEN 'USDC' ELSE left(mint, 8) END);
        IF decs IS NULL THEN
          decs := CASE WHEN stable THEN 6 ELSE NULL END;
        END IF;
        IF decs IS NULL THEN
          CONTINUE;
        END IF;
        contract := CASE WHEN addr.chain = 'solana' THEN mint ELSE lower(mint) END;
        asset := public.pay_ensure_one_asset(
          p_treasury, addr.chain, sym, coalesce(elem->>'name', sym), contract, decs, stable, gl
        );
        IF asset IS NOT NULL AND elem->>'balance' ~ '^[0-9]+(\.[0-9]+)?$' THEN
          qty := round((elem->>'balance')::numeric * power(10::numeric, decs));
          INSERT INTO public.pay_crypto_chain_balances (
            wallet_address_id, asset_id, treasury_group_id, qty_atomic, source, synced_at
          ) VALUES (addr.id, asset, p_treasury, qty, 'snapshot', now())
          ON CONFLICT (wallet_address_id, asset_id) DO UPDATE
            SET qty_atomic = EXCLUDED.qty_atomic, synced_at = now();
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF jsonb_typeof(p_held) = 'array' THEN
    FOR held IN SELECT value FROM jsonb_array_elements(p_held)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.pay_wallet_addresses
        WHERE treasury_group_id = p_treasury
          AND chain = held->>'chain'
      ) THEN
        CONTINUE;
      END IF;
      contract := btrim(coalesce(held->>'contract', ''));
      IF contract IN ('SOL', 'ETH') THEN
        contract := '';
      END IF;
      PERFORM public.pay_ensure_one_asset(
        p_treasury,
        held->>'chain',
        coalesce(held->>'symbol', ''),
        coalesce(held->>'name', held->>'symbol', ''),
        contract,
        NULLIF(held->>'decimals', '')::integer,
        coalesce((held->>'is_stable')::boolean, false),
        gl
      );
    END LOOP;
  END IF;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Lot replay. Mirrors replayLots in src/lib/pay/lots.ts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_crypto_add_lot(
  p_build uuid,
  p_container uuid,
  p_asset uuid,
  p_acquired date,
  p_qty numeric,
  p_cost bigint,
  p_origin uuid,
  p_via uuid,
  p_flags text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  next_seq integer;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.pay_crypto_build_state (build_id, seq)
  VALUES (p_build, 0)
  ON CONFLICT (build_id) DO NOTHING;
  UPDATE public.pay_crypto_build_state
  SET seq = seq + 1
  WHERE build_id = p_build
  RETURNING seq INTO next_seq;
  INSERT INTO public.pay_crypto_build_lot (
    build_id, seq, lot_id, container, asset_id, acquired, qty, rem, cost_cents, rem_cost,
    origin_event_id, via_event_id, flags
  ) VALUES (
    p_build, next_seq, gen_random_uuid(), p_container, p_asset, p_acquired, p_qty, p_qty,
    GREATEST(p_cost, 0), GREATEST(p_cost, 0), p_origin, p_via, coalesce(p_flags, '')
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_crypto_consume(
  p_build uuid,
  p_container uuid,
  p_asset uuid,
  p_qty numeric,
  p_method text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ids uuid[];
  lid uuid;
  left_qty numeric := p_qty;
  v_rem numeric;
  v_rem_cost bigint;
  v_acquired date;
  v_origin uuid;
  take numeric;
  basis bigint;
  piece integer := 0;
BEGIN
  DELETE FROM public.pay_crypto_build_piece WHERE build_id = p_build;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN;
  END IF;

  SELECT coalesce(array_agg(lot.lot_id ORDER BY
    CASE WHEN p_method = 'HIFO' THEN lot.cost_cents::numeric / NULLIF(lot.qty, 0) END DESC NULLS LAST,
    lot.seq ASC
  ), '{}')
  INTO ids
  FROM public.pay_crypto_build_lot AS lot
  WHERE lot.build_id = p_build
    AND lot.container = p_container
    AND lot.asset_id = p_asset
    AND lot.rem > 0;

  FOREACH lid IN ARRAY ids LOOP
    EXIT WHEN left_qty <= 0;
    SELECT lot.rem, lot.rem_cost, lot.acquired, lot.origin_event_id
    INTO v_rem, v_rem_cost, v_acquired, v_origin
    FROM public.pay_crypto_build_lot AS lot
    WHERE lot.build_id = p_build AND lot.lot_id = lid;
    IF v_rem IS NULL OR v_rem <= 0 THEN
      CONTINUE;
    END IF;
    take := least(left_qty, v_rem);
    IF take = v_rem THEN
      basis := v_rem_cost;
    ELSE
      basis := public.pay_prorate_cents(v_rem_cost, take, v_rem);
    END IF;
    UPDATE public.pay_crypto_build_lot AS lot
    SET rem = v_rem - take,
        rem_cost = v_rem_cost - basis
    WHERE lot.build_id = p_build AND lot.lot_id = lid;
    piece := piece + 1;
    INSERT INTO public.pay_crypto_build_piece (
      build_id, piece_no, lot_id, qty, basis_cents, acquired, origin_event_id, missing
    ) VALUES (p_build, piece, lid, take, basis, v_acquired, v_origin, false);
    left_qty := left_qty - take;
  END LOOP;

  IF left_qty > 0 THEN
    piece := piece + 1;
    INSERT INTO public.pay_crypto_build_piece (
      build_id, piece_no, lot_id, qty, basis_cents, acquired, origin_event_id, missing
    ) VALUES (p_build, piece, NULL, left_qty, 0, NULL, NULL, true);
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_crypto_write_pieces(
  p_build uuid,
  p_event uuid,
  p_container uuid,
  p_asset uuid,
  p_role text,
  p_proceeds bigint,
  p_qty numeric,
  p_disposed date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  piece record;
  total integer;
  i integer := 0;
  allocated bigint := 0;
  proc bigint;
  gain bigint;
  next_no integer;
  term text;
BEGIN
  SELECT count(*) INTO total FROM public.pay_crypto_build_piece WHERE build_id = p_build;
  FOR piece IN
    SELECT * FROM public.pay_crypto_build_piece
    WHERE build_id = p_build
    ORDER BY piece_no
  LOOP
    i := i + 1;
    IF p_role = 'transfer' THEN
      proc := 0;
    ELSIF i = total THEN
      proc := p_proceeds - allocated;
    ELSE
      proc := public.pay_prorate_cents(p_proceeds, piece.qty, p_qty);
    END IF;
    allocated := allocated + proc;
    gain := CASE WHEN p_role = 'transfer' THEN 0 ELSE proc - piece.basis_cents END;
    term := '';
    IF p_role <> 'transfer' AND piece.acquired IS NOT NULL THEN
      term := CASE
        WHEN p_disposed > (piece.acquired + INTERVAL '1 year')::date THEN 'long'
        ELSE 'short'
      END;
    END IF;
    SELECT coalesce(max(disposal_no), 0) + 1 INTO next_no
    FROM public.pay_crypto_build_disposal
    WHERE build_id = p_build;
    INSERT INTO public.pay_crypto_build_disposal (
      build_id, disposal_no, event_id, lot_id, container, asset_id, role, qty,
      basis_cents, proceeds_cents, gain_cents, acquired, disposed, term, flags
    ) VALUES (
      p_build, next_no, p_event, piece.lot_id, p_container, p_asset, p_role, piece.qty,
      piece.basis_cents, proc, gain, piece.acquired, p_disposed, term,
      CASE WHEN piece.missing THEN 'missing_basis' ELSE '' END
    );
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_crypto_apply_event(
  p_build uuid,
  p_treasury uuid,
  p_event uuid,
  p_method text,
  p_force_unpaired boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ev public.pay_crypto_events%ROWTYPE;
  piece record;
  flags text;
  cost bigint;
  is_transfer boolean;
  proceeds bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pay_crypto_build_done
    WHERE build_id = p_build AND event_id = p_event
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO ev
  FROM public.pay_crypto_events
  WHERE id = p_event AND treasury_group_id = p_treasury;
  IF NOT FOUND OR ev.status <> 'confirmed' THEN
    INSERT INTO public.pay_crypto_build_done (build_id, event_id)
    VALUES (p_build, p_event)
    ON CONFLICT DO NOTHING;
    RETURN;
  END IF;

  IF ev.direction = 'in' AND ev.kind = 'transfer' AND ev.pair_event_id IS NOT NULL AND NOT p_force_unpaired THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_crypto_build_moved
      WHERE build_id = p_build AND out_event_id = ev.pair_event_id
    ) THEN
      INSERT INTO public.pay_crypto_build_defer (build_id, out_event_id, in_event_id)
      VALUES (p_build, ev.pair_event_id, ev.id)
      ON CONFLICT DO NOTHING;
      RETURN;
    END IF;
    FOR piece IN
      SELECT * FROM public.pay_crypto_build_move
      WHERE build_id = p_build AND out_event_id = ev.pair_event_id
      ORDER BY piece_no
    LOOP
      PERFORM public.pay_crypto_add_lot(
        p_build, ev.wallet_address_id, ev.asset_id,
        coalesce(piece.acquired, ev.event_date), piece.qty, piece.basis_cents,
        coalesce(piece.origin_event_id, ev.id), ev.id,
        CASE WHEN piece.missing THEN 'missing_basis' ELSE '' END
      );
    END LOOP;
  ELSIF ev.direction = 'in' THEN
    flags := '';
    cost := coalesce(ev.usd_cents, 0);
    IF ev.usd_cents IS NULL THEN
      cost := 0;
      flags := 'unpriced';
    END IF;
    IF ev.kind = 'transfer' THEN
      flags := btrim(flags || ' unpaired_transfer');
    END IF;
    PERFORM public.pay_crypto_add_lot(
      p_build, ev.wallet_address_id, ev.asset_id, ev.event_date, ev.qty_atomic, cost,
      ev.id, NULL, flags
    );
  ELSE
    PERFORM public.pay_crypto_consume(p_build, ev.wallet_address_id, ev.asset_id, ev.qty_atomic, p_method);
    is_transfer := ev.kind = 'transfer';
    proceeds := CASE WHEN is_transfer THEN 0 ELSE coalesce(ev.usd_cents, 0) END;
    PERFORM public.pay_crypto_write_pieces(
      p_build, ev.id, ev.wallet_address_id, ev.asset_id,
      CASE WHEN is_transfer THEN 'transfer' ELSE 'disposal' END,
      proceeds, ev.qty_atomic, ev.event_date
    );
    IF is_transfer THEN
      INSERT INTO public.pay_crypto_build_moved (build_id, out_event_id)
      VALUES (p_build, ev.id)
      ON CONFLICT DO NOTHING;
      INSERT INTO public.pay_crypto_build_move (
        build_id, out_event_id, piece_no, lot_id, qty, basis_cents, acquired, origin_event_id, missing
      )
      SELECT p_build, ev.id, piece_no, lot_id, qty, basis_cents, acquired, origin_event_id, missing
      FROM public.pay_crypto_build_piece
      WHERE build_id = p_build;
    END IF;
  END IF;

  IF ev.fee_asset_id IS NOT NULL AND ev.fee_qty_atomic > 0 THEN
    PERFORM public.pay_crypto_consume(
      p_build, ev.wallet_address_id, ev.fee_asset_id, ev.fee_qty_atomic, p_method
    );
    PERFORM public.pay_crypto_write_pieces(
      p_build, ev.id, ev.wallet_address_id, ev.fee_asset_id, 'fee',
      ev.fee_usd_cents, ev.fee_qty_atomic, ev.event_date
    );
  END IF;

  INSERT INTO public.pay_crypto_build_done (build_id, event_id)
  VALUES (p_build, ev.id)
  ON CONFLICT DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_price_crypto_events(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.pay_crypto_events AS event
  SET price_usd = 1,
      usd_cents = public.pay_par_cents(event.qty_atomic, asset.decimals),
      updated_at = now()
  FROM public.pay_crypto_assets AS asset
  WHERE event.asset_id = asset.id
    AND event.treasury_group_id = p_treasury
    AND asset.is_stable
    AND event.status = 'confirmed';

  UPDATE public.pay_crypto_events AS event
  SET fee_usd_cents = public.pay_par_cents(event.fee_qty_atomic, asset.decimals),
      updated_at = now()
  FROM public.pay_crypto_assets AS asset
  WHERE event.fee_asset_id = asset.id
    AND event.treasury_group_id = p_treasury
    AND asset.is_stable
    AND event.fee_qty_atomic > 0
    AND event.status = 'confirmed';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_rebuild_crypto_lots(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  method text;
  build uuid := gen_random_uuid();
  ev record;
  waiting record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pay-lots|' || p_treasury::text, 0));

  SELECT CASE WHEN lot_method = 'HIFO' THEN 'HIFO' ELSE 'FIFO' END
  INTO method
  FROM public.pay_wallets
  WHERE treasury_group_id = p_treasury AND kind = 'nave_treasury';
  IF method IS NULL THEN
    RETURN;
  END IF;

  WITH pairs AS (
    SELECT DISTINCT ON (outgoing.id)
      outgoing.id AS out_id,
      incoming.id AS in_id
    FROM public.pay_crypto_events AS outgoing
    JOIN public.pay_crypto_events AS incoming
      ON incoming.treasury_group_id = outgoing.treasury_group_id
     AND incoming.kind = 'transfer'
     AND incoming.direction = 'in'
     AND incoming.status = 'confirmed'
     AND incoming.chain = outgoing.chain
     AND incoming.tx_hash = outgoing.tx_hash
     AND incoming.asset_id = outgoing.asset_id
     AND incoming.wallet_address_id <> outgoing.wallet_address_id
     AND incoming.pair_event_id IS NULL
    WHERE outgoing.treasury_group_id = p_treasury
      AND outgoing.kind = 'transfer'
      AND outgoing.direction = 'out'
      AND outgoing.status = 'confirmed'
      AND outgoing.pair_event_id IS NULL
    ORDER BY outgoing.id, incoming.id
  ),
  unique_in AS (
    SELECT DISTINCT ON (in_id) out_id, in_id
    FROM pairs
    ORDER BY in_id, out_id
  )
  UPDATE public.pay_crypto_events AS event
  SET pair_event_id = CASE WHEN event.id = picked.out_id THEN picked.in_id ELSE picked.out_id END,
      updated_at = now()
  FROM unique_in AS picked
  WHERE event.id IN (picked.out_id, picked.in_id);

  FOR ev IN
    SELECT id
    FROM public.pay_crypto_events
    WHERE treasury_group_id = p_treasury
      AND status = 'confirmed'
    ORDER BY occurred_at, CASE direction WHEN 'in' THEN 0 ELSE 1 END, id
  LOOP
    PERFORM public.pay_crypto_apply_event(build, p_treasury, ev.id, method, false);
    FOR waiting IN
      SELECT in_event_id
      FROM public.pay_crypto_build_defer
      WHERE build_id = build AND out_event_id = ev.id
    LOOP
      PERFORM public.pay_crypto_apply_event(build, p_treasury, waiting.in_event_id, method, false);
    END LOOP;
    DELETE FROM public.pay_crypto_build_defer
    WHERE build_id = build AND out_event_id = ev.id;
  END LOOP;

  FOR waiting IN
    SELECT in_event_id FROM public.pay_crypto_build_defer WHERE build_id = build
  LOOP
    PERFORM public.pay_crypto_apply_event(build, p_treasury, waiting.in_event_id, method, true);
  END LOOP;

  DELETE FROM public.pay_crypto_disposals WHERE treasury_group_id = p_treasury;
  DELETE FROM public.pay_crypto_lots WHERE treasury_group_id = p_treasury;

  INSERT INTO public.pay_crypto_lots (
    id, treasury_group_id, wallet_address_id, asset_id, acquired, qty_atomic, remaining_atomic,
    cost_cents, remaining_cost_cents, origin_event_id, via_event_id, flags
  )
  SELECT
    lot_id, p_treasury, container, asset_id, acquired, qty, rem,
    cost_cents, rem_cost, origin_event_id, via_event_id, flags
  FROM public.pay_crypto_build_lot
  WHERE build_id = build;

  INSERT INTO public.pay_crypto_disposals (
    treasury_group_id, event_id, lot_id, wallet_address_id, asset_id, role, qty_atomic,
    basis_cents, proceeds_cents, gain_cents, acquired, disposed, term, flags
  )
  SELECT
    p_treasury, event_id, lot_id, container, asset_id, role, qty,
    basis_cents, proceeds_cents, gain_cents, acquired, disposed, term, flags
  FROM public.pay_crypto_build_disposal
  WHERE build_id = build;

  DELETE FROM public.pay_crypto_build_disposal WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_done WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_defer WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_moved WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_move WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_piece WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_lot WHERE build_id = build;
  DELETE FROM public.pay_crypto_build_state WHERE build_id = build;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_post_crypto_journals(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ev record;
  gain uuid;
  digital uuid;
  gas uuid;
  income_default uuid;
  expense_default uuid;
  capital_default uuid;
  offset_acct uuid;
  asset_acct uuid;
  fee_acct uuid;
  basis bigint;
  gain_cents bigint;
  fee record;
  entry uuid;
  line_no integer;
  debit_sum bigint;
  credit_sum bigint;
BEGIN
  gain := public.pay_ensure_realized_gain_account(p_treasury);
  digital := public.pay_account_id(p_treasury, '1200');
  gas := coalesce(public.pay_account_id(p_treasury, '6110'), (
    SELECT id FROM public.pay_accounts
    WHERE treasury_group_id = p_treasury AND system_key = 'gas_fees' AND archived = false
    LIMIT 1
  ));
  income_default := coalesce(
    public.pay_account_id(p_treasury, '4900'),
    public.pay_account_id(p_treasury, '4000')
  );
  expense_default := coalesce(
    public.pay_account_id(p_treasury, '6900'),
    public.pay_account_id(p_treasury, '6110')
  );
  capital_default := coalesce(
    public.pay_account_id(p_treasury, '3100'),
    public.pay_account_id(p_treasury, '3300'),
    public.pay_account_id(p_treasury, '2500')
  );

  DELETE FROM public.pay_journal_entries
  WHERE treasury_group_id = p_treasury
    AND source_type = 'crypto_event';

  CREATE TEMP TABLE IF NOT EXISTS pay_crypto_gl_line (
    line_no integer PRIMARY KEY,
    account_id uuid NOT NULL,
    debit_cents bigint NOT NULL,
    credit_cents bigint NOT NULL,
    memo text NOT NULL
  ) ON COMMIT DROP;

  FOR ev IN
    SELECT
      event.*,
      asset.symbol,
      asset.gl_account_id,
      account.account_type AS chosen_type
    FROM public.pay_crypto_events AS event
    JOIN public.pay_crypto_assets AS asset ON asset.id = event.asset_id
    LEFT JOIN public.pay_accounts AS account
      ON account.id = event.account_id
     AND account.treasury_group_id = p_treasury
     AND account.archived = false
    WHERE event.treasury_group_id = p_treasury
      AND event.status = 'confirmed'
      AND event.kind IN ('income', 'capital', 'expense', 'transfer')
    ORDER BY event.occurred_at, event.id
  LOOP
    TRUNCATE pg_temp.pay_crypto_gl_line;
    line_no := 0;

    asset_acct := coalesce(ev.gl_account_id, digital);

    IF ev.direction = 'in' AND ev.kind IN ('income', 'capital') AND ev.usd_cents IS NOT NULL AND asset_acct IS NOT NULL THEN
      IF ev.kind = 'income' THEN
        offset_acct := CASE WHEN ev.chosen_type = 'income' THEN ev.account_id ELSE income_default END;
      ELSE
        offset_acct := CASE WHEN ev.chosen_type IN ('equity', 'liability') THEN ev.account_id ELSE capital_default END;
      END IF;
      IF offset_acct IS NOT NULL AND ev.usd_cents <> 0 THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, asset_acct, ev.usd_cents, 0, '');
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, offset_acct, 0, ev.usd_cents, '');
      END IF;
    END IF;

    IF ev.direction = 'out' AND ev.kind = 'expense' AND ev.usd_cents IS NOT NULL AND asset_acct IS NOT NULL THEN
      offset_acct := CASE WHEN ev.chosen_type = 'expense' THEN ev.account_id ELSE expense_default END;
      SELECT coalesce(sum(disposal.basis_cents), 0)
      INTO basis
      FROM public.pay_crypto_disposals AS disposal
      WHERE disposal.event_id = ev.id
        AND disposal.role = 'disposal'
        AND disposal.asset_id = ev.asset_id;
      gain_cents := ev.usd_cents - basis;
      IF offset_acct IS NOT NULL AND ev.usd_cents <> 0 THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, offset_acct, ev.usd_cents, 0, '');
      END IF;
      IF basis <> 0 THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, asset_acct, 0, basis, 'At cost');
      END IF;
      IF gain_cents > 0 AND gain IS NOT NULL THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, gain, 0, gain_cents, 'Realized gain');
      ELSIF gain_cents < 0 AND gain IS NOT NULL THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, gain, -gain_cents, 0, 'Realized loss');
      END IF;
    END IF;

    FOR fee IN
      SELECT asset_id, sum(proceeds_cents) AS proceeds, sum(basis_cents) AS basis
      FROM public.pay_crypto_disposals
      WHERE event_id = ev.id AND role = 'fee'
      GROUP BY asset_id
    LOOP
      SELECT coalesce(gl_account_id, digital) INTO fee_acct
      FROM public.pay_crypto_assets
      WHERE id = fee.asset_id;
      IF fee.proceeds <> 0 AND gas IS NOT NULL THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, gas, fee.proceeds, 0, 'Network fee');
      END IF;
      IF fee.basis <> 0 AND fee_acct IS NOT NULL THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, fee_acct, 0, fee.basis, 'Network fee at cost');
      END IF;
      gain_cents := fee.proceeds - fee.basis;
      IF gain_cents > 0 AND gain IS NOT NULL THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, gain, 0, gain_cents, 'Gain on fee asset');
      ELSIF gain_cents < 0 AND gain IS NOT NULL THEN
        line_no := line_no + 1;
        INSERT INTO pg_temp.pay_crypto_gl_line VALUES (line_no, gain, -gain_cents, 0, 'Loss on fee asset');
      END IF;
    END LOOP;

    SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0)
    INTO debit_sum, credit_sum
    FROM pg_temp.pay_crypto_gl_line;
    IF line_no = 0 THEN
      CONTINUE;
    END IF;
    IF debit_sum <> credit_sum THEN
      RAISE EXCEPTION 'crypto_journal_unbalanced' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.pay_journal_entries (
      treasury_group_id, entry_date, memo, ref, party, source_type, source_id
    ) VALUES (
      p_treasury,
      ev.event_date,
      left(initcap(replace(ev.kind, '_', ' ')) || ' · ' || ev.symbol, 500),
      left(ev.tx_hash, 20),
      left(ev.counterparty, 200),
      'crypto_event',
      ev.id
    )
    RETURNING id INTO entry;

    INSERT INTO public.pay_journal_lines (
      treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo
    )
    SELECT p_treasury, entry, gl.line_no, gl.account_id, gl.debit_cents, gl.credit_cents, gl.memo
    FROM pg_temp.pay_crypto_gl_line AS gl;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_sync_crypto_books(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.pay_price_crypto_events(p_treasury);
  PERFORM public.pay_rebuild_crypto_lots(p_treasury);
  PERFORM public.pay_post_crypto_journals(p_treasury);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_observe_treasury_flows(p_treasury uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  log record;
  addr_id uuid;
  v_chain text;
  raw jsonb;
  v_amount numeric;
  mint text;
  v_asset uuid;
  sym text;
  v_contract text;
  v_direction text;
  v_counterparty text;
  v_kind text;
  v_tx text;
  inserted integer := 0;
  gl uuid;
BEGIN
  SELECT id INTO gl FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury AND code = '1200' AND archived = false
  LIMIT 1;

  FOR log IN
    SELECT
      activity.id,
      activity.event_type,
      activity.tx_signature,
      activity.block_time,
      activity.created_at,
      activity.actor,
      activity.raw_data,
      activity.chain AS log_chain,
      addr.id AS wallet_address_id,
      addr.chain AS addr_chain
    FROM public.activity_logs AS activity
    JOIN public.pay_wallet_addresses AS addr
      ON addr.treasury_group_id = p_treasury
     AND (
       addr.dao_onchain_address = activity.dao_onchain_address
       OR (
         addr.dao_onchain_address ~* '^0x[0-9a-f]{40}$'
         AND activity.dao_onchain_address ~* '^0x[0-9a-f]{40}$'
         AND lower(addr.dao_onchain_address) = lower(activity.dao_onchain_address)
       )
     )
    WHERE activity.event_type IN (
      'VaultDeposited', 'VaultWithdrawn', 'TransferExecuted', 'GovernanceTransferExecuted'
    )
      AND (activity.chain IS NULL OR activity.chain = addr.chain)
  LOOP
    raw := coalesce(log.raw_data, '{}'::jsonb);
    v_amount := NULL;
    IF coalesce(raw->>'amount', raw->>'Amount', raw->>'lamports', '') ~ '^[0-9]{1,78}$' THEN
      v_amount := coalesce(raw->>'amount', raw->>'Amount', raw->>'lamports')::numeric;
    END IF;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_chain := log.addr_chain;
    addr_id := log.wallet_address_id;
    v_direction := CASE WHEN log.event_type = 'VaultDeposited' THEN 'in' ELSE 'out' END;
    mint := btrim(coalesce(raw->>'mint', raw->>'asset', raw->>'token', ''));
    IF mint IN ('', '11111111111111111111111111111111', '0x0000000000000000000000000000000000000000', 'SOL', 'ETH') THEN
      SELECT held.id, held.symbol, held.contract INTO v_asset, sym, v_contract
      FROM public.pay_crypto_assets AS held
      WHERE held.treasury_group_id = p_treasury
        AND held.chain = log.addr_chain
        AND held.contract = ''
      ORDER BY (held.symbol = CASE WHEN log.addr_chain = 'solana' THEN 'SOL' WHEN log.addr_chain = 'arc' THEN 'USDC' ELSE 'ETH' END) DESC
      LIMIT 1;
    ELSE
      v_contract := CASE WHEN v_chain = 'solana' THEN mint ELSE lower(mint) END;
      SELECT held.id, held.symbol INTO v_asset, sym
      FROM public.pay_crypto_assets AS held
      WHERE held.treasury_group_id = p_treasury
        AND held.chain = v_chain
        AND (
          v_contract = held.contract
          OR lower(v_contract) = lower(held.contract)
        )
      LIMIT 1;
      IF v_asset IS NULL AND gl IS NOT NULL THEN
        v_asset := public.pay_ensure_one_asset(
          p_treasury, v_chain,
          CASE WHEN v_contract IN (
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
          ) OR lower(v_contract) IN (
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
            '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
            '0xaaae26c5b891bf00d4cd6ef04148bf1cb1cc96b1',
            '0x3600000000000000000000000000000000000000'
          ) THEN 'USDC' ELSE left(v_contract, 8) END,
          CASE WHEN lower(v_contract) LIKE '%usdc%' OR v_contract IN (
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
          ) THEN 'USD Coin' ELSE 'Treasury asset' END,
          v_contract,
          CASE WHEN lower(left(coalesce(raw->>'symbol', ''), 8)) = 'usdc' OR v_contract IN (
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
          ) OR lower(v_contract) IN (
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
            '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
            '0xaaae26c5b891bf00d4cd6ef04148bf1cb1cc96b1',
            '0x3600000000000000000000000000000000000000'
          ) THEN 6 ELSE NULLIF(raw->>'decimals', '')::integer END,
          false,
          gl
        );
        SELECT held.symbol, held.contract INTO sym, v_contract
        FROM public.pay_crypto_assets AS held WHERE held.id = v_asset;
      ELSE
        SELECT held.contract INTO v_contract
        FROM public.pay_crypto_assets AS held WHERE held.id = v_asset;
      END IF;
    END IF;

    IF v_asset IS NULL THEN
      CONTINUE;
    END IF;
    IF public.pay_flow_is_invoice_settlement(p_treasury, v_chain, log.tx_signature, sym, v_contract) THEN
      CONTINUE;
    END IF;

    v_counterparty := left(btrim(coalesce(
      raw->>'depositor', raw->>'recipient', raw->>'to', log.actor, ''
    )), 200);
    v_kind := 'unclassified';
    IF v_counterparty <> '' AND EXISTS (
      SELECT 1 FROM public.pay_wallet_addresses AS other
      WHERE other.treasury_group_id = p_treasury
        AND other.id <> addr_id
        AND (
          other.address = v_counterparty
          OR (other.address ~* '^0x[0-9a-f]{40}$' AND lower(other.address) = lower(v_counterparty))
        )
    ) THEN
      v_kind := 'transfer';
    END IF;

    v_tx := public.pay_tx_base(log.tx_signature);
    IF v_tx = '' THEN
      CONTINUE;
    END IF;

    INSERT INTO public.pay_crypto_events (
      treasury_group_id, wallet_address_id, chain, tx_hash, occurred_at, event_date,
      direction, asset_id, qty_atomic, counterparty, kind, status, source
    ) VALUES (
      p_treasury, addr_id, v_chain, left(v_tx, 200),
      coalesce(log.block_time, log.created_at, now()),
      (coalesce(log.block_time, log.created_at, now()) AT TIME ZONE 'UTC')::date,
      v_direction, v_asset, v_amount, v_counterparty, v_kind, 'confirmed', 'observed'
    )
    ON CONFLICT (treasury_group_id, chain, tx_hash, wallet_address_id, asset_id, direction) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_crypto_events AS existing
      WHERE existing.treasury_group_id = p_treasury
        AND existing.chain = log.addr_chain
        AND existing.tx_hash = left(v_tx, 200)
        AND existing.wallet_address_id = addr_id
        AND existing.asset_id = v_asset
        AND existing.direction = v_direction
        AND existing.created_at < now() - interval '1 second'
    ) THEN
      inserted := inserted + 1;
    END IF;
  END LOOP;

  RETURN inserted;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_refresh_treasury_activity(p_treasury uuid, p_held jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  observed integer;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  PERFORM public.pay_ensure_crypto_assets(p_treasury, coalesce(p_held, '[]'::jsonb));
  observed := public.pay_observe_treasury_flows(p_treasury);
  PERFORM public.pay_sync_crypto_books(p_treasury);
  RETURN jsonb_build_object('observed', observed);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_record_crypto_event(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  addr public.pay_wallet_addresses%ROWTYPE;
  asset public.pay_crypto_assets%ROWTYPE;
  gl uuid;
  qty numeric;
  fee_qty numeric := 0;
  occurred timestamptz;
  direction text;
  kind text;
  tx text;
  event_id uuid;
  counterparty text;
  usd bigint;
  price numeric;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO addr
  FROM public.pay_wallet_addresses
  WHERE id = NULLIF(p_body->>'wallet_address_id', '')::uuid
    AND treasury_group_id = p_treasury;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'address_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO gl FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury AND code = '1200' AND archived = false
  LIMIT 1;
  PERFORM public.pay_ensure_crypto_assets(p_treasury, '[]'::jsonb);

  IF NULLIF(p_body->>'asset_id', '') IS NOT NULL THEN
    SELECT * INTO asset
    FROM public.pay_crypto_assets
    WHERE id = (p_body->>'asset_id')::uuid
      AND treasury_group_id = p_treasury;
  ELSE
    SELECT * INTO asset
    FROM public.pay_crypto_assets
    WHERE id = public.pay_ensure_one_asset(
      p_treasury,
      addr.chain,
      coalesce(p_body#>>'{asset,symbol}', ''),
      coalesce(p_body#>>'{asset,name}', p_body#>>'{asset,symbol}', ''),
      coalesce(p_body#>>'{asset,contract}', ''),
      NULLIF(p_body#>>'{asset,decimals}', '')::integer,
      coalesce((p_body#>>'{asset,is_stable}')::boolean, false),
      gl
    );
  END IF;
  IF asset.id IS NULL THEN
    RAISE EXCEPTION 'asset_not_found' USING ERRCODE = 'P0002';
  END IF;

  direction := p_body->>'direction';
  IF direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'bad_direction' USING ERRCODE = '22023';
  END IF;
  kind := coalesce(NULLIF(p_body->>'kind', ''), 'unclassified');
  IF (direction = 'in' AND kind NOT IN ('income', 'capital', 'transfer', 'unclassified'))
     OR (direction = 'out' AND kind NOT IN ('expense', 'transfer', 'unclassified')) THEN
    RAISE EXCEPTION 'bad_kind' USING ERRCODE = '22023';
  END IF;

  tx := public.pay_tx_base(p_body->>'tx_hash');
  IF tx = '' OR char_length(tx) > 200 THEN
    RAISE EXCEPTION 'invalid_tx' USING ERRCODE = '22023';
  END IF;
  IF public.pay_flow_is_invoice_settlement(p_treasury, addr.chain, tx, asset.symbol, asset.contract) THEN
    RAISE EXCEPTION 'invoice_settlement' USING ERRCODE = '23514';
  END IF;

  qty := public.pay_atomic_from_decimal(p_body->>'qty', asset.decimals);
  IF qty <= 0 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(p_body->>'fee_asset_id', '') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pay_crypto_assets
    WHERE id = (p_body->>'fee_asset_id')::uuid
      AND treasury_group_id = p_treasury
  ) THEN
    RAISE EXCEPTION 'asset_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NULLIF(p_body->>'fee_qty', '') IS NOT NULL THEN
    fee_qty := public.pay_atomic_from_decimal(p_body->>'fee_qty', coalesce((
      SELECT decimals FROM public.pay_crypto_assets
      WHERE id = NULLIF(p_body->>'fee_asset_id', '')::uuid
        AND treasury_group_id = p_treasury
    ), asset.decimals));
  END IF;

  occurred := coalesce(NULLIF(p_body->>'occurred_at', '')::timestamptz, now());
  counterparty := left(btrim(coalesce(p_body->>'counterparty', '')), 200);
  IF counterparty <> '' AND EXISTS (
    SELECT 1 FROM public.pay_wallet_addresses AS other
    WHERE other.treasury_group_id = p_treasury
      AND other.id <> addr.id
      AND (
        other.address = counterparty
        OR (other.address ~* '^0x[0-9a-f]{40}$' AND lower(other.address) = lower(counterparty))
      )
  ) AND kind = 'unclassified' THEN
    kind := 'transfer';
  END IF;

  price := NULL;
  IF NULLIF(p_body->>'price_usd', '') IS NOT NULL THEN
    IF p_body->>'price_usd' !~ '^[0-9]{1,12}(\.[0-9]{1,12})?$' THEN
      RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
    END IF;
    price := (p_body->>'price_usd')::numeric;
  END IF;
  IF NULLIF(p_body->>'usd_cents', '') IS NOT NULL THEN
    usd := (p_body->>'usd_cents')::bigint;
  ELSIF price IS NOT NULL THEN
    usd := round(qty * price * 100 / power(10::numeric, asset.decimals))::bigint;
  ELSE
    usd := NULL;
  END IF;
  IF asset.is_stable THEN
    usd := public.pay_par_cents(qty, asset.decimals);
    price := 1;
  END IF;

  INSERT INTO public.pay_crypto_events (
    treasury_group_id, wallet_address_id, chain, tx_hash, occurred_at, event_date,
    direction, asset_id, qty_atomic, counterparty, price_usd, usd_cents,
    fee_asset_id, fee_qty_atomic, fee_usd_cents, kind, account_id, memo, status, source
  ) VALUES (
    p_treasury, addr.id, addr.chain, tx, occurred, (occurred AT TIME ZONE 'UTC')::date,
    direction, asset.id, qty, counterparty, price, usd,
    NULLIF(p_body->>'fee_asset_id', '')::uuid,
    coalesce(fee_qty, 0),
    coalesce(NULLIF(p_body->>'fee_usd_cents', '')::bigint, 0),
    kind,
    NULLIF(p_body->>'account_id', '')::uuid,
    left(btrim(coalesce(p_body->>'memo', '')), 500),
    'confirmed',
    'operator'
  )
  ON CONFLICT (treasury_group_id, chain, tx_hash, wallet_address_id, asset_id, direction) DO UPDATE
    SET qty_atomic = EXCLUDED.qty_atomic,
        occurred_at = EXCLUDED.occurred_at,
        event_date = EXCLUDED.event_date,
        counterparty = CASE
          WHEN pay_crypto_events.counterparty = '' THEN EXCLUDED.counterparty
          ELSE pay_crypto_events.counterparty
        END,
        fee_asset_id = COALESCE(EXCLUDED.fee_asset_id, pay_crypto_events.fee_asset_id),
        fee_qty_atomic = CASE
          WHEN EXCLUDED.fee_qty_atomic > 0 THEN EXCLUDED.fee_qty_atomic
          ELSE pay_crypto_events.fee_qty_atomic
        END,
        updated_at = now()
  WHERE pay_crypto_events.source = 'observed' AND pay_crypto_events.kind = 'unclassified'
  RETURNING id INTO event_id;

  IF event_id IS NULL THEN
    SELECT id INTO event_id
    FROM public.pay_crypto_events
    WHERE treasury_group_id = p_treasury
      AND chain = addr.chain
      AND tx_hash = tx
      AND wallet_address_id = addr.id
      AND asset_id = asset.id
      AND direction = direction;
  END IF;

  PERFORM public.pay_sync_crypto_books(p_treasury);
  RETURN event_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_classify_crypto_event(
  p_treasury uuid,
  p_event uuid,
  p_kind text,
  p_account uuid,
  p_memo text,
  p_usd_cents bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ev public.pay_crypto_events%ROWTYPE;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO ev
  FROM public.pay_crypto_events
  WHERE id = p_event AND treasury_group_id = p_treasury;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'event_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF (ev.direction = 'in' AND p_kind NOT IN ('income', 'capital', 'transfer', 'unclassified'))
     OR (ev.direction = 'out' AND p_kind NOT IN ('expense', 'transfer', 'unclassified')) THEN
    RAISE EXCEPTION 'bad_kind' USING ERRCODE = '22023';
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pay_accounts
    WHERE id = p_account AND treasury_group_id = p_treasury AND archived = false
  ) THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.pay_crypto_events
  SET kind = p_kind,
      account_id = p_account,
      memo = left(btrim(coalesce(p_memo, memo)), 500),
      usd_cents = COALESCE(p_usd_cents, usd_cents),
      updated_at = now()
  WHERE id = ev.id;

  PERFORM public.pay_sync_crypto_books(p_treasury);
  RETURN ev.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_set_lot_method(p_treasury uuid, p_method text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  IF p_method NOT IN ('FIFO', 'HIFO') THEN
    RAISE EXCEPTION 'bad_method' USING ERRCODE = '22023';
  END IF;
  UPDATE public.pay_wallets
  SET lot_method = p_method
  WHERE treasury_group_id = p_treasury
    AND kind = 'nave_treasury';
  PERFORM public.pay_sync_crypto_books(p_treasury);
  RETURN p_method;
END;
$fn$;

-- Seed asset rows for treasuries that already turned Pay on.
DO $seed$
DECLARE
  treasury uuid;
BEGIN
  FOR treasury IN
    SELECT treasury_group_id FROM public.pay_enablement WHERE enabled
  LOOP
    PERFORM public.pay_ensure_crypto_assets(treasury, '[]'::jsonb);
    PERFORM public.pay_ensure_realized_gain_account(treasury);
  END LOOP;
END
$seed$;

-- ---------------------------------------------------------------------------
-- RLS. Operators read. Writes stay on the functions above.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_crypto_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_disposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_chain_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_piece ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_move ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_moved ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_defer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_done ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_crypto_build_disposal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read crypto assets" ON public.pay_crypto_assets;
CREATE POLICY "Pay operators read crypto assets"
  ON public.pay_crypto_assets FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read crypto events" ON public.pay_crypto_events;
CREATE POLICY "Pay operators read crypto events"
  ON public.pay_crypto_events FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read crypto lots" ON public.pay_crypto_lots;
CREATE POLICY "Pay operators read crypto lots"
  ON public.pay_crypto_lots FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read crypto disposals" ON public.pay_crypto_disposals;
CREATE POLICY "Pay operators read crypto disposals"
  ON public.pay_crypto_disposals FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read crypto chain balances" ON public.pay_crypto_chain_balances;
CREATE POLICY "Pay operators read crypto chain balances"
  ON public.pay_crypto_chain_balances FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_crypto_assets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_lots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_disposals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_chain_balances FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_lot FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_piece FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_move FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_moved FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_defer FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_done FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_crypto_build_disposal FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_crypto_assets TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_crypto_events TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_crypto_lots TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_crypto_disposals TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_crypto_chain_balances TO anon, authenticated;

GRANT ALL ON TABLE public.pay_crypto_assets TO service_role;
GRANT ALL ON TABLE public.pay_crypto_events TO service_role;
GRANT ALL ON TABLE public.pay_crypto_lots TO service_role;
GRANT ALL ON TABLE public.pay_crypto_disposals TO service_role;
GRANT ALL ON TABLE public.pay_crypto_chain_balances TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_state TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_lot TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_piece TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_move TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_moved TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_defer TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_done TO service_role;
GRANT ALL ON TABLE public.pay_crypto_build_disposal TO service_role;

REVOKE ALL ON FUNCTION public.pay_tx_base(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_prorate_cents(bigint, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_par_cents(numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_atomic_from_decimal(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_settlement_asset_matches(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_flow_is_invoice_settlement(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_ensure_realized_gain_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_ensure_one_asset(uuid, text, text, text, text, integer, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_ensure_crypto_assets(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_crypto_add_lot(uuid, uuid, uuid, date, numeric, bigint, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_crypto_consume(uuid, uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_crypto_write_pieces(uuid, uuid, uuid, uuid, text, bigint, numeric, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_crypto_apply_event(uuid, uuid, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_price_crypto_events(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_rebuild_crypto_lots(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_post_crypto_journals(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_sync_crypto_books(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_observe_treasury_flows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_refresh_treasury_activity(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_record_crypto_event(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_classify_crypto_event(uuid, uuid, text, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_set_lot_method(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pay_refresh_treasury_activity(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_record_crypto_event(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_classify_crypto_event(uuid, uuid, text, uuid, text, bigint) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_set_lot_method(uuid, text) TO anon, authenticated, service_role;
