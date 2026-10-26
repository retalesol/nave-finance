-- Nave Pay books, one tenant per treasury_group_id.
--
-- This phase stores enablement, company settings, the chart of accounts, and
-- the watch-only Nave treasury wallet. It does not store journal lines,
-- invoices, Mercury tokens, seeds, private keys, or xpubs.
--
-- Authorization
-- -------------
-- Wallet identity is the x-wallet-address request header (there is no
-- Supabase Auth user). nave_wallet_header_matches() is the same comparison
-- used by watched_daos.
--
-- Operators who may read books, and who may call the enable RPC, are:
--   1. dao_registry.creator_wallet on any deployment in the treasury group
--   2. dao_authorized_wallets for any deployment in the group
--
-- Token holders are not operators. dao_authorized_wallets is written for
-- wallet-governed treasuries (founder plus the wallets registered with them).
-- It is not a token-holder list.
--
-- Guardian gap
-- ------------
-- Guardians are read from chain in the app (useGuardianConfig). There is no
-- Postgres table or on-chain mirror of the guardian set. A guardian who is
-- not the creator_wallet and not listed in dao_authorized_wallets cannot
-- pass pay_caller_is_operator(), so they cannot enable Pay or read books
-- through RLS. Wallet-governed guardians are usually copied into
-- dao_authorized_wallets at registration. Token-governed guardians are
-- on-chain only and hit this gap unless they are also the founder.
-- The client still shows the enable action only to a founder or guardian.
-- The RPC cannot tell a chain guardian from any other authorized wallet, so
-- a dao_authorized_wallets row can also enable Pay if it calls the RPC.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_enablement (
  treasury_group_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  enabled_by_wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_enablement IS
  'One Pay enablement row per treasury_group_id. See the guardian gap in this migration: chain guardians are not in Postgres.';

COMMENT ON COLUMN public.pay_enablement.enabled_by_wallet IS
  'Wallet header that passed pay_caller_is_operator (creator_wallet or dao_authorized_wallets). Not a chain-guardian proof.';

CREATE TABLE IF NOT EXISTS public.pay_company_settings (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  address text NOT NULL DEFAULT '',
  ein text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_company_settings_legal_name_len CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 200),
  CONSTRAINT pay_company_settings_address_len CHECK (char_length(address) <= 500),
  CONSTRAINT pay_company_settings_ein_len CHECK (char_length(ein) <= 32)
);

COMMENT ON TABLE public.pay_company_settings IS
  'Company profile for one treasury group. legal_name is seeded from the treasury name. address and ein start blank.';

CREATE TABLE IF NOT EXISTS public.pay_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  subtype text NOT NULL DEFAULT '',
  system_key text,
  tax_line text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_accounts_code_len CHECK (char_length(code) BETWEEN 1 AND 16),
  CONSTRAINT pay_accounts_group_code UNIQUE (treasury_group_id, code)
);

COMMENT ON TABLE public.pay_accounts IS
  'Chart of accounts only. Balances and journal lines are integer cents in a later phase and are not stored here.';

CREATE UNIQUE INDEX IF NOT EXISTS pay_accounts_system_key_unique
  ON public.pay_accounts (treasury_group_id, system_key)
  WHERE system_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS pay_accounts_group_idx
  ON public.pay_accounts (treasury_group_id, code);

CREATE TABLE IF NOT EXISTS public.pay_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'nave_treasury'),
  label text NOT NULL DEFAULT 'Nave treasury',
  cash_account_id uuid NOT NULL REFERENCES public.pay_accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_wallets_one_treasury UNIQUE (treasury_group_id, kind)
);

COMMENT ON TABLE public.pay_wallets IS
  'Watch-only wallets. kind nave_treasury has no seed, private key, or xpub column. cash_account_id is Digital assets (1200), the default crypto cash account.';

