-- Nave Pay Mercury read-only feed, matching, and statement reconciliation.
--
-- Tenant is treasury_group_id. Operators are x-wallet-address matched to
-- creator_wallet or dao_authorized_wallets, the same predicate as the other
-- pay tables. Token holders have no SELECT policy.
--
-- The Mercury token is pgp_sym_encrypt ciphertext. pay_mercury_secrets and
-- pay_mercury_keys have no client grants and no policies. Only service_role
-- functions read or write the token, and those functions never return it to
-- a browser RPC. The app sends GET to api.mercury.com or the sandbox host.
-- It does not create bill tables. Outflows use pay_cash_entries and
-- pay_bill_payments when those tables exist, and otherwise a feed row
-- against the chart.
--
-- Reconciliation is per account. Finish can write pay_account_locks for that
-- account only. This is not a books-wide period lock and there is no audit chain.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_mercury_keys (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  kek text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_mercury_keys IS
  'Per-treasury key for the Mercury token. No client policy. Service role only.';

CREATE TABLE IF NOT EXISTS public.pay_mercury_secrets (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  token_ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_mercury_secrets IS
  'pgp_sym_encrypt ciphertext of the read-only Mercury token. Clients cannot select this table. The token is never returned by a browser RPC.';

CREATE TABLE IF NOT EXISTS public.pay_mercury_settings (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  token_hint text NOT NULL DEFAULT '',
  environment text,
  sync_start date,
  auto_match boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_mercury_settings_environment CHECK (environment IS NULL OR environment IN ('sandbox', 'production')),
  CONSTRAINT pay_mercury_settings_hint_len CHECK (char_length(token_hint) <= 32),
  CONSTRAINT pay_mercury_settings_error_len CHECK (char_length(last_error) <= 500)
);

COMMENT ON TABLE public.pay_mercury_settings IS
  'Connection hint and sync prefs. token_hint is the last four characters only.';

CREATE TABLE IF NOT EXISTS public.pay_mercury_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  mercury_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  nickname text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  account_type text NOT NULL DEFAULT '',
  last4 text NOT NULL DEFAULT '',
  available_cents bigint NOT NULL DEFAULT 0,
  current_cents bigint NOT NULL DEFAULT 0,
  dashboard_link text NOT NULL DEFAULT '',
  gl_account_id uuid REFERENCES public.pay_accounts (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_mercury_accounts_id_len CHECK (char_length(mercury_id) BETWEEN 1 AND 80),
  CONSTRAINT pay_mercury_accounts_group_mercury UNIQUE (treasury_group_id, mercury_id)
);

COMMENT ON TABLE public.pay_mercury_accounts IS
  'Mercury accounts for one treasury. Full account numbers are not stored. gl_account_id is 1000 or 1010 until an operator maps it.';

CREATE INDEX IF NOT EXISTS pay_mercury_accounts_group_idx
  ON public.pay_mercury_accounts (treasury_group_id, status, name);

CREATE TABLE IF NOT EXISTS public.pay_mercury_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  mercury_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.pay_mercury_accounts (id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL,
  status text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT '',
  counterparty text NOT NULL DEFAULT '',
  bank_description text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  external_memo text NOT NULL DEFAULT '',
  posted_at timestamptz,
  mercury_created_at timestamptz,
  dashboard_link text NOT NULL DEFAULT '',
  match_type text,
  match_id uuid,
  match_created boolean NOT NULL DEFAULT false,
  ignored boolean NOT NULL DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_mercury_tx_id_len CHECK (char_length(mercury_id) BETWEEN 1 AND 80),
  CONSTRAINT pay_mercury_tx_match CHECK (
    match_type IS NULL OR match_type IN ('payment', 'bill_payment', 'cash_entry', 'feed')
  ),
  CONSTRAINT pay_mercury_tx_group_mercury UNIQUE (treasury_group_id, mercury_id)
);

COMMENT ON TABLE public.pay_mercury_transactions IS
  'Read-only Mercury feed. match_created marks rows this feed inserted. Unmatch deletes only those.';

CREATE INDEX IF NOT EXISTS pay_mercury_tx_group_idx
  ON public.pay_mercury_transactions (treasury_group_id, posted_at DESC);

CREATE INDEX IF NOT EXISTS pay_mercury_tx_match_idx
  ON public.pay_mercury_transactions (treasury_group_id, match_type, match_id);

CREATE TABLE IF NOT EXISTS public.pay_feed_entries (
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
  account_id uuid NOT NULL REFERENCES public.pay_accounts (id),
  cash_account_id uuid NOT NULL REFERENCES public.pay_accounts (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_feed_entries IS
  'Deposit or expense recorded from the bank feed when pay_cash_entries does not exist. account_id is the chart offset. cash_account_id is the bank account.';

CREATE INDEX IF NOT EXISTS pay_feed_entries_group_idx
  ON public.pay_feed_entries (treasury_group_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS public.pay_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.pay_accounts (id),
  statement_date date NOT NULL,
  statement_balance_cents bigint NOT NULL,
  begin_balance_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

COMMENT ON TABLE public.pay_reconciliations IS
  'Statement period for one bank, cash, credit card, or digital-asset account.';

CREATE UNIQUE INDEX IF NOT EXISTS pay_reconciliations_one_open
  ON public.pay_reconciliations (account_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS pay_reconciliations_account_idx
  ON public.pay_reconciliations (account_id, statement_date DESC);

CREATE TABLE IF NOT EXISTS public.pay_recon_items (
  recon_id uuid NOT NULL REFERENCES public.pay_reconciliations (id) ON DELETE CASCADE,
  clear_key text NOT NULL,
  amount_cents bigint NOT NULL,
  entry_date date NOT NULL,
  PRIMARY KEY (recon_id, clear_key)
);

COMMENT ON TABLE public.pay_recon_items IS
  'Lines cleared on a statement. Stored apart from the journal so a rebuilt journal line keeps its tick.';

CREATE INDEX IF NOT EXISTS pay_recon_items_key_idx
  ON public.pay_recon_items (clear_key);

CREATE TABLE IF NOT EXISTS public.pay_account_locks (
  account_id uuid PRIMARY KEY REFERENCES public.pay_accounts (id) ON DELETE CASCADE,
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  locked_through date NOT NULL,
  note text NOT NULL DEFAULT '',
  locked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pay_account_locks IS
  'Period lock for one account, written when a reconciliation is finished with the lock option. Not a books-wide lock and not an audit chain.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_wallet_is_operator(p_treasury uuid, p_wallet text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_treasury IS NULL OR p_wallet IS NULL OR btrim(p_wallet) = '' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.dao_registry AS registry
    WHERE registry.treasury_group_id = p_treasury
      AND (
        registry.creator_wallet = p_wallet
        OR (
          registry.creator_wallet ~* '^0x[0-9a-f]{40}$'
          AND lower(registry.creator_wallet) = lower(p_wallet)
        )
      )
  ) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
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
    WHERE registry.treasury_group_id = p_treasury
      AND (
        authorized.wallet_address = p_wallet
        OR (
          authorized.wallet_address ~* '^0x[0-9a-f]{40}$'
          AND lower(authorized.wallet_address) = lower(p_wallet)
        )
      )
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_require_wallet(p_treasury uuid, p_wallet text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.pay_wallet_is_operator(p_treasury, p_wallet) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pay_enablement
    WHERE treasury_group_id = p_treasury AND enabled
  ) THEN
    RAISE EXCEPTION 'pay_not_enabled' USING ERRCODE = 'P0002';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_kek(p_treasury uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  existing text;
BEGIN
  SELECT kek INTO existing
  FROM public.pay_mercury_keys
  WHERE treasury_group_id = p_treasury;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;
  INSERT INTO public.pay_mercury_keys (treasury_group_id, kek)
  VALUES (p_treasury, encode(extensions.gen_random_bytes(32), 'hex'))
  ON CONFLICT (treasury_group_id) DO NOTHING;
  SELECT kek INTO existing
  FROM public.pay_mercury_keys
  WHERE treasury_group_id = p_treasury;
  RETURN existing;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_clip(raw text, max_len integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT left(btrim(coalesce(raw, '')), max_len);
$fn$;

CREATE OR REPLACE FUNCTION public.pay_cents_money(p_cents bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT (p_cents / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0');
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_local_date(p_ts timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE WHEN p_ts IS NULL THEN NULL ELSE (p_ts AT TIME ZONE 'UTC')::date END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_ts(raw text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(raw)::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_method(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT left('Mercury · ' || CASE coalesce(p_kind, '')
    WHEN 'incomingDomesticWire' THEN 'Wire'
    WHEN 'incomingInternationalWire' THEN 'Wire (intl)'
    WHEN 'externalTransfer' THEN 'ACH'
    WHEN 'checkDeposit' THEN 'Check'
    WHEN 'outgoingPayment' THEN 'ACH / Wire'
    WHEN 'debitCardTransaction' THEN 'Card'
    WHEN 'creditCardTransaction' THEN 'Card'
    WHEN 'internalTransfer' THEN 'Internal transfer'
    WHEN 'treasuryTransfer' THEN 'Treasury transfer'
    WHEN 'wireFee' THEN 'Bank fee'
    WHEN 'interestPayment' THEN 'Interest'
    ELSE coalesce(nullif(p_kind, ''), 'transfer')
  END, 60);
$fn$;

-- 3 when the invoice number is its own token. 2 when a long normalized number is contained. 0 otherwise.
CREATE OR REPLACE FUNCTION public.pay_mercury_number_hit(p_number text, p_text text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  num text := lower(btrim(coalesce(p_number, '')));
  memo text := lower(coalesce(p_text, ''));
  norm_num text;
  start_at integer := 1;
  found integer;
  at_pos integer;
  before_ch text;
  after_ch text;
BEGIN
  norm_num := regexp_replace(num, '[^a-z0-9]', '', 'g');
  IF num = '' OR char_length(norm_num) < 3 THEN
    RETURN 0;
  END IF;
  LOOP
    found := position(num IN substring(memo FROM start_at));
    EXIT WHEN found = 0;
    at_pos := start_at + found - 1;
    before_ch := CASE WHEN at_pos = 1 THEN '' ELSE substring(memo FROM at_pos - 1 FOR 1) END;
    after_ch := substring(memo FROM at_pos + char_length(num) FOR 1);
    IF (at_pos = 1 OR before_ch ~ '[^a-z0-9]') AND (after_ch = '' OR after_ch ~ '[^a-z0-9]') THEN
      RETURN 3;
    END IF;
    start_at := at_pos + 1;
    EXIT WHEN start_at > char_length(memo);
  END LOOP;
  IF char_length(norm_num) >= 5
     AND position(norm_num IN regexp_replace(memo, '[^a-z0-9]', '', 'g')) > 0 THEN
    RETURN 2;
  END IF;
  RETURN 0;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_gl_account(p_treasury uuid, p_kind text, p_name text, p_nickname text, p_type text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  blob text;
  mapped uuid;
BEGIN
  blob := lower(concat_ws(' ', coalesce(p_kind, ''), coalesce(p_name, ''), coalesce(p_nickname, ''), coalesce(p_type, '')));
  IF blob LIKE '%saving%' OR blob LIKE '%treasury%' THEN
    mapped := public.pay_account_id(p_treasury, '1010');
  END IF;
  IF mapped IS NULL THEN
    mapped := public.pay_account_id(p_treasury, '1000');
  END IF;
  RETURN mapped;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_chart_account(p_treasury uuid, p_direction text, p_category text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  code text;
BEGIN
  code := CASE lower(btrim(coalesce(p_category, '')))
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
    WHEN 'invoice payments' THEN '4000'
    WHEN 'protocol revenue' THEN '4010'
    WHEN 'grants' THEN '7010'
    WHEN 'interest' THEN '7000'
    WHEN 'other' THEN CASE WHEN p_direction = 'in' THEN '4900' ELSE '6900' END
    ELSE CASE WHEN p_direction = 'in' THEN '4900' ELSE '6900' END
  END;
  RETURN public.pay_account_id(p_treasury, code);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Token. Service role only. Never returns the token to anon.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_mercury_put_token(p_treasury uuid, p_wallet text, p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  token text;
  env text;
  hint text;
BEGIN
  PERFORM public.pay_mercury_require_wallet(p_treasury, p_wallet);
  token := regexp_replace(btrim(coalesce(p_token, '')), '^(Authorization:\s*)?Bearer\s+', '', 'i');
  IF token !~ '^secret-token:mercury_(production|sandbox)_[A-Za-z0-9_-]{8,}$' THEN
    RAISE EXCEPTION 'invalid_mercury_token' USING ERRCODE = '22023';
  END IF;
  env := CASE WHEN position('mercury_sandbox_' IN token) > 0 THEN 'sandbox' ELSE 'production' END;
  hint := '••••' || right(token, 4);
  INSERT INTO public.pay_mercury_secrets (treasury_group_id, token_ciphertext)
  VALUES (p_treasury, extensions.pgp_sym_encrypt(token, public.pay_mercury_kek(p_treasury)))
  ON CONFLICT (treasury_group_id) DO UPDATE
  SET token_ciphertext = EXCLUDED.token_ciphertext, updated_at = now();
  INSERT INTO public.pay_mercury_settings (treasury_group_id, token_hint, environment, last_error)
  VALUES (p_treasury, hint, env, '')
  ON CONFLICT (treasury_group_id) DO UPDATE
  SET token_hint = EXCLUDED.token_hint,
      environment = EXCLUDED.environment,
      last_error = '',
      updated_at = now();
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_read_token(p_treasury uuid, p_wallet text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  token text;
BEGIN
  PERFORM public.pay_mercury_require_wallet(p_treasury, p_wallet);
  SELECT convert_from(extensions.pgp_sym_decrypt(secret.token_ciphertext, keyring.kek), 'UTF8')
  INTO token
  FROM public.pay_mercury_secrets AS secret
  JOIN public.pay_mercury_keys AS keyring ON keyring.treasury_group_id = secret.treasury_group_id
  WHERE secret.treasury_group_id = p_treasury;
  RETURN token;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_note_sync(p_treasury uuid, p_wallet text, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.pay_mercury_require_wallet(p_treasury, p_wallet);
  INSERT INTO public.pay_mercury_settings (treasury_group_id)
  VALUES (p_treasury)
  ON CONFLICT (treasury_group_id) DO NOTHING;
  IF p_error IS NULL OR btrim(p_error) = '' THEN
    UPDATE public.pay_mercury_settings
    SET last_sync_at = now(), last_error = '', updated_at = now()
    WHERE treasury_group_id = p_treasury;
  ELSE
    UPDATE public.pay_mercury_settings
    SET last_error = left(btrim(p_error), 500), updated_at = now()
    WHERE treasury_group_id = p_treasury;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_upsert(
  p_treasury uuid,
  p_wallet text,
  p_accounts jsonb,
  p_transactions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  elem record;
  mid text;
  mapped uuid;
  acct_uuid uuid;
  old_status text;
  old_amt bigint;
  acct_count integer := 0;
  new_count integer := 0;
  upd_count integer := 0;
  amt bigint;
BEGIN
  PERFORM public.pay_mercury_require_wallet(p_treasury, p_wallet);
  IF jsonb_typeof(coalesce(p_accounts, '[]'::jsonb)) = 'array' THEN
    FOR elem IN
      SELECT value FROM jsonb_array_elements(p_accounts) AS t(value)
    LOOP
      mid := public.pay_mercury_clip(elem.value->>'id', 80);
      IF mid = '' THEN
        CONTINUE;
      END IF;
      mapped := public.pay_mercury_gl_account(
        p_treasury,
        elem.value->>'kind',
        elem.value->>'name',
        elem.value->>'nickname',
        elem.value->>'type'
      );
      INSERT INTO public.pay_mercury_accounts (
        treasury_group_id, mercury_id, name, nickname, kind, status, account_type, last4,
        available_cents, current_cents, dashboard_link, gl_account_id
      ) VALUES (
        p_treasury,
        mid,
        public.pay_mercury_clip(elem.value->>'name', 200),
        public.pay_mercury_clip(elem.value->>'nickname', 200),
        public.pay_mercury_clip(elem.value->>'kind', 40),
        public.pay_mercury_clip(elem.value->>'status', 40),
        public.pay_mercury_clip(elem.value->>'type', 40),
        public.pay_mercury_clip(coalesce(elem.value->>'last4', right(coalesce(elem.value->>'accountNumber', ''), 4)), 4),
        coalesce((elem.value->>'available_cents')::bigint, 0),
        coalesce((elem.value->>'current_cents')::bigint, 0),
        public.pay_mercury_clip(elem.value->>'dashboard_link', 500),
        mapped
      )
      ON CONFLICT (treasury_group_id, mercury_id) DO UPDATE SET
        name = EXCLUDED.name,
        nickname = EXCLUDED.nickname,
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        account_type = EXCLUDED.account_type,
        last4 = EXCLUDED.last4,
        available_cents = EXCLUDED.available_cents,
        current_cents = EXCLUDED.current_cents,
        dashboard_link = EXCLUDED.dashboard_link,
        gl_account_id = COALESCE(public.pay_mercury_accounts.gl_account_id, EXCLUDED.gl_account_id),
        updated_at = now();
      acct_count := acct_count + 1;
    END LOOP;
  END IF;

  IF jsonb_typeof(coalesce(p_transactions, '[]'::jsonb)) = 'array' THEN
    FOR elem IN
      SELECT value FROM jsonb_array_elements(p_transactions) AS t(value)
    LOOP
      mid := public.pay_mercury_clip(elem.value->>'id', 80);
      IF mid = '' THEN
        CONTINUE;
      END IF;
      acct_uuid := NULL;
      SELECT id INTO acct_uuid
      FROM public.pay_mercury_accounts
      WHERE treasury_group_id = p_treasury
        AND mercury_id = public.pay_mercury_clip(coalesce(elem.value->>'account_id', elem.value->>'accountId'), 80);
      IF acct_uuid IS NULL THEN
        CONTINUE;
      END IF;
      BEGIN
        amt := coalesce(elem.value->>'amount_cents', '0')::bigint;
      EXCEPTION WHEN OTHERS THEN
        amt := 0;
      END;
      old_status := NULL;
      old_amt := NULL;
      SELECT status, amount_cents INTO old_status, old_amt
      FROM public.pay_mercury_transactions
      WHERE treasury_group_id = p_treasury AND mercury_id = mid
      FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.pay_mercury_transactions (
          treasury_group_id, mercury_id, account_id, amount_cents, status, kind, counterparty,
          bank_description, note, external_memo, posted_at, mercury_created_at, dashboard_link
        ) VALUES (
          p_treasury,
          mid,
          acct_uuid,
          amt,
          public.pay_mercury_clip(elem.value->>'status', 40),
          public.pay_mercury_clip(elem.value->>'kind', 80),
          public.pay_mercury_clip(elem.value->>'counterparty', 200),
          public.pay_mercury_clip(elem.value->>'bank_description', 500),
          public.pay_mercury_clip(elem.value->>'note', 1000),
          public.pay_mercury_clip(elem.value->>'external_memo', 500),
          public.pay_mercury_ts(elem.value->>'posted_at'),
          public.pay_mercury_ts(coalesce(elem.value->>'created_at', elem.value->>'mercury_created_at')),
          public.pay_mercury_clip(elem.value->>'dashboard_link', 500)
        );
        new_count := new_count + 1;
      ELSE
        UPDATE public.pay_mercury_transactions SET
          account_id = acct_uuid,
          amount_cents = amt,
          status = public.pay_mercury_clip(elem.value->>'status', 40),
          kind = public.pay_mercury_clip(elem.value->>'kind', 80),
          counterparty = public.pay_mercury_clip(elem.value->>'counterparty', 200),
          bank_description = public.pay_mercury_clip(elem.value->>'bank_description', 500),
          note = public.pay_mercury_clip(elem.value->>'note', 1000),
          external_memo = public.pay_mercury_clip(elem.value->>'external_memo', 500),
          posted_at = public.pay_mercury_ts(elem.value->>'posted_at'),
          mercury_created_at = public.pay_mercury_ts(coalesce(elem.value->>'created_at', elem.value->>'mercury_created_at')),
          dashboard_link = public.pay_mercury_clip(elem.value->>'dashboard_link', 500),
          synced_at = now()
        WHERE treasury_group_id = p_treasury AND mercury_id = mid;
        IF old_status IS DISTINCT FROM public.pay_mercury_clip(elem.value->>'status', 40)
           OR old_amt IS DISTINCT FROM amt THEN
          upd_count := upd_count + 1;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('accounts', acct_count, 'new', new_count, 'updated', upd_count);
END;
$fn$;

-- True when an unlinked book row already has this amount within 7 days.
-- Auto-match leaves those for review so it does not book the same receipt twice.
CREATE OR REPLACE FUNCTION public.pay_mercury_has_existing(p_treasury uuid, p_amount bigint, p_on date)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  lo date := p_on - 7;
  hi date := p_on + 7;
  abs_amt bigint := abs(p_amount);
  found boolean := false;
BEGIN
  IF p_amount <= 0 THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.pay_payments AS pay
    WHERE pay.treasury_group_id = p_treasury
      AND pay.amount_cents = abs_amt
      AND pay.paid_on BETWEEN lo AND hi
      AND NOT EXISTS (
        SELECT 1 FROM public.pay_mercury_transactions AS txn
        WHERE txn.match_type = 'payment' AND txn.match_id = pay.id
      )
  ) INTO found;
  IF found THEN
    RETURN true;
  END IF;
  IF to_regclass('public.pay_cash_entries') IS NOT NULL THEN
    EXECUTE $q$
      SELECT EXISTS (
        SELECT 1 FROM public.pay_cash_entries AS entry
        WHERE entry.treasury_group_id = $1
          AND entry.direction = 'in'
          AND entry.amount_cents = $2
          AND entry.entry_date BETWEEN $3 AND $4
          AND NOT EXISTS (
            SELECT 1 FROM public.pay_mercury_transactions AS txn
            WHERE txn.match_type = 'cash_entry' AND txn.match_id = entry.id
          )
      )
    $q$ INTO found USING p_treasury, abs_amt, lo, hi;
  END IF;
  RETURN coalesce(found, false);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_apply(p_treasury uuid, p_mercury_id text, p_body jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  txn public.pay_mercury_transactions%ROWTYPE;
  kind text;
  target uuid;
  link_type text;
  pay_on date;
  gl uuid;
  cash uuid;
  memo text;
  payload jsonb;
  created_id uuid;
  row_amt bigint;
  row_dir text;
  bill_treasury uuid;
  offset_acct uuid;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO txn
  FROM public.pay_mercury_transactions
  WHERE treasury_group_id = p_treasury AND mercury_id = p_mercury_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_transaction_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF txn.status <> 'sent' THEN
    RAISE EXCEPTION 'not_posted' USING ERRCODE = '22023';
  END IF;
  IF txn.match_type IS NOT NULL THEN
    RAISE EXCEPTION 'already_matched' USING ERRCODE = '23514';
  END IF;

  kind := coalesce(p_body->>'type', '');
  target := NULLIF(p_body->>'target_id', '')::uuid;
  pay_on := coalesce(public.pay_mercury_local_date(coalesce(txn.posted_at, txn.mercury_created_at)), current_date);
  SELECT gl_account_id INTO gl FROM public.pay_mercury_accounts WHERE id = txn.account_id;
  memo := left(concat_ws(' · ',
    NULLIF(btrim(txn.counterparty), ''),
    NULLIF(btrim(txn.bank_description), ''),
    NULLIF(btrim(txn.external_memo), '')
  ), 900);
  payload := jsonb_build_object(
    'amount', public.pay_cents_money(abs(txn.amount_cents)),
    'date', to_char(pay_on, 'YYYY-MM-DD'),
    'method', public.pay_mercury_method(txn.kind),
    'reference', left('Mercury ' || left(txn.mercury_id, 8), 200),
    'notes', left(coalesce(NULLIF(btrim(p_body->>'memo'), ''), memo), 1000),
    'memo', left(coalesce(NULLIF(btrim(p_body->>'memo'), ''), memo), 2000),
    'category', left(coalesce(NULLIF(btrim(p_body->>'category'), ''), 'Other'), 80),
    'counterparty', left(coalesce(NULLIF(btrim(p_body->>'counterparty'), ''), txn.counterparty), 200)
  );
  IF gl IS NOT NULL THEN
    payload := payload || jsonb_build_object('cash_account_id', gl);
  END IF;

  IF kind = 'link' THEN
    link_type := p_body->>'link_type';
    IF target IS NULL OR link_type NOT IN ('payment', 'bill_payment', 'cash_entry') THEN
      RAISE EXCEPTION 'link_target_required' USING ERRCODE = '22023';
    END IF;
    IF link_type = 'payment' THEN
      SELECT amount_cents INTO row_amt
      FROM public.pay_payments
      WHERE id = target AND treasury_group_id = p_treasury;
      IF NOT FOUND OR row_amt IS DISTINCT FROM txn.amount_cents THEN
        RAISE EXCEPTION 'amounts_differ' USING ERRCODE = '22023';
      END IF;
    ELSIF link_type = 'bill_payment' THEN
      IF to_regclass('public.pay_bill_payments') IS NULL THEN
        RAISE EXCEPTION 'payables_unavailable' USING ERRCODE = 'P0002';
      END IF;
      row_amt := NULL;
      EXECUTE 'SELECT amount_cents FROM public.pay_bill_payments WHERE id = $1 AND treasury_group_id = $2'
        INTO row_amt USING target, p_treasury;
      IF row_amt IS NULL OR row_amt IS DISTINCT FROM -txn.amount_cents THEN
        RAISE EXCEPTION 'amounts_differ' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF to_regclass('public.pay_cash_entries') IS NULL THEN
        RAISE EXCEPTION 'payables_unavailable' USING ERRCODE = 'P0002';
      END IF;
      row_dir := NULL;
      row_amt := NULL;
      EXECUTE 'SELECT direction, amount_cents FROM public.pay_cash_entries WHERE id = $1 AND treasury_group_id = $2'
        INTO row_dir, row_amt USING target, p_treasury;
      IF row_dir IS NULL
         OR (txn.amount_cents > 0 AND row_dir IS DISTINCT FROM 'in')
         OR (txn.amount_cents < 0 AND row_dir IS DISTINCT FROM 'out')
         OR row_amt IS DISTINCT FROM abs(txn.amount_cents) THEN
        RAISE EXCEPTION 'amounts_differ' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.pay_mercury_transactions
      WHERE treasury_group_id = p_treasury
        AND match_type = link_type
        AND match_id = target
        AND mercury_id <> txn.mercury_id
    ) THEN
      RAISE EXCEPTION 'already_linked' USING ERRCODE = '23514';
    END IF;
    UPDATE public.pay_mercury_transactions
    SET match_type = link_type, match_id = target, match_created = false, ignored = false
    WHERE id = txn.id;
    IF gl IS NOT NULL AND link_type = 'payment' THEN
      UPDATE public.pay_payments
      SET cash_account_id = gl
      WHERE id = target AND treasury_group_id = p_treasury AND cash_account_id IS NULL;
      PERFORM public.pay_sync_journals(p_treasury);
    ELSIF gl IS NOT NULL AND link_type = 'bill_payment' AND to_regclass('public.pay_bill_payments') IS NOT NULL THEN
      EXECUTE 'UPDATE public.pay_bill_payments SET cash_account_id = $1 WHERE id = $2 AND treasury_group_id = $3 AND cash_account_id IS NULL'
        USING gl, target, p_treasury;
      IF to_regprocedure('public.pay_sync_payable_journals(uuid)') IS NOT NULL THEN
        EXECUTE 'SELECT public.pay_sync_payable_journals($1)' USING p_treasury;
      END IF;
    ELSIF gl IS NOT NULL AND link_type = 'cash_entry' AND to_regclass('public.pay_cash_entries') IS NOT NULL THEN
      EXECUTE 'UPDATE public.pay_cash_entries SET cash_account_id = $1 WHERE id = $2 AND treasury_group_id = $3 AND cash_account_id IS NULL'
        USING gl, target, p_treasury;
      IF to_regprocedure('public.pay_sync_payable_journals(uuid)') IS NOT NULL THEN
        EXECUTE 'SELECT public.pay_sync_payable_journals($1)' USING p_treasury;
      END IF;
    END IF;
    RETURN;
  END IF;

  IF kind = 'invoice' THEN
    IF txn.amount_cents <= 0 THEN
      RAISE EXCEPTION 'inflow_required' USING ERRCODE = '22023';
    END IF;
    IF target IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.pay_invoices
      WHERE id = target AND treasury_group_id = p_treasury AND status IN ('sent', 'draft')
    ) THEN
      RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
    END IF;
    created_id := public.pay_record_payment(target, payload);
    UPDATE public.pay_mercury_transactions
    SET match_type = 'payment', match_id = created_id, match_created = true, ignored = false
    WHERE id = txn.id;
    RETURN;
  END IF;

  IF kind = 'bill' THEN
    IF txn.amount_cents >= 0 THEN
      RAISE EXCEPTION 'outflow_required' USING ERRCODE = '22023';
    END IF;
    IF to_regprocedure('public.pay_record_bill_payment(uuid,jsonb)') IS NULL THEN
      RAISE EXCEPTION 'payables_unavailable' USING ERRCODE = 'P0002';
    END IF;
    EXECUTE 'SELECT treasury_group_id FROM public.pay_bills WHERE id = $1 AND status = ''open'''
      INTO bill_treasury USING target;
    IF bill_treasury IS DISTINCT FROM p_treasury THEN
      RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0002';
    END IF;
    EXECUTE 'SELECT public.pay_record_bill_payment($1, $2)'
      INTO created_id USING target, payload;
    UPDATE public.pay_mercury_transactions
    SET match_type = 'bill_payment', match_id = created_id, match_created = true, ignored = false
    WHERE id = txn.id;
    RETURN;
  END IF;

  IF kind = 'deposit' AND txn.amount_cents <= 0 THEN
    RAISE EXCEPTION 'inflow_required' USING ERRCODE = '22023';
  END IF;
  IF kind = 'expense' AND txn.amount_cents >= 0 THEN
    RAISE EXCEPTION 'outflow_required' USING ERRCODE = '22023';
  END IF;
  IF kind NOT IN ('deposit', 'expense') THEN
    RAISE EXCEPTION 'unknown_match' USING ERRCODE = '22023';
  END IF;

  payload := payload || jsonb_build_object('direction', CASE WHEN kind = 'deposit' THEN 'in' ELSE 'out' END);
  IF to_regprocedure('public.pay_save_cash_entry(uuid,jsonb)') IS NOT NULL THEN
    EXECUTE 'SELECT public.pay_save_cash_entry($1, $2)' INTO created_id USING p_treasury, payload;
    UPDATE public.pay_mercury_transactions
    SET match_type = 'cash_entry', match_id = created_id, match_created = true, ignored = false
    WHERE id = txn.id;
    RETURN;
  END IF;

  cash := coalesce(gl, public.pay_account_id(p_treasury, '1000'));
  offset_acct := public.pay_mercury_chart_account(p_treasury, CASE WHEN kind = 'deposit' THEN 'in' ELSE 'out' END, payload->>'category');
  IF cash IS NULL OR offset_acct IS NULL THEN
    RAISE EXCEPTION 'chart_missing' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.pay_feed_entries (
    treasury_group_id, entry_date, direction, amount_cents, category, counterparty,
    method, reference, memo, account_id, cash_account_id
  ) VALUES (
    p_treasury,
    pay_on,
    CASE WHEN kind = 'deposit' THEN 'in' ELSE 'out' END,
    abs(txn.amount_cents),
    payload->>'category',
    payload->>'counterparty',
    payload->>'method',
    payload->>'reference',
    payload->>'memo',
    offset_acct,
    cash
  ) RETURNING id INTO created_id;
  PERFORM public.pay_activity_add(
    p_treasury,
    'mercury',
    left(CASE WHEN kind = 'deposit' THEN 'Mercury deposit' ELSE 'Mercury expense' END, 500),
    NULL
  );
  UPDATE public.pay_mercury_transactions
  SET match_type = 'feed', match_id = created_id, match_created = true, ignored = false
  WHERE id = txn.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_automatch_inner(p_treasury uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  txn public.pay_mercury_transactions%ROWTYPE;
  inv record;
  memo text;
  hit integer;
  best integer;
  score integer;
  best_id uuid;
  tie boolean;
  pay_on date;
  n integer := 0;
BEGIN
  FOR txn IN
    SELECT *
    FROM public.pay_mercury_transactions
    WHERE treasury_group_id = p_treasury
      AND status = 'sent'
      AND ignored = false
      AND match_type IS NULL
      AND amount_cents > 0
    ORDER BY coalesce(posted_at, mercury_created_at), mercury_id
  LOOP
    pay_on := coalesce(public.pay_mercury_local_date(coalesce(txn.posted_at, txn.mercury_created_at)), current_date);
    IF public.pay_mercury_has_existing(p_treasury, txn.amount_cents, pay_on) THEN
      CONTINUE;
    END IF;
    memo := lower(concat_ws(' ', txn.bank_description, txn.external_memo, txn.note, txn.counterparty));
    best := 0;
    best_id := NULL;
    tie := false;
    FOR inv IN
      SELECT i.id, i.number, (i.total_cents - public.pay_paid_cents(i.id)) AS balance_cents
      FROM public.pay_invoices AS i
      WHERE i.treasury_group_id = p_treasury
        AND i.status IN ('sent', 'draft')
    LOOP
      IF inv.balance_cents IS NULL OR inv.balance_cents <= 0 OR txn.amount_cents <> inv.balance_cents THEN
        CONTINUE;
      END IF;
      hit := public.pay_mercury_number_hit(inv.number, memo);
      IF hit < 3 THEN
        CONTINUE;
      END IF;
      score := hit + 2;
      IF score > best THEN
        best := score;
        best_id := inv.id;
        tie := false;
      ELSIF score = best THEN
        tie := true;
      END IF;
    END LOOP;
    IF best_id IS NOT NULL AND NOT tie AND best >= 5 THEN
      BEGIN
        PERFORM public.pay_mercury_apply(
          p_treasury,
          txn.mercury_id,
          jsonb_build_object('type', 'invoice', 'target_id', best_id)
        );
        n := n + 1;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END LOOP;
  RETURN n;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_status(p_treasury uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  settings public.pay_mercury_settings%ROWTYPE;
  accounts jsonb;
  available bigint;
  current_bal bigint;
  pending_n bigint;
  unmatched_n bigint;
  total_n bigint;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO settings FROM public.pay_mercury_settings WHERE treasury_group_id = p_treasury;
  IF NOT FOUND THEN
    settings := ROW(p_treasury, '', NULL, NULL, true, NULL, '', now())::public.pay_mercury_settings;
  END IF;
  SELECT coalesce(jsonb_agg(row_json ORDER BY sort_status, sort_name), '[]'::jsonb)
  INTO accounts
  FROM (
    SELECT jsonb_build_object(
      'id', account.id,
      'mercury_id', account.mercury_id,
      'name', account.name,
      'nickname', account.nickname,
      'kind', account.kind,
      'status', account.status,
      'account_type', account.account_type,
      'last4', account.last4,
      'available_cents', account.available_cents,
      'current_cents', account.current_cents,
      'dashboard_link', account.dashboard_link,
      'gl_account_id', account.gl_account_id
    ) AS row_json,
    account.status AS sort_status,
    account.name AS sort_name
    FROM public.pay_mercury_accounts AS account
    WHERE account.treasury_group_id = p_treasury
  ) AS listed;
  SELECT coalesce(sum(available_cents), 0), coalesce(sum(current_cents), 0)
  INTO available, current_bal
  FROM public.pay_mercury_accounts
  WHERE treasury_group_id = p_treasury AND status = 'active';
  SELECT
    count(*) FILTER (WHERE status = 'pending'),
    count(*) FILTER (WHERE status = 'sent' AND ignored = false AND match_type IS NULL),
    count(*)
  INTO pending_n, unmatched_n, total_n
  FROM public.pay_mercury_transactions
  WHERE treasury_group_id = p_treasury;
  RETURN jsonb_build_object(
    'connected', EXISTS (SELECT 1 FROM public.pay_mercury_secrets WHERE treasury_group_id = p_treasury),
    'token_hint', coalesce(settings.token_hint, ''),
    'environment', settings.environment,
    'sync_start', settings.sync_start,
    'auto_match', coalesce(settings.auto_match, true),
    'last_sync_at', settings.last_sync_at,
    'last_error', coalesce(settings.last_error, ''),
    'payables', to_regclass('public.pay_bills') IS NOT NULL AND to_regclass('public.pay_bill_payments') IS NOT NULL,
    'expenses', to_regclass('public.pay_cash_entries') IS NOT NULL,
    'pending', coalesce(pending_n, 0),
    'unmatched', coalesce(unmatched_n, 0),
    'transactions', coalesce(total_n, 0),
    'total_available_cents', coalesce(available, 0),
    'total_current_cents', coalesce(current_bal, 0),
    'accounts', coalesce(accounts, '[]'::jsonb)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_save_settings(p_treasury uuid, p_sync_start text, p_auto_match boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  start_on date;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  IF p_sync_start IS NULL OR btrim(p_sync_start) = '' THEN
    start_on := NULL;
  ELSE
    start_on := public.pay_date_in(p_sync_start);
  END IF;
  INSERT INTO public.pay_mercury_settings (treasury_group_id, sync_start, auto_match)
  VALUES (p_treasury, start_on, coalesce(p_auto_match, true))
  ON CONFLICT (treasury_group_id) DO UPDATE
  SET sync_start = EXCLUDED.sync_start,
      auto_match = EXCLUDED.auto_match,
      updated_at = now();
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_disconnect(p_treasury uuid, p_forget boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  DELETE FROM public.pay_mercury_secrets WHERE treasury_group_id = p_treasury;
  UPDATE public.pay_mercury_settings
  SET token_hint = '', environment = NULL, last_error = '', updated_at = now()
  WHERE treasury_group_id = p_treasury;
  IF coalesce(p_forget, false) THEN
    DELETE FROM public.pay_mercury_transactions
    WHERE treasury_group_id = p_treasury AND match_type IS NULL;
    DELETE FROM public.pay_mercury_accounts AS account
    WHERE account.treasury_group_id = p_treasury
      AND NOT EXISTS (
        SELECT 1 FROM public.pay_mercury_transactions AS txn WHERE txn.account_id = account.id
      );
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_link_gl(p_treasury uuid, p_mercury_id text, p_gl uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  acct public.pay_mercury_accounts%ROWTYPE;
  found_type text;
  found_sub text;
  found_archived boolean;
  mapped uuid;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO acct
  FROM public.pay_mercury_accounts
  WHERE treasury_group_id = p_treasury AND mercury_id = p_mercury_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mercury_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_gl IS NULL THEN
    mapped := public.pay_mercury_gl_account(p_treasury, acct.kind, acct.name, acct.nickname, acct.account_type);
  ELSE
    SELECT account_type, subtype, archived INTO found_type, found_sub, found_archived
    FROM public.pay_accounts
    WHERE id = p_gl AND treasury_group_id = p_treasury;
    IF NOT FOUND OR found_archived
       OR found_type NOT IN ('asset', 'liability')
       OR found_sub NOT IN ('bank', 'cash', 'credit_card', 'digital_asset') THEN
      RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
    END IF;
    mapped := p_gl;
  END IF;
  UPDATE public.pay_mercury_accounts SET gl_account_id = mapped, updated_at = now() WHERE id = acct.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_match(p_treasury uuid, p_mercury_id text, p_body jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  kind text;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  kind := coalesce(p_body->>'type', '');
  IF kind IN ('ignore', 'unignore') THEN
    IF kind = 'ignore' AND EXISTS (
      SELECT 1 FROM public.pay_mercury_transactions
      WHERE treasury_group_id = p_treasury AND mercury_id = p_mercury_id AND match_type IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'already_matched' USING ERRCODE = '23514';
    END IF;
    UPDATE public.pay_mercury_transactions
    SET ignored = (kind = 'ignore')
    WHERE treasury_group_id = p_treasury AND mercury_id = p_mercury_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bank_transaction_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN;
  END IF;
  PERFORM public.pay_mercury_apply(p_treasury, p_mercury_id, p_body);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_unmatch(p_treasury uuid, p_mercury_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  txn public.pay_mercury_transactions%ROWTYPE;
  found boolean;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO txn
  FROM public.pay_mercury_transactions
  WHERE treasury_group_id = p_treasury AND mercury_id = p_mercury_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_transaction_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF txn.match_created AND txn.match_id IS NOT NULL AND txn.match_type = 'payment' THEN
    IF EXISTS (SELECT 1 FROM public.pay_payments WHERE id = txn.match_id) THEN
      PERFORM public.pay_delete_payment(txn.match_id);
    END IF;
  ELSIF txn.match_created AND txn.match_id IS NOT NULL AND txn.match_type = 'bill_payment'
        AND to_regclass('public.pay_bill_payments') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.pay_bill_payments WHERE id = $1)' INTO found USING txn.match_id;
    IF found AND to_regprocedure('public.pay_delete_bill_payment(uuid)') IS NOT NULL THEN
      EXECUTE 'SELECT public.pay_delete_bill_payment($1)' USING txn.match_id;
    END IF;
  ELSIF txn.match_created AND txn.match_id IS NOT NULL AND txn.match_type = 'cash_entry'
        AND to_regclass('public.pay_cash_entries') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.pay_cash_entries WHERE id = $1)' INTO found USING txn.match_id;
    IF found AND to_regprocedure('public.pay_delete_cash_entry(uuid)') IS NOT NULL THEN
      EXECUTE 'SELECT public.pay_delete_cash_entry($1)' USING txn.match_id;
    END IF;
  ELSIF txn.match_created AND txn.match_id IS NOT NULL AND txn.match_type = 'feed' THEN
    DELETE FROM public.pay_feed_entries
    WHERE id = txn.match_id AND treasury_group_id = p_treasury;
  END IF;
  UPDATE public.pay_mercury_transactions
  SET match_type = NULL, match_id = NULL, match_created = false
  WHERE id = txn.id;
  PERFORM public.pay_activity_add(p_treasury, 'mercury', 'Mercury match removed', NULL);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_automatch(p_treasury uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  RETURN public.pay_mercury_automatch_inner(p_treasury);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Reconciliation. Clearing is stored on pay_recon_items, not on the journal.
-- A finished period can lock this account only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_account_reconcilable(p_subtype text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT coalesce(p_subtype, '') IN ('bank', 'cash', 'credit_card', 'digital_asset');
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_lines(p_account uuid, p_through date)
RETURNS TABLE (
  clear_key text,
  entry_date date,
  memo text,
  ref text,
  party text,
  source_type text,
  source_id uuid,
  amount_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_treasury uuid;
  v_type text;
  v_sign integer;
BEGIN
  SELECT treasury_group_id, account_type INTO v_treasury, v_type
  FROM public.pay_accounts
  WHERE id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(v_treasury);
  v_sign := CASE WHEN v_type IN ('asset', 'expense') THEN 1 ELSE -1 END;
  RETURN QUERY
  SELECT
    (entry.source_type || ':' || entry.source_id::text || ':' || line.line_no::text),
    entry.entry_date,
    entry.memo,
    entry.ref,
    entry.party,
    entry.source_type,
    entry.source_id,
    ((line.debit_cents - line.credit_cents) * v_sign)::bigint
  FROM public.pay_journal_lines AS line
  JOIN public.pay_journal_entries AS entry ON entry.id = line.entry_id
  WHERE line.account_id = p_account
    AND entry.treasury_group_id = v_treasury
    AND entry.entry_date <= p_through
  UNION ALL
  SELECT
    ('feed:' || feed.id::text),
    feed.entry_date,
    feed.memo,
    feed.reference,
    feed.counterparty,
    'feed'::text,
    feed.id,
    ((CASE WHEN feed.direction = 'in' THEN feed.amount_cents ELSE -feed.amount_cents END) * v_sign)::bigint
  FROM public.pay_feed_entries AS feed
  WHERE feed.cash_account_id = p_account
    AND feed.treasury_group_id = v_treasury
    AND feed.entry_date <= p_through
  ORDER BY 2, 6, 1;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_mercury_line_bank(p_treasury uuid, p_source_type text, p_source_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'id', txn.mercury_id,
    'status', txn.status,
    'posted', public.pay_mercury_local_date(coalesce(txn.posted_at, txn.mercury_created_at))
  )
  FROM public.pay_mercury_transactions AS txn
  WHERE txn.treasury_group_id = p_treasury
    AND txn.match_id = p_source_id
    AND (
      (p_source_type = 'payment' AND txn.match_type = 'payment')
      OR (p_source_type = 'bill_payment' AND txn.match_type = 'bill_payment')
      OR (p_source_type = 'cash_transaction' AND txn.match_type = 'cash_entry')
      OR (p_source_type = 'feed' AND txn.match_type = 'feed')
    )
  LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_get(p_recon uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  recon public.pay_reconciliations%ROWTYPE;
  acct public.pay_accounts%ROWTYPE;
  rec record;
  items jsonb := '[]'::jsonb;
  flags jsonb := '[]'::jsonb;
  seen_keys text[] := ARRAY[]::text[];
  stored bigint;
  cleared_sum bigint := 0;
  is_cleared boolean;
  bank jsonb;
  last_dates jsonb := '{}'::jsonb;
  prev text;
  book_bal bigint;
  locked date;
  unb record;
BEGIN
  SELECT * INTO recon FROM public.pay_reconciliations WHERE id = p_recon;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(recon.treasury_group_id);
  SELECT * INTO acct FROM public.pay_accounts WHERE id = recon.account_id;

  FOR rec IN
    SELECT * FROM public.pay_recon_lines(recon.account_id, recon.statement_date)
  LOOP
    seen_keys := seen_keys || rec.clear_key;
    IF EXISTS (
      SELECT 1
      FROM public.pay_recon_items AS item
      JOIN public.pay_reconciliations AS other ON other.id = item.recon_id
      WHERE other.account_id = recon.account_id
        AND other.id <> recon.id
        AND other.status = 'finished'
        AND item.clear_key = rec.clear_key
    ) THEN
      CONTINUE;
    END IF;
    stored := NULL;
    SELECT amount_cents INTO stored
    FROM public.pay_recon_items
    WHERE recon_id = recon.id AND clear_key = rec.clear_key;
    is_cleared := FOUND;
    IF is_cleared THEN
      cleared_sum := cleared_sum + stored;
      IF stored IS DISTINCT FROM rec.amount_cents AND jsonb_array_length(flags) < 100 THEN
        flags := flags || jsonb_build_object(
          'level', 'error',
          'key', rec.clear_key,
          'text', 'Cleared line changed after it was ticked'
        );
      END IF;
    ELSIF rec.entry_date < recon.statement_date - 60 AND jsonb_array_length(flags) < 100 THEN
      flags := flags || jsonb_build_object(
        'level', 'warn',
        'key', rec.clear_key,
        'text', 'Uncleared for 60 or more days'
      );
    END IF;
    bank := public.pay_mercury_line_bank(recon.treasury_group_id, rec.source_type, rec.source_id);
    items := items || jsonb_build_object(
      'clear_key', rec.clear_key,
      'date', rec.entry_date,
      'memo', rec.memo,
      'ref', rec.ref,
      'party', rec.party,
      'source_type', rec.source_type,
      'source_id', rec.source_id,
      'amount_cents', rec.amount_cents,
      'cleared', is_cleared,
      'mercury', bank
    );
    prev := last_dates ->> rec.amount_cents::text;
    IF prev IS NOT NULL AND rec.amount_cents <> 0 AND (rec.entry_date - prev::date) BETWEEN 0 AND 3
       AND jsonb_array_length(flags) < 100 THEN
      flags := flags || jsonb_build_object(
        'level', 'warn',
        'key', rec.clear_key,
        'text', 'Possible duplicate amount'
      );
    END IF;
    last_dates := jsonb_set(last_dates, ARRAY[rec.amount_cents::text], to_jsonb(rec.entry_date::text), true);
  END LOOP;

  FOR rec IN
    SELECT clear_key, amount_cents, entry_date
    FROM public.pay_recon_items
    WHERE recon_id = recon.id
  LOOP
    IF NOT rec.clear_key = ANY (seen_keys) THEN
      cleared_sum := cleared_sum + rec.amount_cents;
      IF jsonb_array_length(flags) < 100 THEN
        flags := flags || jsonb_build_object(
          'level', 'error',
          'key', rec.clear_key,
          'text', 'A cleared line no longer exists on this account'
        );
      END IF;
    END IF;
  END LOOP;

  FOR unb IN
    SELECT
      txn.amount_cents,
      txn.counterparty,
      public.pay_mercury_local_date(coalesce(txn.posted_at, txn.mercury_created_at)) AS posted_on
    FROM public.pay_mercury_transactions AS txn
    JOIN public.pay_mercury_accounts AS account ON account.id = txn.account_id
    WHERE account.gl_account_id = recon.account_id
      AND account.treasury_group_id = recon.treasury_group_id
      AND txn.status = 'sent'
      AND txn.ignored = false
      AND txn.match_type IS NULL
  LOOP
    IF unb.posted_on IS NOT NULL AND unb.posted_on <= recon.statement_date AND jsonb_array_length(flags) < 100 THEN
      flags := flags || jsonb_build_object(
        'level', 'error',
        'key', NULL,
        'text', 'Mercury posted ' || unb.posted_on::text || ' but it is not in the books'
      );
    END IF;
  END LOOP;

  SELECT coalesce(sum(amount_cents), 0) INTO book_bal
  FROM public.pay_recon_lines(recon.account_id, recon.statement_date);
  SELECT locked_through INTO locked FROM public.pay_account_locks WHERE account_id = recon.account_id;

  RETURN jsonb_build_object(
    'recon', jsonb_build_object(
      'id', recon.id,
      'account_id', recon.account_id,
      'statement_date', recon.statement_date,
      'statement_balance_cents', recon.statement_balance_cents,
      'begin_balance_cents', recon.begin_balance_cents,
      'status', recon.status,
      'notes', recon.notes,
      'finished_at', recon.finished_at
    ),
    'account', jsonb_build_object(
      'id', acct.id,
      'code', acct.code,
      'name', acct.name,
      'account_type', acct.account_type,
      'subtype', acct.subtype
    ),
    'items', items,
    'cleared_cents', cleared_sum,
    'cleared_balance_cents', recon.begin_balance_cents + cleared_sum,
    'difference_cents', recon.statement_balance_cents - (recon.begin_balance_cents + cleared_sum),
    'flags', flags,
    'book_balance_cents', coalesce(book_bal, 0),
    'locked_through', locked
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_accounts(p_treasury uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  acct record;
  rows jsonb := '[]'::jsonb;
  bal bigint;
  last_on date;
  open_id uuid;
  locked date;
  merc jsonb;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  FOR acct IN
    SELECT id, code, name, account_type, subtype
    FROM public.pay_accounts
    WHERE treasury_group_id = p_treasury
      AND archived = false
      AND public.pay_account_reconcilable(subtype)
    ORDER BY code
  LOOP
    bal := 0;
    last_on := NULL;
    open_id := NULL;
    locked := NULL;
    merc := '[]'::jsonb;
    SELECT coalesce(sum(amount_cents), 0) INTO bal
    FROM public.pay_recon_lines(acct.id, current_date);
    SELECT max(statement_date) INTO last_on
    FROM public.pay_reconciliations
    WHERE account_id = acct.id AND status = 'finished';
    SELECT id INTO open_id
    FROM public.pay_reconciliations
    WHERE account_id = acct.id AND status = 'open';
    SELECT locked_through INTO locked FROM public.pay_account_locks WHERE account_id = acct.id;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'mercury_id', mercury_id,
      'name', name,
      'nickname', nickname,
      'last4', last4,
      'current_cents', current_cents
    )), '[]'::jsonb)
    INTO merc
    FROM public.pay_mercury_accounts
    WHERE gl_account_id = acct.id;
    rows := rows || jsonb_build_object(
      'id', acct.id,
      'code', acct.code,
      'name', acct.name,
      'account_type', acct.account_type,
      'subtype', acct.subtype,
      'balance_cents', coalesce(bal, 0),
      'last_reconciled', last_on,
      'open_recon', open_id,
      'locked_through', locked,
      'mercury', coalesce(merc, '[]'::jsonb)
    );
  END LOOP;
  RETURN rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_list(p_treasury uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  rows jsonb;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT coalesce(jsonb_agg(row_json), '[]'::jsonb) INTO rows
  FROM (
    SELECT jsonb_build_object(
      'id', recon.id,
      'account_id', recon.account_id,
      'code', acct.code,
      'name', acct.name,
      'statement_date', recon.statement_date,
      'statement_balance_cents', recon.statement_balance_cents,
      'status', recon.status,
      'notes', recon.notes,
      'finished_at', recon.finished_at
    ) AS row_json
    FROM public.pay_reconciliations AS recon
    JOIN public.pay_accounts AS acct ON acct.id = recon.account_id
    WHERE recon.treasury_group_id = p_treasury
    ORDER BY recon.statement_date DESC, recon.created_at DESC
    LIMIT 200
  ) AS listed;
  RETURN coalesce(rows, '[]'::jsonb);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_start(
  p_treasury uuid,
  p_account uuid,
  p_statement_date text,
  p_statement_balance text,
  p_notes text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  acct public.pay_accounts%ROWTYPE;
  statement_on date;
  ending bigint;
  last_on date;
  begin_bal bigint := 0;
  created uuid;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  SELECT * INTO acct FROM public.pay_accounts WHERE id = p_account AND treasury_group_id = p_treasury;
  IF NOT FOUND OR acct.archived OR NOT public.pay_account_reconcilable(acct.subtype) THEN
    RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
  END IF;
  IF acct.account_type NOT IN ('asset', 'liability') THEN
    RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
  END IF;
  statement_on := public.pay_date_in(p_statement_date);
  ending := public.pay_money_cents(coalesce(p_statement_balance, '0'), true);
  IF EXISTS (
    SELECT 1 FROM public.pay_reconciliations WHERE account_id = p_account AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'reconciliation_open' USING ERRCODE = '23514';
  END IF;
  SELECT statement_date, statement_balance_cents INTO last_on, begin_bal
  FROM public.pay_reconciliations
  WHERE account_id = p_account AND status = 'finished'
  ORDER BY statement_date DESC
  LIMIT 1;
  IF NOT FOUND THEN
    begin_bal := 0;
  ELSIF statement_on <= last_on THEN
    RAISE EXCEPTION 'statement_not_after_last' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pay_reconciliations (
    treasury_group_id, account_id, statement_date, statement_balance_cents, begin_balance_cents, notes
  ) VALUES (
    p_treasury, p_account, statement_on, ending, begin_bal, left(coalesce(p_notes, ''), 1000)
  ) RETURNING id INTO created;
  RETURN created;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_set_cleared(p_recon uuid, p_keys text[], p_cleared boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  recon public.pay_reconciliations%ROWTYPE;
  key text;
  found_date date;
  found_amt bigint;
BEGIN
  SELECT * INTO recon FROM public.pay_reconciliations WHERE id = p_recon FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(recon.treasury_group_id);
  IF recon.status <> 'open' THEN
    RAISE EXCEPTION 'reconciliation_finished' USING ERRCODE = '23514';
  END IF;
  IF p_keys IS NULL THEN
    RETURN;
  END IF;
  FOREACH key IN ARRAY p_keys LOOP
    IF p_cleared THEN
      SELECT entry_date, amount_cents INTO found_date, found_amt
      FROM public.pay_recon_lines(recon.account_id, recon.statement_date)
      WHERE clear_key = key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'line_not_found' USING ERRCODE = 'P0002';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.pay_recon_items AS item
        JOIN public.pay_reconciliations AS other ON other.id = item.recon_id
        WHERE other.account_id = recon.account_id
          AND other.id <> recon.id
          AND other.status = 'finished'
          AND item.clear_key = key
      ) THEN
        CONTINUE;
      END IF;
      INSERT INTO public.pay_recon_items (recon_id, clear_key, amount_cents, entry_date)
      VALUES (p_recon, key, found_amt, found_date)
      ON CONFLICT (recon_id, clear_key) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents, entry_date = EXCLUDED.entry_date;
    ELSE
      DELETE FROM public.pay_recon_items WHERE recon_id = p_recon AND clear_key = key;
    END IF;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_autoclear(p_recon uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  recon public.pay_reconciliations%ROWTYPE;
  keys text[];
BEGIN
  SELECT * INTO recon FROM public.pay_reconciliations WHERE id = p_recon;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(recon.treasury_group_id);
  SELECT coalesce(array_agg(line.clear_key), ARRAY[]::text[]) INTO keys
  FROM public.pay_recon_lines(recon.account_id, recon.statement_date) AS line
  JOIN public.pay_mercury_transactions AS txn
    ON txn.treasury_group_id = recon.treasury_group_id
   AND txn.match_id = line.source_id
   AND (
     (line.source_type = 'payment' AND txn.match_type = 'payment')
     OR (line.source_type = 'bill_payment' AND txn.match_type = 'bill_payment')
     OR (line.source_type = 'cash_transaction' AND txn.match_type = 'cash_entry')
     OR (line.source_type = 'feed' AND txn.match_type = 'feed')
   )
  WHERE txn.status = 'sent'
    AND public.pay_mercury_local_date(coalesce(txn.posted_at, txn.mercury_created_at)) IS NOT NULL
    AND public.pay_mercury_local_date(coalesce(txn.posted_at, txn.mercury_created_at)) <= recon.statement_date
    AND NOT EXISTS (
      SELECT 1 FROM public.pay_recon_items AS item
      WHERE item.recon_id = p_recon AND item.clear_key = line.clear_key
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.pay_recon_items AS item
      JOIN public.pay_reconciliations AS other ON other.id = item.recon_id
      WHERE other.account_id = recon.account_id
        AND other.status = 'finished'
        AND other.id <> recon.id
        AND item.clear_key = line.clear_key
    );
  IF keys IS NULL OR cardinality(keys) = 0 THEN
    RETURN 0;
  END IF;
  PERFORM public.pay_recon_set_cleared(p_recon, keys, true);
  RETURN cardinality(keys);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_update(p_recon uuid, p_statement_balance text, p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  recon public.pay_reconciliations%ROWTYPE;
BEGIN
  SELECT * INTO recon FROM public.pay_reconciliations WHERE id = p_recon FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(recon.treasury_group_id);
  IF recon.status <> 'open' THEN
    RAISE EXCEPTION 'reconciliation_finished' USING ERRCODE = '23514';
  END IF;
  UPDATE public.pay_reconciliations
  SET statement_balance_cents = public.pay_money_cents(coalesce(p_statement_balance, '0'), true),
      notes = left(coalesce(p_notes, ''), 1000)
  WHERE id = p_recon;
  RETURN public.pay_recon_get(p_recon);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_finish(p_recon uuid, p_lock boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  recon public.pay_reconciliations%ROWTYPE;
  acct public.pay_accounts%ROWTYPE;
  detail jsonb;
  diff bigint;
  blocked boolean;
  locked date;
BEGIN
  SELECT * INTO recon FROM public.pay_reconciliations WHERE id = p_recon FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(recon.treasury_group_id);
  IF recon.status <> 'open' THEN
    RAISE EXCEPTION 'reconciliation_finished' USING ERRCODE = '23514';
  END IF;
  detail := public.pay_recon_get(p_recon);
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(detail->'flags') AS flag
    WHERE flag->>'level' = 'error' AND coalesce(flag->>'key', '') <> ''
  ) INTO blocked;
  IF blocked THEN
    RAISE EXCEPTION 'reconciliation_unbalanced' USING ERRCODE = '23514';
  END IF;
  diff := (detail->>'difference_cents')::bigint;
  IF diff IS NULL OR diff <> 0 THEN
    RAISE EXCEPTION 'difference_not_zero' USING ERRCODE = '23514';
  END IF;
  UPDATE public.pay_reconciliations SET status = 'finished', finished_at = now() WHERE id = p_recon;
  IF coalesce(p_lock, false) THEN
    SELECT * INTO acct FROM public.pay_accounts WHERE id = recon.account_id;
    INSERT INTO public.pay_account_locks (account_id, treasury_group_id, locked_through, note)
    VALUES (
      recon.account_id,
      recon.treasury_group_id,
      recon.statement_date,
      left('Reconciled ' || coalesce(acct.name, '') || ' through ' || recon.statement_date::text, 500)
    )
    ON CONFLICT (account_id) DO UPDATE
    SET locked_through = EXCLUDED.locked_through,
        note = EXCLUDED.note,
        locked_at = now()
    WHERE public.pay_account_locks.locked_through < EXCLUDED.locked_through;
  END IF;
  SELECT locked_through INTO locked FROM public.pay_account_locks WHERE account_id = recon.account_id;
  RETURN jsonb_build_object('finished', true, 'locked_through', locked);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_recon_undo(p_recon uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  recon public.pay_reconciliations%ROWTYPE;
BEGIN
  SELECT * INTO recon FROM public.pay_reconciliations WHERE id = p_recon FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(recon.treasury_group_id);
  IF recon.status = 'finished' THEN
    IF EXISTS (
      SELECT 1 FROM public.pay_reconciliations
      WHERE account_id = recon.account_id AND statement_date > recon.statement_date
    ) THEN
      RAISE EXCEPTION 'later_reconciliation' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.pay_account_locks
      WHERE account_id = recon.account_id AND locked_through >= recon.statement_date
    ) THEN
      RAISE EXCEPTION 'account_locked' USING ERRCODE = '23514';
    END IF;
    UPDATE public.pay_reconciliations SET status = 'open', finished_at = NULL WHERE id = p_recon;
  ELSE
    DELETE FROM public.pay_reconciliations WHERE id = p_recon;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_account_lock_clear(p_account uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_treasury uuid;
BEGIN
  SELECT treasury_group_id INTO v_treasury FROM public.pay_accounts WHERE id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(v_treasury);
  DELETE FROM public.pay_account_locks WHERE account_id = p_account;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- RLS. Operators read. Token holders do not. The token tables have no policy.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_mercury_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_mercury_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_mercury_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_mercury_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_mercury_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_feed_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_recon_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_account_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read mercury settings" ON public.pay_mercury_settings;
CREATE POLICY "Pay operators read mercury settings"
  ON public.pay_mercury_settings FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read mercury accounts" ON public.pay_mercury_accounts;
CREATE POLICY "Pay operators read mercury accounts"
  ON public.pay_mercury_accounts FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read mercury transactions" ON public.pay_mercury_transactions;
CREATE POLICY "Pay operators read mercury transactions"
  ON public.pay_mercury_transactions FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read feed entries" ON public.pay_feed_entries;
CREATE POLICY "Pay operators read feed entries"
  ON public.pay_feed_entries FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read reconciliations" ON public.pay_reconciliations;
CREATE POLICY "Pay operators read reconciliations"
  ON public.pay_reconciliations FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read recon items" ON public.pay_recon_items;
CREATE POLICY "Pay operators read recon items"
  ON public.pay_recon_items FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.pay_reconciliations AS recon
      WHERE recon.id = recon_id
        AND public.pay_caller_is_operator(recon.treasury_group_id)
    )
  );

DROP POLICY IF EXISTS "Pay operators read account locks" ON public.pay_account_locks;
CREATE POLICY "Pay operators read account locks"
  ON public.pay_account_locks FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_mercury_keys FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_mercury_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_mercury_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_mercury_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_mercury_transactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_feed_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_reconciliations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_recon_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_account_locks FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_mercury_settings TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_mercury_accounts TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_mercury_transactions TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_feed_entries TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_reconciliations TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_recon_items TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_account_locks TO anon, authenticated;

GRANT ALL ON TABLE public.pay_mercury_keys TO service_role;
GRANT ALL ON TABLE public.pay_mercury_secrets TO service_role;
GRANT ALL ON TABLE public.pay_mercury_settings TO service_role;
GRANT ALL ON TABLE public.pay_mercury_accounts TO service_role;
GRANT ALL ON TABLE public.pay_mercury_transactions TO service_role;
GRANT ALL ON TABLE public.pay_feed_entries TO service_role;
GRANT ALL ON TABLE public.pay_reconciliations TO service_role;
GRANT ALL ON TABLE public.pay_recon_items TO service_role;
GRANT ALL ON TABLE public.pay_account_locks TO service_role;

REVOKE ALL ON FUNCTION public.pay_wallet_is_operator(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_require_wallet(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_kek(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_clip(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_cents_money(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_local_date(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_ts(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_method(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_number_hit(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_gl_account(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_chart_account(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_put_token(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_read_token(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_note_sync(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_upsert(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_has_existing(uuid, bigint, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_apply(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_automatch_inner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_account_reconcilable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_recon_lines(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_mercury_line_bank(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pay_wallet_is_operator(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_require_wallet(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_kek(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_put_token(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_read_token(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_note_sync(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_upsert(uuid, text, jsonb, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.pay_mercury_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_mercury_save_settings(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_mercury_disconnect(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_mercury_link_gl(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_mercury_match(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_mercury_unmatch(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_mercury_automatch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_get(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_accounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_start(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_set_cleared(uuid, text[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_autoclear(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_update(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_finish(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_recon_undo(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_account_lock_clear(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pay_mercury_status(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_save_settings(uuid, text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_disconnect(uuid, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_link_gl(uuid, text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_match(uuid, text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_unmatch(uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_mercury_automatch(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_get(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_accounts(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_list(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_start(uuid, uuid, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_set_cleared(uuid, text[], boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_autoclear(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_update(uuid, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_finish(uuid, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_recon_undo(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_account_lock_clear(uuid) TO anon, authenticated, service_role;
