-- Nave Pay close: reports read the existing journal, and this migration adds
-- the books-wide period lock, the append-only audit hash chain, manual
-- journals, and chart name / active edits.
--
-- Tenant is treasury_group_id. Operators are x-wallet-address matched to
-- creator_wallet or dao_authorized_wallets, same as the other pay tables.
-- Token holders have no SELECT policy.
--
-- Period lock
-- -----------
-- pay_books_lock.locked_through is one date for the whole set of books.
-- A journal insert dated on or before that date is rejected unless it is a
-- faithful restore of a source that was already sealed when the period was
-- closed. Invoice, bill, cash, and payroll posters delete and reinsert their
-- journals. An unchanged closed document can be restored. A new or changed
-- journal dated inside the lock raises PERIOD_LOCKED, so those posters fail
-- without this migration rewriting them. Deletes that drop a sealed journal,
-- and updates of a locked entry, are rejected too.
--
-- Audit
-- -----
-- pay_audit_log is append-only, one chain per treasury. Each row stores
-- prev_hash and a SHA-256 of the canonical payload. Snapshots omit
-- company and bank-instruction blobs. Keys that would hold a tax id,
-- direct-deposit number, or Mercury token are stored as a SHA-256 only.
-- SSN and EIN patterns in free text are replaced with a hash before insert.

-- ---------------------------------------------------------------------------
-- Manual journals. Keep every source type already allowed, and add manual.
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
      CHECK (source_type IN ('invoice', 'payment', 'manual'));
    RETURN;
  END IF;

  IF def ILIKE '%manual%' THEN
    RETURN;
  END IF;

  body := regexp_replace(def, '^\s*CHECK\s*\((.*)\)\s*$', '\1', 'i');
  EXECUTE format('ALTER TABLE public.pay_journal_entries DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE public.pay_journal_entries ADD CONSTRAINT pay_journal_entries_source_type_check CHECK ((%s) OR source_type = %L)',
    body,
    'manual'
  );
END
$widen$;

-- ---------------------------------------------------------------------------
-- Lock, seals, and the audit chain
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_books_lock (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  locked_through date,
  locked_at timestamptz,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_books_lock_note_len CHECK (char_length(note) <= 500)
);

COMMENT ON TABLE public.pay_books_lock IS
  'One lock date for every journal in the treasury. NULL locked_through means the books are open.';

COMMENT ON COLUMN public.pay_books_lock.locked_through IS
  'Journal dates on or before this day are closed. Inserts of a new or changed entry are rejected.';

CREATE TABLE IF NOT EXISTS public.pay_journal_seals (
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  entry_date date NOT NULL,
  payload_hash text NOT NULL,
  PRIMARY KEY (treasury_group_id, source_type, source_id)
);

COMMENT ON TABLE public.pay_journal_seals IS
  'Frozen content of each journal dated inside the lock. A poster may delete and reinsert that source only when the date and payload hash still match.';

CREATE TABLE IF NOT EXISTS public.pay_audit_head (
  treasury_group_id uuid PRIMARY KEY REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  last_seq bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT 'GENESIS'
);

COMMENT ON TABLE public.pay_audit_head IS
  'Tip of the per-treasury audit chain. Row locks serialize appends. The log itself is the evidence.';

CREATE TABLE IF NOT EXISTS public.pay_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_group_id uuid NOT NULL REFERENCES public.pay_enablement (treasury_group_id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  at timestamptz NOT NULL,
  at_text text NOT NULL,
  actor text,
  document_type text NOT NULL,
  document_id uuid,
  op text NOT NULL,
  before_payload jsonb,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  CONSTRAINT pay_audit_log_seq UNIQUE (treasury_group_id, seq),
  CONSTRAINT pay_audit_log_op CHECK (op IN ('I', 'U', 'D')),
  CONSTRAINT pay_audit_log_document CHECK (
    document_type IN ('invoice', 'bill', 'journal', 'payroll_run', 'account', 'period_lock')
  ),
  CONSTRAINT pay_audit_log_payload_safe CHECK (
    payload::text !~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
    AND payload::text !~ '[0-9]{2}-[0-9]{7}'
    AND coalesce(before_payload::text, '') !~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
    AND coalesce(before_payload::text, '') !~ '[0-9]{2}-[0-9]{7}'
  )
);

COMMENT ON TABLE public.pay_audit_log IS
  'Append-only hash chain for invoice, bill, journal, payroll run, account, and period-lock changes. prev_hash links to the prior row. hash is SHA-256 of the canonical payload. Tax ids, direct-deposit numbers, and Mercury tokens are not stored; a hash is stored if the key was present.';