CREATE TABLE IF NOT EXISTS public.pay_wallet_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES public.pay_wallets (id) ON DELETE CASCADE,
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  chain text NOT NULL,
  chain_id bigint,
  dao_onchain_address text NOT NULL,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_wallet_addresses_group_dao UNIQUE (treasury_group_id, dao_onchain_address),
  CONSTRAINT pay_wallet_addresses_solana_shape CHECK (
    (chain = 'solana' AND chain_id IS NULL AND address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    OR (chain <> 'solana' AND chain_id IS NOT NULL AND address ~* '^0x[0-9a-f]{40}$')
  )
);

COMMENT ON TABLE public.pay_wallet_addresses IS
  'Watch-only addresses for the Nave treasury wallet. Solana address is the vault authority PDA. Each EVM chain stores that deployment''s dao_onchain_address. No key material.';

CREATE UNIQUE INDEX IF NOT EXISTS pay_wallet_addresses_chain_unique
  ON public.pay_wallet_addresses (treasury_group_id, chain, chain_id)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS pay_wallet_addresses_wallet_idx
  ON public.pay_wallet_addresses (wallet_id);

-- ---------------------------------------------------------------------------
-- Operator predicate
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_caller_is_operator(p_treasury_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_treasury_group_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.dao_registry AS registry
        WHERE registry.treasury_group_id = p_treasury_group_id
          AND public.nave_wallet_header_matches(registry.creator_wallet)
      )
      OR EXISTS (
        SELECT 1
        FROM public.dao_registry AS registry
        JOIN public.dao_authorized_wallets AS authorized
          ON (
            authorized.dao_onchain_address = registry.dao_onchain_address
            OR (
              authorized.dao_onchain_address ~* '^0x[0-9a-f]{40}$'
              AND registry.dao_onchain_address ~* '^0x[0-9a-f]{40}$'
              AND lower(authorized.dao_onchain_address) = lower(registry.dao_onchain_address)
            )
          )
        WHERE registry.treasury_group_id = p_treasury_group_id
          AND public.nave_wallet_header_matches(authorized.wallet_address)
      )
    );
$$;

COMMENT ON FUNCTION public.pay_caller_is_operator(uuid) IS
  'True when x-wallet-address is creator_wallet or dao_authorized_wallets for the treasury group. Chain guardians are not consulted; see the guardian gap on pay_enablement.';

