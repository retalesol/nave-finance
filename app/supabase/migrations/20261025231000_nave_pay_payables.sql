-- Nave Pay vendors, bills, deposits, expenses, and cash-basis journals.
--
-- Tenant is treasury_group_id. Operators are the same wallets as the books
-- migration: x-wallet-address matches creator_wallet or dao_authorized_wallets.
-- Token holders have no SELECT policy on these tables.
--
-- Invoice journals stay in pay_sync_journals. This migration only adds
-- source types bill, bill_payment, and cash_transaction, and posts those
-- from pay_sync_payable_journals.
--
-- A treasury bill payment does not move funds. pay_link_bill_proposal stores
-- the governance proposal id, the vendor payment address, and the USD amount.
-- pay_confirm_bill_proposal books Dr AP / Cr digital assets 1200 only when
-- that stored recipient still matches the vendor and the amount still fits
-- the open balance. It does not submit a chain transaction. activity_logs
-- has no stable outbound recipient and amount, so the indexer is not hooked.
--
-- Vendor tax_id is stored on pay_vendors only. Activity summaries and journal
-- memos go through pay_safe_text and never read tax_id.

-- ---------------------------------------------------------------------------
-- Journal source types. Invoice and payment rows are unchanged.
-- ---------------------------------------------------------------------------

DO $drop$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'pay_journal_entries'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.pay_journal_entries DROP CONSTRAINT %I', cname);
  END LOOP;
END
$drop$;

ALTER TABLE public.pay_journal_entries
  ADD CONSTRAINT pay_journal_entries_source_type_check
  CHECK (source_type IN ('invoice', 'payment', 'bill', 'bill_payment', 'cash_transaction'));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_vendors (
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
  payment_address text NOT NULL DEFAULT '',
  is_1099 boolean NOT NULL DEFAULT false,
  form_1099 text NOT NULL DEFAULT 'NEC',
  legal_name text NOT NULL DEFAULT '',
  tin_type text NOT NULL DEFAULT '',
  w9_on_file boolean NOT NULL DEFAULT false,
  w9_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_vendors_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT pay_vendors_form CHECK (form_1099 IN ('NEC', 'MISC')),
  CONSTRAINT pay_vendors_tin_type CHECK (tin_type IN ('', 'EIN', 'SSN', 'ITIN')),
  CONSTRAINT pay_vendors_payment_len CHECK (char_length(payment_address) <= 200)
);

COMMENT ON COLUMN public.pay_vendors.tax_id IS
  'Vendor TIN. Stored on this row only. Do not copy it into pay_activity or journal text.';

COMMENT ON COLUMN public.pay_vendors.payment_address IS
  'Wallet prefilled on a treasury payment proposal. Nave Pay does not send from this address.';

CREATE INDEX IF NOT EXISTS pay_vendors_group_idx
  ON public.pay_vendors (treasury_group_id, archived, name);

CREATE TABLE IF NOT EXISTS public.pay_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.pay_vendors (id),
  ref text NOT NULL DEFAULT '',
  bill_date date NOT NULL,
  due_date date NOT NULL,
  category text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'void')),
  notes text NOT NULL DEFAULT '',
  account_id uuid REFERENCES public.pay_accounts (id),
  proposal_dao text NOT NULL DEFAULT '',
  proposal_index integer,
  proposal_chain text NOT NULL DEFAULT '',
  proposal_amount_cents bigint,
  proposal_recipient text NOT NULL DEFAULT '',
  proposal_payment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_bills_due CHECK (due_date >= bill_date),
  CONSTRAINT pay_bills_proposal_amount CHECK (proposal_amount_cents IS NULL OR proposal_amount_cents > 0),
  CONSTRAINT pay_bills_proposal_index CHECK (proposal_index IS NULL OR proposal_index >= 0)
);

COMMENT ON COLUMN public.pay_bills.proposal_index IS
  'Governance proposal index prefilled for this bill. Confirming it books the payment and does not send funds.';

CREATE INDEX IF NOT EXISTS pay_bills_group_idx
  ON public.pay_bills (treasury_group_id, bill_date DESC);

CREATE INDEX IF NOT EXISTS pay_bills_vendor_idx
  ON public.pay_bills (vendor_id);

