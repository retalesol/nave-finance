-- Nave Pay payroll and hiring.
-- Records wages, withholding, and net pay. Does not originate ACH or move money.
-- Tenant is treasury_group_id. Operators are x-wallet-address matched to
-- creator_wallet or dao_authorized_wallets, same as the other pay tables.
--
-- Tax ids and direct-deposit account numbers are encrypted with pgcrypto
-- before insert. Employee rows keep a last-4 and a SHA-256 only. Audit text
-- stores that hash. The key table has no client policies.

-- ---------------------------------------------------------------------------
-- Allow paystub journals on the books ledger, when that ledger exists.
-- ---------------------------------------------------------------------------

DO $payroll_journal_source$
DECLARE
  cname text;
  def text;
BEGIN
  IF to_regclass('public.pay_journal_entries') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_constraintdef(oid), conname
  INTO def, cname
  FROM pg_constraint
  WHERE conrelid = 'public.pay_journal_entries'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%source_type%'
  LIMIT 1;
  IF def ILIKE '%paystub%' THEN
    RETURN;
  END IF;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.pay_journal_entries DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE public.pay_journal_entries
    ADD CONSTRAINT pay_journal_entries_source_type_check
    CHECK (source_type IN ('invoice', 'payment', 'paystub'));
END
$payroll_journal_source$;

-- ---------------------------------------------------------------------------
-- Keys and secrets. No SELECT for anon or authenticated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_payroll_keys (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  kek text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_payroll_keys IS
  'Per-treasury key for payroll identifier encryption. No client policy. Service role and security-definer functions only.';

CREATE TABLE IF NOT EXISTS public.pay_employee_secrets (
  employee_id uuid PRIMARY KEY,
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  tin_ciphertext bytea,
  dd_ciphertext bytea,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_employee_secrets IS
  'pgp_sym_encrypt ciphertext for the tax id and the direct-deposit account number. Last-4 and SHA-256 live on pay_employees. Clients cannot select this table.';

-- ---------------------------------------------------------------------------
-- People, runs, hiring
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('w2', '1099')),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'terminated')),
  first_name text NOT NULL DEFAULT '',
  middle_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  business_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address1 text NOT NULL DEFAULT '',
  address2 text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  zip text NOT NULL DEFAULT '',
  tin_type text NOT NULL DEFAULT 'SSN' CHECK (tin_type IN ('SSN', 'EIN', 'ITIN')),
  tin_last4 text NOT NULL DEFAULT '',
  tin_hash text NOT NULL DEFAULT '',
  employee_no text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  department text NOT NULL DEFAULT '',
  hire_date date,
  term_date date,
  birth_year integer NOT NULL DEFAULT 0,
  is_officer boolean NOT NULL DEFAULT false,
  flsa_exempt boolean NOT NULL DEFAULT false,
  pay_type text NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary', 'hourly')),
  pay_rate_cents bigint NOT NULL DEFAULT 0 CHECK (pay_rate_cents >= 0),
  frequency text NOT NULL DEFAULT 'semimonthly' CHECK (frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  std_hours_e2 integer NOT NULL DEFAULT 0,
  work_state text NOT NULL DEFAULT 'CA',
  w4_version text NOT NULL DEFAULT '2020' CHECK (w4_version IN ('2020', 'legacy')),
  fed_status text NOT NULL DEFAULT 'single' CHECK (fed_status IN ('single', 'mfj', 'hoh')),
  fed_step2 boolean NOT NULL DEFAULT false,
  fed_dependents_cents bigint NOT NULL DEFAULT 0 CHECK (fed_dependents_cents >= 0),
  fed_other_income_cents bigint NOT NULL DEFAULT 0 CHECK (fed_other_income_cents >= 0),
  fed_deductions_cents bigint NOT NULL DEFAULT 0 CHECK (fed_deductions_cents >= 0),
  fed_extra_cents bigint NOT NULL DEFAULT 0 CHECK (fed_extra_cents >= 0),
  fed_exempt boolean NOT NULL DEFAULT false,
  fed_allowances integer NOT NULL DEFAULT 0 CHECK (fed_allowances BETWEEN 0 AND 99),
  st_status text NOT NULL DEFAULT 'single' CHECK (st_status IN ('single', 'married', 'hoh')),
  st_allowances integer NOT NULL DEFAULT 0 CHECK (st_allowances BETWEEN 0 AND 99),
  st_est_allowances integer NOT NULL DEFAULT 0 CHECK (st_est_allowances BETWEEN 0 AND 99),
  st_extra_cents bigint NOT NULL DEFAULT 0 CHECK (st_extra_cents >= 0),
  st_exempt boolean NOT NULL DEFAULT false,
  st_flat_bp integer NOT NULL DEFAULT 0 CHECK (st_flat_bp BETWEEN 0 AND 2000),
  sdi_exempt boolean NOT NULL DEFAULT false,
  fica_exempt boolean NOT NULL DEFAULT false,
  k401_type text NOT NULL DEFAULT 'none' CHECK (k401_type IN ('none', 'traditional', 'roth')),
  k401_pct_bp integer NOT NULL DEFAULT 0 CHECK (k401_pct_bp BETWEEN 0 AND 10000),
  k401_flat_cents bigint NOT NULL DEFAULT 0 CHECK (k401_flat_cents >= 0),
  k401_prior_high boolean NOT NULL DEFAULT false,
  health_pretax_cents bigint NOT NULL DEFAULT 0 CHECK (health_pretax_cents >= 0),
  health_er_cents bigint NOT NULL DEFAULT 0 CHECK (health_er_cents >= 0),
  posttax jsonb NOT NULL DEFAULT '[]'::jsonb,
  pay_method text NOT NULL DEFAULT 'direct_deposit' CHECK (pay_method IN ('direct_deposit', 'check')),
  dd_bank text NOT NULL DEFAULT '',
  dd_routing text NOT NULL DEFAULT '',
  dd_last4 text NOT NULL DEFAULT '',
  dd_account_hash text NOT NULL DEFAULT '',
  dd_type text NOT NULL DEFAULT 'checking' CHECK (dd_type IN ('checking', 'savings')),
  sick_policy text NOT NULL DEFAULT 'accrue' CHECK (sick_policy IN ('accrue', 'frontload', 'none')),
  sick_open_e2 integer NOT NULL DEFAULT 0,
  sick_cap_e2 integer NOT NULL DEFAULT 8000,
  pto_per_period_e2 integer NOT NULL DEFAULT 0,
  pto_cap_e2 integer NOT NULL DEFAULT 0,
  pto_open_e2 integer NOT NULL DEFAULT 0,
  backup_wh boolean NOT NULL DEFAULT false,
  contract_rate_cents bigint NOT NULL DEFAULT 0 CHECK (contract_rate_cents >= 0),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_employees_notes_safe CHECK (
    notes !~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' AND notes !~ '[0-9]{2}-[0-9]{7}'
  ),
  CONSTRAINT pay_employees_zip CHECK (zip = '' OR zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  CONSTRAINT pay_employees_k401_one CHECK (k401_type = 'none' OR k401_pct_bp = 0 OR k401_flat_cents = 0),
  CONSTRAINT pay_employees_state CHECK (work_state ~ '^[A-Z]{2}$')
);

CREATE INDEX IF NOT EXISTS pay_employees_group_idx
  ON public.pay_employees (treasury_group_id, status, last_name);

ALTER TABLE public.pay_employee_secrets
  DROP CONSTRAINT IF EXISTS pay_employee_secrets_employee_fk;
ALTER TABLE public.pay_employee_secrets
  ADD CONSTRAINT pay_employee_secrets_employee_fk
  FOREIGN KEY (employee_id) REFERENCES public.pay_employees (id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS public.pay_payroll_settings (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  pay_date date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  kind text NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'offcycle', 'contractor')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'void')),
  memo text NOT NULL DEFAULT '',
  cash_account_id uuid REFERENCES public.pay_accounts (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  voided_at timestamptz,
  approved_by_wallet text,
  CONSTRAINT pay_runs_period CHECK (period_start <= period_end),
  CONSTRAINT pay_runs_year CHECK (extract(year FROM pay_date) = 2026)
);

CREATE INDEX IF NOT EXISTS pay_runs_group_idx
  ON public.pay_runs (treasury_group_id, pay_date DESC);

CREATE TABLE IF NOT EXISTS public.pay_stubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.pay_runs (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.pay_employees (id),
  pay_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'void')),
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  calc jsonb NOT NULL DEFAULT '{}'::jsonb,
  gross_cents bigint NOT NULL DEFAULT 0,
  net_cents bigint NOT NULL DEFAULT 0,
  pay_method text NOT NULL DEFAULT 'direct_deposit' CHECK (pay_method IN ('direct_deposit', 'check')),
  check_number integer,
  advice_number integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_stubs_run_employee UNIQUE (run_id, employee_id),
  CONSTRAINT pay_stubs_year CHECK (extract(year FROM pay_date) = 2026)
);

CREATE INDEX IF NOT EXISTS pay_stubs_employee_idx
  ON public.pay_stubs (employee_id, pay_date);