REVOKE ALL ON FUNCTION public.pay_caller_is_operator(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_caller_is_operator(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Access probe (booleans only — no books rows)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_treasury_access(p_treasury_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  group_exists boolean;
  is_enabled boolean;
  can_operate boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.dao_registry
    WHERE treasury_group_id = p_treasury_group_id
  )
  INTO group_exists;

  can_operate := public.pay_caller_is_operator(p_treasury_group_id);

  SELECT COALESCE(bool_or(enabled), false)
  INTO is_enabled
  FROM public.pay_enablement
  WHERE treasury_group_id = p_treasury_group_id;

  RETURN jsonb_build_object(
    'group_exists', COALESCE(group_exists, false),
    'enabled', COALESCE(is_enabled, false),
    'can_operate', COALESCE(can_operate, false)
  );
END;
$$;

COMMENT ON FUNCTION public.pay_treasury_access(uuid) IS
  'Returns whether Pay is on and whether the caller is an operator. Does not return company, chart, or wallet rows.';

REVOKE ALL ON FUNCTION public.pay_treasury_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_treasury_access(uuid) TO anon, authenticated, service_role;

-- Solana dao address for PDA derivation. Operators only, so a private
-- treasury's Solana deployment can be found even when RLS hides the registry row.
CREATE OR REPLACE FUNCTION public.pay_solana_dao_for_enable(p_treasury_group_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  solana_address text;
  solana_count integer;
BEGIN
  IF NOT public.pay_caller_is_operator(p_treasury_group_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer
  INTO solana_count
  FROM public.dao_registry
  WHERE treasury_group_id = p_treasury_group_id
    AND dao_onchain_address !~* '^0x[0-9a-f]{40}$';

  IF solana_count > 1 THEN
    RAISE EXCEPTION 'multiple_solana_deployments' USING ERRCODE = '22023';
  END IF;

  IF solana_count = 0 THEN
    RETURN NULL;
  END IF;

  SELECT dao_onchain_address
  INTO solana_address
  FROM public.dao_registry
  WHERE treasury_group_id = p_treasury_group_id
    AND dao_onchain_address !~* '^0x[0-9a-f]{40}$'
  ORDER BY created_at
  LIMIT 1;

  RETURN solana_address;
END;
$$;

COMMENT ON FUNCTION public.pay_solana_dao_for_enable(uuid) IS
  'Solana dao_onchain_address whose vault authority PDA the client must pass to pay_enable_treasury. Null when the group has no Solana deployment.';

REVOKE ALL ON FUNCTION public.pay_solana_dao_for_enable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_solana_dao_for_enable(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic enablement
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_enable_treasury(
  p_treasury_group_id uuid,
  p_solana_vault text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller text;
  seed_name text;
  cash_account uuid;
  wallet_id uuid;
  solana_count integer;
  deployment record;
  stored_address text;
  stored_chain text;
  stored_chain_id bigint;
  stored_dao text;
BEGIN
  IF p_treasury_group_id IS NULL THEN
    RAISE EXCEPTION 'treasury_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.pay_caller_is_operator(p_treasury_group_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.dao_registry WHERE treasury_group_id = p_treasury_group_id
  ) THEN
    RAISE EXCEPTION 'treasury_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Second click is a no-op. Addresses from the first seed stay.
  IF EXISTS (
    SELECT 1 FROM public.pay_enablement WHERE treasury_group_id = p_treasury_group_id
  ) THEN
    RETURN p_treasury_group_id;
  END IF;

  caller := NULLIF(current_setting('request.headers', true)::json->>'x-wallet-address', '');
  IF caller IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF caller ~* '^0x[0-9a-f]{40}$' THEN
    caller := lower(caller);
  END IF;

  SELECT count(*)::integer
  INTO solana_count
  FROM public.dao_registry
  WHERE treasury_group_id = p_treasury_group_id
    AND dao_onchain_address !~* '^0x[0-9a-f]{40}$';

  IF solana_count > 1 THEN
    RAISE EXCEPTION 'multiple_solana_deployments' USING ERRCODE = '22023';
  END IF;

  IF solana_count = 1 THEN
    p_solana_vault := NULLIF(btrim(p_solana_vault), '');
    IF p_solana_vault IS NULL OR p_solana_vault !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
      RAISE EXCEPTION 'solana_vault_required' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.dao_registry
      WHERE treasury_group_id = p_treasury_group_id
        AND dao_onchain_address = p_solana_vault
    ) THEN
      RAISE EXCEPTION 'invalid_solana_vault' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT btrim(name)
  INTO seed_name
  FROM public.dao_registry
  WHERE treasury_group_id = p_treasury_group_id
    AND btrim(coalesce(name, '')) <> ''
  ORDER BY created_at
  LIMIT 1;

  IF seed_name IS NULL OR seed_name = '' THEN
    seed_name := 'Treasury';
  END IF;
  seed_name := left(seed_name, 200);

  INSERT INTO public.pay_enablement (treasury_group_id, enabled, enabled_at, enabled_by_wallet)
  VALUES (p_treasury_group_id, true, now(), caller);

  INSERT INTO public.pay_company_settings (treasury_group_id, legal_name, address, ein)
  VALUES (p_treasury_group_id, seed_name, '', '');

  INSERT INTO public.pay_accounts (
    treasury_group_id, code, name, account_type, subtype, system_key, tax_line
  )
  SELECT
    p_treasury_group_id,
    chart.code,
    chart.name,
    chart.account_type,
    chart.subtype,
    NULLIF(chart.system_key, ''),
    chart.tax_line
  FROM (
    VALUES
      ('1000', 'Mercury Checking', 'asset', 'bank', 'cash_default', 'Sch L 1 Cash'),
      ('1010', 'Mercury Treasury / Savings', 'asset', 'bank', '', 'Sch L 1 Cash'),
      ('1100', 'Accounts receivable', 'asset', 'ar', 'ar', 'Sch L 2a'),
      ('1200', 'Digital assets', 'asset', 'digital_asset', 'digital_assets', 'Sch L 6 Other current assets'),
      ('1290', 'Digital assets - clearing', 'asset', 'digital_asset', 'crypto_clearing', 'Sch L 6 Other current assets'),
      ('1300', 'Prepaid expenses', 'asset', 'other_current_asset', '', 'Sch L 6'),
      ('1500', 'Equipment', 'asset', 'fixed_asset', '', 'Sch L 10a'),
      ('1590', 'Accumulated depreciation', 'asset', 'fixed_asset', '', 'Sch L 10b'),
      ('2000', 'Accounts payable', 'liability', 'ap', 'ap', 'Sch L 16'),
      ('2100', 'Credit card', 'liability', 'credit_card', '', 'Sch L 18'),
      ('2200', 'Accrued liabilities', 'liability', 'current_liability', '', 'Sch L 18'),
      ('2300', 'Sales tax payable', 'liability', 'current_liability', 'sales_tax', 'Sch L 18'),
      ('2400', 'Deferred revenue', 'liability', 'current_liability', '', 'Sch L 18'),
      ('2500', 'SAFE notes', 'liability', 'long_term_liability', 'safe', 'Sch L 21 (confirm ASC 480 classification with CPA)'),
      ('2600', 'Notes payable', 'liability', 'long_term_liability', '', 'Sch L 20'),
      ('3000', 'Common stock', 'equity', 'equity', '', 'Sch L 22b'),
      ('3100', 'Additional paid-in capital', 'equity', 'equity', '', 'Sch L 23'),
      ('3300', 'Opening balance equity', 'equity', 'equity', 'opening_equity', ''),
      ('3900', 'Retained earnings', 'equity', 'retained_earnings', 'retained', 'Sch L 25'),
      ('4000', 'Revenue - services', 'income', 'revenue', 'revenue', '1120 L1a'),
      ('4010', 'Protocol revenue', 'income', 'revenue', '', '1120 L1a'),
      ('4090', 'Sales discounts', 'income', 'revenue', 'sales_discounts', '1120 L1b'),
      ('4900', 'Uncategorized income', 'income', 'revenue', 'uncat_income', '1120 L10'),
      ('6000', 'Software & SaaS', 'expense', 'expense', '', '1120 L26'),
      ('6010', 'Infrastructure & RPC', 'expense', 'expense', '', '1120 L26'),
      ('6020', 'Audits & security', 'expense', 'expense', '', '1120 L26'),
      ('6030', 'Legal', 'expense', 'expense', '', '1120 L26'),
      ('6040', 'Accounting', 'expense', 'expense', '', '1120 L26'),
      ('6050', 'Contractors', 'expense', 'expense', '', '1120 L26'),
      ('6060', 'Payroll', 'expense', 'expense', '', '1120 L13'),
      ('6070', 'Marketing', 'expense', 'expense', '', '1120 L26'),
      ('6080', 'Travel', 'expense', 'expense', '', '1120 L26'),
      ('6090', 'Office', 'expense', 'expense', '', '1120 L26'),
      ('6100', 'Bank & network fees', 'expense', 'expense', 'bank_fees', '1120 L26'),
      ('6110', 'Gas & on-chain fees', 'expense', 'expense', 'gas_fees', '1120 L26'),
      ('6120', 'Taxes & licenses', 'expense', 'expense', '', '1120 L17'),
      ('6900', 'Uncategorized expense', 'expense', 'expense', 'uncat_expense', '1120 L26'),
      ('7000', 'Interest income', 'income', 'other_income', '', '1120 L5'),
      ('7010', 'Grant income', 'income', 'other_income', '', '1120 L10'),
      ('7100', 'Realized gain/loss on digital assets', 'income', 'other_income', 'realized_gain', '1120 L8/L9 (Sch D / 4797)'),
      ('7110', 'Unrealized gain/loss on digital assets', 'income', 'other_income', 'unrealized_gain', 'Book only (ASU 2023-08); M-1 adjustment')
  ) AS chart(code, name, account_type, subtype, system_key, tax_line);

  SELECT id
  INTO cash_account
  FROM public.pay_accounts
  WHERE treasury_group_id = p_treasury_group_id
    AND code = '1200';

  IF cash_account IS NULL THEN
    RAISE EXCEPTION 'chart_missing_digital_assets' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.pay_wallets (treasury_group_id, kind, label, cash_account_id)
  VALUES (p_treasury_group_id, 'nave_treasury', 'Nave treasury', cash_account)
  RETURNING id INTO wallet_id;

  FOR deployment IN
    SELECT dao_onchain_address, chain, chain_id
    FROM public.dao_registry
    WHERE treasury_group_id = p_treasury_group_id
    ORDER BY created_at
  LOOP
    IF deployment.dao_onchain_address ~* '^0x[0-9a-f]{40}$' THEN
      IF deployment.chain_id IS NULL OR deployment.chain IS NULL OR deployment.chain = 'solana' THEN
        RAISE EXCEPTION 'unsupported_deployment' USING ERRCODE = '22023';
      END IF;
      stored_chain := deployment.chain;
      stored_chain_id := deployment.chain_id;
      stored_dao := lower(deployment.dao_onchain_address);
      stored_address := stored_dao;
    ELSE
      stored_chain := 'solana';
      stored_chain_id := NULL;
      stored_dao := deployment.dao_onchain_address;
      stored_address := p_solana_vault;
    END IF;

    INSERT INTO public.pay_wallet_addresses (
      wallet_id, treasury_group_id, chain, chain_id, dao_onchain_address, address
    )
    VALUES (
      wallet_id, p_treasury_group_id, stored_chain, stored_chain_id, stored_dao, stored_address
    );
  END LOOP;

  RETURN p_treasury_group_id;
END;
$$;

COMMENT ON FUNCTION public.pay_enable_treasury(uuid, text) IS
  'Atomically seeds Pay enablement, company settings (legal name from the treasury name), the C-corp chart, and watch-only nave_treasury addresses. p_solana_vault must be getVaultAuthorityPDA for the group''s Solana dao. EVM addresses are taken from dao_registry, not from the caller.';

REVOKE ALL ON FUNCTION public.pay_enable_treasury(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_enable_treasury(uuid, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: operators read. Writes stay on the enable function and service_role.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_enablement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_wallet_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read enablement" ON public.pay_enablement;
CREATE POLICY "Pay operators read enablement"
  ON public.pay_enablement
  FOR SELECT
  TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read company settings" ON public.pay_company_settings;
CREATE POLICY "Pay operators read company settings"
  ON public.pay_company_settings
  FOR SELECT
  TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read accounts" ON public.pay_accounts;
CREATE POLICY "Pay operators read accounts"
  ON public.pay_accounts
  FOR SELECT
  TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read wallets" ON public.pay_wallets;
CREATE POLICY "Pay operators read wallets"
  ON public.pay_wallets
  FOR SELECT
  TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read wallet addresses" ON public.pay_wallet_addresses;
CREATE POLICY "Pay operators read wallet addresses"
  ON public.pay_wallet_addresses
  FOR SELECT
  TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_enablement FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_company_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_wallets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_wallet_addresses FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_enablement TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_company_settings TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_accounts TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_wallets TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_wallet_addresses TO anon, authenticated;

GRANT ALL ON TABLE public.pay_enablement TO service_role;
GRANT ALL ON TABLE public.pay_company_settings TO service_role;
GRANT ALL ON TABLE public.pay_accounts TO service_role;
GRANT ALL ON TABLE public.pay_wallets TO service_role;
GRANT ALL ON TABLE public.pay_wallet_addresses TO service_role;