CREATE TABLE IF NOT EXISTS public.pay_bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  bill_id uuid NOT NULL REFERENCES public.pay_bills (id),
  paid_on date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  cash_account_id uuid REFERENCES public.pay_accounts (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pay_bill_payments_bill_idx
  ON public.pay_bill_payments (bill_id, paid_on);

CREATE INDEX IF NOT EXISTS pay_bill_payments_group_idx
  ON public.pay_bill_payments (treasury_group_id, paid_on);

ALTER TABLE public.pay_bills
  DROP CONSTRAINT IF EXISTS pay_bills_proposal_payment_fk;

ALTER TABLE public.pay_bills
  ADD CONSTRAINT pay_bills_proposal_payment_fk
  FOREIGN KEY (proposal_payment_id) REFERENCES public.pay_bill_payments (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.pay_cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  category text NOT NULL DEFAULT '',
  counterparty text NOT NULL DEFAULT '',
  method text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  account_id uuid REFERENCES public.pay_accounts (id),
  cash_account_id uuid REFERENCES public.pay_accounts (id),
  vendor_id uuid REFERENCES public.pay_vendors (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_cash_entries IS
  'Deposits and expenses that are not invoice payments or bill payments.';

CREATE INDEX IF NOT EXISTS pay_cash_entries_group_idx
  ON public.pay_cash_entries (treasury_group_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS pay_cash_entries_vendor_idx
  ON public.pay_cash_entries (vendor_id);

-- ---------------------------------------------------------------------------
-- Helpers. Tax ids are never arguments to these.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_clip(raw text, max_len integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT left(btrim(coalesce(raw, '')), max_len);
$fn$;

CREATE OR REPLACE FUNCTION public.pay_safe_text(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT btrim(regexp_replace(
    regexp_replace(coalesce(raw, ''), '[0-9]{3}-[0-9]{2}-[0-9]{4}', '', 'g'),
    '[0-9]{2}-[0-9]{7}',
    '',
    'g'
  ));
$fn$;

CREATE OR REPLACE FUNCTION public.pay_category_code(p_kind text, p_category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE lower(btrim(coalesce(p_category, '')))
    WHEN 'software & saas' THEN '6000'
    WHEN 'infrastructure & rpc' THEN '6010'
    WHEN 'audits & security' THEN '6020'
    WHEN 'legal' THEN '6030'
    WHEN 'accounting' THEN '6040'
    WHEN 'contractors' THEN '6050'
    WHEN 'payroll' THEN '6060'
    WHEN 'marketing' THEN '6070'
    WHEN 'travel' THEN '6080'
    WHEN 'office' THEN '6090'
    WHEN 'bank & network fees' THEN '6100'
    WHEN 'taxes' THEN '6120'
    WHEN 'other' THEN CASE WHEN p_kind = 'income' THEN '4900' ELSE '6900' END
    WHEN 'invoice payments' THEN '4000'
    WHEN 'protocol revenue' THEN '4010'
    WHEN 'grants' THEN '7010'
    WHEN 'investment (safe/equity)' THEN '2500'
    WHEN 'refunds' THEN '6900'
    WHEN 'interest' THEN '7000'
    ELSE CASE WHEN p_kind = 'income' THEN '4900' ELSE '6900' END
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_account_if(p_treasury uuid, p_id uuid, p_types text[])
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  found_type text;
BEGIN
  IF p_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT account_type INTO found_type
  FROM public.pay_accounts
  WHERE id = p_id
    AND treasury_group_id = p_treasury;
  IF NOT FOUND OR NOT (found_type = ANY (p_types)) THEN
    RETURN NULL;
  END IF;
  RETURN p_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_opt_account(p_treasury uuid, p_id uuid, p_types text[])
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  found_type text;
  found_archived boolean;
BEGIN
  IF p_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT account_type, archived INTO found_type, found_archived
  FROM public.pay_accounts
  WHERE id = p_id
    AND treasury_group_id = p_treasury;
  IF NOT FOUND OR found_archived OR NOT (found_type = ANY (p_types)) THEN
    RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
  END IF;
  RETURN p_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_resolve_cash(p_treasury uuid, p_cash uuid, p_method text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  cash uuid;
  method text;
BEGIN
  cash := public.pay_account_if(p_treasury, p_cash, ARRAY['asset', 'liability']);
  IF cash IS NOT NULL THEN
    RETURN cash;
  END IF;
  method := lower(btrim(coalesce(p_method, '')));
  IF method LIKE '%usdc%'
    OR method LIKE '%crypto%'
    OR method LIKE '%treasury%'
    OR method IN ('sol', 'solana', 'eth', 'ethereum') THEN
    RETURN public.pay_account_id(p_treasury, '1200');
  END IF;
  RETURN coalesce(
    public.pay_account_id(p_treasury, '1000'),
    public.pay_account_id(p_treasury, '1200')
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_bill_paid(p_bill uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT coalesce(sum(amount_cents), 0)::bigint
  FROM public.pay_bill_payments
  WHERE bill_id = p_bill;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_same_payee(left_addr text, right_addr text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE
    WHEN lower(btrim(coalesce(left_addr, ''))) LIKE '0x%'
      OR lower(btrim(coalesce(right_addr, ''))) LIKE '0x%'
    THEN lower(btrim(coalesce(left_addr, ''))) = lower(btrim(coalesce(right_addr, '')))
    ELSE btrim(coalesce(left_addr, '')) = btrim(coalesce(right_addr, ''))
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- Payable journals. Does not read or write invoice or payment entries.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_sync_payable_journals(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ap_id uuid;
  bill record;
  pay record;
  cash_row record;
  entry uuid;
  expense_id uuid;
  income_id uuid;
  cash uuid;
BEGIN
  ap_id := public.pay_account_id(p_treasury, '2000');
  IF ap_id IS NULL THEN
    RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.pay_journal_entries
  WHERE treasury_group_id = p_treasury
    AND source_type IN ('bill', 'bill_payment', 'cash_transaction');

  FOR bill IN
    SELECT b.id, b.bill_date, b.ref, b.amount_cents, b.category, b.account_id, v.name AS vendor_name
    FROM public.pay_bills b
    JOIN public.pay_vendors v ON v.id = b.vendor_id
    WHERE b.treasury_group_id = p_treasury
      AND b.status = 'open'
  LOOP
    expense_id := public.pay_account_if(
      p_treasury,
      bill.account_id,
      ARRAY['expense', 'asset', 'liability', 'equity']
    );
    IF expense_id IS NULL THEN
      expense_id := public.pay_account_id(p_treasury, public.pay_category_code('expense', bill.category));
    END IF;
    IF expense_id IS NULL THEN
      RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.pay_journal_entries (
      treasury_group_id, entry_date, memo, ref, party, source_type, source_id
    ) VALUES (
      p_treasury,
      bill.bill_date,
      left(public.pay_safe_text('Bill' || CASE WHEN bill.ref <> '' THEN ' ' || bill.ref ELSE '' END), 500),
      left(public.pay_safe_text(bill.ref), 200),
      left(public.pay_safe_text(bill.vendor_name), 200),
      'bill',
      bill.id
    ) RETURNING id INTO entry;
    INSERT INTO public.pay_journal_lines (
      treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents
    ) VALUES
      (p_treasury, entry, 0, expense_id, bill.amount_cents, 0),
      (p_treasury, entry, 1, ap_id, 0, bill.amount_cents);
  END LOOP;

  FOR pay IN
    SELECT bp.id, bp.paid_on, bp.amount_cents, bp.method, bp.reference, bp.cash_account_id, b.ref, v.name AS vendor_name
    FROM public.pay_bill_payments bp
    JOIN public.pay_bills b ON b.id = bp.bill_id
    JOIN public.pay_vendors v ON v.id = b.vendor_id
    WHERE bp.treasury_group_id = p_treasury
  LOOP
    cash := public.pay_resolve_cash(p_treasury, pay.cash_account_id, pay.method);
    IF cash IS NULL THEN
      RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.pay_journal_entries (
      treasury_group_id, entry_date, memo, ref, party, source_type, source_id
    ) VALUES (
      p_treasury,
      pay.paid_on,
      left(public.pay_safe_text(
        'Bill payment' || CASE WHEN pay.ref <> '' THEN ' ' || pay.ref ELSE '' END
        || CASE WHEN pay.method <> '' THEN ' · ' || pay.method ELSE '' END
      ), 500),
      left(public.pay_safe_text(coalesce(nullif(pay.reference, ''), pay.ref)), 200),
      left(public.pay_safe_text(pay.vendor_name), 200),
      'bill_payment',
      pay.id
    ) RETURNING id INTO entry;
    INSERT INTO public.pay_journal_lines (
      treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents
    ) VALUES
      (p_treasury, entry, 0, ap_id, pay.amount_cents, 0),
      (p_treasury, entry, 1, cash, 0, pay.amount_cents);
  END LOOP;

  FOR cash_row IN
    SELECT t.id, t.entry_date, t.direction, t.amount_cents, t.category, t.method, t.reference,
      t.memo, t.account_id, t.cash_account_id, t.counterparty, v.name AS vendor_name
    FROM public.pay_cash_entries t
    LEFT JOIN public.pay_vendors v ON v.id = t.vendor_id
    WHERE t.treasury_group_id = p_treasury
  LOOP
    cash := public.pay_resolve_cash(p_treasury, cash_row.cash_account_id, cash_row.method);
    IF cash IS NULL THEN
      RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
    END IF;
    IF cash_row.direction = 'in' THEN
      income_id := public.pay_account_if(
        p_treasury,
        cash_row.account_id,
        ARRAY['income', 'expense', 'asset', 'liability', 'equity']
      );
      IF income_id IS NULL THEN
        income_id := public.pay_account_id(p_treasury, public.pay_category_code('income', cash_row.category));
      END IF;
      IF income_id IS NULL THEN
        RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
      END IF;
      INSERT INTO public.pay_journal_entries (
        treasury_group_id, entry_date, memo, ref, party, source_type, source_id
      ) VALUES (
        p_treasury,
        cash_row.entry_date,
        left(public.pay_safe_text('Deposit' || CASE WHEN cash_row.category <> '' THEN ' · ' || cash_row.category ELSE '' END), 500),
        left(public.pay_safe_text(cash_row.reference), 200),
        left(public.pay_safe_text(coalesce(cash_row.vendor_name, cash_row.counterparty, '')), 200),
        'cash_transaction',
        cash_row.id
      ) RETURNING id INTO entry;
      INSERT INTO public.pay_journal_lines (
        treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo
      ) VALUES
        (p_treasury, entry, 0, cash, cash_row.amount_cents, 0, ''),
        (p_treasury, entry, 1, income_id, 0, cash_row.amount_cents, left(public.pay_safe_text(cash_row.memo), 500));
    ELSE
      expense_id := public.pay_account_if(
        p_treasury,
        cash_row.account_id,
        ARRAY['income', 'expense', 'asset', 'liability', 'equity']
      );
      IF expense_id IS NULL THEN
        expense_id := public.pay_account_id(p_treasury, public.pay_category_code('expense', cash_row.category));
      END IF;
      IF expense_id IS NULL THEN
        RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
      END IF;
      INSERT INTO public.pay_journal_entries (
        treasury_group_id, entry_date, memo, ref, party, source_type, source_id
      ) VALUES (
        p_treasury,
        cash_row.entry_date,
        left(public.pay_safe_text('Expense' || CASE WHEN cash_row.category <> '' THEN ' · ' || cash_row.category ELSE '' END), 500),
        left(public.pay_safe_text(cash_row.reference), 200),
        left(public.pay_safe_text(coalesce(cash_row.vendor_name, cash_row.counterparty, '')), 200),
        'cash_transaction',
        cash_row.id
      ) RETURNING id INTO entry;
      INSERT INTO public.pay_journal_lines (
        treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo
      ) VALUES
        (p_treasury, entry, 0, expense_id, cash_row.amount_cents, 0, left(public.pay_safe_text(cash_row.memo), 500)),
        (p_treasury, entry, 1, cash, 0, cash_row.amount_cents, '');
    END IF;
  END LOOP;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_save_vendor(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  vid uuid;
  vendor public.pay_vendors%ROWTYPE;
  name text;
  email text;
  tax_id text;
  tin_type text;
  form_1099 text;
  is_1099 boolean;
  w9_on_file boolean;
  w9_date date;
  contact text;
  phone text;
  address text;
  notes text;
  legal_name text;
  payment_address text;
  archived boolean;
  creating boolean;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  vid := NULLIF(p_body->>'id', '')::uuid;
  creating := vid IS NULL;
  IF NOT creating THEN
    SELECT * INTO vendor
    FROM public.pay_vendors
    WHERE id = vid
      AND treasury_group_id = p_treasury
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF creating OR p_body ? 'name' THEN
    name := public.pay_clip(p_body->>'name', 200);
  ELSE
    name := vendor.name;
  END IF;
  IF name = '' THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;

  IF creating OR p_body ? 'email' THEN
    email := public.pay_clip(p_body->>'email', 200);
  ELSE
    email := vendor.email;
  END IF;
  IF email <> '' AND email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = '22023';
  END IF;

  IF creating OR p_body ? 'contact' THEN
    contact := public.pay_clip(p_body->>'contact', 200);
  ELSE
    contact := vendor.contact;
  END IF;
  IF creating OR p_body ? 'phone' THEN
    phone := public.pay_clip(p_body->>'phone', 60);
  ELSE
    phone := vendor.phone;
  END IF;
  IF creating OR p_body ? 'address' THEN
    address := public.pay_clip(p_body->>'address', 1000);
  ELSE
    address := vendor.address;
  END IF;
  IF creating OR p_body ? 'notes' THEN
    notes := public.pay_clip(p_body->>'notes', 4000);
  ELSE
    notes := vendor.notes;
  END IF;
  IF creating OR p_body ? 'legal_name' THEN
    legal_name := public.pay_clip(p_body->>'legal_name', 200);
  ELSE
    legal_name := vendor.legal_name;
  END IF;
  IF creating OR p_body ? 'payment_address' THEN
    payment_address := public.pay_clip(p_body->>'payment_address', 200);
  ELSE
    payment_address := vendor.payment_address;
  END IF;
  IF creating OR p_body ? 'tax_id' THEN
    tax_id := public.pay_clip(p_body->>'tax_id', 60);
  ELSE
    tax_id := vendor.tax_id;
  END IF;

  IF creating OR p_body ? 'form_1099' THEN
    form_1099 := CASE WHEN p_body->>'form_1099' IN ('NEC', 'MISC') THEN p_body->>'form_1099' ELSE 'NEC' END;
  ELSE
    form_1099 := vendor.form_1099;
  END IF;
  IF creating OR p_body ? 'tin_type' THEN
    tin_type := CASE WHEN p_body->>'tin_type' IN ('EIN', 'SSN', 'ITIN') THEN p_body->>'tin_type' ELSE '' END;
  ELSE
    tin_type := vendor.tin_type;
  END IF;
  IF creating OR p_body ? 'is_1099' THEN
    is_1099 := coalesce((p_body->>'is_1099')::boolean, false);
  ELSE
    is_1099 := vendor.is_1099;
  END IF;
  IF creating OR p_body ? 'w9_on_file' THEN
    w9_on_file := coalesce((p_body->>'w9_on_file')::boolean, false);
  ELSE
    w9_on_file := vendor.w9_on_file;
  END IF;
  IF creating OR p_body ? 'archived' THEN
    archived := coalesce((p_body->>'archived')::boolean, false);
  ELSE
    archived := vendor.archived;
  END IF;
  IF creating OR p_body ? 'w9_date' THEN
    IF btrim(coalesce(p_body->>'w9_date', '')) = '' THEN
      w9_date := NULL;
    ELSE
      w9_date := public.pay_date_in(p_body->>'w9_date');
    END IF;
  ELSE
    w9_date := vendor.w9_date;
  END IF;

  IF tax_id <> '' AND tin_type <> ''
    AND tax_id !~ '^[0-9]{2}-?[0-9]{7}$'
    AND tax_id !~ '^[0-9]{3}-?[0-9]{2}-?[0-9]{4}$' THEN
    RAISE EXCEPTION 'invalid_tin' USING ERRCODE = '22023';
  END IF;

  IF creating THEN
    INSERT INTO public.pay_vendors (
      treasury_group_id, name, contact, email, phone, address, tax_id, notes, archived,
      payment_address, is_1099, form_1099, legal_name, tin_type, w9_on_file, w9_date
    ) VALUES (
      p_treasury, name, contact, email, phone, address, tax_id, notes, archived,
      payment_address, is_1099, form_1099, legal_name, tin_type, w9_on_file, w9_date
    ) RETURNING id INTO vid;
  ELSE
    UPDATE public.pay_vendors SET
      name = name,
      contact = contact,
      email = email,
      phone = phone,
      address = address,
      tax_id = tax_id,
      notes = notes,
      archived = archived,
      payment_address = payment_address,
      is_1099 = is_1099,
      form_1099 = form_1099,
      legal_name = legal_name,
      tin_type = tin_type,
      w9_on_file = w9_on_file,
      w9_date = w9_date,
      updated_at = now()
    WHERE id = vid
      AND treasury_group_id = p_treasury;
  END IF;

  PERFORM public.pay_activity_add(
    p_treasury,
    'vendor',
    left(public.pay_safe_text('Vendor ' || name || CASE WHEN creating THEN ' added' ELSE ' updated' END), 500),
    NULL
  );
  RETURN vid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_vendor(p_vendor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  vendor public.pay_vendors%ROWTYPE;
BEGIN
  SELECT * INTO vendor FROM public.pay_vendors WHERE id = p_vendor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(vendor.treasury_group_id);
  IF EXISTS (SELECT 1 FROM public.pay_bills WHERE vendor_id = p_vendor) THEN
    RAISE EXCEPTION 'vendor_has_bills' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pay_cash_entries WHERE vendor_id = p_vendor) THEN
    RAISE EXCEPTION 'vendor_has_entries' USING ERRCODE = '23503';
  END IF;
  DELETE FROM public.pay_vendors WHERE id = p_vendor;
  PERFORM public.pay_activity_add(
    vendor.treasury_group_id,
    'vendor',
    left(public.pay_safe_text('Vendor ' || vendor.name || ' deleted'), 500),
    NULL
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Bills and bill payments
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_save_bill(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bid uuid;
  vendor_id uuid;
  vendor_archived boolean;
  vendor_name text;
  bill_date date;
  due_date date;
  amount_cents bigint;
  paid bigint;
  account_id uuid;
  ref text;
  category text;
  description text;
  notes text;
  pay_now boolean;
  pay_method text;
  pay_account uuid;
  old_status text;
  old_vendor uuid;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  vendor_id := NULLIF(p_body->>'vendor_id', '')::uuid;
  SELECT archived, name INTO vendor_archived, vendor_name
  FROM public.pay_vendors
  WHERE id = vendor_id
    AND treasury_group_id = p_treasury;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'P0002';
  END IF;

  bill_date := public.pay_date_in(p_body->>'bill_date');
  due_date := public.pay_date_in(p_body->>'due_date');
  IF due_date < bill_date THEN
    RAISE EXCEPTION 'due_before_bill' USING ERRCODE = '22023';
  END IF;
  amount_cents := public.pay_money_cents(coalesce(p_body->>'amount', ''), false);
  IF amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '22023';
  END IF;

  ref := public.pay_clip(p_body->>'ref', 100);
  category := public.pay_clip(p_body->>'category', 80);
  description := public.pay_clip(p_body->>'description', 2000);
  notes := public.pay_clip(p_body->>'notes', 2000);
  IF NULLIF(p_body->>'account_id', '') IS NULL THEN
    account_id := NULL;
  ELSE
    account_id := public.pay_opt_account(
      p_treasury,
      (p_body->>'account_id')::uuid,
      ARRAY['expense', 'asset', 'liability', 'equity']
    );
  END IF;

  bid := NULLIF(p_body->>'id', '')::uuid;
  IF bid IS NULL THEN
    IF vendor_archived THEN
      RAISE EXCEPTION 'vendor_archived' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.pay_bills (
      treasury_group_id, vendor_id, ref, bill_date, due_date, category, description,
      amount_cents, notes, account_id
    ) VALUES (
      p_treasury, vendor_id, ref, bill_date, due_date, category, description,
      amount_cents, notes, account_id
    ) RETURNING id INTO bid;
  ELSE
    SELECT status, vendor_id INTO old_status, old_vendor
    FROM public.pay_bills
    WHERE id = bid
      AND treasury_group_id = p_treasury
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF old_status = 'void' THEN
      RAISE EXCEPTION 'bill_void' USING ERRCODE = '22023';
    END IF;
    IF vendor_archived AND vendor_id IS DISTINCT FROM old_vendor THEN
      RAISE EXCEPTION 'vendor_archived' USING ERRCODE = '22023';
    END IF;
    paid := public.pay_bill_paid(bid);
    IF amount_cents < paid THEN
      RAISE EXCEPTION 'amount_below_payments' USING ERRCODE = '22023';
    END IF;
    UPDATE public.pay_bills SET
      vendor_id = vendor_id,
      ref = ref,
      bill_date = bill_date,
      due_date = due_date,
      category = category,
      description = description,
      amount_cents = amount_cents,
      notes = notes,
      account_id = account_id,
      updated_at = now()
    WHERE id = bid;
  END IF;

  pay_now := coalesce((p_body->>'pay_now')::boolean, false);
  IF pay_now THEN
    paid := public.pay_bill_paid(bid);
    IF amount_cents > paid THEN
      pay_method := public.pay_clip(p_body->>'pay_method', 60);
      IF NULLIF(p_body->>'pay_account_id', '') IS NULL THEN
        pay_account := NULL;
      ELSE
        pay_account := public.pay_opt_account(
          p_treasury,
          (p_body->>'pay_account_id')::uuid,
          ARRAY['asset', 'liability']
        );
      END IF;
      INSERT INTO public.pay_bill_payments (
        treasury_group_id, bill_id, paid_on, amount_cents, method, reference, notes, cash_account_id
      ) VALUES (
        p_treasury, bid, bill_date, amount_cents - paid, pay_method, '', 'Paid on entry', pay_account
      );
    END IF;
  END IF;

  PERFORM public.pay_activity_add(
    p_treasury,
    'bill',
    left(public.pay_safe_text('Bill' || CASE WHEN ref <> '' THEN ' ' || ref ELSE '' END || ' for ' || vendor_name), 500),
    NULL
  );
  PERFORM public.pay_sync_payable_journals(p_treasury);
  RETURN bid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_set_bill_status(p_bill uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bill public.pay_bills%ROWTYPE;
  vendor_name text;
BEGIN
  SELECT * INTO bill FROM public.pay_bills WHERE id = p_bill FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(bill.treasury_group_id);
  IF p_status NOT IN ('open', 'void') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'void' AND EXISTS (SELECT 1 FROM public.pay_bill_payments WHERE bill_id = p_bill) THEN
    RAISE EXCEPTION 'bill_has_payments' USING ERRCODE = '23503';
  END IF;
  UPDATE public.pay_bills SET status = p_status, updated_at = now() WHERE id = p_bill;
  SELECT name INTO vendor_name FROM public.pay_vendors WHERE id = bill.vendor_id;
  PERFORM public.pay_activity_add(
    bill.treasury_group_id,
    'bill',
    left(public.pay_safe_text(
      CASE WHEN p_status = 'void' THEN 'Bill voided for ' ELSE 'Bill reopened for ' END || coalesce(vendor_name, '')
    ), 500),
    NULL
  );
  PERFORM public.pay_sync_payable_journals(bill.treasury_group_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_bill(p_bill uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bill public.pay_bills%ROWTYPE;
BEGIN
  SELECT * INTO bill FROM public.pay_bills WHERE id = p_bill FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(bill.treasury_group_id);
  IF EXISTS (SELECT 1 FROM public.pay_bill_payments WHERE bill_id = p_bill) THEN
    RAISE EXCEPTION 'bill_has_payments' USING ERRCODE = '23503';
  END IF;
  DELETE FROM public.pay_bills WHERE id = p_bill;
  PERFORM public.pay_activity_add(bill.treasury_group_id, 'bill', 'Bill deleted', NULL);
  PERFORM public.pay_sync_payable_journals(bill.treasury_group_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_record_bill_payment(p_bill uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bill public.pay_bills%ROWTYPE;
  vendor_name text;
  paid_on date;
  amount_cents bigint;
  paid bigint;
  cash uuid;
  payment_id uuid;
BEGIN
  SELECT * INTO bill FROM public.pay_bills WHERE id = p_bill FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(bill.treasury_group_id);
  IF bill.status = 'void' THEN
    RAISE EXCEPTION 'bill_void' USING ERRCODE = '22023';
  END IF;
  paid_on := public.pay_date_in(p_body->>'date');
  amount_cents := public.pay_money_cents(coalesce(p_body->>'amount', ''), false);
  IF amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '22023';
  END IF;
  paid := public.pay_bill_paid(p_bill);
  IF amount_cents > bill.amount_cents - paid THEN
    RAISE EXCEPTION 'payment_exceeds_balance' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(p_body->>'cash_account_id', '') IS NULL THEN
    cash := NULL;
  ELSE
    cash := public.pay_opt_account(
      bill.treasury_group_id,
      (p_body->>'cash_account_id')::uuid,
      ARRAY['asset', 'liability']
    );
  END IF;
  INSERT INTO public.pay_bill_payments (
    treasury_group_id, bill_id, paid_on, amount_cents, method, reference, notes, cash_account_id
  ) VALUES (
    bill.treasury_group_id,
    p_bill,
    paid_on,
    amount_cents,
    public.pay_clip(p_body->>'method', 60),
    public.pay_clip(p_body->>'reference', 200),
    public.pay_clip(p_body->>'notes', 1000),
    cash
  ) RETURNING id INTO payment_id;
  SELECT name INTO vendor_name FROM public.pay_vendors WHERE id = bill.vendor_id;
  PERFORM public.pay_activity_add(
    bill.treasury_group_id,
    'bill_payment',
    left(public.pay_safe_text('Bill payment' || CASE WHEN bill.ref <> '' THEN ' ' || bill.ref ELSE '' END || ' to ' || coalesce(vendor_name, '')), 500),
    NULL
  );
  PERFORM public.pay_sync_payable_journals(bill.treasury_group_id);
  RETURN payment_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_bill_payment(p_payment uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  pay public.pay_bill_payments%ROWTYPE;
BEGIN
  SELECT * INTO pay FROM public.pay_bill_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(pay.treasury_group_id);
  DELETE FROM public.pay_bill_payments WHERE id = p_payment;
  PERFORM public.pay_activity_add(pay.treasury_group_id, 'bill_payment', 'Bill payment deleted', NULL);
  PERFORM public.pay_sync_payable_journals(pay.treasury_group_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_link_bill_proposal(
  p_bill uuid,
  p_dao text,
  p_index integer,
  p_chain text,
  p_amount_cents bigint,
  p_recipient text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bill public.pay_bills%ROWTYPE;
  vendor_name text;
  vendor_address text;
  paid bigint;
BEGIN
  SELECT * INTO bill FROM public.pay_bills WHERE id = p_bill FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(bill.treasury_group_id);
  IF bill.status = 'void' THEN
    RAISE EXCEPTION 'bill_void' USING ERRCODE = '22023';
  END IF;
  IF p_index IS NULL OR p_index < 0 THEN
    RAISE EXCEPTION 'proposal_missing' USING ERRCODE = '22023';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '22023';
  END IF;
  paid := public.pay_bill_paid(p_bill);
  IF p_amount_cents > bill.amount_cents - paid THEN
    RAISE EXCEPTION 'payment_exceeds_balance' USING ERRCODE = '22023';
  END IF;
  SELECT name, payment_address INTO vendor_name, vendor_address
  FROM public.pay_vendors
  WHERE id = bill.vendor_id;
  IF btrim(coalesce(vendor_address, '')) = '' OR NOT public.pay_same_payee(vendor_address, p_recipient) THEN
    RAISE EXCEPTION 'recipient_mismatch' USING ERRCODE = '22023';
  END IF;
  UPDATE public.pay_bills SET
    proposal_dao = public.pay_clip(p_dao, 80),
    proposal_index = p_index,
    proposal_chain = public.pay_clip(p_chain, 20),
    proposal_amount_cents = p_amount_cents,
    proposal_recipient = public.pay_clip(p_recipient, 200),
    proposal_payment_id = NULL,
    updated_at = now()
  WHERE id = p_bill;
  PERFORM public.pay_activity_add(
    bill.treasury_group_id,
    'bill_proposal',
    left(public.pay_safe_text('Treasury proposal ' || p_index::text || ' opened for ' || coalesce(vendor_name, '')), 500),
    NULL
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_confirm_bill_proposal(p_bill uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bill public.pay_bills%ROWTYPE;
  vendor_name text;
  vendor_address text;
  paid bigint;
  cash uuid;
  payment_id uuid;
BEGIN
  SELECT * INTO bill FROM public.pay_bills WHERE id = p_bill FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(bill.treasury_group_id);
  IF bill.proposal_payment_id IS NOT NULL THEN
    RETURN bill.proposal_payment_id;
  END IF;
  IF bill.proposal_index IS NULL OR bill.proposal_amount_cents IS NULL OR btrim(bill.proposal_recipient) = '' THEN
    RAISE EXCEPTION 'proposal_missing' USING ERRCODE = '22023';
  END IF;
  IF bill.status = 'void' THEN
    RAISE EXCEPTION 'bill_void' USING ERRCODE = '22023';
  END IF;
  SELECT name, payment_address INTO vendor_name, vendor_address
  FROM public.pay_vendors
  WHERE id = bill.vendor_id;
  IF NOT public.pay_same_payee(vendor_address, bill.proposal_recipient) THEN
    RAISE EXCEPTION 'recipient_mismatch' USING ERRCODE = '22023';
  END IF;
  paid := public.pay_bill_paid(p_bill);
  IF bill.proposal_amount_cents > bill.amount_cents - paid THEN
    RAISE EXCEPTION 'payment_exceeds_balance' USING ERRCODE = '22023';
  END IF;
  cash := public.pay_account_id(bill.treasury_group_id, '1200');
  IF cash IS NULL THEN
    RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.pay_bill_payments (
    treasury_group_id, bill_id, paid_on, amount_cents, method, reference, notes, cash_account_id
  ) VALUES (
    bill.treasury_group_id,
    p_bill,
    CURRENT_DATE,
    bill.proposal_amount_cents,
    'Treasury',
    'proposal:' || bill.proposal_index::text,
    'Recorded after the governance proposal executed',
    cash
  ) RETURNING id INTO payment_id;
  UPDATE public.pay_bills SET proposal_payment_id = payment_id, updated_at = now() WHERE id = p_bill;
  PERFORM public.pay_activity_add(
    bill.treasury_group_id,
    'bill_payment',
    left(public.pay_safe_text(
      'Bill payment to ' || coalesce(vendor_name, '') || ' recorded after proposal ' || bill.proposal_index::text
    ), 500),
    NULL
  );
  PERFORM public.pay_sync_payable_journals(bill.treasury_group_id);
  RETURN payment_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Deposits and expenses
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_save_cash_entry(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  eid uuid;
  direction text;
  amount_cents bigint;
  entry_date date;
  vendor_id uuid;
  account_id uuid;
  cash uuid;
  category text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  direction := p_body->>'direction';
  IF direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'invalid_direction' USING ERRCODE = '22023';
  END IF;
  entry_date := public.pay_date_in(p_body->>'date');
  amount_cents := public.pay_money_cents(coalesce(p_body->>'amount', ''), false);
  IF amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '22023';
  END IF;
  vendor_id := NULLIF(p_body->>'vendor_id', '')::uuid;
  IF vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pay_vendors WHERE id = vendor_id AND treasury_group_id = p_treasury
  ) THEN
    RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NULLIF(p_body->>'account_id', '') IS NULL THEN
    account_id := NULL;
  ELSE
    account_id := public.pay_opt_account(
      p_treasury,
      (p_body->>'account_id')::uuid,
      ARRAY['income', 'expense', 'asset', 'liability', 'equity']
    );
  END IF;
  IF NULLIF(p_body->>'cash_account_id', '') IS NULL THEN
    cash := NULL;
  ELSE
    cash := public.pay_opt_account(
      p_treasury,
      (p_body->>'cash_account_id')::uuid,
      ARRAY['asset', 'liability']
    );
  END IF;
  category := public.pay_clip(p_body->>'category', 80);
  eid := NULLIF(p_body->>'id', '')::uuid;
  IF eid IS NULL THEN
    INSERT INTO public.pay_cash_entries (
      treasury_group_id, entry_date, direction, amount_cents, category, counterparty,
      method, reference, memo, account_id, cash_account_id, vendor_id
    ) VALUES (
      p_treasury,
      entry_date,
      direction,
      amount_cents,
      category,
      public.pay_clip(p_body->>'counterparty', 200),
      public.pay_clip(p_body->>'method', 60),
      public.pay_clip(p_body->>'reference', 200),
      public.pay_clip(p_body->>'memo', 2000),
      account_id,
      cash,
      vendor_id
    ) RETURNING id INTO eid;
  ELSE
    UPDATE public.pay_cash_entries SET
      entry_date = entry_date,
      direction = direction,
      amount_cents = amount_cents,
      category = category,
      counterparty = public.pay_clip(p_body->>'counterparty', 200),
      method = public.pay_clip(p_body->>'method', 60),
      reference = public.pay_clip(p_body->>'reference', 200),
      memo = public.pay_clip(p_body->>'memo', 2000),
      account_id = account_id,
      cash_account_id = cash,
      vendor_id = vendor_id,
      updated_at = now()
    WHERE id = eid
      AND treasury_group_id = p_treasury;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  PERFORM public.pay_activity_add(
    p_treasury,
    'cash',
    left(public.pay_safe_text(CASE WHEN direction = 'in' THEN 'Deposit' ELSE 'Expense' END || CASE WHEN category <> '' THEN ' · ' || category ELSE '' END), 500),
    NULL
  );
  PERFORM public.pay_sync_payable_journals(p_treasury);
  RETURN eid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_cash_entry(p_entry uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  row_treasury uuid;
BEGIN
  SELECT treasury_group_id INTO row_treasury FROM public.pay_cash_entries WHERE id = p_entry;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(row_treasury);
  DELETE FROM public.pay_cash_entries WHERE id = p_entry;
  PERFORM public.pay_activity_add(row_treasury, 'cash', 'Cash entry deleted', NULL);
  PERFORM public.pay_sync_payable_journals(row_treasury);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- RLS. Operators read. Token holders do not. Writes stay on the functions.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_bill_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_cash_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read vendors" ON public.pay_vendors;
CREATE POLICY "Pay operators read vendors"
  ON public.pay_vendors FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read bills" ON public.pay_bills;
CREATE POLICY "Pay operators read bills"
  ON public.pay_bills FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read bill payments" ON public.pay_bill_payments;
CREATE POLICY "Pay operators read bill payments"
  ON public.pay_bill_payments FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read cash entries" ON public.pay_cash_entries;
CREATE POLICY "Pay operators read cash entries"
  ON public.pay_cash_entries FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_vendors FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_bills FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_bill_payments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_cash_entries FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_vendors TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_bills TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_bill_payments TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_cash_entries TO anon, authenticated;

GRANT ALL ON TABLE public.pay_vendors TO service_role;
GRANT ALL ON TABLE public.pay_bills TO service_role;
GRANT ALL ON TABLE public.pay_bill_payments TO service_role;
GRANT ALL ON TABLE public.pay_cash_entries TO service_role;

REVOKE ALL ON FUNCTION public.pay_clip(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_safe_text(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_category_code(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_account_if(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_opt_account(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_resolve_cash(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_bill_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_same_payee(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_sync_payable_journals(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.pay_save_vendor(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_vendor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_save_bill(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_set_bill_status(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_bill(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_record_bill_payment(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_bill_payment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_link_bill_proposal(uuid, text, integer, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_confirm_bill_proposal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_save_cash_entry(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_cash_entry(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pay_save_vendor(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_vendor(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_save_bill(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_set_bill_status(uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_bill(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_record_bill_payment(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_bill_payment(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_link_bill_proposal(uuid, text, integer, text, bigint, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_confirm_bill_proposal(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_save_cash_entry(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_cash_entry(uuid) TO anon, authenticated, service_role;
