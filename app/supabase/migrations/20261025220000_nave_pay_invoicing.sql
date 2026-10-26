-- Nave Pay invoicing and settlement booking.
--
-- Tenant is treasury_group_id. Operators are the same wallets as the books
-- migration: x-wallet-address matches creator_wallet or dao_authorized_wallets.
-- Token holders are not operators and have no SELECT policy on these tables.
--
-- Writes go through SECURITY DEFINER functions, matching pay_enable_treasury.
-- The public invoice route uses pay_public_invoice, which returns only the
-- company display name, amount due, payable addresses, reference, and status.
--
-- Invoice totals are recomputed here. Client amounts are ignored. Discount is
-- applied before tax. Journals for one treasury are rewritten in the same
-- transaction as the document write. There is no stored balance column.
--
-- activity_logs is the treasury feed. Its rows are publicly readable for
-- non-private treasuries and its tx_signature key belongs to the indexer.
-- Invoice amounts stay in pay_activity so token holders do not read the books.

-- ---------------------------------------------------------------------------
-- Company rails and invoice defaults
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_company_settings
  ADD COLUMN IF NOT EXISTS wire_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ach_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invoice_prefix text NOT NULL DEFAULT 'INV-',
  ADD COLUMN IF NOT EXISTS invoice_next_number integer NOT NULL DEFAULT 1001,
  ADD COLUMN IF NOT EXISTS invoice_terms_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS default_notes text NOT NULL DEFAULT 'Thank you for your business.',
  ADD COLUMN IF NOT EXISTS default_terms text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';

ALTER TABLE public.pay_company_settings
  DROP CONSTRAINT IF EXISTS pay_company_settings_wire_len;
ALTER TABLE public.pay_company_settings
  ADD CONSTRAINT pay_company_settings_wire_len CHECK (char_length(wire_instructions) <= 4000);

ALTER TABLE public.pay_company_settings
  DROP CONSTRAINT IF EXISTS pay_company_settings_ach_len;
ALTER TABLE public.pay_company_settings
  ADD CONSTRAINT pay_company_settings_ach_len CHECK (char_length(ach_instructions) <= 4000);

ALTER TABLE public.pay_company_settings
  DROP CONSTRAINT IF EXISTS pay_company_settings_prefix_len;
ALTER TABLE public.pay_company_settings
  ADD CONSTRAINT pay_company_settings_prefix_len CHECK (char_length(invoice_prefix) BETWEEN 1 AND 12);

ALTER TABLE public.pay_company_settings
  DROP CONSTRAINT IF EXISTS pay_company_settings_next_number;
ALTER TABLE public.pay_company_settings
  ADD CONSTRAINT pay_company_settings_next_number CHECK (invoice_next_number >= 1);

ALTER TABLE public.pay_company_settings
  DROP CONSTRAINT IF EXISTS pay_company_settings_terms_days;
ALTER TABLE public.pay_company_settings
  ADD CONSTRAINT pay_company_settings_terms_days CHECK (invoice_terms_days BETWEEN 0 AND 3650);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  name text NOT NULL,
  contact text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  tax_id text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_customers_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS pay_customers_group_idx
  ON public.pay_customers (treasury_group_id, archived, name);

CREATE TABLE IF NOT EXISTS public.pay_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.pay_customers (id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'void')),
  issue_date date NOT NULL,
  due_date date NOT NULL,
  po_number text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'USD',
  tax_label text NOT NULL DEFAULT 'Tax',
  tax_rate_e3 integer NOT NULL DEFAULT 0,
  discount_cents bigint NOT NULL DEFAULT 0,
  subtotal_cents bigint NOT NULL DEFAULT 0,
  taxable_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  terms text NOT NULL DEFAULT '',
  footer text NOT NULL DEFAULT '',
  company_snapshot jsonb,
  customer_snapshot jsonb,
  rails_snapshot jsonb,
  public_token text NOT NULL,
  reference_code text NOT NULL,
  invoice_id_hex text NOT NULL,
  sent_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_invoices_number_unique UNIQUE (treasury_group_id, number),
  CONSTRAINT pay_invoices_token_unique UNIQUE (public_token),
  CONSTRAINT pay_invoices_reference_unique UNIQUE (treasury_group_id, reference_code),
  CONSTRAINT pay_invoices_id_hex_unique UNIQUE (invoice_id_hex),
  CONSTRAINT pay_invoices_due CHECK (due_date >= issue_date),
  CONSTRAINT pay_invoices_money CHECK (
    discount_cents >= 0 AND tax_cents >= 0 AND total_cents >= 0 AND tax_rate_e3 BETWEEN 0 AND 100000
  ),
  CONSTRAINT pay_invoices_token_len CHECK (char_length(public_token) >= 32),
  CONSTRAINT pay_invoices_id_hex CHECK (invoice_id_hex ~ '^[0-9a-f]{64}$')
);

COMMENT ON COLUMN public.pay_invoices.taxable_cents IS
  'Tax base after the discount is allocated to taxable lines. Matches nave-books taxable_cents.';

COMMENT ON COLUMN public.pay_invoices.public_token IS
  'Unguessable customer link token. Not a books identifier for operators.';

CREATE INDEX IF NOT EXISTS pay_invoices_group_idx
  ON public.pay_invoices (treasury_group_id, issue_date DESC);

CREATE TABLE IF NOT EXISTS public.pay_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.pay_invoices (id) ON DELETE CASCADE,
  position integer NOT NULL,
  description text NOT NULL DEFAULT '',
  qty_e4 bigint NOT NULL,
  rate_cents bigint NOT NULL,
  taxable boolean NOT NULL DEFAULT false,
  amount_cents bigint NOT NULL,
  CONSTRAINT pay_invoice_items_position_unique UNIQUE (invoice_id, position)
);

CREATE INDEX IF NOT EXISTS pay_invoice_items_invoice_idx
  ON public.pay_invoice_items (invoice_id, position);

CREATE TABLE IF NOT EXISTS public.pay_invoice_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.pay_invoices (id) ON DELETE CASCADE,
  chain text NOT NULL,
  chain_id bigint,
  asset text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('solana_vault', 'solana_ata', 'evm_forwarder')),
  address text NOT NULL,
  dao_onchain_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_invoice_addresses_unique UNIQUE (invoice_id, chain, asset)
);

COMMENT ON TABLE public.pay_invoice_addresses IS
  'Derived payment addresses only. A chain with no router has no evm_forwarder row. The canonical treasury address is not stored here.';