CREATE INDEX IF NOT EXISTS pay_audit_log_group_idx
  ON public.pay_audit_log (treasury_group_id, seq);

-- ---------------------------------------------------------------------------
-- Canonical audit hash and redaction
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_audit_digest(
  p_prev text,
  p_seq bigint,
  p_at text,
  p_document_type text,
  p_op text,
  p_document_id uuid,
  p_before jsonb,
  p_payload jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
  SELECT encode(digest(convert_to(
    coalesce(p_prev, '') || '|' ||
    p_seq::text || '|' ||
    coalesce(p_at, '') || '|' ||
    coalesce(p_document_type, '') || '|' ||
    coalesce(p_op, '') || '|' ||
    coalesce(p_document_id::text, '') || '|' ||
    coalesce(p_before::text, '') || '|' ||
    coalesce(p_payload::text, ''),
    'UTF8'
  ), 'sha256'), 'hex');
$fn$;

COMMENT ON FUNCTION public.pay_audit_digest(text, bigint, text, text, text, uuid, jsonb, jsonb) IS
  'SHA-256 of prev|seq|at|document|op|id|before|payload. payload text is Postgres jsonb text, with a space after ":" and ",".';

CREATE OR REPLACE FUNCTION public.pay_audit_scrub_text(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
DECLARE
  s text := coalesce(p_value, '');
  m text[];
BEGIN
  WHILE s ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' LOOP
    m := regexp_match(s, '[0-9]{3}-[0-9]{2}-[0-9]{4}');
    EXIT WHEN m IS NULL OR m[1] IS NULL;
    s := replace(s, m[1], 'sha256:' || encode(digest(convert_to(m[1], 'UTF8'), 'sha256'), 'hex'));
  END LOOP;
  WHILE s ~ '[0-9]{2}-[0-9]{7}' LOOP
    m := regexp_match(s, '[0-9]{2}-[0-9]{7}');
    EXIT WHEN m IS NULL OR m[1] IS NULL;
    s := replace(s, m[1], 'sha256:' || encode(digest(convert_to(m[1], 'UTF8'), 'sha256'), 'hex'));
  END LOOP;
  RETURN s;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_audit_scrub_json(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
DECLARE
  k text;
  v jsonb;
  result jsonb;
  secret boolean;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN p_value;
  END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    result := '{}'::jsonb;
    FOR k, v IN SELECT key, value FROM jsonb_each(p_value) LOOP
      secret := lower(k) IN (
        'tax_id', 'ein', 'tin', 'ssn', 'dd_account', 'dd_routing', 'routing', 'routing_number',
        'account_number', 'mercury_token', 'access_token', 'refresh_token', 'token',
        'ciphertext', 'tin_ciphertext', 'dd_ciphertext', 'sealed_seed', 'private_key', 'secret',
        'company_snapshot', 'rails_snapshot'
      );
      IF lower(k) = 'public_token' THEN
        CONTINUE;
      ELSIF secret THEN
        IF v IS NULL OR v = 'null'::jsonb OR v = '""'::jsonb THEN
          result := result || jsonb_build_object(k, v);
        ELSE
          result := result || jsonb_build_object(
            k,
            'sha256:' || encode(digest(convert_to(v::text, 'UTF8'), 'sha256'), 'hex')
          );
        END IF;
      ELSE
        result := result || jsonb_build_object(k, public.pay_audit_scrub_json(v));
      END IF;
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    SELECT coalesce(jsonb_agg(public.pay_audit_scrub_json(elem) ORDER BY ord), '[]'::jsonb)
    INTO result
    FROM jsonb_array_elements(p_value) WITH ORDINALITY AS listed(elem, ord);
    RETURN result;
  ELSIF jsonb_typeof(p_value) = 'string' THEN
    RETURN to_jsonb(public.pay_audit_scrub_text(p_value #>> '{}'));
  END IF;
  RETURN p_value;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_audit_write(
  p_treasury uuid,
  p_type text,
  p_id uuid,
  p_op text,
  p_before jsonb,
  p_after jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_before jsonb;
  v_payload jsonb;
  v_seq bigint;
  v_prev text;
  v_at timestamptz;
  v_at_text text;
  v_hash text;
BEGIN
  IF current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN;
  END IF;
  IF p_type NOT IN ('invoice', 'bill', 'journal', 'payroll_run', 'account', 'period_lock') THEN
    RAISE EXCEPTION 'audit_document' USING ERRCODE = '22023';
  END IF;
  IF p_op NOT IN ('I', 'U', 'D') THEN
    RAISE EXCEPTION 'audit_document' USING ERRCODE = '22023';
  END IF;
  v_before := CASE WHEN p_before IS NULL THEN NULL ELSE public.pay_audit_scrub_json(p_before) END;
  v_payload := public.pay_audit_scrub_json(coalesce(p_after, '{}'::jsonb));
  IF p_op = 'U' AND v_before IS NOT DISTINCT FROM v_payload THEN
    RETURN;
  END IF;

  INSERT INTO public.pay_audit_head (treasury_group_id)
  VALUES (p_treasury)
  ON CONFLICT (treasury_group_id) DO NOTHING;

  SELECT last_seq, last_hash
  INTO v_seq, v_prev
  FROM public.pay_audit_head
  WHERE treasury_group_id = p_treasury
  FOR UPDATE;

  v_seq := v_seq + 1;
  v_at := date_trunc('milliseconds', clock_timestamp());
  v_at_text := to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_hash := public.pay_audit_digest(v_prev, v_seq, v_at_text, p_type, p_op, p_id, v_before, v_payload);

  INSERT INTO public.pay_audit_log (
    treasury_group_id, seq, at, at_text, actor, document_type, document_id, op,
    before_payload, payload, prev_hash, hash
  ) VALUES (
    p_treasury, v_seq, v_at, v_at_text, public.pay_actor_wallet(), p_type, p_id, p_op,
    v_before, v_payload, v_prev, v_hash
  );

  UPDATE public.pay_audit_head
  SET last_seq = v_seq, last_hash = v_hash
  WHERE treasury_group_id = p_treasury;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_audit_verify(p_treasury uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_prev text := 'GENESIS';
  v_expect bigint := 1;
  v_count integer := 0;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  FOR r IN
    SELECT *
    FROM public.pay_audit_log
    WHERE treasury_group_id = p_treasury
    ORDER BY seq
  LOOP
    v_count := v_count + 1;
    IF r.seq <> v_expect THEN
      RETURN jsonb_build_object(
        'ok', false, 'rows', v_count, 'broken_at', r.seq, 'reason', 'gap',
        'head_hash', v_prev, 'head_seq', v_expect - 1
      );
    END IF;
    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      RETURN jsonb_build_object(
        'ok', false, 'rows', v_count, 'broken_at', r.seq, 'reason', 'prev_hash',
        'head_hash', v_prev, 'head_seq', v_expect - 1
      );
    END IF;
    IF r.hash IS DISTINCT FROM public.pay_audit_digest(
      r.prev_hash, r.seq, r.at_text, r.document_type, r.op, r.document_id, r.before_payload, r.payload
    ) THEN
      RETURN jsonb_build_object(
        'ok', false, 'rows', v_count, 'broken_at', r.seq, 'reason', 'hash',
        'head_hash', v_prev, 'head_seq', v_expect - 1
      );
    END IF;
    v_prev := r.hash;
    v_expect := v_expect + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'ok', true, 'rows', v_count, 'head_hash', v_prev, 'head_seq', v_expect - 1
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Document triggers. Explicit columns only; snapshots and secrets stay out.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_audit_log_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log_append_only' USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_log_no_update ON public.pay_audit_log;
CREATE TRIGGER pay_audit_log_no_update
BEFORE UPDATE ON public.pay_audit_log
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_log_freeze();

DROP TRIGGER IF EXISTS pay_audit_log_no_delete ON public.pay_audit_log;
CREATE TRIGGER pay_audit_log_no_delete
BEFORE DELETE ON public.pay_audit_log
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_log_freeze();

CREATE OR REPLACE FUNCTION public.pay_enablement_mark_purge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  PERFORM set_config('pay.audit_purge', 'on', true);
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS pay_enablement_audit_purge ON public.pay_enablement;
CREATE TRIGGER pay_enablement_audit_purge
BEFORE DELETE ON public.pay_enablement
FOR EACH ROW
EXECUTE FUNCTION public.pay_enablement_mark_purge();

CREATE OR REPLACE FUNCTION public.pay_audit_invoice_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'number', OLD.number, 'status', OLD.status, 'issue_date', OLD.issue_date,
      'due_date', OLD.due_date, 'po_number', OLD.po_number, 'currency', OLD.currency,
      'tax_label', OLD.tax_label, 'tax_rate_e3', OLD.tax_rate_e3,
      'discount_cents', OLD.discount_cents, 'subtotal_cents', OLD.subtotal_cents,
      'taxable_cents', OLD.taxable_cents, 'tax_cents', OLD.tax_cents, 'total_cents', OLD.total_cents,
      'customer_id', OLD.customer_id, 'reference_code', OLD.reference_code,
      'notes', OLD.notes, 'terms', OLD.terms, 'footer', OLD.footer
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'number', NEW.number, 'status', NEW.status, 'issue_date', NEW.issue_date,
      'due_date', NEW.due_date, 'po_number', NEW.po_number, 'currency', NEW.currency,
      'tax_label', NEW.tax_label, 'tax_rate_e3', NEW.tax_rate_e3,
      'discount_cents', NEW.discount_cents, 'subtotal_cents', NEW.subtotal_cents,
      'taxable_cents', NEW.taxable_cents, 'tax_cents', NEW.tax_cents, 'total_cents', NEW.total_cents,
      'customer_id', NEW.customer_id, 'reference_code', NEW.reference_code,
      'notes', NEW.notes, 'terms', NEW.terms, 'footer', NEW.footer
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'invoice',
    COALESCE(NEW.id, OLD.id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_invoice ON public.pay_invoices;
CREATE TRIGGER pay_audit_invoice
AFTER INSERT OR UPDATE OR DELETE ON public.pay_invoices
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_invoice_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_bill_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'vendor_id', OLD.vendor_id, 'ref', OLD.ref, 'bill_date', OLD.bill_date, 'due_date', OLD.due_date,
      'category', OLD.category, 'description', OLD.description, 'amount_cents', OLD.amount_cents,
      'status', OLD.status, 'notes', OLD.notes, 'account_id', OLD.account_id,
      'proposal_index', OLD.proposal_index, 'proposal_chain', OLD.proposal_chain,
      'proposal_amount_cents', OLD.proposal_amount_cents
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'vendor_id', NEW.vendor_id, 'ref', NEW.ref, 'bill_date', NEW.bill_date, 'due_date', NEW.due_date,
      'category', NEW.category, 'description', NEW.description, 'amount_cents', NEW.amount_cents,
      'status', NEW.status, 'notes', NEW.notes, 'account_id', NEW.account_id,
      'proposal_index', NEW.proposal_index, 'proposal_chain', NEW.proposal_chain,
      'proposal_amount_cents', NEW.proposal_amount_cents
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'bill',
    COALESCE(NEW.id, OLD.id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_bill ON public.pay_bills;
CREATE TRIGGER pay_audit_bill
AFTER INSERT OR UPDATE OR DELETE ON public.pay_bills
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_bill_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_bill_payment_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'payment_id', OLD.id, 'bill_id', OLD.bill_id, 'paid_on', OLD.paid_on,
      'amount_cents', OLD.amount_cents, 'method', OLD.method, 'reference', OLD.reference, 'notes', OLD.notes
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'payment_id', NEW.id, 'bill_id', NEW.bill_id, 'paid_on', NEW.paid_on,
      'amount_cents', NEW.amount_cents, 'method', NEW.method, 'reference', NEW.reference, 'notes', NEW.notes
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'bill',
    COALESCE(NEW.bill_id, OLD.bill_id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_bill_payment ON public.pay_bill_payments;
CREATE TRIGGER pay_audit_bill_payment
AFTER INSERT OR UPDATE OR DELETE ON public.pay_bill_payments
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_bill_payment_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_journal_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'entry_date', OLD.entry_date, 'memo', OLD.memo, 'ref', OLD.ref, 'party', OLD.party,
      'source_type', OLD.source_type, 'source_id', OLD.source_id
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'entry_date', NEW.entry_date, 'memo', NEW.memo, 'ref', NEW.ref, 'party', NEW.party,
      'source_type', NEW.source_type, 'source_id', NEW.source_id
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'journal',
    COALESCE(NEW.id, OLD.id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_journal ON public.pay_journal_entries;
CREATE TRIGGER pay_audit_journal
AFTER INSERT OR UPDATE OR DELETE ON public.pay_journal_entries
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_journal_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_journal_line_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'line_id', OLD.id, 'entry_id', OLD.entry_id, 'line_no', OLD.line_no,
      'account_id', OLD.account_id, 'debit_cents', OLD.debit_cents,
      'credit_cents', OLD.credit_cents, 'memo', OLD.memo
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'line_id', NEW.id, 'entry_id', NEW.entry_id, 'line_no', NEW.line_no,
      'account_id', NEW.account_id, 'debit_cents', NEW.debit_cents,
      'credit_cents', NEW.credit_cents, 'memo', NEW.memo
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'journal',
    COALESCE(NEW.entry_id, OLD.entry_id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_journal_line ON public.pay_journal_lines;
CREATE TRIGGER pay_audit_journal_line
AFTER INSERT OR UPDATE OR DELETE ON public.pay_journal_lines
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_journal_line_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_payroll_run_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'pay_date', OLD.pay_date, 'period_start', OLD.period_start, 'period_end', OLD.period_end,
      'frequency', OLD.frequency, 'kind', OLD.kind, 'status', OLD.status, 'memo', OLD.memo,
      'cash_account_id', OLD.cash_account_id
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'pay_date', NEW.pay_date, 'period_start', NEW.period_start, 'period_end', NEW.period_end,
      'frequency', NEW.frequency, 'kind', NEW.kind, 'status', NEW.status, 'memo', NEW.memo,
      'cash_account_id', NEW.cash_account_id
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'payroll_run',
    COALESCE(NEW.id, OLD.id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_payroll_run ON public.pay_runs;
CREATE TRIGGER pay_audit_payroll_run
AFTER INSERT OR UPDATE OR DELETE ON public.pay_runs
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_payroll_run_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_account_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object(
      'code', OLD.code, 'name', OLD.name, 'account_type', OLD.account_type,
      'subtype', OLD.subtype, 'archived', OLD.archived, 'tax_line', OLD.tax_line,
      'description', OLD.description
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object(
      'code', NEW.code, 'name', NEW.name, 'account_type', NEW.account_type,
      'subtype', NEW.subtype, 'archived', NEW.archived, 'tax_line', NEW.tax_line,
      'description', NEW.description
    );
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'account',
    COALESCE(NEW.id, OLD.id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_account ON public.pay_accounts;
CREATE TRIGGER pay_audit_account
AFTER INSERT OR UPDATE OR DELETE ON public.pay_accounts
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_account_trigger();

CREATE OR REPLACE FUNCTION public.pay_audit_lock_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  op text := CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END;
  row_before jsonb;
  row_after jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_before := jsonb_build_object('locked_through', OLD.locked_through, 'note', OLD.note);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_after := jsonb_build_object('locked_through', NEW.locked_through, 'note', NEW.note);
  END IF;
  PERFORM public.pay_audit_write(
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), 'period_lock',
    COALESCE(NEW.treasury_group_id, OLD.treasury_group_id), op, row_before, row_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS pay_audit_lock ON public.pay_books_lock;
CREATE TRIGGER pay_audit_lock
AFTER INSERT OR UPDATE OR DELETE ON public.pay_books_lock
FOR EACH ROW
EXECUTE FUNCTION public.pay_audit_lock_trigger();

-- ---------------------------------------------------------------------------
-- Period lock enforcement
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_journal_content_hash(p_entry uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT encode(digest(convert_to((
    SELECT jsonb_build_object(
      'entry_date', e.entry_date,
      'memo', e.memo,
      'ref', e.ref,
      'party', e.party,
      'source_type', e.source_type,
      'source_id', e.source_id,
      'lines', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'line_no', l.line_no,
          'account_id', l.account_id,
          'debit_cents', l.debit_cents,
          'credit_cents', l.credit_cents,
          'memo', l.memo
        ) ORDER BY l.line_no)
        FROM public.pay_journal_lines l
        WHERE l.entry_id = e.id
      ), '[]'::jsonb)
    )::text
    FROM public.pay_journal_entries e
    WHERE e.id = p_entry
  ), 'UTF8'), 'sha256'), 'hex');
$fn$;

CREATE OR REPLACE FUNCTION public.pay_period_lock_ok(p_treasury uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_lock date;
  v_bad boolean;
BEGIN
  IF current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN;
  END IF;
  SELECT locked_through INTO v_lock
  FROM public.pay_books_lock
  WHERE treasury_group_id = p_treasury;
  IF v_lock IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.pay_journal_entries e
    LEFT JOIN public.pay_journal_seals s
      ON s.treasury_group_id = e.treasury_group_id
     AND s.source_type = e.source_type
     AND s.source_id IS NOT DISTINCT FROM e.source_id
    WHERE e.treasury_group_id = p_treasury
      AND e.entry_date <= v_lock
      AND (
        s.payload_hash IS NULL
        OR s.entry_date IS DISTINCT FROM e.entry_date
        OR s.payload_hash IS DISTINCT FROM public.pay_journal_content_hash(e.id)
      )
  ) INTO v_bad;
  IF v_bad THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.pay_journal_seals s
    WHERE s.treasury_group_id = p_treasury
      AND NOT EXISTS (
        SELECT 1
        FROM public.pay_journal_entries e
        WHERE e.treasury_group_id = s.treasury_group_id
          AND e.source_type = s.source_type
          AND e.source_id IS NOT DISTINCT FROM s.source_id
          AND e.entry_date <= v_lock
          AND e.entry_date IS NOT DISTINCT FROM s.entry_date
          AND public.pay_journal_content_hash(e.id) = s.payload_hash
      )
  ) INTO v_bad;
  IF v_bad THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_journal_period_lock_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_lock date;
BEGIN
  IF current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT locked_through INTO v_lock
  FROM public.pay_books_lock
  WHERE treasury_group_id = NEW.treasury_group_id;
  IF v_lock IS NOT NULL AND NEW.entry_date <= v_lock AND NOT EXISTS (
    SELECT 1
    FROM public.pay_journal_seals s
    WHERE s.treasury_group_id = NEW.treasury_group_id
      AND s.source_type = NEW.source_type
      AND s.source_id IS NOT DISTINCT FROM NEW.source_id
      AND s.entry_date = NEW.entry_date
  ) THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_journal_period_lock_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_lock date;
BEGIN
  IF current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT locked_through INTO v_lock
  FROM public.pay_books_lock
  WHERE treasury_group_id = NEW.treasury_group_id;
  IF v_lock IS NOT NULL AND (OLD.entry_date <= v_lock OR NEW.entry_date <= v_lock) THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_journal_period_lock_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  gid uuid;
BEGIN
  IF current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
  gid := COALESCE(NEW.treasury_group_id, OLD.treasury_group_id);
  PERFORM public.pay_period_lock_ok(gid);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_journal_line_period_lock_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_lock date;
  v_date date;
  v_gid uuid;
BEGIN
  IF current_setting('pay.audit_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT e.treasury_group_id, e.entry_date INTO v_gid, v_date
  FROM public.pay_journal_entries e
  WHERE e.id = NEW.entry_id;
  SELECT locked_through INTO v_lock FROM public.pay_books_lock WHERE treasury_group_id = v_gid;
  IF v_lock IS NOT NULL AND v_date <= v_lock THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS pay_journal_entries_period_lock_ins ON public.pay_journal_entries;
CREATE TRIGGER pay_journal_entries_period_lock_ins
BEFORE INSERT ON public.pay_journal_entries
FOR EACH ROW
EXECUTE FUNCTION public.pay_journal_period_lock_insert();

DROP TRIGGER IF EXISTS pay_journal_entries_period_lock_upd ON public.pay_journal_entries;
CREATE TRIGGER pay_journal_entries_period_lock_upd
BEFORE UPDATE ON public.pay_journal_entries
FOR EACH ROW
EXECUTE FUNCTION public.pay_journal_period_lock_update();

DROP TRIGGER IF EXISTS pay_journal_lines_period_lock_upd ON public.pay_journal_lines;
CREATE TRIGGER pay_journal_lines_period_lock_upd
BEFORE UPDATE ON public.pay_journal_lines
FOR EACH ROW
EXECUTE FUNCTION public.pay_journal_line_period_lock_update();

DROP TRIGGER IF EXISTS pay_journal_entries_period_lock_def ON public.pay_journal_entries;
CREATE CONSTRAINT TRIGGER pay_journal_entries_period_lock_def
AFTER INSERT OR UPDATE OR DELETE ON public.pay_journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.pay_journal_period_lock_row();

DROP TRIGGER IF EXISTS pay_journal_lines_period_lock_def ON public.pay_journal_lines;
CREATE CONSTRAINT TRIGGER pay_journal_lines_period_lock_def
AFTER INSERT OR UPDATE OR DELETE ON public.pay_journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.pay_journal_period_lock_row();

-- ---------------------------------------------------------------------------
-- Chart edits: name and active flag. Codes used by journals stay put.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_accounts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF NEW.treasury_group_id IS DISTINCT FROM OLD.treasury_group_id THEN
    RAISE EXCEPTION 'account_tenant_locked' USING ERRCODE = '23514';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code AND (
    OLD.system_key IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.pay_journal_lines WHERE account_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'account_code_in_use' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_type IS DISTINCT FROM OLD.account_type AND EXISTS (
    SELECT 1 FROM public.pay_journal_lines WHERE account_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'account_type_in_use' USING ERRCODE = '23514';
  END IF;
  IF NEW.archived IS TRUE AND OLD.archived IS FALSE AND OLD.system_key IS NOT NULL THEN
    RAISE EXCEPTION 'system_account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS pay_accounts_guard ON public.pay_accounts;
CREATE TRIGGER pay_accounts_guard
BEFORE UPDATE ON public.pay_accounts
FOR EACH ROW
EXECUTE FUNCTION public.pay_accounts_guard();

CREATE OR REPLACE FUNCTION public.pay_update_account(p_account uuid, p_name text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.pay_accounts%ROWTYPE;
  v_name text;
BEGIN
  SELECT * INTO v_row FROM public.pay_accounts WHERE id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_account' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(v_row.treasury_group_id);
  v_name := public.pay_clip(p_name, 120);
  IF v_name = '' THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF p_active IS NOT TRUE AND v_row.system_key IS NOT NULL THEN
    RAISE EXCEPTION 'system_account' USING ERRCODE = '23514';
  END IF;
  UPDATE public.pay_accounts
  SET name = v_name, archived = NOT p_active
  WHERE id = p_account;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Manual journal and the lock date
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pay_post_manual_journal(p_treasury uuid, p_body jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_date date;
  v_memo text;
  v_ref text;
  v_lock date;
  v_line jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_debit bigint;
  v_credit bigint;
  v_account uuid;
  v_dr bigint := 0;
  v_cr bigint := 0;
  v_n integer := 0;
  v_old_date date;
  v_item jsonb;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  v_date := public.pay_date_in(p_body->>'date');
  v_memo := public.pay_clip(p_body->>'memo', 500);
  IF v_memo = '' THEN
    RAISE EXCEPTION 'memo_required' USING ERRCODE = '22023';
  END IF;
  v_ref := public.pay_clip(p_body->>'ref', 60);
  SELECT locked_through INTO v_lock
  FROM public.pay_books_lock
  WHERE treasury_group_id = p_treasury;
  IF v_lock IS NOT NULL AND v_date <= v_lock THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_body->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'journal_lines' USING ERRCODE = '22023';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_body->'lines') LOOP
    v_debit := public.pay_money_cents(coalesce(v_line->>'debit', '0'), false);
    v_credit := public.pay_money_cents(coalesce(v_line->>'credit', '0'), false);
    IF v_debit = 0 AND v_credit = 0 THEN
      CONTINUE;
    END IF;
    IF v_debit > 0 AND v_credit > 0 THEN
      RAISE EXCEPTION 'line_both_sides' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_account := NULLIF(v_line->>'account_id', '')::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
    END;
    IF v_account IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.pay_accounts a
      WHERE a.id = v_account
        AND a.treasury_group_id = p_treasury
        AND a.archived = false
    ) THEN
      RAISE EXCEPTION 'invalid_account' USING ERRCODE = '22023';
    END IF;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'account_id', v_account,
      'debit', v_debit,
      'credit', v_credit,
      'memo', public.pay_clip(v_line->>'memo', 300)
    ));
    v_dr := v_dr + v_debit;
    v_cr := v_cr + v_credit;
  END LOOP;

  IF jsonb_array_length(v_clean) < 2 THEN
    RAISE EXCEPTION 'journal_lines' USING ERRCODE = '22023';
  END IF;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'journal_unbalanced' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_id := NULLIF(p_body->>'id', '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'manual_only' USING ERRCODE = '22023';
  END;

  IF v_id IS NOT NULL THEN
    SELECT entry_date INTO v_old_date
    FROM public.pay_journal_entries
    WHERE id = v_id
      AND treasury_group_id = p_treasury
      AND source_type = 'manual';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'manual_only' USING ERRCODE = 'P0002';
    END IF;
    IF v_lock IS NOT NULL AND v_old_date <= v_lock THEN
      RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.pay_journal_lines WHERE entry_id = v_id;
    UPDATE public.pay_journal_entries
    SET entry_date = v_date, memo = v_memo, ref = v_ref, updated_at = now()
    WHERE id = v_id;
  ELSE
    v_id := gen_random_uuid();
    INSERT INTO public.pay_journal_entries (
      id, treasury_group_id, entry_date, memo, ref, party, source_type, source_id
    ) VALUES (
      v_id, p_treasury, v_date, v_memo, v_ref, '', 'manual', v_id
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_clean) LOOP
    INSERT INTO public.pay_journal_lines (
      treasury_group_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo
    ) VALUES (
      p_treasury,
      v_id,
      v_n,
      (v_item->>'account_id')::uuid,
      (v_item->>'debit')::bigint,
      (v_item->>'credit')::bigint,
      v_item->>'memo'
    );
    v_n := v_n + 1;
  END LOOP;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_delete_manual_journal(p_entry uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_treasury uuid;
  v_date date;
  v_lock date;
BEGIN
  SELECT treasury_group_id, entry_date
  INTO v_treasury, v_date
  FROM public.pay_journal_entries
  WHERE id = p_entry
    AND source_type = 'manual';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_only' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.pay_require_operator(v_treasury);
  SELECT locked_through INTO v_lock
  FROM public.pay_books_lock
  WHERE treasury_group_id = v_treasury;
  IF v_lock IS NOT NULL AND v_date <= v_lock THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.pay_journal_entries WHERE id = p_entry;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pay_set_books_lock(
  p_treasury uuid,
  p_through text,
  p_note text,
  p_confirm_reopen boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_through date;
  v_cur date;
  v_note text;
  v_dr bigint;
  v_cr bigint;
BEGIN
  PERFORM public.pay_require_operator(p_treasury);
  IF btrim(coalesce(p_through, '')) = '' THEN
    v_through := NULL;
  ELSE
    v_through := public.pay_date_in(p_through);
  END IF;
  IF v_through IS NOT NULL AND v_through > CURRENT_DATE THEN
    RAISE EXCEPTION 'future_lock' USING ERRCODE = '22023';
  END IF;
  SELECT locked_through INTO v_cur
  FROM public.pay_books_lock
  WHERE treasury_group_id = p_treasury;
  IF v_cur IS NOT NULL AND (v_through IS NULL OR v_through < v_cur) AND p_confirm_reopen IS NOT TRUE THEN
    RAISE EXCEPTION 'reopen_confirm' USING ERRCODE = 'P0001';
  END IF;
  IF v_through IS NOT NULL THEN
    SELECT coalesce(sum(l.debit_cents), 0), coalesce(sum(l.credit_cents), 0)
    INTO v_dr, v_cr
    FROM public.pay_journal_lines l
    JOIN public.pay_journal_entries e ON e.id = l.entry_id
    WHERE e.treasury_group_id = p_treasury
      AND e.entry_date <= v_through;
    IF v_dr <> v_cr THEN
      RAISE EXCEPTION 'trial_balance_unbalanced' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_note := left(public.pay_audit_scrub_text(public.pay_clip(p_note, 500)), 500);
  INSERT INTO public.pay_books_lock (treasury_group_id, locked_through, locked_at, note, updated_at)
  VALUES (p_treasury, v_through, now(), v_note, now())
  ON CONFLICT (treasury_group_id) DO UPDATE
  SET locked_through = EXCLUDED.locked_through,
      locked_at = EXCLUDED.locked_at,
      note = EXCLUDED.note,
      updated_at = EXCLUDED.updated_at;

  DELETE FROM public.pay_journal_seals WHERE treasury_group_id = p_treasury;
  IF v_through IS NOT NULL THEN
    INSERT INTO public.pay_journal_seals (treasury_group_id, source_type, source_id, entry_date, payload_hash)
    SELECT e.treasury_group_id, e.source_type, e.source_id, e.entry_date, public.pay_journal_content_hash(e.id)
    FROM public.pay_journal_entries e
    WHERE e.treasury_group_id = p_treasury
      AND e.entry_date <= v_through
      AND e.source_id IS NOT NULL;
  END IF;

  RETURN jsonb_build_object('locked_through', v_through);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- RLS. Operators read. Token holders do not. Writes stay on the functions.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pay_books_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_journal_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_audit_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pay operators read books lock" ON public.pay_books_lock;
CREATE POLICY "Pay operators read books lock"
  ON public.pay_books_lock FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read journal seals" ON public.pay_journal_seals;
CREATE POLICY "Pay operators read journal seals"
  ON public.pay_journal_seals FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read audit head" ON public.pay_audit_head;
CREATE POLICY "Pay operators read audit head"
  ON public.pay_audit_head FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

DROP POLICY IF EXISTS "Pay operators read audit log" ON public.pay_audit_log;
CREATE POLICY "Pay operators read audit log"
  ON public.pay_audit_log FOR SELECT TO anon, authenticated
  USING (public.pay_caller_is_operator(treasury_group_id));

REVOKE ALL ON TABLE public.pay_books_lock FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_journal_seals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_audit_head FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pay_audit_log FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.pay_books_lock TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_journal_seals TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_audit_head TO anon, authenticated;
GRANT SELECT ON TABLE public.pay_audit_log TO anon, authenticated;

GRANT ALL ON TABLE public.pay_books_lock TO service_role;
GRANT ALL ON TABLE public.pay_journal_seals TO service_role;
GRANT ALL ON TABLE public.pay_audit_head TO service_role;
GRANT ALL ON TABLE public.pay_audit_log TO service_role;

REVOKE ALL ON FUNCTION public.pay_audit_digest(text, bigint, text, text, text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_scrub_text(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_scrub_json(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_write(uuid, text, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_log_freeze() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_enablement_mark_purge() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_invoice_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_bill_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_bill_payment_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_journal_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_journal_line_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_payroll_run_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_account_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_audit_lock_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_journal_content_hash(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_period_lock_ok(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_journal_period_lock_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_journal_period_lock_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_journal_period_lock_row() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_journal_line_period_lock_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_accounts_guard() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.pay_update_account(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_post_manual_journal(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_delete_manual_journal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_set_books_lock(uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_audit_verify(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pay_update_account(uuid, text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_post_manual_journal(uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_delete_manual_journal(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_set_books_lock(uuid, text, text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_audit_verify(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_audit_digest(text, bigint, text, text, text, uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_journal_content_hash(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_period_lock_ok(uuid) TO service_role;
