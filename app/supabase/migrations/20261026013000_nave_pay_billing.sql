-- Nave Pay logo, subscription, and a richer public invoice.
-- $49 a month. 3 months are 10% off. 12 months are 25% off.
-- The books stay usable for 7 days after the period ends, then lock.
-- 30 days after the period ends, the books rows are deleted.

ALTER TABLE public.pay_company_settings
  ADD COLUMN IF NOT EXISTS logo_url text NOT NULL DEFAULT '';

ALTER TABLE public.pay_company_settings
  DROP CONSTRAINT IF EXISTS pay_company_settings_logo_len;
ALTER TABLE public.pay_company_settings
  ADD CONSTRAINT pay_company_settings_logo_len CHECK (char_length(logo_url) <= 2000);

CREATE TABLE IF NOT EXISTS public.pay_subscriptions (
  treasury_group_id uuid PRIMARY KEY,
  term_months integer NOT NULL CHECK (term_months IN (1, 3, 12)),
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  period_end timestamptz,
  payer text NOT NULL DEFAULT '',
  chain text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '' CHECK (source IN ('', 'wallet', 'treasury')),
  proposal_index bigint,
  purged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pay_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read subscriptions" ON public.pay_subscriptions;
CREATE POLICY "Pay operators read subscriptions"
  ON public.pay_subscriptions FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON public.pay_subscriptions FROM PUBLIC;
GRANT SELECT ON public.pay_subscriptions TO anon, authenticated;
GRANT ALL ON public.pay_subscriptions TO service_role;

CREATE OR REPLACE FUNCTION public.pay_price_cents(p_term integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_term
    WHEN 1 THEN 4900::bigint
    WHEN 3 THEN 13230::bigint
    WHEN 12 THEN 44100::bigint
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.pay_set_logo(p_treasury_group_id uuid, p_url text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.pay_caller_is_operator(p_treasury_group_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_url IS NULL OR p_url !~ '^https://' OR char_length(p_url) > 2000 THEN
    RAISE EXCEPTION 'invalid_logo' USING ERRCODE = '22023';
  END IF;
  UPDATE public.pay_company_settings
  SET logo_url = p_url
  WHERE treasury_group_id = p_treasury_group_id;
  UPDATE public.dao_registry
  SET logo_url = p_url
  WHERE treasury_group_id = p_treasury_group_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pay_set_logo(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_set_logo(uuid, text) TO anon, authenticated, service_role;

-- Freeze the logo onto the invoice when it is sent.
CREATE OR REPLACE FUNCTION public.pay_freeze_invoice(p_invoice uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
  company public.pay_company_settings%ROWTYPE;
  customer public.pay_customers%ROWTYPE;
  rails jsonb;
BEGIN
  SELECT * INTO inv FROM public.pay_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'draft' THEN
    RETURN;
  END IF;
  SELECT * INTO company FROM public.pay_company_settings WHERE treasury_group_id = inv.treasury_group_id;
  SELECT * INTO customer FROM public.pay_customers WHERE id = inv.customer_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'chain', chain,
    'chain_id', chain_id,
    'address', address,
    'dao_onchain_address', dao_onchain_address
  ) ORDER BY chain, chain_id), '[]'::jsonb)
  INTO rails
  FROM public.pay_wallet_addresses
  WHERE treasury_group_id = inv.treasury_group_id;

  UPDATE public.pay_invoices SET
    status = 'sent',
    sent_at = coalesce(sent_at, now()),
    company_snapshot = jsonb_build_object(
      'legal_name', company.legal_name,
      'address', company.address,
      'ein', company.ein,
      'email', company.email,
      'logo_url', company.logo_url
    ),
    customer_snapshot = jsonb_build_object(
      'name', customer.name,
      'contact', customer.contact,
      'email', customer.email,
      'phone', customer.phone,
      'address', customer.address,
      'tax_id', customer.tax_id
    ),
    rails_snapshot = jsonb_build_object(
      'wire_instructions', company.wire_instructions,
      'ach_instructions', company.ach_instructions,
      'reference_code', inv.reference_code,
      'treasury_addresses', rails
    ),
    updated_at = now()
  WHERE id = p_invoice;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_purge_treasury(p_group uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  pass integer;
  progress boolean;
BEGIN
  FOR pass IN 1..8 LOOP
    progress := false;
    FOR r IN
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'treasury_group_id'
        AND c.table_name LIKE 'pay\_%' ESCAPE '\'
        AND c.table_name NOT IN ('pay_subscriptions', 'pay_enablement')
        AND t.table_type = 'BASE TABLE'
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE treasury_group_id = $1', r.table_name) USING p_group;
        progress := true;
      EXCEPTION
        WHEN foreign_key_violation THEN
          NULL;
      END;
    END LOOP;
    EXIT WHEN NOT progress;
  END LOOP;
  DELETE FROM public.pay_enablement WHERE treasury_group_id = p_group;
  UPDATE public.pay_subscriptions
  SET purged_at = now(), updated_at = now()
  WHERE treasury_group_id = p_group;
END;
$$;

REVOKE ALL ON FUNCTION public.pay_purge_treasury(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_purge_treasury(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pay_subscription_status(p_treasury_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row public.pay_subscriptions%ROWTYPE;
  state text := 'none';
  usable boolean := false;
BEGIN
  IF NOT public.pay_caller_is_operator(p_treasury_group_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO row FROM public.pay_subscriptions WHERE treasury_group_id = p_treasury_group_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'none', 'usable', false, 'period_end', null, 'term_months', null, 'price_cents', null);
  END IF;
  IF row.purged_at IS NOT NULL THEN
    state := 'purged';
  ELSIF row.period_end IS NULL THEN
    state := 'none';
  ELSIF now() < row.period_end THEN
    state := 'active';
    usable := true;
  ELSIF now() < row.period_end + interval '7 days' THEN
    state := 'grace';
    usable := true;
  ELSIF now() < row.period_end + interval '30 days' THEN
    state := 'locked';
  ELSE
    PERFORM public.pay_purge_treasury(p_treasury_group_id);
    state := 'purged';
  END IF;
  RETURN jsonb_build_object(
    'state', state,
    'usable', usable,
    'period_end', row.period_end,
    'term_months', row.term_months,
    'price_cents', row.price_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pay_subscription_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_subscription_status(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pay_activate_subscription(
  p_treasury_group_id uuid,
  p_term integer,
  p_tx_hash text,
  p_chain text,
  p_payer text,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  price bigint;
  start_at timestamptz;
  existing public.pay_subscriptions%ROWTYPE;
BEGIN
  price := public.pay_price_cents(p_term);
  IF price IS NULL THEN
    RAISE EXCEPTION 'invalid_term' USING ERRCODE = '22023';
  END IF;
  IF p_source = 'wallet' AND coalesce(current_setting('request.jwt.claim.role', true), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_source = 'treasury' AND NOT public.pay_caller_is_operator(p_treasury_group_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('wallet', 'treasury') THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
  END IF;
  IF p_tx_hash IS NULL OR char_length(btrim(p_tx_hash)) < 8 THEN
    RAISE EXCEPTION 'invalid_tx' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO existing FROM public.pay_subscriptions WHERE treasury_group_id = p_treasury_group_id;
  IF existing.tx_hash = btrim(p_tx_hash) AND existing.period_end IS NOT NULL THEN
    RETURN jsonb_build_object('period_end', existing.period_end, 'price_cents', existing.price_cents, 'replay', true);
  END IF;

  start_at := now();
  IF existing.period_end IS NOT NULL AND existing.period_end > start_at AND existing.purged_at IS NULL THEN
    start_at := existing.period_end;
  END IF;

  INSERT INTO public.pay_subscriptions (
    treasury_group_id, term_months, price_cents, period_end, payer, chain, tx_hash, source, purged_at, updated_at
  ) VALUES (
    p_treasury_group_id, p_term, price, start_at + make_interval(months => p_term),
    coalesce(p_payer, ''), coalesce(p_chain, ''), btrim(p_tx_hash), p_source, NULL, now()
  )
  ON CONFLICT (treasury_group_id) DO UPDATE SET
    term_months = EXCLUDED.term_months,
    price_cents = EXCLUDED.price_cents,
    period_end = EXCLUDED.period_end,
    payer = EXCLUDED.payer,
    chain = EXCLUDED.chain,
    tx_hash = EXCLUDED.tx_hash,
    source = EXCLUDED.source,
    purged_at = NULL,
    updated_at = now();

  RETURN jsonb_build_object('period_end', start_at + make_interval(months => p_term), 'price_cents', price, 'replay', false);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_activate_subscription(uuid, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_activate_subscription(uuid, integer, text, text, text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pay_public_invoice(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
  paid bigint;
  balance bigint;
  display text;
  days integer := 0;
  company_name text;
  logo text;
  addresses jsonb;
  items jsonb;
  today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_token IS NULL OR char_length(p_token) < 32 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO inv FROM public.pay_invoices WHERE public_token = p_token;
  IF NOT FOUND OR inv.status = 'draft' THEN
    RETURN NULL;
  END IF;
  paid := public.pay_paid_cents(inv.id);
  IF inv.status = 'void' THEN
    display := 'void';
    balance := 0;
  ELSIF inv.total_cents - paid <= 0 THEN
    display := 'paid';
    balance := 0;
  ELSIF inv.due_date < today THEN
    display := 'overdue';
    balance := inv.total_cents - paid;
    days := today - inv.due_date;
  ELSIF paid > 0 THEN
    display := 'partial';
    balance := inv.total_cents - paid;
  ELSE
    display := 'open';
    balance := inv.total_cents - paid;
  END IF;

  company_name := nullif(inv.company_snapshot->>'legal_name', '');
  logo := nullif(inv.company_snapshot->>'logo_url', '');
  IF company_name IS NULL OR logo IS NULL THEN
    SELECT coalesce(company_name, s.legal_name), coalesce(logo, nullif(s.logo_url, ''))
    INTO company_name, logo
    FROM public.pay_company_settings s
    WHERE s.treasury_group_id = inv.treasury_group_id;
  END IF;

  SELECT coalesce(jsonb_agg(item ORDER BY item->>'chain', item->>'asset'), '[]'::jsonb)
  INTO addresses
  FROM (
    SELECT jsonb_build_object(
      'chain', a.chain,
      'chain_id', a.chain_id,
      'asset', a.asset,
      'address', a.address,
      'unique', true
    ) AS item
    FROM public.pay_invoice_addresses a
    WHERE a.invoice_id = inv.id
    UNION ALL
    SELECT jsonb_build_object(
      'chain', w.chain,
      'chain_id', w.chain_id,
      'asset', 'treasury',
      'address', w.address,
      'unique', false
    )
    FROM public.pay_wallet_addresses w
    WHERE w.treasury_group_id = inv.treasury_group_id
      AND NOT EXISTS (
        SELECT 1 FROM public.pay_invoice_addresses a
        WHERE a.invoice_id = inv.id AND a.chain = w.chain
      )
  ) rows;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'description', description,
    'amount_cents', amount_cents
  ) ORDER BY position), '[]'::jsonb)
  INTO items
  FROM public.pay_invoice_items
  WHERE invoice_id = inv.id;

  RETURN jsonb_build_object(
    'company_name', coalesce(company_name, 'Invoice'),
    'logo_url', coalesce(logo, ''),
    'number', inv.number,
    'amount_due_cents', balance,
    'total_cents', inv.total_cents,
    'currency', inv.currency,
    'status', display,
    'days_overdue', days,
    'reference', inv.reference_code,
    'due_date', inv.due_date,
    'addresses', addresses,
    'items', items
  );
END;
$fn$;