CREATE INDEX IF NOT EXISTS pay_invoice_addresses_lookup_idx
  ON public.pay_invoice_addresses (treasury_group_id, kind);

CREATE TABLE IF NOT EXISTS public.pay_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.pay_invoices (id),
  paid_on date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  cash_account_id uuid REFERENCES public.pay_accounts (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pay_payments_invoice_idx
  ON public.pay_payments (invoice_id, paid_on);

CREATE TABLE IF NOT EXISTS public.pay_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.pay_invoices (id) ON DELETE CASCADE,
  chain text NOT NULL,
  tx_hash text NOT NULL,
  asset text NOT NULL,
  raw_amount text NOT NULL,
  decimals integer,
  price_usd numeric,
  quoted_cents bigint NOT NULL DEFAULT 0,
  applied_cents bigint NOT NULL DEFAULT 0,
  excess_cents bigint NOT NULL DEFAULT 0,
  excess_note text NOT NULL DEFAULT '',
  usd_booked boolean NOT NULL DEFAULT false,
  payment_id uuid REFERENCES public.pay_payments (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_settlements_idem UNIQUE (chain, tx_hash, invoice_id, asset)
);

COMMENT ON TABLE public.pay_settlements IS
  'One chain settlement. Idempotent on (chain, tx hash, invoice, asset). Excess above the open balance is an unclassified note, not an overpayment.';

CREATE TABLE IF NOT EXISTS public.pay_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  memo text NOT NULL DEFAULT '',
  ref text NOT NULL DEFAULT '',
  party text NOT NULL DEFAULT '',
  source_type text NOT NULL CHECK (source_type IN ('invoice', 'payment')),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_journal_entries_source UNIQUE (treasury_group_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS pay_journal_entries_date_idx
  ON public.pay_journal_entries (treasury_group_id, entry_date);

CREATE TABLE IF NOT EXISTS public.pay_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.pay_journal_entries (id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  account_id uuid NOT NULL REFERENCES public.pay_accounts (id),
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo text NOT NULL DEFAULT '',
  CONSTRAINT pay_journal_lines_one_side CHECK ((debit_cents = 0) <> (credit_cents = 0)),
  CONSTRAINT pay_journal_lines_entry_no UNIQUE (entry_id, line_no)
);

CREATE INDEX IF NOT EXISTS pay_journal_lines_account_idx
  ON public.pay_journal_lines (account_id);

CREATE TABLE IF NOT EXISTS public.pay_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  kind text NOT NULL,
  summary text NOT NULL,
  invoice_id uuid REFERENCES public.pay_invoices (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_activity IS
  'Pay home activity. Kept out of activity_logs so token holders do not read invoice amounts and the indexer dedup key is left alone.';

CREATE INDEX IF NOT EXISTS pay_activity_group_idx
  ON public.pay_activity (treasury_group_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Integer money, matching nave-books
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_muldiv_round(a bigint, b bigint, c bigint)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
BEGIN
  IF c <= 0 THEN
    RAISE EXCEPTION 'bad_divisor' USING ERRCODE = '22023';
  END IF;
  IF a = 0 OR b = 0 THEN
    RETURN 0;
  END IF;
  RETURN (
    sign(a::numeric) * sign(b::numeric) * round(abs(a::numeric) * abs(b::numeric) / c::numeric)
  )::bigint;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_money_cents(raw text, allow_neg boolean)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  s text;
  neg boolean := false;
  whole text;
  frac text;
  cents bigint;
BEGIN
  s := replace(replace(replace(btrim(coalesce(raw, '')), ',', ''), '$', ''), ' ', '');
  IF s = '' THEN
    s := '0';
  END IF;
  IF s !~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  IF left(s, 1) = '-' THEN
    IF NOT allow_neg THEN
      RAISE EXCEPTION 'amount_negative' USING ERRCODE = '22023';
    END IF;
    neg := true;
    s := substr(s, 2);
  END IF;
  whole := split_part(s, '.', 1);
  frac := rpad(split_part(s, '.', 2), 2, '0');
  cents := whole::bigint * 100 + frac::bigint;
  IF neg THEN
    cents := -cents;
  END IF;
  RETURN cents;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_qty_e4(raw text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  s text;
  neg boolean := false;
  whole text;
  frac text;
  qty bigint;
BEGIN
  s := replace(replace(btrim(coalesce(raw, '')), ',', ''), ' ', '');
  IF s = '' THEN
    s := '0';
  END IF;
  IF s !~ '^-?[0-9]{1,9}(\.[0-9]{1,4})?$' THEN
    RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = '22023';
  END IF;
  IF left(s, 1) = '-' THEN
    neg := true;
    s := substr(s, 2);
  END IF;
  whole := split_part(s, '.', 1);
  frac := rpad(split_part(s, '.', 2), 4, '0');
  qty := whole::bigint * 10000 + frac::bigint;
  IF neg THEN
    qty := -qty;
  END IF;
  RETURN qty;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_rate_e3(raw text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  s text;
  whole text;
  frac text;
  rate integer;
BEGIN
  s := btrim(coalesce(raw, ''));
  IF s = '' THEN
    RETURN 0;
  END IF;
  s := rtrim(s, '% ');
  IF s !~ '^[0-9]{1,3}(\.[0-9]{1,3})?$' THEN
    RAISE EXCEPTION 'invalid_rate' USING ERRCODE = '22023';
  END IF;
  whole := split_part(s, '.', 1);
  frac := rpad(split_part(s, '.', 2), 3, '0');
  rate := whole::integer * 1000 + frac::integer;
  IF rate > 100000 THEN
    RAISE EXCEPTION 'rate_over_100' USING ERRCODE = '22023';
  END IF;
  RETURN rate;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_compute_invoice(p_items jsonb, p_discount text, p_rate text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  item jsonb;
  description text;
  qty bigint;
  rate bigint;
  amount bigint;
  taxable boolean;
  subtotal bigint := 0;
  taxable_sum bigint := 0;
  discount bigint;
  rate_e3 integer;
  tax_discount bigint := 0;
  tax_base bigint;
  tax bigint;
  total bigint;
  lines jsonb := '[]'::jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items_required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'too_many_lines' USING ERRCODE = '22023';
  END IF;
  discount := public.pay_money_cents(p_discount, false);
  rate_e3 := public.pay_rate_e3(p_rate);
  FOR item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    description := left(btrim(coalesce(item->>'description', '')), 4000);
    qty := public.pay_qty_e4(coalesce(item->>'qty', '1'));
    rate := public.pay_money_cents(coalesce(item->>'rate', '0'), true);
    IF abs(qty) > 10000000000 THEN
      RAISE EXCEPTION 'qty_too_large' USING ERRCODE = '22023';
    END IF;
    amount := public.pay_muldiv_round(qty, rate, 10000);
    IF description = '' AND amount = 0 THEN
      CONTINUE;
    END IF;
    taxable := lower(coalesce(item->>'taxable', 'false')) IN ('true', 't', '1');
    subtotal := subtotal + amount;
    IF taxable THEN
      taxable_sum := taxable_sum + amount;
    END IF;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'description', description,
      'qty_e4', qty,
      'rate_cents', rate,
      'taxable', taxable,
      'amount_cents', amount
    ));
  END LOOP;
  IF jsonb_array_length(lines) = 0 THEN
    RAISE EXCEPTION 'lines_required' USING ERRCODE = '22023';
  END IF;
  IF discount > 0 AND discount > subtotal THEN
    RAISE EXCEPTION 'discount_exceeds_subtotal' USING ERRCODE = '22023';
  END IF;
  IF subtotal > 0 AND taxable_sum > 0 THEN
    tax_discount := public.pay_muldiv_round(discount, taxable_sum, subtotal);
  END IF;
  tax_base := greatest(0, taxable_sum - tax_discount);
  tax := public.pay_muldiv_round(tax_base, rate_e3::bigint, 100000);
  total := subtotal - discount + tax;
  IF total < 0 THEN
    RAISE EXCEPTION 'total_negative' USING ERRCODE = '22023';
  END IF;
  IF total > 9999999999999 THEN
    RAISE EXCEPTION 'total_too_large' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object(
    'lines', lines,
    'subtotal_cents', subtotal,
    'taxable_cents', taxable_sum,
    'tax_base_cents', tax_base,
    'tax_cents', tax,
    'discount_cents', discount,
    'tax_rate_e3', rate_e3,
    'total_cents', total
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Journals for one treasury. Called inside the document transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_account_id(p_treasury uuid, p_code text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT id
  FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury
    AND code = p_code
    AND archived = false
  LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_sync_journals(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ar_id uuid;
  revenue_id uuid;
  discount_id uuid;
  tax_id uuid;
  digital_id uuid;
  cash_id uuid;
  inv record;
  pay record;
  entry uuid;
  line_no integer;
  debit bigint;
  credit bigint;
  cash uuid;
  party text;
BEGIN
  ar_id := public.pay_account_id(p_treasury, '1100');
  revenue_id := public.pay_account_id(p_treasury, '4000');
  discount_id := public.pay_account_id(p_treasury, '4090');
  tax_id := public.pay_account_id(p_treasury, '2300');
  digital_id := public.pay_account_id(p_treasury, '1200');
  cash_id := public.pay_account_id(p_treasury, '1000');
  IF ar_id IS NULL OR revenue_id IS NULL OR digital_id IS NULL THEN
    RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.pay_journal_entries
  WHERE treasury_group_id = p_treasury
    AND source_type IN ('invoice', 'payment');

  FOR inv IN
    SELECT i.*, c.name AS customer_name
    FROM public.pay_invoices i
    JOIN public.pay_customers c ON c.id = i.customer_id
    WHERE i.treasury_group_id = p_treasury
      AND i.status = 'sent'
  LOOP
    debit := 0;
    credit := 0;
    line_no := 0;
    party := coalesce(inv.customer_snapshot->>'name', inv.customer_name, '');
    INSERT INTO public.pay_journal_entries (
      treasury_group_id, entry_date, memo, ref, party, source_type, source_id
    ) VALUES (
      p_treasury, inv.issue_date, 'Invoice ' || inv.number, inv.number, party, 'invoice', inv.id
    ) RETURNING id INTO entry;

    IF inv.total_cents > 0 THEN
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents)
      VALUES (p_treasury, entry, line_no, ar_id, inv.total_cents, 0);
      debit := debit + inv.total_cents;
      line_no := line_no + 1;
    ELSIF inv.total_cents < 0 THEN
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents)
      VALUES (p_treasury, entry, line_no, ar_id, 0, -inv.total_cents);
      credit := credit + (-inv.total_cents);
      line_no := line_no + 1;
    END IF;

    IF inv.subtotal_cents > 0 THEN
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents)
      VALUES (p_treasury, entry, line_no, revenue_id, 0, inv.subtotal_cents);
      credit := credit + inv.subtotal_cents;
      line_no := line_no + 1;
    ELSIF inv.subtotal_cents < 0 THEN
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents)
      VALUES (p_treasury, entry, line_no, revenue_id, -inv.subtotal_cents, 0);
      debit := debit + (-inv.subtotal_cents);
      line_no := line_no + 1;
    END IF;

    IF inv.discount_cents > 0 THEN
      IF discount_id IS NULL THEN
        RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
      END IF;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (p_treasury, entry, line_no, discount_id, inv.discount_cents, 0, 'Discount');
      debit := debit + inv.discount_cents;
      line_no := line_no + 1;
    END IF;

    IF inv.tax_cents > 0 THEN
      IF tax_id IS NULL THEN
        RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
      END IF;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (p_treasury, entry, line_no, tax_id, 0, inv.tax_cents, coalesce(nullif(inv.tax_label, ''), 'Sales tax'));
      credit := credit + inv.tax_cents;
      line_no := line_no + 1;
    END IF;

    IF line_no = 0 THEN
      DELETE FROM public.pay_journal_entries WHERE id = entry;
    ELSIF debit <> credit THEN
      RAISE EXCEPTION 'journal_unbalanced' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR pay IN
    SELECT p.*, i.number, c.name AS customer_name
    FROM public.pay_payments p
    JOIN public.pay_invoices i ON i.id = p.invoice_id
    JOIN public.pay_customers c ON c.id = i.customer_id
    WHERE p.treasury_group_id = p_treasury
  LOOP
    cash := pay.cash_account_id;
    IF cash IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.pay_accounts a
      WHERE a.id = cash
        AND a.treasury_group_id = p_treasury
        AND a.account_type IN ('asset', 'liability')
        AND a.archived = false
    ) THEN
      cash := NULL;
    END IF;
    IF cash IS NULL THEN
      IF lower(pay.method) IN ('crypto', 'usdc', 'sol', 'solana', 'eth', 'ethereum')
         OR pay.method ILIKE '%usdc%'
         OR pay.method ILIKE '%crypto%' THEN
        cash := digital_id;
      ELSE
        cash := coalesce(cash_id, digital_id);
      END IF;
    END IF;
    INSERT INTO public.pay_journal_entries (
      treasury_group_id, entry_date, memo, ref, party, source_type, source_id
    ) VALUES (
      p_treasury,
      pay.paid_on,
      'Payment ' || pay.number || CASE WHEN pay.method <> '' THEN ' · ' || pay.method ELSE '' END,
      coalesce(nullif(pay.reference, ''), pay.number),
      pay.customer_name,
      'payment',
      pay.id
    ) RETURNING id INTO entry;
    INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents)
    VALUES
      (p_treasury, entry, 0, cash, pay.amount_cents, 0),
      (p_treasury, entry, 1, ar_id, 0, pay.amount_cents);
  END LOOP;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Shared invoice helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_require_operator(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.pay_caller_is_operator(p_treasury) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pay_enablement WHERE treasury_group_id = p_treasury AND enabled) THEN
    RAISE EXCEPTION 'pay_not_enabled' USING ERRCODE = 'P0002';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_date_in(raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  d date;
BEGIN
  IF btrim(coalesce(raw, '')) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE = '22023';
  END IF;
  d := btrim(raw)::date;
  IF to_char(d, 'YYYY-MM-DD') IS DISTINCT FROM btrim(raw) THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE = '22023';
  END IF;
  RETURN d;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_random_token()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public, extensions
AS $fn$
  SELECT encode(extensions.gen_random_bytes(32), 'hex');
$fn$;

CREATE OR REPLACE FUNCTION public.pay_store_addresses(p_invoice uuid, p_treasury uuid, p_addresses jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  row jsonb;
  chain text;
  kind text;
  asset text;
  address text;
  dao text;
  chain_id bigint;
BEGIN
  IF p_addresses IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_addresses) <> 'array' OR jsonb_array_length(p_addresses) > 24 THEN
    RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.pay_invoice_addresses WHERE invoice_id = p_invoice;
  FOR row IN SELECT value FROM jsonb_array_elements(p_addresses)
  LOOP
    chain := row->>'chain';
    kind := row->>'kind';
    asset := btrim(coalesce(row->>'asset', ''));
    address := btrim(coalesce(row->>'address', ''));
    dao := btrim(coalesce(row->>'dao_onchain_address', ''));
    IF chain NOT IN ('solana', 'ethereum', 'base', 'robinhood', 'arc') THEN
      RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
    END IF;
    IF kind NOT IN ('solana_vault', 'solana_ata', 'evm_forwarder') THEN
      RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
    END IF;
    IF chain = 'solana' THEN
      chain_id := NULL;
      IF kind = 'evm_forwarder' OR address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' OR dao !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
        RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
      END IF;
      IF kind = 'solana_vault' AND asset <> 'native' THEN
        RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
      END IF;
      IF kind = 'solana_ata' AND asset !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
        RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF kind <> 'evm_forwarder' THEN
        RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
      END IF;
      chain_id := NULLIF(row->>'chain_id', '')::bigint;
      address := lower(address);
      dao := lower(dao);
      asset := lower(asset);
      IF chain_id IS NULL OR address !~ '^0x[0-9a-f]{40}$' OR dao !~ '^0x[0-9a-f]{40}$' OR asset !~ '^0x[0-9a-f]{40}$' THEN
        RAISE EXCEPTION 'invalid_addresses' USING ERRCODE = '22023';
      END IF;
    END IF;
    INSERT INTO public.pay_invoice_addresses (
      treasury_group_id, invoice_id, chain, chain_id, asset, kind, address, dao_onchain_address
    ) VALUES (
      p_treasury, p_invoice, chain, chain_id, asset, kind, address, dao
    );
  END LOOP;
END;
$fn$;

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
      'email', company.email
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

CREATE OR REPLACE FUNCTION public.pay_paid_cents(p_invoice uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT coalesce(sum(amount_cents), 0)::bigint
  FROM public.pay_payments
  WHERE invoice_id = p_invoice;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_activity_add(
  p_treasury uuid,
  p_kind text,
  p_summary text,
  p_invoice uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  INSERT INTO public.pay_activity (treasury_group_id, kind, summary, invoice_id)
  VALUES (p_treasury, left(p_kind, 40), left(p_summary, 500), p_invoice);
$fn$;

-- ---------------------------------------------------------------------------
-- Customers and company rails
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_save_customer(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  cid uuid;
  name text;
  email text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  name := left(btrim(coalesce(p_body->>'name', '')), 200);
  IF name = '' THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  email := left(btrim(coalesce(p_body->>'email', '')), 200);
  IF email <> '' AND email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = '22023';
  END IF;
  cid := NULLIF(p_body->>'id', '')::uuid;
  IF cid IS NULL THEN
    INSERT INTO public.pay_customers (
      treasury_group_id, name, contact, email, phone, address, tax_id, notes, archived
    ) VALUES (
      p_treasury,
      name,
      left(btrim(coalesce(p_body->>'contact', '')), 200),
      email,
      left(btrim(coalesce(p_body->>'phone', '')), 60),
      left(btrim(coalesce(p_body->>'address', '')), 1000),
      left(btrim(coalesce(p_body->>'tax_id', '')), 60),
      left(btrim(coalesce(p_body->>'notes', '')), 4000),
      coalesce((p_body->>'archived')::boolean, false)
    ) RETURNING id INTO cid;
  ELSE
    UPDATE public.pay_customers SET
      name = name,
      contact = left(btrim(coalesce(p_body->>'contact', '')), 200),
      email = email,
      phone = left(btrim(coalesce(p_body->>'phone', '')), 60),
      address = left(btrim(coalesce(p_body->>'address', '')), 1000),
      tax_id = left(btrim(coalesce(p_body->>'tax_id', '')), 60),
      notes = left(btrim(coalesce(p_body->>'notes', '')), 4000),
      archived = coalesce((p_body->>'archived')::boolean, archived),
      updated_at = now()
    WHERE id = cid
      AND treasury_group_id = p_treasury;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN cid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_update_company_settings(
  p_treasury uuid,
  p_wire text,
  p_ach text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  UPDATE public.pay_company_settings SET
    wire_instructions = left(coalesce(p_wire, ''), 4000),
    ach_instructions = left(coalesce(p_ach, ''), 4000),
    updated_at = now()
  WHERE treasury_group_id = p_treasury;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_allocate_number(p_treasury uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  prefix text;
  n integer;
  candidate text;
BEGIN
  SELECT invoice_prefix, invoice_next_number
  INTO prefix, n
  FROM public.pay_company_settings
  WHERE treasury_group_id = p_treasury
  FOR UPDATE;
  IF n IS NULL THEN
    RAISE EXCEPTION 'pay_not_enabled' USING ERRCODE = 'P0002';
  END IF;
  LOOP
    candidate := prefix || n::text;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.pay_invoices
      WHERE treasury_group_id = p_treasury AND number = candidate
    );
    n := n + 1;
    IF n > 100000000 THEN
      RAISE EXCEPTION 'invoice_number_exhausted' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  UPDATE public.pay_company_settings
  SET invoice_next_number = n + 1, updated_at = now()
  WHERE treasury_group_id = p_treasury;
  RETURN candidate;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_new_reference(p_treasury uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  ref text;
  tries integer := 0;
BEGIN
  LOOP
    ref := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 8));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.pay_invoices
      WHERE treasury_group_id = p_treasury AND reference_code = ref
    );
    tries := tries + 1;
    IF tries > 8 THEN
      RAISE EXCEPTION 'reference_exhausted' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN ref;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_replace_items(p_invoice uuid, p_treasury uuid, p_lines jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  line jsonb;
  pos integer := 0;
BEGIN
  DELETE FROM public.pay_invoice_items WHERE invoice_id = p_invoice;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    INSERT INTO public.pay_invoice_items (
      treasury_group_id, invoice_id, position, description, qty_e4, rate_cents, taxable, amount_cents
    ) VALUES (
      p_treasury,
      p_invoice,
      pos,
      line->>'description',
      (line->>'qty_e4')::bigint,
      (line->>'rate_cents')::bigint,
      (line->>'taxable')::boolean,
      (line->>'amount_cents')::bigint
    );
    pos := pos + 1;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_save_invoice(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  calc jsonb;
  iid uuid;
  cid uuid;
  issue date;
  due date;
  num text;
  hex text;
  existing public.pay_invoices%ROWTYPE;
  paid bigint;
  token text;
  ref text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  cid := NULLIF(p_body->>'customer_id', '')::uuid;
  IF cid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.pay_customers
    WHERE id = cid AND treasury_group_id = p_treasury AND archived = false
  ) THEN
    IF cid IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.pay_customers WHERE id = cid AND treasury_group_id = p_treasury
    ) THEN
      RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  issue := public.pay_date_in(p_body->>'issue_date');
  due := public.pay_date_in(p_body->>'due_date');
  IF due < issue THEN
    RAISE EXCEPTION 'due_before_issue' USING ERRCODE = '22023';
  END IF;
  calc := public.pay_compute_invoice(
    coalesce(p_body->'items', '[]'::jsonb),
    coalesce(p_body->>'discount', '0'),
    coalesce(p_body->>'tax_rate', '0')
  );
  iid := NULLIF(p_body->>'id', '')::uuid;
  IF iid IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.pay_customers
      WHERE id = cid AND treasury_group_id = p_treasury AND archived = true
    ) THEN
      RAISE EXCEPTION 'customer_archived' USING ERRCODE = '22023';
    END IF;
    num := left(btrim(coalesce(p_body->>'number', '')), 60);
    IF num = '' THEN
      num := public.pay_allocate_number(p_treasury);
    ELSIF EXISTS (
      SELECT 1 FROM public.pay_invoices WHERE treasury_group_id = p_treasury AND number = num
    ) THEN
      RAISE EXCEPTION 'invoice_number_taken' USING ERRCODE = '23505';
    END IF;
    hex := lower(coalesce(p_body->>'invoice_id_hex', ''));
    IF hex = '' THEN
      hex := encode(extensions.gen_random_bytes(32), 'hex');
    END IF;
    IF hex !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid_invoice_id' USING ERRCODE = '22023';
    END IF;
    token := public.pay_random_token();
    ref := public.pay_new_reference(p_treasury);
    INSERT INTO public.pay_invoices (
      treasury_group_id, customer_id, number, status, issue_date, due_date, po_number,
      tax_label, tax_rate_e3, discount_cents, subtotal_cents, taxable_cents, tax_cents, total_cents,
      notes, terms, footer, public_token, reference_code, invoice_id_hex
    ) VALUES (
      p_treasury, cid, num, 'draft', issue, due,
      left(btrim(coalesce(p_body->>'po_number', '')), 100),
      coalesce(nullif(left(btrim(coalesce(p_body->>'tax_label', '')), 40), ''), 'Tax'),
      (calc->>'tax_rate_e3')::integer,
      (calc->>'discount_cents')::bigint,
      (calc->>'subtotal_cents')::bigint,
      (calc->>'tax_base_cents')::bigint,
      (calc->>'tax_cents')::bigint,
      (calc->>'total_cents')::bigint,
      left(btrim(coalesce(p_body->>'notes', '')), 4000),
      left(btrim(coalesce(p_body->>'terms', '')), 4000),
      left(btrim(coalesce(p_body->>'footer', '')), 1000),
      token, ref, hex
    ) RETURNING id INTO iid;
  ELSE
    SELECT * INTO existing FROM public.pay_invoices WHERE id = iid AND treasury_group_id = p_treasury FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF existing.status = 'void' THEN
      RAISE EXCEPTION 'invoice_void' USING ERRCODE = '22023';
    END IF;
    paid := public.pay_paid_cents(iid);
    IF (calc->>'total_cents')::bigint < paid THEN
      RAISE EXCEPTION 'total_below_payments' USING ERRCODE = '22023';
    END IF;
    num := left(btrim(coalesce(p_body->>'number', existing.number)), 60);
    IF num = '' THEN
      num := existing.number;
    END IF;
    IF num <> existing.number AND EXISTS (
      SELECT 1 FROM public.pay_invoices
      WHERE treasury_group_id = p_treasury AND number = num AND id <> iid
    ) THEN
      RAISE EXCEPTION 'invoice_number_taken' USING ERRCODE = '23505';
    END IF;
    UPDATE public.pay_invoices SET
      customer_id = cid,
      customer_snapshot = CASE
        WHEN existing.status = 'sent' THEN (
          SELECT jsonb_build_object(
            'name', c.name, 'contact', c.contact, 'email', c.email,
            'phone', c.phone, 'address', c.address, 'tax_id', c.tax_id
          )
          FROM public.pay_customers c
          WHERE c.id = cid
        )
        ELSE customer_snapshot
      END,
      number = num,
      issue_date = issue,
      due_date = due,
      po_number = left(btrim(coalesce(p_body->>'po_number', '')), 100),
      tax_label = coalesce(nullif(left(btrim(coalesce(p_body->>'tax_label', '')), 40), ''), 'Tax'),
      tax_rate_e3 = (calc->>'tax_rate_e3')::integer,
      discount_cents = (calc->>'discount_cents')::bigint,
      subtotal_cents = (calc->>'subtotal_cents')::bigint,
      taxable_cents = (calc->>'tax_base_cents')::bigint,
      tax_cents = (calc->>'tax_cents')::bigint,
      total_cents = (calc->>'total_cents')::bigint,
      notes = left(btrim(coalesce(p_body->>'notes', '')), 4000),
      terms = left(btrim(coalesce(p_body->>'terms', '')), 4000),
      footer = left(btrim(coalesce(p_body->>'footer', '')), 1000),
      updated_at = now()
    WHERE id = iid;
  END IF;

  PERFORM public.pay_replace_items(iid, p_treasury, calc->'lines');
  IF EXISTS (SELECT 1 FROM public.pay_invoices WHERE id = iid AND status = 'draft') THEN
    PERFORM public.pay_store_addresses(iid, p_treasury, p_body->'addresses');
  END IF;
  IF coalesce((p_body->>'mark_sent')::boolean, false)
     AND EXISTS (SELECT 1 FROM public.pay_invoices WHERE id = iid AND status = 'draft') THEN
    PERFORM public.pay_freeze_invoice(iid);
    PERFORM public.pay_activity_add(p_treasury, 'invoice_sent', 'Invoice ' || num || ' sent', iid);
  END IF;
  PERFORM public.pay_sync_journals(p_treasury);
  RETURN iid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_set_invoice_addresses(p_invoice uuid, p_addresses jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM public.pay_invoices WHERE id = p_invoice;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(inv.treasury_group_id);
  IF inv.status <> 'draft' THEN
    RAISE EXCEPTION 'invoice_frozen' USING ERRCODE = '22023';
  END IF;
  PERFORM public.pay_store_addresses(p_invoice, inv.treasury_group_id, coalesce(p_addresses, '[]'::jsonb));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_set_invoice_status(p_invoice uuid, p_status text, p_addresses jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
  paid bigint;
BEGIN
  SELECT * INTO inv FROM public.pay_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(inv.treasury_group_id);
  paid := public.pay_paid_cents(p_invoice);
  IF p_status = 'sent' THEN
    IF inv.status = 'draft' THEN
      PERFORM public.pay_store_addresses(p_invoice, inv.treasury_group_id, p_addresses);
      PERFORM public.pay_freeze_invoice(p_invoice);
      PERFORM public.pay_activity_add(inv.treasury_group_id, 'invoice_sent', 'Invoice ' || inv.number || ' sent', p_invoice);
    END IF;
  ELSIF p_status = 'void' THEN
    IF paid > 0 THEN
      RAISE EXCEPTION 'payments_exist' USING ERRCODE = '22023';
    END IF;
    IF inv.status <> 'void' THEN
      UPDATE public.pay_invoices
      SET status = 'void', voided_at = now(), updated_at = now()
      WHERE id = p_invoice;
      PERFORM public.pay_activity_add(inv.treasury_group_id, 'invoice_void', 'Invoice ' || inv.number || ' voided', p_invoice);
    END IF;
  ELSIF p_status = 'reopen' THEN
    IF inv.status <> 'void' THEN
      RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
    END IF;
    UPDATE public.pay_invoices
    SET status = 'sent', voided_at = NULL, updated_at = now()
    WHERE id = p_invoice;
    IF NOT EXISTS (SELECT 1 FROM public.pay_invoices WHERE id = p_invoice AND company_snapshot IS NOT NULL) THEN
      UPDATE public.pay_invoices SET status = 'draft' WHERE id = p_invoice;
      PERFORM public.pay_freeze_invoice(p_invoice);
    END IF;
    PERFORM public.pay_activity_add(inv.treasury_group_id, 'invoice_reopen', 'Invoice ' || inv.number || ' reopened', p_invoice);
  ELSE
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  PERFORM public.pay_sync_journals(inv.treasury_group_id);
  RETURN p_invoice;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_invoice(p_invoice uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM public.pay_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(inv.treasury_group_id);
  IF inv.status <> 'draft' THEN
    RAISE EXCEPTION 'draft_only' USING ERRCODE = '22023';
  END IF;
  IF public.pay_paid_cents(p_invoice) > 0 THEN
    RAISE EXCEPTION 'payments_exist' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.pay_invoice_items WHERE invoice_id = p_invoice;
  DELETE FROM public.pay_invoice_addresses WHERE invoice_id = p_invoice;
  DELETE FROM public.pay_invoices WHERE id = p_invoice;
  PERFORM public.pay_sync_journals(inv.treasury_group_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_duplicate_invoice(p_invoice uuid, p_invoice_id_hex text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  src public.pay_invoices%ROWTYPE;
  company public.pay_company_settings%ROWTYPE;
  nid uuid;
  hex text;
  issue date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO src FROM public.pay_invoices WHERE id = p_invoice;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(src.treasury_group_id);
  SELECT * INTO company FROM public.pay_company_settings WHERE treasury_group_id = src.treasury_group_id;
  hex := lower(coalesce(p_invoice_id_hex, ''));
  IF hex = '' THEN
    hex := encode(extensions.gen_random_bytes(32), 'hex');
  END IF;
  IF hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_invoice_id' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pay_invoices (
    treasury_group_id, customer_id, number, status, issue_date, due_date, po_number,
    tax_label, tax_rate_e3, discount_cents, subtotal_cents, taxable_cents, tax_cents, total_cents,
    notes, terms, footer, public_token, reference_code, invoice_id_hex
  ) VALUES (
    src.treasury_group_id,
    src.customer_id,
    public.pay_allocate_number(src.treasury_group_id),
    'draft',
    issue,
    issue + company.invoice_terms_days,
    '',
    src.tax_label,
    src.tax_rate_e3,
    src.discount_cents,
    src.subtotal_cents,
    src.taxable_cents,
    src.tax_cents,
    src.total_cents,
    src.notes,
    src.terms,
    src.footer,
    public.pay_random_token(),
    public.pay_new_reference(src.treasury_group_id),
    hex
  ) RETURNING id INTO nid;
  INSERT INTO public.pay_invoice_items (
    treasury_group_id, invoice_id, position, description, qty_e4, rate_cents, taxable, amount_cents
  )
  SELECT treasury_group_id, nid, position, description, qty_e4, rate_cents, taxable, amount_cents
  FROM public.pay_invoice_items
  WHERE invoice_id = p_invoice;
  RETURN nid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_record_payment(p_invoice uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
  amt bigint;
  paid bigint;
  cash uuid;
  pid uuid;
  paid_on date;
BEGIN
  SELECT * INTO inv FROM public.pay_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(inv.treasury_group_id);
  IF inv.status = 'void' THEN
    RAISE EXCEPTION 'invoice_void' USING ERRCODE = '22023';
  END IF;
  amt := public.pay_money_cents(coalesce(p_body->>'amount', ''), false);
  IF amt <= 0 THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '22023';
  END IF;
  paid := public.pay_paid_cents(p_invoice);
  IF amt > inv.total_cents - paid THEN
    RAISE EXCEPTION 'payment_exceeds_balance' USING ERRCODE = '22023';
  END IF;
  paid_on := public.pay_date_in(coalesce(p_body->>'date', to_char(now(), 'YYYY-MM-DD')));
  cash := NULLIF(p_body->>'cash_account_id', '')::uuid;
  IF cash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pay_accounts
    WHERE id = cash
      AND treasury_group_id = inv.treasury_group_id
      AND account_type IN ('asset', 'liability')
      AND archived = false
  ) THEN
    RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
  END IF;
  IF inv.status = 'draft' THEN
    PERFORM public.pay_store_addresses(p_invoice, inv.treasury_group_id, p_body->'addresses');
    PERFORM public.pay_freeze_invoice(p_invoice);
  END IF;
  INSERT INTO public.pay_payments (
    treasury_group_id, invoice_id, paid_on, amount_cents, method, reference, notes, cash_account_id
  ) VALUES (
    inv.treasury_group_id,
    p_invoice,
    paid_on,
    amt,
    left(btrim(coalesce(p_body->>'method', '')), 60),
    left(btrim(coalesce(p_body->>'reference', '')), 200),
    left(btrim(coalesce(p_body->>'notes', '')), 1000),
    cash
  ) RETURNING id INTO pid;
  PERFORM public.pay_activity_add(
    inv.treasury_group_id,
    'payment',
    'Payment of ' || to_char(amt / 100.0, 'FM999999990.00') || ' recorded on ' || inv.number,
    p_invoice
  );
  PERFORM public.pay_sync_journals(inv.treasury_group_id);
  RETURN pid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_payment(p_payment uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  pay public.pay_payments%ROWTYPE;
BEGIN
  SELECT * INTO pay FROM public.pay_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(pay.treasury_group_id);
  IF EXISTS (SELECT 1 FROM public.pay_settlements WHERE payment_id = p_payment) THEN
    RAISE EXCEPTION 'settlement_payment' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.pay_payments WHERE id = p_payment;
  PERFORM public.pay_sync_journals(pay.treasury_group_id);
  RETURN pay.invoice_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Service-role settlement. Idempotent on (chain, tx hash, invoice, asset).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_book_settlement(
  p_chain text,
  p_tx_hash text,
  p_invoice_id uuid,
  p_asset text,
  p_raw_amount text,
  p_decimals integer,
  p_stable boolean,
  p_symbol text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
  existing public.pay_settlements%ROWTYPE;
  price numeric;
  raw numeric;
  quoted bigint := 0;
  applied bigint := 0;
  excess bigint := 0;
  note text := '';
  booked boolean := false;
  open_cents bigint;
  pid uuid;
  asset text;
  chain text;
  txh text;
BEGIN
  IF coalesce(auth.role(), '') IS DISTINCT FROM 'service_role'
     AND coalesce(current_setting('request.jwt.claims', true)::json->>'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  chain := lower(btrim(coalesce(p_chain, '')));
  txh := btrim(coalesce(p_tx_hash, ''));
  asset := btrim(coalesce(p_asset, ''));
  IF chain = '' OR txh = '' OR asset = '' OR p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'settlement_incomplete' USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_raw_amount, '')) !~ '^[0-9]{1,78}$' THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  raw := btrim(p_raw_amount)::numeric;
  PERFORM pg_advisory_xact_lock(hashtextextended(chain || '|' || txh || '|' || p_invoice_id::text || '|' || asset, 0));
  SELECT * INTO existing
  FROM public.pay_settlements
  WHERE chain = chain AND tx_hash = txh AND invoice_id = p_invoice_id AND asset = asset;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'applied_cents', existing.applied_cents,
      'excess_cents', existing.excess_cents,
      'usd_booked', existing.usd_booked,
      'payment_id', existing.payment_id,
      'excess_note', existing.excess_note
    );
  END IF;

  SELECT * INTO inv FROM public.pay_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF coalesce(p_stable, false) THEN
    price := 1;
  ELSIF nullif(btrim(coalesce(p_symbol, '')), '') IS NOT NULL THEN
    SELECT price_usd INTO price FROM public.price_cache WHERE symbol = btrim(p_symbol);
  END IF;

  IF price IS NOT NULL AND price > 0 AND p_decimals IS NOT NULL AND p_decimals BETWEEN 0 AND 36 AND raw > 0 THEN
    quoted := round((raw * price * 100) / power(10::numeric, p_decimals))::bigint;
  END IF;

  IF quoted <= 0 THEN
    booked := false;
    note := 'Unpriced receipt of ' || btrim(p_raw_amount) ||
      ' base units. USD booking is left for a manual payment.';
  ELSE
    booked := true;
    IF inv.status = 'void' THEN
      open_cents := 0;
    ELSE
      open_cents := greatest(0, inv.total_cents - public.pay_paid_cents(inv.id));
    END IF;
    applied := least(quoted, open_cents);
    excess := quoted - applied;
    IF inv.status = 'void' THEN
      note := 'Unclassified inflow. The invoice is void, so none of it was applied.';
      applied := 0;
      excess := quoted;
    ELSIF excess > 0 THEN
      note := 'Unclassified inflow above the open invoice balance. The excess was not applied to the invoice.';
    END IF;
  END IF;

  IF applied > 0 THEN
    IF inv.status = 'draft' THEN
      PERFORM public.pay_freeze_invoice(inv.id);
    END IF;
    INSERT INTO public.pay_payments (
      treasury_group_id, invoice_id, paid_on, amount_cents, method, reference, notes, cash_account_id
    ) VALUES (
      inv.treasury_group_id,
      inv.id,
      (now() AT TIME ZONE 'UTC')::date,
      applied,
      'crypto',
      left(txh, 200),
      left(chain || ' ' || asset, 1000),
      public.pay_account_id(inv.treasury_group_id, '1200')
    ) RETURNING id INTO pid;
  END IF;

  INSERT INTO public.pay_settlements (
    treasury_group_id, invoice_id, chain, tx_hash, asset, raw_amount, decimals, price_usd,
    quoted_cents, applied_cents, excess_cents, excess_note, usd_booked, payment_id
  ) VALUES (
    inv.treasury_group_id, inv.id, chain, txh, asset, btrim(p_raw_amount),
    p_decimals, price, quoted, applied, excess, note, booked, pid
  );

  PERFORM public.pay_activity_add(
    inv.treasury_group_id,
    CASE WHEN excess > 0 OR NOT booked THEN 'unclassified_inflow' ELSE 'settlement' END,
    CASE
      WHEN NOT booked THEN 'Invoice ' || inv.number || ': ' || note
      WHEN excess > 0 THEN 'Invoice ' || inv.number || ' payment booked. ' || note
      ELSE 'Invoice ' || inv.number || ' payment booked from ' || chain || '.'
    END,
    inv.id
  );
  PERFORM public.pay_sync_journals(inv.treasury_group_id);
  RETURN jsonb_build_object(
    'status', 'booked',
    'applied_cents', applied,
    'excess_cents', excess,
    'usd_booked', booked,
    'payment_id', pid,
    'excess_note', note
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Public invoice. Nothing else from the books.
-- ---------------------------------------------------------------------------

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
  addresses jsonb;
  today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_token IS NULL OR char_length(p_token) < 32 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO inv FROM public.pay_invoices WHERE public_token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  paid := public.pay_paid_cents(inv.id);
  IF inv.status = 'void' THEN
    display := 'void';
    balance := 0;
  ELSIF inv.status = 'draft' THEN
    display := 'draft';
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
  IF company_name IS NULL THEN
    SELECT legal_name INTO company_name
    FROM public.pay_company_settings
    WHERE treasury_group_id = inv.treasury_group_id;
  END IF;

  SELECT coalesce(jsonb_agg(item ORDER BY item->>'chain', item->>'asset'), '[]'::jsonb)
  INTO addresses
  FROM (
    SELECT jsonb_build_object(
      'chain', a.chain,
      'asset', a.asset,
      'address', a.address,
      'unique', true
    ) AS item
    FROM public.pay_invoice_addresses a
    WHERE a.invoice_id = inv.id
    UNION ALL
    SELECT jsonb_build_object(
      'chain', w.chain,
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

  RETURN jsonb_build_object(
    'company_name', coalesce(company_name, 'Invoice'),
    'amount_due_cents', balance,
    'currency', inv.currency,
    'status', display,
    'days_overdue', days,
    'reference', inv.reference_code,
    'addresses', addresses
  );
END;
$fn$;

COMMENT ON FUNCTION public.pay_public_invoice(text) IS
  'Customer payment page. Returns display name, amount due, payable addresses, reference, and status. No other books fields.';

-- ---------------------------------------------------------------------------
-- RLS. Operators read. Token holders do not. Writes stay on the functions.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_invoice_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read customers" ON public.pay_customers;
CREATE POLICY "Pay operators read customers"
  ON public.pay_customers FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read invoices" ON public.pay_invoices;
CREATE POLICY "Pay operators read invoices"
  ON public.pay_invoices FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read invoice items" ON public.pay_invoice_items;
CREATE POLICY "Pay operators read invoice items"
  ON public.pay_invoice_items FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read invoice addresses" ON public.pay_invoice_addresses;
CREATE POLICY "Pay operators read invoice addresses"
  ON public.pay_invoice_addresses FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read payments" ON public.pay_payments;
CREATE POLICY "Pay operators read payments"
  ON public.pay_payments FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read settlements" ON public.pay_settlements;
CREATE POLICY "Pay operators read settlements"
  ON public.pay_settlements FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read journal entries" ON public.pay_journal_entries;
CREATE POLICY "Pay operators read journal entries"
  ON public.pay_journal_entries FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read journal lines" ON public.pay_journal_lines;
CREATE POLICY "Pay operators read journal lines"
  ON public.pay_journal_lines FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read activity" ON public.pay_activity;
CREATE POLICY "Pay operators read activity"
  ON public.pay_activity FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_customers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_invoices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_invoice_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_invoice_addresses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_payments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_settlements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_journal_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_journal_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_activity FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_customers TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_invoices TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_invoice_items TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_invoice_addresses TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_payments TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_settlements TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_journal_entries TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_journal_lines TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_activity TO anon, authenticated;

GRANT ALL ON TABLE public.pay_customers TO service_role;
GRANT ALL ON TABLE public.pay_invoices TO service_role;
GRANT ALL ON TABLE public.pay_invoice_items TO service_role;
GRANT ALL ON TABLE public.pay_invoice_addresses TO service_role;
GRANT ALL ON TABLE public.pay_payments TO service_role;
GRANT ALL ON TABLE public.pay_settlements TO service_role;
GRANT ALL ON TABLE public.pay_journal_entries TO service_role;
GRANT ALL ON TABLE public.pay_journal_lines TO service_role;
GRANT ALL ON TABLE public.pay_activity TO service_role;

REVOKE ALL ON FUNCTION public.pay_muldiv_round(bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_money_cents(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_qty_e4(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_rate_e3(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_compute_invoice(jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_account_id(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_sync_journals(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_require_operator(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_date_in(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_random_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_store_addresses(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_freeze_invoice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_paid_cents(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_activity_add(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_allocate_number(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_new_reference(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_replace_items(uuid, uuid, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.pay_save_customer(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_update_company_settings(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_save_invoice(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_set_invoice_addresses(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_set_invoice_status(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_invoice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_duplicate_invoice(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_record_payment(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_payment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_book_settlement(text, text, uuid, text, text, integer, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_public_invoice(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pay_save_customer(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_update_company_settings(uuid, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_save_invoice(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_set_invoice_addresses(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_set_invoice_status(uuid, text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_invoice(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_duplicate_invoice(uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_record_payment(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_payment(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_public_invoice(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_book_settlement(text, text, uuid, text, text, integer, boolean, text) TO service_role;

-- Helpers are invoked by the security-definer RPCs as the function owner.
GRANT EXECUTE ON FUNCTION public.pay_muldiv_round(bigint, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_compute_invoice(jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_public_invoice(text) TO service_role;