CREATE UNIQUE INDEX IF NOT EXISTS pay_stubs_check_unique
  ON public.pay_stubs (treasury_group_id, check_number)
  WHERE check_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.pay_offer_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.pay_employees (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'withdrawn')),
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  letter_text text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  sent_at timestamptz,
  expires_on date,
  signed_at timestamptz,
  sign_method text NOT NULL DEFAULT '',
  signer_typed_name text NOT NULL DEFAULT '',
  signed_hash text NOT NULL DEFAULT '',
  decline_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pay_offer_letters_employee_idx
  ON public.pay_offer_letters (employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pay_onboarding_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.pay_employees (id) ON DELETE CASCADE,
  item text NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done', 'na')),
  done_on date,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_onboarding_items_unique UNIQUE (employee_id, item),
  CONSTRAINT pay_onboarding_items_note_safe CHECK (note !~ '[0-9]{3}-[0-9]{2}-[0-9]{4}')
);

CREATE TABLE IF NOT EXISTS public.pay_payroll_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  actor_wallet text,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  detail text NOT NULL DEFAULT '',
  identifier_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_payroll_audit_text_safe CHECK (
    detail !~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
    AND action !~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
    AND (identifier_hash = '' OR identifier_hash ~ '^[0-9a-f]{64}$')
  )
);

COMMENT ON TABLE public.pay_payroll_audit IS
  'Payroll audit. detail and identifier_hash store a SHA-256 or an action code, never the raw tax id or account number. actor_wallet is the operator wallet.';

CREATE INDEX IF NOT EXISTS pay_payroll_audit_group_idx
  ON public.pay_payroll_audit (treasury_group_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Internal helpers. Not granted to the Data API.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_actor_wallet()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  caller text;
BEGIN
  caller := NULLIF(current_setting('request.headers', true)::json->>'x-wallet-address', '');
  IF caller IS NULL THEN
    RETURN NULL;
  END IF;
  IF caller ~* '^0x[0-9a-f]{40}$' THEN
    RETURN lower(caller);
  END IF;
  RETURN caller;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_identifier_hash(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
  SELECT CASE
    WHEN p_value IS NULL OR btrim(p_value) = '' THEN ''
    ELSE encode(digest(convert_to(regexp_replace(p_value, '\s+', '', 'g'), 'UTF8'), 'sha256'), 'hex')
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_kek(p_treasury uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  existing text;
BEGIN
  SELECT kek INTO existing
  FROM public.pay_payroll_keys
  WHERE treasury_group_id = p_treasury;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;
  INSERT INTO public.pay_payroll_keys (treasury_group_id, kek)
  VALUES (p_treasury, encode(gen_random_bytes(32), 'hex'))
  ON CONFLICT (treasury_group_id) DO NOTHING;
  SELECT kek INTO existing
  FROM public.pay_payroll_keys
  WHERE treasury_group_id = p_treasury;
  RETURN existing;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_encrypt(p_treasury uuid, p_plain text)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
  IF p_plain IS NULL OR btrim(p_plain) = '' THEN
    RETURN NULL;
  END IF;
  RETURN pgp_sym_encrypt(p_plain, public.pay_payroll_kek(p_treasury));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_decrypt(p_treasury uuid, p_cipher bytea)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
  IF p_cipher IS NULL THEN
    RETURN '';
  END IF;
  -- This Postgres build's pgp_sym_decrypt returns text.
  RETURN pgp_sym_decrypt(p_cipher, public.pay_payroll_kek(p_treasury));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_aba_ok(p_routing text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  d integer[];
  i integer;
  total integer := 0;
BEGIN
  IF p_routing IS NULL OR p_routing !~ '^[0-9]{9}$' THEN
    RETURN false;
  END IF;
  FOR i IN 1..9 LOOP
    d[i] := substr(p_routing, i, 1)::integer;
  END LOOP;
  total := 3 * (d[1] + d[4] + d[7]) + 7 * (d[2] + d[5] + d[8]) + (d[3] + d[6] + d[9]);
  RETURN total % 10 = 0;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_audit_add(
  p_treasury uuid,
  p_action text,
  p_subject_type text,
  p_subject uuid,
  p_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_hash text := coalesce(p_hash, '');
BEGIN
  IF p_action ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' OR p_action ~ '[0-9]{2}-[0-9]{7}' THEN
    RAISE EXCEPTION 'audit_has_raw_identifier' USING ERRCODE = '22023';
  END IF;
  IF v_hash <> '' AND v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'audit_hash_required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pay_payroll_audit (
    treasury_group_id, actor_wallet, action, subject_type, subject_id, detail, identifier_hash
  ) VALUES (
    p_treasury,
    public.pay_actor_wallet(),
    left(p_action, 80),
    left(p_subject_type, 40),
    p_subject,
    CASE WHEN v_hash = '' THEN left(p_action, 80) ELSE v_hash END,
    v_hash
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_seed_accounts(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  rec record;
  chosen text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pay_enablement WHERE treasury_group_id = p_treasury AND enabled
  ) THEN
    RAISE EXCEPTION 'pay_not_enabled' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.pay_accounts AS account
  SET system_key = 'wages'
  WHERE account.treasury_group_id = p_treasury
    AND account.code = '6060'
    AND account.system_key IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.pay_accounts AS other
      WHERE other.treasury_group_id = p_treasury AND other.system_key = 'wages'
    );

  UPDATE public.pay_accounts AS account
  SET system_key = 'contractors'
  WHERE account.treasury_group_id = p_treasury
    AND account.code = '6050'
    AND account.system_key IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.pay_accounts AS other
      WHERE other.treasury_group_id = p_treasury AND other.system_key = 'contractors'
    );

  FOR rec IN
    SELECT *
    FROM (
      VALUES
        ('6060', 'Payroll wages', 'expense', 'expense', 'wages', '1120 L13'),
        ('6050', 'Contractors', 'expense', 'expense', 'contractors', '1120 L26'),
        ('6061', 'Officer compensation', 'expense', 'expense', 'officer_comp', '1120 L12'),
        ('6062', 'Payroll taxes', 'expense', 'expense', 'payroll_taxes', '1120 L17'),
        ('6063', 'Retirement plan contributions', 'expense', 'expense', 'pension', '1120 L23'),
        ('6064', 'Employee benefits', 'expense', 'expense', 'benefits', '1120 L24'),
        ('6065', 'Employee reimbursements', 'expense', 'expense', 'reimb', '1120 L26'),
        ('2210', 'Federal payroll taxes payable', 'liability', 'current_liability', 'pay_fed', 'Sch L 18'),
        ('2215', 'FUTA payable', 'liability', 'current_liability', 'pay_futa', 'Sch L 18'),
        ('2220', 'State income tax withheld', 'liability', 'current_liability', 'pay_state_wh', 'Sch L 18'),
        ('2225', 'State disability (SDI) withheld', 'liability', 'current_liability', 'pay_sdi', 'Sch L 18'),
        ('2230', 'State unemployment (SUI/ETT) payable', 'liability', 'current_liability', 'pay_sui', 'Sch L 18'),
        ('2240', '401(k) contributions payable', 'liability', 'current_liability', 'pay_401k', 'Sch L 18'),
        ('2245', 'Health insurance payable', 'liability', 'current_liability', 'pay_health', 'Sch L 18'),
        ('2250', 'Other payroll deductions payable', 'liability', 'current_liability', 'pay_other', 'Sch L 18'),
        ('2260', 'Wages payable', 'liability', 'current_liability', 'pay_wages', 'Sch L 18')
    ) AS chart(code, name, account_type, subtype, system_key, tax_line)
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.pay_accounts
      WHERE treasury_group_id = p_treasury AND system_key = rec.system_key
    ) THEN
      CONTINUE;
    END IF;
    chosen := rec.code;
    IF EXISTS (
      SELECT 1 FROM public.pay_accounts
      WHERE treasury_group_id = p_treasury AND code = chosen
    ) THEN
      chosen := left('p' || rec.system_key, 16);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.pay_accounts
      WHERE treasury_group_id = p_treasury AND code = chosen
    ) THEN
      CONTINUE;
    END IF;
    INSERT INTO public.pay_accounts (
      treasury_group_id, code, name, account_type, subtype, system_key, tax_line
    ) VALUES (
      p_treasury, chosen, rec.name, rec.account_type, rec.subtype, rec.system_key, rec.tax_line
    );
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_account(p_treasury uuid, p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  found uuid;
BEGIN
  SELECT id INTO found
  FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury AND system_key = p_key;
  IF found IS NULL THEN
    PERFORM public.pay_payroll_seed_accounts(p_treasury);
    SELECT id INTO found
    FROM public.pay_accounts
    WHERE treasury_group_id = p_treasury AND system_key = p_key;
  END IF;
  IF found IS NULL THEN
    RAISE EXCEPTION 'payroll_account_missing' USING ERRCODE = '23503';
  END IF;
  RETURN found;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_assert_calc(p_calc jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  gross bigint := 0;
  pretax bigint := 0;
  posttax bigint := 0;
  tax_ee bigint := 0;
  reimb bigint := 0;
  expected bigint;
  line jsonb;
BEGIN
  IF coalesce((p_calc->>'tables_year')::integer, 0) <> 2026 THEN
    RAISE EXCEPTION 'payroll_year_unsupported' USING ERRCODE = '22023';
  END IF;
  IF p_calc::text ~* '"(tin|ssn|dd_account)"' THEN
    RAISE EXCEPTION 'stub_cannot_store_identifier' USING ERRCODE = '22023';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(coalesce(p_calc->'lines', '[]'::jsonb))
  LOOP
    IF (line->>'cat') = 'earning' THEN gross := gross + coalesce((line->>'amount_cents')::bigint, 0);
    ELSIF (line->>'cat') = 'pretax' THEN pretax := pretax + coalesce((line->>'amount_cents')::bigint, 0);
    ELSIF (line->>'cat') = 'posttax' THEN posttax := posttax + coalesce((line->>'amount_cents')::bigint, 0);
    ELSIF (line->>'cat') = 'tax_ee' THEN tax_ee := tax_ee + coalesce((line->>'amount_cents')::bigint, 0);
    ELSIF (line->>'cat') = 'reimb' THEN reimb := reimb + coalesce((line->>'amount_cents')::bigint, 0);
    END IF;
  END LOOP;
  expected := gross - pretax - posttax - tax_ee + reimb;
  IF coalesce((p_calc->>'net_cents')::bigint, 0) IS DISTINCT FROM expected
     OR coalesce((p_calc->>'gross_cents')::bigint, 0) IS DISTINCT FROM gross THEN
    RAISE EXCEPTION 'stub_does_not_balance' USING ERRCODE = '23514';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_activation_blockers(p_employee uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.pay_employees%ROWTYPE;
  secret public.pay_employee_secrets%ROWTYPE;
  blockers text[] := ARRAY[]::text[];
  no_tax_states text[] := ARRAY['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY'];
BEGIN
  SELECT * INTO emp FROM public.pay_employees WHERE id = p_employee;
  IF emp.id IS NULL THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO secret FROM public.pay_employee_secrets WHERE employee_id = emp.id;

  IF emp.kind = '1099' THEN
    IF secret.tin_ciphertext IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.pay_onboarding_items
      WHERE employee_id = emp.id AND item = 'w9' AND status IN ('done', 'na')
    ) THEN
      blockers := blockers || 'Form W-9 received';
    END IF;
    RETURN blockers;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.pay_onboarding_items
    WHERE employee_id = emp.id AND item = 'w4' AND status IN ('done', 'na')
  ) THEN
    blockers := blockers || 'Form W-4 received and entered';
  END IF;
  IF emp.work_state = 'CA' AND NOT EXISTS (
    SELECT 1 FROM public.pay_onboarding_items
    WHERE employee_id = emp.id AND item = 'de4' AND status IN ('done', 'na')
  ) THEN
    blockers := blockers || 'Form DE 4 received and entered';
  END IF;
  IF emp.work_state <> 'CA' AND NOT (emp.work_state = ANY (no_tax_states)) AND NOT EXISTS (
    SELECT 1 FROM public.pay_onboarding_items
    WHERE employee_id = emp.id AND item = 'state_w4' AND status IN ('done', 'na')
  ) THEN
    blockers := blockers || 'State withholding form entered';
  END IF;
  IF secret.tin_ciphertext IS NULL THEN
    blockers := blockers || 'SSN on the employee record';
  END IF;
  IF emp.pay_rate_cents <= 0 AND NOT emp.is_officer THEN
    blockers := blockers || 'Pay rate';
  END IF;
  IF emp.address1 = '' OR emp.city = '' OR emp.zip = '' THEN
    blockers := blockers || 'Home address';
  END IF;
  IF emp.pay_method = 'direct_deposit' AND (emp.dd_routing = '' OR secret.dd_ciphertext IS NULL) THEN
    blockers := blockers || 'Direct deposit account, or switch to a paper check';
  END IF;
  RETURN blockers;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_post_stub(p_stub uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  stub public.pay_stubs%ROWTYPE;
  run public.pay_runs%ROWTYPE;
  emp public.pay_employees%ROWTYPE;
  line jsonb;
  entry uuid;
  n integer := 0;
  dr bigint := 0;
  cr bigint := 0;
  acct uuid;
  amt bigint;
  cat text;
  wage_key text;
  cash uuid;
  memo text;
BEGIN
  IF to_regclass('public.pay_journal_entries') IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO stub FROM public.pay_stubs WHERE id = p_stub;
  SELECT * INTO run FROM public.pay_runs WHERE id = stub.run_id;
  SELECT * INTO emp FROM public.pay_employees WHERE id = stub.employee_id;
  PERFORM public.pay_payroll_seed_accounts(stub.treasury_group_id);

  wage_key := CASE
    WHEN emp.kind = '1099' THEN 'contractors'
    WHEN emp.is_officer THEN 'officer_comp'
    ELSE 'wages'
  END;

  INSERT INTO public.pay_journal_entries (
    treasury_group_id, entry_date, memo, ref, party, source_type, source_id
  ) VALUES (
    stub.treasury_group_id,
    stub.pay_date,
    'Payroll ' || to_char(run.period_start, 'YYYY-MM-DD') || ' to ' || to_char(run.period_end, 'YYYY-MM-DD') || '. Net pay recorded, not sent.',
    CASE WHEN stub.check_number IS NOT NULL THEN 'CHK ' || stub.check_number::text ELSE 'STUB' END,
    left(btrim(concat_ws(' ', nullif(emp.business_name, ''), emp.first_name, emp.last_name)), 200),
    'paystub',
    stub.id
  ) RETURNING id INTO entry;

  FOR line IN SELECT value FROM jsonb_array_elements(coalesce(stub.calc->'lines', '[]'::jsonb))
  LOOP
    amt := coalesce((line->>'amount_cents')::bigint, 0);
    IF amt = 0 THEN
      CONTINUE;
    END IF;
    cat := line->>'cat';
    memo := left(coalesce(line->>'label', ''), 200);
    IF cat = 'earning' THEN
      acct := public.pay_payroll_account(stub.treasury_group_id, wage_key);
      n := n + 1;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (stub.treasury_group_id, entry, n, acct, amt, 0, 'Gross pay');
      dr := dr + amt;
    ELSIF cat = 'reimb' THEN
      acct := NULL;
      IF coalesce(line->>'account_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT id INTO acct FROM public.pay_accounts
        WHERE id = (line->>'account_id')::uuid
          AND treasury_group_id = stub.treasury_group_id
          AND account_type = 'expense';
      END IF;
      IF acct IS NULL THEN
        acct := public.pay_payroll_account(stub.treasury_group_id, 'reimb');
      END IF;
      n := n + 1;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (stub.treasury_group_id, entry, n, acct, amt, 0, memo);
      dr := dr + amt;
    ELSIF cat IN ('pretax', 'posttax', 'tax_ee') THEN
      acct := public.pay_payroll_account(stub.treasury_group_id, coalesce(nullif(line->>'liab', ''), 'pay_other'));
      n := n + 1;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (stub.treasury_group_id, entry, n, acct, 0, amt, memo);
      cr := cr + amt;
    ELSIF cat = 'tax_er' THEN
      acct := public.pay_payroll_account(stub.treasury_group_id, coalesce(nullif(line->>'exp', ''), 'payroll_taxes'));
      n := n + 1;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (stub.treasury_group_id, entry, n, acct, amt, 0, memo);
      dr := dr + amt;
      acct := public.pay_payroll_account(stub.treasury_group_id, coalesce(nullif(line->>'liab', ''), 'pay_other'));
      n := n + 1;
      INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
      VALUES (stub.treasury_group_id, entry, n, acct, 0, amt, memo);
      cr := cr + amt;
    END IF;
  END LOOP;

  amt := coalesce((stub.calc->>'net_cents')::bigint, 0);
  IF amt > 0 THEN
    cash := NULL;
    IF run.cash_account_id IS NOT NULL THEN
      SELECT id INTO cash FROM public.pay_accounts
      WHERE id = run.cash_account_id
        AND treasury_group_id = stub.treasury_group_id
        AND account_type = 'asset';
    END IF;
    IF cash IS NULL THEN
      cash := public.pay_payroll_account(stub.treasury_group_id, 'pay_wages');
    END IF;
    n := n + 1;
    INSERT INTO public.pay_journal_lines (treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo)
    VALUES (stub.treasury_group_id, entry, n, cash, 0, amt, 'Net pay recorded, not sent');
    cr := cr + amt;
  END IF;

  IF dr <> cr THEN
    RAISE EXCEPTION 'payroll_journal_unbalanced' USING ERRCODE = '23514';
  END IF;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_payroll_save_employee(p_treasury uuid, p_body jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.pay_employees%ROWTYPE;
  secret public.pay_employee_secrets%ROWTYPE;
  eid uuid;
  v_kind text;
  v_status text;
  v_tin_type text;
  v_tin text;
  v_tin_digits text;
  v_account text;
  v_routing text;
  v_hash text;
  v_posttax jsonb;
  v_keep_tin boolean;
  v_keep_account boolean;
  v_was_active boolean := false;
  blockers text[];
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  PERFORM public.pay_payroll_seed_accounts(p_treasury);

  eid := NULLIF(p_body->>'id', '')::uuid;
  IF eid IS NOT NULL THEN
    SELECT * INTO emp FROM public.pay_employees
    WHERE id = eid AND treasury_group_id = p_treasury;
    IF emp.id IS NULL THEN
      RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO secret FROM public.pay_employee_secrets WHERE employee_id = emp.id;
  END IF;

  v_kind := CASE
    WHEN emp.id IS NOT NULL THEN emp.kind
    WHEN p_body->>'kind' = '1099' THEN '1099'
    ELSE 'w2'
  END;
  IF emp.id IS NOT NULL AND p_body->>'kind' IS NOT NULL AND p_body->>'kind' <> emp.kind
     AND EXISTS (SELECT 1 FROM public.pay_stubs WHERE employee_id = emp.id) THEN
    RAISE EXCEPTION 'kind_locked' USING ERRCODE = '22023';
  END IF;

  v_status := CASE
    WHEN p_body->>'status' IN ('candidate', 'active', 'terminated') THEN p_body->>'status'
    ELSE coalesce(emp.status, 'candidate')
  END;
  IF emp.id IS NOT NULL AND emp.status <> 'candidate' AND v_status = 'candidate' THEN
    RAISE EXCEPTION 'status_cannot_revert' USING ERRCODE = '22023';
  END IF;
  v_was_active := emp.id IS NOT NULL AND emp.status = 'active';
  IF v_kind = 'w2' AND btrim(coalesce(p_body->>'first_name', emp.first_name, '')) = '' THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'w2' AND btrim(coalesce(p_body->>'last_name', emp.last_name, '')) = '' THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF v_kind = '1099'
     AND btrim(coalesce(p_body->>'business_name', '')) = ''
     AND (btrim(coalesce(p_body->>'first_name', '')) = '' OR btrim(coalesce(p_body->>'last_name', '')) = '') THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'terminated' AND btrim(coalesce(p_body->>'term_date', '')) = '' AND emp.term_date IS NULL THEN
    RAISE EXCEPTION 'term_date_required' USING ERRCODE = '22023';
  END IF;

  v_tin_type := CASE
    WHEN p_body->>'tin_type' IN ('SSN', 'EIN', 'ITIN') THEN p_body->>'tin_type'
    ELSE coalesce(emp.tin_type, 'SSN')
  END;
  v_tin := coalesce(p_body->>'tin', '');
  v_keep_tin := v_tin = '' OR position('•' IN v_tin) > 0 OR position('*' IN v_tin) > 0;
  IF NOT v_keep_tin THEN
    v_tin_digits := regexp_replace(v_tin, '\D', '', 'g');
    IF length(v_tin_digits) <> 9 THEN
      RAISE EXCEPTION 'invalid_tax_id' USING ERRCODE = '22023';
    END IF;
    IF v_tin_type <> 'EIN' AND (
      left(v_tin_digits, 3) IN ('000', '666')
      OR substr(v_tin_digits, 4, 2) = '00'
      OR right(v_tin_digits, 4) = '0000'
      OR (v_tin_type = 'SSN' AND left(v_tin_digits, 1) = '9')
    ) THEN
      RAISE EXCEPTION 'invalid_tax_id' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_account := coalesce(p_body->>'dd_account', '');
  v_keep_account := v_account = '' OR position('•' IN v_account) > 0 OR position('*' IN v_account) > 0;
  IF NOT v_keep_account THEN
    v_account := regexp_replace(v_account, '\s', '', 'g');
    IF v_account !~ '^[0-9]{4,17}$' THEN
      RAISE EXCEPTION 'invalid_account_number' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_routing := regexp_replace(coalesce(p_body->>'dd_routing', emp.dd_routing, ''), '\D', '', 'g');
  IF v_routing <> '' AND NOT public.pay_payroll_aba_ok(v_routing) THEN
    RAISE EXCEPTION 'invalid_routing' USING ERRCODE = '22023';
  END IF;

  IF coalesce(p_body->>'work_state', emp.work_state, 'CA') = 'CA'
     AND v_kind = 'w2'
     AND coalesce(p_body->>'sick_policy', emp.sick_policy, 'accrue') = 'none' THEN
    RAISE EXCEPTION 'ca_sick_leave_required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_body->>'work_state', emp.work_state, 'CA') = 'CA'
     AND v_kind = 'w2'
     AND coalesce(p_body->>'sick_policy', emp.sick_policy, 'accrue') = 'accrue'
     AND coalesce((p_body->>'sick_cap_e2')::integer, emp.sick_cap_e2, 8000) < 8000 THEN
    RAISE EXCEPTION 'ca_sick_cap' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'label', left(btrim(item->>'label'), 60),
    'amount_cents', coalesce((item->>'amount_cents')::bigint, 0),
    'garnishment', coalesce((item->>'garnishment')::boolean, false)
  )), '[]'::jsonb)
  INTO v_posttax
  FROM jsonb_array_elements(coalesce(p_body->'posttax', '[]'::jsonb)) AS item
  WHERE btrim(coalesce(item->>'label', '')) <> '';
  IF v_posttax::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' OR v_posttax::text ~ '[0-9]{8,}' THEN
    RAISE EXCEPTION 'deduction_label_has_identifier' USING ERRCODE = '22023';
  END IF;

  IF emp.id IS NULL THEN
    INSERT INTO public.pay_employees (
      treasury_group_id, kind, status, first_name, middle_name, last_name, business_name,
      email, phone, address1, address2, city, state, zip, tin_type, employee_no, title, department,
      hire_date, term_date, birth_year, is_officer, flsa_exempt, pay_type, pay_rate_cents, frequency,
      std_hours_e2, work_state, w4_version, fed_status, fed_step2, fed_dependents_cents,
      fed_other_income_cents, fed_deductions_cents, fed_extra_cents, fed_exempt, fed_allowances,
      st_status, st_allowances, st_est_allowances, st_extra_cents, st_exempt, st_flat_bp,
      sdi_exempt, fica_exempt, k401_type, k401_pct_bp, k401_flat_cents, k401_prior_high,
      health_pretax_cents, health_er_cents, posttax, pay_method, dd_bank, dd_routing, dd_type,
      sick_policy, sick_open_e2, sick_cap_e2, pto_per_period_e2, pto_cap_e2, pto_open_e2,
      backup_wh, contract_rate_cents, notes
    ) VALUES (
      p_treasury, v_kind, v_status,
      left(btrim(coalesce(p_body->>'first_name', '')), 80),
      left(btrim(coalesce(p_body->>'middle_name', '')), 40),
      left(btrim(coalesce(p_body->>'last_name', '')), 80),
      left(btrim(coalesce(p_body->>'business_name', '')), 160),
      left(btrim(coalesce(p_body->>'email', '')), 160),
      left(btrim(coalesce(p_body->>'phone', '')), 40),
      left(btrim(coalesce(p_body->>'address1', '')), 160),
      left(btrim(coalesce(p_body->>'address2', '')), 160),
      left(btrim(coalesce(p_body->>'city', '')), 80),
      upper(left(btrim(coalesce(p_body->>'state', '')), 2)),
      left(btrim(coalesce(p_body->>'zip', '')), 10),
      v_tin_type,
      left(btrim(coalesce(p_body->>'employee_no', '')), 20),
      left(btrim(coalesce(p_body->>'title', '')), 80),
      left(btrim(coalesce(p_body->>'department', '')), 80),
      CASE WHEN btrim(coalesce(p_body->>'hire_date', '')) = '' THEN NULL ELSE (p_body->>'hire_date')::date END,
      CASE WHEN btrim(coalesce(p_body->>'term_date', '')) = '' THEN NULL ELSE (p_body->>'term_date')::date END,
      coalesce((p_body->>'birth_year')::integer, 0),
      coalesce((p_body->>'is_officer')::boolean, false),
      coalesce((p_body->>'flsa_exempt')::boolean, false),
      CASE WHEN p_body->>'pay_type' IN ('salary', 'hourly') THEN p_body->>'pay_type' ELSE 'salary' END,
      coalesce((p_body->>'pay_rate_cents')::bigint, 0),
      CASE WHEN p_body->>'frequency' IN ('weekly', 'biweekly', 'semimonthly', 'monthly') THEN p_body->>'frequency' ELSE 'semimonthly' END,
      coalesce((p_body->>'std_hours_e2')::integer, 0),
      upper(left(coalesce(nullif(p_body->>'work_state', ''), 'CA'), 2)),
      CASE WHEN p_body->>'w4_version' IN ('2020', 'legacy') THEN p_body->>'w4_version' ELSE '2020' END,
      CASE WHEN p_body->>'fed_status' IN ('single', 'mfj', 'hoh') THEN p_body->>'fed_status' ELSE 'single' END,
      coalesce((p_body->>'fed_step2')::boolean, false),
      coalesce((p_body->>'fed_dependents_cents')::bigint, 0),
      coalesce((p_body->>'fed_other_income_cents')::bigint, 0),
      coalesce((p_body->>'fed_deductions_cents')::bigint, 0),
      coalesce((p_body->>'fed_extra_cents')::bigint, 0),
      coalesce((p_body->>'fed_exempt')::boolean, false),
      coalesce((p_body->>'fed_allowances')::integer, 0),
      CASE WHEN p_body->>'st_status' IN ('single', 'married', 'hoh') THEN p_body->>'st_status' ELSE 'single' END,
      coalesce((p_body->>'st_allowances')::integer, 0),
      coalesce((p_body->>'st_est_allowances')::integer, 0),
      coalesce((p_body->>'st_extra_cents')::bigint, 0),
      coalesce((p_body->>'st_exempt')::boolean, false),
      coalesce((p_body->>'st_flat_bp')::integer, 0),
      coalesce((p_body->>'sdi_exempt')::boolean, false),
      coalesce((p_body->>'fica_exempt')::boolean, false),
      CASE WHEN p_body->>'k401_type' IN ('none', 'traditional', 'roth') THEN p_body->>'k401_type' ELSE 'none' END,
      coalesce((p_body->>'k401_pct_bp')::integer, 0),
      coalesce((p_body->>'k401_flat_cents')::bigint, 0),
      coalesce((p_body->>'k401_prior_high')::boolean, false),
      coalesce((p_body->>'health_pretax_cents')::bigint, 0),
      coalesce((p_body->>'health_er_cents')::bigint, 0),
      v_posttax,
      CASE WHEN p_body->>'pay_method' IN ('direct_deposit', 'check') THEN p_body->>'pay_method' ELSE 'direct_deposit' END,
      left(btrim(coalesce(p_body->>'dd_bank', '')), 80),
      v_routing,
      CASE WHEN p_body->>'dd_type' IN ('checking', 'savings') THEN p_body->>'dd_type' ELSE 'checking' END,
      CASE WHEN p_body->>'sick_policy' IN ('accrue', 'frontload', 'none') THEN p_body->>'sick_policy' ELSE 'accrue' END,
      coalesce((p_body->>'sick_open_e2')::integer, 0),
      coalesce((p_body->>'sick_cap_e2')::integer, 8000),
      coalesce((p_body->>'pto_per_period_e2')::integer, 0),
      coalesce((p_body->>'pto_cap_e2')::integer, 0),
      coalesce((p_body->>'pto_open_e2')::integer, 0),
      coalesce((p_body->>'backup_wh')::boolean, false),
      coalesce((p_body->>'contract_rate_cents')::bigint, 0),
      left(coalesce(p_body->>'notes', ''), 2000)
    ) RETURNING * INTO emp;
  ELSE
    UPDATE public.pay_employees SET
      status = v_status,
      first_name = left(btrim(coalesce(p_body->>'first_name', first_name)), 80),
      middle_name = left(btrim(coalesce(p_body->>'middle_name', middle_name)), 40),
      last_name = left(btrim(coalesce(p_body->>'last_name', last_name)), 80),
      business_name = left(btrim(coalesce(p_body->>'business_name', business_name)), 160),
      email = left(btrim(coalesce(p_body->>'email', email)), 160),
      phone = left(btrim(coalesce(p_body->>'phone', phone)), 40),
      address1 = left(btrim(coalesce(p_body->>'address1', address1)), 160),
      address2 = left(btrim(coalesce(p_body->>'address2', address2)), 160),
      city = left(btrim(coalesce(p_body->>'city', city)), 80),
      state = upper(left(btrim(coalesce(p_body->>'state', state)), 2)),
      zip = left(btrim(coalesce(p_body->>'zip', zip)), 10),
      tin_type = v_tin_type,
      employee_no = left(btrim(coalesce(p_body->>'employee_no', employee_no)), 20),
      title = left(btrim(coalesce(p_body->>'title', title)), 80),
      department = left(btrim(coalesce(p_body->>'department', department)), 80),
      hire_date = CASE WHEN btrim(coalesce(p_body->>'hire_date', '')) = '' THEN hire_date ELSE (p_body->>'hire_date')::date END,
      term_date = CASE WHEN btrim(coalesce(p_body->>'term_date', '')) = '' THEN term_date ELSE (p_body->>'term_date')::date END,
      birth_year = coalesce((p_body->>'birth_year')::integer, birth_year),
      is_officer = coalesce((p_body->>'is_officer')::boolean, is_officer),
      flsa_exempt = coalesce((p_body->>'flsa_exempt')::boolean, flsa_exempt),
      pay_type = CASE WHEN p_body->>'pay_type' IN ('salary', 'hourly') THEN p_body->>'pay_type' ELSE pay_type END,
      pay_rate_cents = coalesce((p_body->>'pay_rate_cents')::bigint, pay_rate_cents),
      frequency = CASE WHEN p_body->>'frequency' IN ('weekly', 'biweekly', 'semimonthly', 'monthly') THEN p_body->>'frequency' ELSE frequency END,
      std_hours_e2 = coalesce((p_body->>'std_hours_e2')::integer, std_hours_e2),
      work_state = upper(left(coalesce(nullif(p_body->>'work_state', ''), work_state), 2)),
      w4_version = CASE WHEN p_body->>'w4_version' IN ('2020', 'legacy') THEN p_body->>'w4_version' ELSE w4_version END,
      fed_status = CASE WHEN p_body->>'fed_status' IN ('single', 'mfj', 'hoh') THEN p_body->>'fed_status' ELSE fed_status END,
      fed_step2 = coalesce((p_body->>'fed_step2')::boolean, fed_step2),
      fed_dependents_cents = coalesce((p_body->>'fed_dependents_cents')::bigint, fed_dependents_cents),
      fed_other_income_cents = coalesce((p_body->>'fed_other_income_cents')::bigint, fed_other_income_cents),
      fed_deductions_cents = coalesce((p_body->>'fed_deductions_cents')::bigint, fed_deductions_cents),
      fed_extra_cents = coalesce((p_body->>'fed_extra_cents')::bigint, fed_extra_cents),
      fed_exempt = coalesce((p_body->>'fed_exempt')::boolean, fed_exempt),
      fed_allowances = coalesce((p_body->>'fed_allowances')::integer, fed_allowances),
      st_status = CASE WHEN p_body->>'st_status' IN ('single', 'married', 'hoh') THEN p_body->>'st_status' ELSE st_status END,
      st_allowances = coalesce((p_body->>'st_allowances')::integer, st_allowances),
      st_est_allowances = coalesce((p_body->>'st_est_allowances')::integer, st_est_allowances),
      st_extra_cents = coalesce((p_body->>'st_extra_cents')::bigint, st_extra_cents),
      st_exempt = coalesce((p_body->>'st_exempt')::boolean, st_exempt),
      st_flat_bp = coalesce((p_body->>'st_flat_bp')::integer, st_flat_bp),
      sdi_exempt = coalesce((p_body->>'sdi_exempt')::boolean, sdi_exempt),
      fica_exempt = coalesce((p_body->>'fica_exempt')::boolean, fica_exempt),
      k401_type = CASE WHEN p_body->>'k401_type' IN ('none', 'traditional', 'roth') THEN p_body->>'k401_type' ELSE k401_type END,
      k401_pct_bp = coalesce((p_body->>'k401_pct_bp')::integer, k401_pct_bp),
      k401_flat_cents = coalesce((p_body->>'k401_flat_cents')::bigint, k401_flat_cents),
      k401_prior_high = coalesce((p_body->>'k401_prior_high')::boolean, k401_prior_high),
      health_pretax_cents = coalesce((p_body->>'health_pretax_cents')::bigint, health_pretax_cents),
      health_er_cents = coalesce((p_body->>'health_er_cents')::bigint, health_er_cents),
      posttax = v_posttax,
      pay_method = CASE WHEN p_body->>'pay_method' IN ('direct_deposit', 'check') THEN p_body->>'pay_method' ELSE pay_method END,
      dd_bank = left(btrim(coalesce(p_body->>'dd_bank', dd_bank)), 80),
      dd_routing = v_routing,
      dd_type = CASE WHEN p_body->>'dd_type' IN ('checking', 'savings') THEN p_body->>'dd_type' ELSE dd_type END,
      sick_policy = CASE WHEN p_body->>'sick_policy' IN ('accrue', 'frontload', 'none') THEN p_body->>'sick_policy' ELSE sick_policy END,
      sick_open_e2 = coalesce((p_body->>'sick_open_e2')::integer, sick_open_e2),
      sick_cap_e2 = coalesce((p_body->>'sick_cap_e2')::integer, sick_cap_e2),
      pto_per_period_e2 = coalesce((p_body->>'pto_per_period_e2')::integer, pto_per_period_e2),
      pto_cap_e2 = coalesce((p_body->>'pto_cap_e2')::integer, pto_cap_e2),
      pto_open_e2 = coalesce((p_body->>'pto_open_e2')::integer, pto_open_e2),
      backup_wh = coalesce((p_body->>'backup_wh')::boolean, backup_wh),
      contract_rate_cents = coalesce((p_body->>'contract_rate_cents')::bigint, contract_rate_cents),
      notes = left(coalesce(p_body->>'notes', notes), 2000),
      updated_at = now()
    WHERE id = emp.id
    RETURNING * INTO emp;
  END IF;

  IF NOT v_keep_tin THEN
    v_hash := public.pay_payroll_identifier_hash(v_tin_digits);
    UPDATE public.pay_employees
    SET tin_last4 = right(v_tin_digits, 4), tin_hash = v_hash, updated_at = now()
    WHERE id = emp.id;
    INSERT INTO public.pay_employee_secrets (employee_id, treasury_group_id, tin_ciphertext, dd_ciphertext)
    VALUES (emp.id, p_treasury, public.pay_payroll_encrypt(p_treasury, v_tin_digits), secret.dd_ciphertext)
    ON CONFLICT (employee_id) DO UPDATE
      SET tin_ciphertext = EXCLUDED.tin_ciphertext, updated_at = now();
    PERFORM public.pay_payroll_audit_add(p_treasury, 'tax_identifier_updated', 'employee', emp.id, v_hash);
    IF to_regclass('public.pay_activity') IS NOT NULL THEN
      PERFORM public.pay_activity_add(p_treasury, 'payroll_identifier', 'Payroll tax identifier updated ' || v_hash, NULL);
    END IF;
  ELSIF secret.employee_id IS NULL THEN
    INSERT INTO public.pay_employee_secrets (employee_id, treasury_group_id)
    VALUES (emp.id, p_treasury)
    ON CONFLICT (employee_id) DO NOTHING;
  END IF;

  IF NOT v_keep_account THEN
    v_hash := public.pay_payroll_identifier_hash(v_account);
    UPDATE public.pay_employees
    SET dd_last4 = right(v_account, 4), dd_account_hash = v_hash, updated_at = now()
    WHERE id = emp.id;
    INSERT INTO public.pay_employee_secrets (employee_id, treasury_group_id, dd_ciphertext)
    VALUES (emp.id, p_treasury, public.pay_payroll_encrypt(p_treasury, v_account))
    ON CONFLICT (employee_id) DO UPDATE
      SET dd_ciphertext = EXCLUDED.dd_ciphertext, updated_at = now();
    PERFORM public.pay_payroll_audit_add(p_treasury, 'account_identifier_updated', 'employee', emp.id, v_hash);
    IF to_regclass('public.pay_activity') IS NOT NULL THEN
      PERFORM public.pay_activity_add(p_treasury, 'payroll_identifier', 'Payroll account identifier updated ' || v_hash, NULL);
    END IF;
  END IF;

  IF v_status = 'active' AND NOT v_was_active THEN
    blockers := public.pay_payroll_activation_blockers(emp.id);
    IF coalesce(array_length(blockers, 1), 0) > 0 THEN
      RAISE EXCEPTION 'activation_blocked' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT to_jsonb(row) INTO v_posttax FROM public.pay_employees AS row WHERE row.id = emp.id;
  RETURN v_posttax;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_reveal_employee(p_treasury uuid, p_employee uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.pay_employees%ROWTYPE;
  secret public.pay_employee_secrets%ROWTYPE;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO emp FROM public.pay_employees
  WHERE id = p_employee AND treasury_group_id = p_treasury;
  IF emp.id IS NULL THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO secret FROM public.pay_employee_secrets WHERE employee_id = emp.id;
  IF emp.tin_hash <> '' THEN
    PERFORM public.pay_payroll_audit_add(p_treasury, 'tax_identifier_revealed', 'employee', emp.id, emp.tin_hash);
  END IF;
  IF emp.dd_account_hash <> '' THEN
    PERFORM public.pay_payroll_audit_add(p_treasury, 'account_identifier_revealed', 'employee', emp.id, emp.dd_account_hash);
  END IF;
  RETURN jsonb_build_object(
    'tin', public.pay_payroll_decrypt(p_treasury, secret.tin_ciphertext),
    'dd_account', public.pay_payroll_decrypt(p_treasury, secret.dd_ciphertext)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_save_settings(p_treasury uuid, p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  clean jsonb;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  clean := coalesce(p_settings, '{}'::jsonb)
    - 'check_account' - 'account' - 'dd_account' - 'tin' - 'ssn' - 'kek';
  IF clean::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' THEN
    RAISE EXCEPTION 'settings_have_identifier' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pay_payroll_settings (treasury_group_id, settings)
  VALUES (p_treasury, clean)
  ON CONFLICT (treasury_group_id) DO UPDATE
    SET settings = EXCLUDED.settings, updated_at = now();
  RETURN clean;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Runs. The calc is produced by the application from the 2026 tables.
-- Approval posts one journal per stub. Net pay is credited, not sent.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_payroll_create_run(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  rid uuid;
  pay_date date;
  stub jsonb;
  emp public.pay_employees%ROWTYPE;
  v_kind text;
  v_freq text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  pay_date := (p_body->>'pay_date')::date;
  IF extract(year FROM pay_date) <> 2026 THEN
    RAISE EXCEPTION 'payroll_year_unsupported' USING ERRCODE = '22023';
  END IF;
  v_kind := CASE
    WHEN p_body->>'kind' IN ('regular', 'offcycle', 'contractor') THEN p_body->>'kind'
    ELSE 'regular'
  END;
  v_freq := CASE
    WHEN p_body->>'frequency' IN ('weekly', 'biweekly', 'semimonthly', 'monthly') THEN p_body->>'frequency'
    ELSE 'semimonthly'
  END;
  INSERT INTO public.pay_runs (
    treasury_group_id, pay_date, period_start, period_end, frequency, kind, memo, cash_account_id
  ) VALUES (
    p_treasury,
    pay_date,
    coalesce((p_body->>'period_start')::date, pay_date),
    coalesce((p_body->>'period_end')::date, pay_date),
    v_freq,
    v_kind,
    left(coalesce(p_body->>'memo', ''), 200),
    NULLIF(p_body->>'cash_account_id', '')::uuid
  ) RETURNING id INTO rid;

  IF NULLIF(p_body->>'cash_account_id', '') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pay_accounts
    WHERE id = NULLIF(p_body->>'cash_account_id', '')::uuid
      AND treasury_group_id = p_treasury
      AND account_type = 'asset'
  ) THEN
    RAISE EXCEPTION 'cash_account_invalid' USING ERRCODE = '22023';
  END IF;

  FOR stub IN SELECT value FROM jsonb_array_elements(coalesce(p_body->'stubs', '[]'::jsonb))
  LOOP
    SELECT * INTO emp FROM public.pay_employees
    WHERE id = (stub->>'employee_id')::uuid AND treasury_group_id = p_treasury;
    IF emp.id IS NULL THEN
      RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF emp.status <> 'active' THEN
      RAISE EXCEPTION 'employee_not_active' USING ERRCODE = '22023';
    END IF;
    IF (v_kind = 'contractor') <> (emp.kind = '1099') THEN
      RAISE EXCEPTION 'employee_wrong_run' USING ERRCODE = '22023';
    END IF;
    PERFORM public.pay_payroll_assert_calc(stub->'calc');
    INSERT INTO public.pay_stubs (
      treasury_group_id, run_id, employee_id, pay_date, inputs, calc, gross_cents, net_cents, pay_method
    ) VALUES (
      p_treasury,
      rid,
      emp.id,
      pay_date,
      coalesce(stub->'inputs', '{}'::jsonb),
      stub->'calc',
      coalesce((stub->'calc'->>'gross_cents')::bigint, 0),
      coalesce((stub->'calc'->>'net_cents')::bigint, 0),
      CASE
        WHEN stub->>'pay_method' IN ('direct_deposit', 'check') THEN stub->>'pay_method'
        ELSE emp.pay_method
      END
    );
  END LOOP;
  RETURN rid;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_save_stub(p_treasury uuid, p_stub uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  stub public.pay_stubs%ROWTYPE;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO stub FROM public.pay_stubs
  WHERE id = p_stub AND treasury_group_id = p_treasury;
  IF stub.id IS NULL THEN
    RAISE EXCEPTION 'stub_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF stub.status <> 'draft' THEN
    RAISE EXCEPTION 'stub_not_draft' USING ERRCODE = '22023';
  END IF;
  PERFORM public.pay_payroll_assert_calc(p_body->'calc');
  UPDATE public.pay_stubs SET
    inputs = coalesce(p_body->'inputs', inputs),
    calc = p_body->'calc',
    gross_cents = coalesce((p_body->'calc'->>'gross_cents')::bigint, 0),
    net_cents = coalesce((p_body->'calc'->>'net_cents')::bigint, 0),
    pay_method = CASE
      WHEN p_body->>'pay_method' IN ('direct_deposit', 'check') THEN p_body->>'pay_method'
      ELSE pay_method
    END,
    updated_at = now()
  WHERE id = stub.id;
  RETURN stub.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_approve_run(p_treasury uuid, p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  run public.pay_runs%ROWTYPE;
  stub public.pay_stubs%ROWTYPE;
  settings jsonb;
  next_check integer;
  next_advice integer;
  max_check integer;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO run FROM public.pay_runs
  WHERE id = p_run AND treasury_group_id = p_treasury
  FOR UPDATE;
  IF run.id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF run.status <> 'draft' THEN
    RAISE EXCEPTION 'run_not_draft' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pay_stubs WHERE run_id = run.id AND status = 'draft') THEN
    RAISE EXCEPTION 'run_empty' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(settings, '{}'::jsonb) INTO settings
  FROM public.pay_payroll_settings WHERE treasury_group_id = p_treasury;
  settings := coalesce(settings, '{}'::jsonb);
  next_check := coalesce((settings->>'next_check')::integer, 1001);
  next_advice := coalesce((settings->>'next_advice')::integer, 1);
  SELECT coalesce(max(check_number), 0) INTO max_check
  FROM public.pay_stubs WHERE treasury_group_id = p_treasury;
  IF next_check <= max_check THEN
    next_check := max_check + 1;
  END IF;

  FOR stub IN
    SELECT * FROM public.pay_stubs WHERE run_id = run.id AND status = 'draft' ORDER BY id
  LOOP
    PERFORM public.pay_payroll_assert_calc(stub.calc);
    IF coalesce((stub.calc->>'net_cents')::bigint, 0) < 0 THEN
      RAISE EXCEPTION 'net_negative' USING ERRCODE = '22023';
    END IF;
    IF coalesce((stub.calc->>'net_cents')::bigint, 0) = 0
       AND coalesce((stub.calc->>'gross_cents')::bigint, 0) = 0 THEN
      RAISE EXCEPTION 'nothing_to_pay' USING ERRCODE = '22023';
    END IF;
    IF stub.pay_method = 'check' THEN
      UPDATE public.pay_stubs
      SET status = 'approved', check_number = next_check, advice_number = NULL, updated_at = now()
      WHERE id = stub.id;
      next_check := next_check + 1;
    ELSE
      UPDATE public.pay_stubs
      SET status = 'approved', advice_number = next_advice, check_number = NULL, updated_at = now()
      WHERE id = stub.id;
      next_advice := next_advice + 1;
    END IF;
    PERFORM public.pay_payroll_post_stub(stub.id);
  END LOOP;

  UPDATE public.pay_runs
  SET status = 'approved', approved_at = now(), approved_by_wallet = public.pay_actor_wallet()
  WHERE id = run.id;

  settings := settings || jsonb_build_object('next_check', next_check, 'next_advice', next_advice);
  INSERT INTO public.pay_payroll_settings (treasury_group_id, settings)
  VALUES (p_treasury, settings)
  ON CONFLICT (treasury_group_id) DO UPDATE
    SET settings = EXCLUDED.settings, updated_at = now();

  PERFORM public.pay_payroll_audit_add(p_treasury, 'run_approved', 'pay_run', run.id, '');
  IF to_regclass('public.pay_activity') IS NOT NULL THEN
    PERFORM public.pay_activity_add(
      p_treasury,
      'payroll_approved',
      'Payroll run approved. Net pay is recorded in the books and is not sent.',
      NULL
    );
  END IF;
  RETURN jsonb_build_object('id', run.id, 'status', 'approved');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_void_run(p_treasury uuid, p_run uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  run public.pay_runs%ROWTYPE;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO run FROM public.pay_runs
  WHERE id = p_run AND treasury_group_id = p_treasury
  FOR UPDATE;
  IF run.id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF run.status <> 'approved' THEN
    RAISE EXCEPTION 'run_not_approved' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_reason, '') ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' OR coalesce(p_reason, '') ~ '[0-9]{2}-[0-9]{7}' THEN
    RAISE EXCEPTION 'reason_has_identifier' USING ERRCODE = '22023';
  END IF;
  IF to_regclass('public.pay_journal_entries') IS NOT NULL THEN
    DELETE FROM public.pay_journal_entries
    WHERE treasury_group_id = p_treasury
      AND source_type = 'paystub'
      AND source_id IN (SELECT id FROM public.pay_stubs WHERE run_id = run.id);
  END IF;
  UPDATE public.pay_stubs
  SET status = 'void', updated_at = now()
  WHERE run_id = run.id AND status = 'approved';
  UPDATE public.pay_runs
  SET status = 'void', voided_at = now()
  WHERE id = run.id;
  PERFORM public.pay_payroll_audit_add(p_treasury, 'run_voided', 'pay_run', run.id, '');
  IF to_regclass('public.pay_activity') IS NOT NULL THEN
    PERFORM public.pay_activity_add(
      p_treasury,
      'payroll_void',
      left('Payroll run voided. ' || left(coalesce(p_reason, ''), 120), 200),
      NULL
    );
  END IF;
  RETURN jsonb_build_object('id', run.id, 'status', 'void');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_delete_run(p_treasury uuid, p_run uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT status INTO v_status FROM public.pay_runs
  WHERE id = p_run AND treasury_group_id = p_treasury;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'run_not_draft' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.pay_runs WHERE id = p_run;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Hiring
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_payroll_set_onboarding(
  p_treasury uuid,
  p_employee uuid,
  p_item text,
  p_status text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.pay_employees%ROWTYPE;
  v_status text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO emp FROM public.pay_employees
  WHERE id = p_employee AND treasury_group_id = p_treasury;
  IF emp.id IS NULL THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_item NOT IN (
    'offer', 'i9', 'w4', 'de4', 'state_w4', 'direct_deposit', 'ciiaa', 'wtpa',
    'w9', 'agreement', 'classification', 'payment'
  ) THEN
    RAISE EXCEPTION 'unknown_checklist_item' USING ERRCODE = '22023';
  END IF;
  v_status := CASE WHEN p_status IN ('todo', 'done', 'na') THEN p_status ELSE 'done' END;
  IF p_item = 'offer' AND v_status = 'done' AND NOT EXISTS (
    SELECT 1 FROM public.pay_offer_letters
    WHERE employee_id = emp.id AND status = 'signed'
  ) THEN
    RAISE EXCEPTION 'offer_not_signed' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_note, '') ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' THEN
    RAISE EXCEPTION 'note_has_identifier' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pay_onboarding_items (treasury_group_id, employee_id, item, status, done_on, note)
  VALUES (
    p_treasury, emp.id, p_item, v_status,
    CASE WHEN v_status = 'done' THEN current_date ELSE NULL END,
    left(coalesce(p_note, ''), 300)
  )
  ON CONFLICT (employee_id, item) DO UPDATE
    SET status = EXCLUDED.status,
        done_on = EXCLUDED.done_on,
        note = EXCLUDED.note,
        updated_at = now();
  RETURN jsonb_build_object('employee_id', emp.id, 'item', p_item, 'status', v_status);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_activate_employee(p_treasury uuid, p_employee uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.pay_employees%ROWTYPE;
  blockers text[];
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO emp FROM public.pay_employees
  WHERE id = p_employee AND treasury_group_id = p_treasury;
  IF emp.id IS NULL THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF emp.status <> 'candidate' THEN
    RAISE EXCEPTION 'not_candidate' USING ERRCODE = '22023';
  END IF;
  blockers := public.pay_payroll_activation_blockers(emp.id);
  IF coalesce(array_length(blockers, 1), 0) > 0 THEN
    RAISE EXCEPTION 'activation_blocked' USING ERRCODE = '22023';
  END IF;
  UPDATE public.pay_employees
  SET status = 'active',
      hire_date = coalesce(hire_date, current_date),
      updated_at = now()
  WHERE id = emp.id;
  PERFORM public.pay_payroll_audit_add(p_treasury, 'employee_activated', 'employee', emp.id, '');
  RETURN jsonb_build_object('id', emp.id, 'status', 'active');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_save_offer(p_treasury uuid, p_body jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.pay_employees%ROWTYPE;
  offer public.pay_offer_letters%ROWTYPE;
  terms jsonb;
  oid uuid;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO emp FROM public.pay_employees
  WHERE id = (p_body->>'employee_id')::uuid AND treasury_group_id = p_treasury;
  IF emp.id IS NULL THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF emp.kind <> 'w2' THEN
    RAISE EXCEPTION 'offer_is_for_employees' USING ERRCODE = '22023';
  END IF;
  oid := NULLIF(p_body->>'id', '')::uuid;
  IF oid IS NOT NULL THEN
    SELECT * INTO offer FROM public.pay_offer_letters
    WHERE id = oid AND treasury_group_id = p_treasury;
    IF offer.id IS NULL THEN
      RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF offer.status <> 'draft' THEN
      RAISE EXCEPTION 'offer_not_draft' USING ERRCODE = '22023';
    END IF;
  END IF;
  terms := coalesce(p_body->'terms', '{}'::jsonb);
  IF btrim(coalesce(terms->>'title', '')) = '' OR btrim(coalesce(terms->>'signer_name', '')) = '' THEN
    RAISE EXCEPTION 'offer_incomplete' USING ERRCODE = '22023';
  END IF;
  IF coalesce((terms->>'rate_cents')::bigint, 0) <= 0 THEN
    RAISE EXCEPTION 'offer_incomplete' USING ERRCODE = '22023';
  END IF;
  IF emp.work_state = 'CA' AND coalesce((terms->>'exempt')::boolean, false)
     AND coalesce(terms->>'pay_type', 'salary') = 'salary'
     AND coalesce((terms->>'rate_cents')::bigint, 0) < 7030400 THEN
    RAISE EXCEPTION 'ca_exempt_minimum' USING ERRCODE = '22023';
  END IF;
  IF emp.work_state = 'CA' AND coalesce(terms->>'pay_type', 'salary') = 'hourly'
     AND coalesce((terms->>'rate_cents')::bigint, 0) < 1690 THEN
    RAISE EXCEPTION 'ca_minimum_wage' USING ERRCODE = '22023';
  END IF;
  IF oid IS NULL AND EXISTS (
    SELECT 1 FROM public.pay_offer_letters
    WHERE employee_id = emp.id AND status IN ('draft', 'sent')
  ) THEN
    RAISE EXCEPTION 'offer_already_open' USING ERRCODE = '22023';
  END IF;
  IF oid IS NULL THEN
    INSERT INTO public.pay_offer_letters (treasury_group_id, employee_id, terms, expires_on)
    VALUES (
      p_treasury,
      emp.id,
      terms,
      coalesce(NULLIF(terms->>'expires_on', '')::date, current_date + 7)
    ) RETURNING * INTO offer;
  ELSE
    UPDATE public.pay_offer_letters
    SET terms = terms,
        expires_on = coalesce(NULLIF(terms->>'expires_on', '')::date, expires_on),
        updated_at = now()
    WHERE id = offer.id
    RETURNING * INTO offer;
  END IF;
  RETURN to_jsonb(offer);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_send_offer(p_treasury uuid, p_offer uuid, p_letter_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  offer public.pay_offer_letters%ROWTYPE;
  v_hash text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO offer FROM public.pay_offer_letters
  WHERE id = p_offer AND treasury_group_id = p_treasury
  FOR UPDATE;
  IF offer.id IS NULL THEN
    RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF offer.status <> 'draft' THEN
    RAISE EXCEPTION 'offer_not_draft' USING ERRCODE = '22023';
  END IF;
  IF offer.expires_on IS NOT NULL AND offer.expires_on < current_date THEN
    RAISE EXCEPTION 'offer_expired' USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_letter_text, '')) = '' OR p_letter_text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' THEN
    RAISE EXCEPTION 'offer_letter_invalid' USING ERRCODE = '22023';
  END IF;
  v_hash := encode(digest(convert_to(p_letter_text, 'UTF8'), 'sha256'), 'hex');
  UPDATE public.pay_offer_letters
  SET status = 'sent',
      letter_text = p_letter_text,
      content_hash = v_hash,
      sent_at = now(),
      updated_at = now()
  WHERE id = offer.id
  RETURNING * INTO offer;
  PERFORM public.pay_payroll_audit_add(p_treasury, 'offer_sent', 'offer', offer.id, v_hash);
  RETURN to_jsonb(offer);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_sign_offer(p_treasury uuid, p_offer uuid, p_typed_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  offer public.pay_offer_letters%ROWTYPE;
  emp public.pay_employees%ROWTYPE;
  typed text;
  signed_at text;
  v_hash text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO offer FROM public.pay_offer_letters
  WHERE id = p_offer AND treasury_group_id = p_treasury
  FOR UPDATE;
  IF offer.id IS NULL THEN
    RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF offer.status <> 'sent' THEN
    RAISE EXCEPTION 'offer_not_sent' USING ERRCODE = '22023';
  END IF;
  IF offer.expires_on IS NOT NULL AND offer.expires_on < current_date THEN
    RAISE EXCEPTION 'offer_expired' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO emp FROM public.pay_employees WHERE id = offer.employee_id;
  typed := left(btrim(coalesce(p_typed_name, '')), 120);
  IF typed = '' THEN
    RAISE EXCEPTION 'typed_name_required' USING ERRCODE = '22023';
  END IF;
  IF emp.last_name <> '' AND position(lower(emp.last_name) IN lower(typed)) = 0 THEN
    RAISE EXCEPTION 'typed_name_mismatch' USING ERRCODE = '22023';
  END IF;
  signed_at := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_hash := encode(digest(convert_to(offer.content_hash || '|' || typed || '|' || signed_at || '|typed|typed', 'UTF8'), 'sha256'), 'hex');
  UPDATE public.pay_offer_letters
  SET status = 'signed',
      signed_at = now(),
      sign_method = 'typed',
      signer_typed_name = typed,
      signed_hash = v_hash,
      updated_at = now()
  WHERE id = offer.id
  RETURNING * INTO offer;
  UPDATE public.pay_employees SET
    title = coalesce(nullif(offer.terms->>'title', ''), title),
    department = coalesce(offer.terms->>'department', department),
    pay_type = CASE WHEN offer.terms->>'pay_type' IN ('salary', 'hourly') THEN offer.terms->>'pay_type' ELSE pay_type END,
    pay_rate_cents = coalesce((offer.terms->>'rate_cents')::bigint, pay_rate_cents),
    frequency = CASE
      WHEN offer.terms->>'frequency' IN ('weekly', 'biweekly', 'semimonthly', 'monthly') THEN offer.terms->>'frequency'
      ELSE frequency
    END,
    flsa_exempt = coalesce((offer.terms->>'exempt')::boolean, flsa_exempt),
    hire_date = coalesce(hire_date, NULLIF(offer.terms->>'start_date', '')::date),
    updated_at = now()
  WHERE id = emp.id;
  INSERT INTO public.pay_onboarding_items (treasury_group_id, employee_id, item, status, done_on, note)
  VALUES (p_treasury, emp.id, 'offer', 'done', current_date, 'Offer signed')
  ON CONFLICT (employee_id, item) DO UPDATE
    SET status = 'done', done_on = current_date, note = 'Offer signed', updated_at = now();
  PERFORM public.pay_payroll_audit_add(p_treasury, 'offer_signed', 'offer', offer.id, v_hash);
  RETURN to_jsonb(offer);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_payroll_set_offer_status(
  p_treasury uuid,
  p_offer uuid,
  p_status text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  offer public.pay_offer_letters%ROWTYPE;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO offer FROM public.pay_offer_letters
  WHERE id = p_offer AND treasury_group_id = p_treasury;
  IF offer.id IS NULL THEN
    RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_status NOT IN ('declined', 'withdrawn') OR offer.status NOT IN ('draft', 'sent') THEN
    RAISE EXCEPTION 'offer_status_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'declined' AND offer.status <> 'sent' THEN
    RAISE EXCEPTION 'offer_status_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE public.pay_offer_letters
  SET status = p_status,
      decline_reason = left(coalesce(p_reason, ''), 200),
      updated_at = now()
  WHERE id = offer.id
  RETURNING * INTO offer;
  RETURN to_jsonb(offer);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Seed payroll accounts for treasuries that already turned Pay on.
-- ---------------------------------------------------------------------------

DO $seed$
DECLARE
  gid uuid;
BEGIN
  FOR gid IN SELECT treasury_group_id FROM public.pay_enablement WHERE enabled
  LOOP
    PERFORM public.pay_payroll_seed_accounts(gid);
  END LOOP;
END
$seed$;

-- ---------------------------------------------------------------------------
-- RLS. Operators read. Writes stay on the functions above.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_payroll_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_employee_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_stubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_offer_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_onboarding_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_payroll_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read employees" ON public.pay_employees;
CREATE POLICY "Pay operators read employees"
  ON public.pay_employees FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read payroll settings" ON public.pay_payroll_settings;
CREATE POLICY "Pay operators read payroll settings"
  ON public.pay_payroll_settings FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read pay runs" ON public.pay_runs;
CREATE POLICY "Pay operators read pay runs"
  ON public.pay_runs FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read pay stubs" ON public.pay_stubs;
CREATE POLICY "Pay operators read pay stubs"
  ON public.pay_stubs FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read offers" ON public.pay_offer_letters;
CREATE POLICY "Pay operators read offers"
  ON public.pay_offer_letters FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read onboarding" ON public.pay_onboarding_items;
CREATE POLICY "Pay operators read onboarding"
  ON public.pay_onboarding_items FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read payroll audit" ON public.pay_payroll_audit;
CREATE POLICY "Pay operators read payroll audit"
  ON public.pay_payroll_audit FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_payroll_keys FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_employee_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_employees FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_payroll_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_stubs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_offer_letters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_onboarding_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_payroll_audit FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_employees TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_payroll_settings TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_runs TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_stubs TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_offer_letters TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_onboarding_items TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_payroll_audit TO anon, authenticated;

GRANT ALL ON TABLE public.pay_payroll_keys TO service_role;
GRANT ALL ON TABLE public.pay_employee_secrets TO service_role;
GRANT ALL ON TABLE public.pay_employees TO service_role;
GRANT ALL ON TABLE public.pay_payroll_settings TO service_role;
GRANT ALL ON TABLE public.pay_runs TO service_role;
GRANT ALL ON TABLE public.pay_stubs TO service_role;
GRANT ALL ON TABLE public.pay_offer_letters TO service_role;
GRANT ALL ON TABLE public.pay_onboarding_items TO service_role;
GRANT ALL ON TABLE public.pay_payroll_audit TO service_role;

REVOKE ALL ON FUNCTION public.pay_actor_wallet() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_identifier_hash(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_kek(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_encrypt(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_decrypt(uuid, bytea) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_aba_ok(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_audit_add(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_seed_accounts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_account(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_assert_calc(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_activation_blockers(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_payroll_post_stub(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.pay_payroll_save_employee(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_reveal_employee(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_save_settings(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_create_run(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_save_stub(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_approve_run(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_void_run(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_delete_run(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_set_onboarding(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_activate_employee(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_save_offer(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_send_offer(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_sign_offer(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_payroll_set_offer_status(uuid, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pay_payroll_save_employee(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_reveal_employee(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_save_settings(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_create_run(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_save_stub(uuid, uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_approve_run(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_void_run(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_delete_run(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_set_onboarding(uuid, uuid, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_activate_employee(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_save_offer(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_send_offer(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_sign_offer(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_payroll_set_offer_status(uuid, uuid, text, text) TO anon, authenticated, service_role;
