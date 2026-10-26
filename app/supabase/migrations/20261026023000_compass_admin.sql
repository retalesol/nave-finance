-- Compass operator console.
--
-- The browser at /compass never receives a database password or the service
-- role key. The compass edge function checks the operator password, then calls
-- these functions with the service role. anon and authenticated cannot execute
-- them and cannot read the session, attempt, or audit tables.
--
-- Reads are aggregate or operational. They do not return payroll rows, bank
-- secrets, customer or vendor contacts, invoice documents, journal lines,
-- signing keys, or raw chain payloads. Reading a subscription does not delete books.

CREATE TABLE IF NOT EXISTS public.compass_sessions (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compass_sessions_expires_idx
  ON public.compass_sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.compass_login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compass_login_attempts_bucket_idx
  ON public.compass_login_attempts (bucket, created_at DESC);

CREATE TABLE IF NOT EXISTS public.compass_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  treasury_group_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compass_audit_detail_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS compass_audit_created_idx
  ON public.compass_audit (created_at DESC);

ALTER TABLE public.compass_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compass_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compass_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.compass_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compass_login_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compass_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.compass_sessions TO service_role;
GRANT ALL ON TABLE public.compass_login_attempts TO service_role;
GRANT ALL ON TABLE public.compass_audit TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relkind = 'S' AND relname = 'compass_login_attempts_id_seq'
  ) THEN
    EXECUTE 'REVOKE ALL ON SEQUENCE public.compass_login_attempts_id_seq FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON SEQUENCE public.compass_login_attempts_id_seq TO service_role';
  END IF;
END $$;

-- Operator grants are not customer payments. The public activation function
-- still accepts only wallet and treasury sources.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.pay_subscriptions'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE public.pay_subscriptions DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.pay_subscriptions
  DROP CONSTRAINT IF EXISTS pay_subscriptions_source_check;
ALTER TABLE public.pay_subscriptions
  ADD CONSTRAINT pay_subscriptions_source_check
  CHECK (source IN ('', 'wallet', 'treasury', 'compass'));

CREATE OR REPLACE FUNCTION public.compass_require_service()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF jwt_role = '' THEN
    BEGIN
      jwt_role := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
    EXCEPTION
      WHEN others THEN
        jwt_role := '';
    END;
  END IF;
  IF jwt_role = '' THEN
    BEGIN
      jwt_role := coalesce(auth.role(), '');
    EXCEPTION
      WHEN undefined_function THEN
        jwt_role := '';
    END;
  END IF;
  IF jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.compass_clip(p_text text, p_len integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT left(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', '', 'g'), greatest(coalesce(p_len, 0), 0));
$$;

-- Devnet SOL is still SOL. When a snapshot stored no dollar total, mark the
-- native balance at the cached mainnet SOL/USD price and keep USDC at $1.
CREATE OR REPLACE FUNCTION public.compass_marked_usd(
  p_chain text,
  p_total numeric,
  p_sol numeric,
  p_usdc numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN coalesce(p_chain, 'solana') = 'solana' THEN greatest(
      coalesce(p_total, 0),
      coalesce(p_sol, 0) * coalesce((SELECT price_usd FROM public.price_cache WHERE symbol = 'solana'), 0)
        + coalesce(p_usdc, 0)
    )
    ELSE coalesce(p_total, 0)
  END;
$$;

CREATE OR REPLACE FUNCTION public.compass_subscription_state(
  p_end timestamptz,
  p_purged timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_purged IS NOT NULL THEN 'purged'
    WHEN p_end IS NULL THEN 'none'
    WHEN now() < p_end THEN 'active'
    WHEN now() < p_end + interval '7 days' THEN 'grace'
    WHEN now() < p_end + interval '30 days' THEN 'locked'
    ELSE 'purged'
  END;
$$;

CREATE OR REPLACE FUNCTION public.compass_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM public.compass_require_service();

  WITH groups AS (
    SELECT treasury_group_id, min(created_at) AS created_at, bool_or(privacy_enabled) AS private
    FROM public.dao_registry
    GROUP BY treasury_group_id
  ),
  subs AS (
    SELECT
      source,
      price_cents,
      period_end,
      public.compass_subscription_state(period_end, purged_at) AS state
    FROM public.pay_subscriptions
  ),
  states AS (
    SELECT state, count(*) AS n
    FROM subs
    GROUP BY state
  ),
  chains AS (
    SELECT chain, chain_id, network, count(*) AS deployments
    FROM public.dao_registry
    GROUP BY chain, chain_id, network
  ),
  invoices AS (
    SELECT status, count(*) AS n, coalesce(sum(total_cents), 0) AS cents
    FROM public.pay_invoices
    GROUP BY status
  ),
  proposals AS (
    SELECT status, count(*) AS n
    FROM public.agent_proposals
    GROUP BY status
  ),
  bridges AS (
    SELECT status, count(*) AS n
    FROM public.bridge_transfers
    GROUP BY status
  ),
  aum AS (
    SELECT coalesce(sum(public.compass_marked_usd(chain, total_value_usd, sol_balance, usdc_balance)), 0) AS value
    FROM (
      SELECT DISTINCT ON (dao_onchain_address, chain_id)
        chain, total_value_usd, sol_balance, usdc_balance
      FROM public.treasury_snapshots
      ORDER BY dao_onchain_address, chain_id, snapshot_at DESC
    ) latest
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'treasuries', jsonb_build_object(
      'deployments', (SELECT count(*) FROM public.dao_registry),
      'groups', (SELECT count(*) FROM groups),
      'private_groups', (SELECT count(*) FROM groups WHERE private),
      'created_7d', (SELECT count(*) FROM groups WHERE created_at >= now() - interval '7 days'),
      'created_30d', (SELECT count(*) FROM groups WHERE created_at >= now() - interval '30 days')
    ),
    'chains', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'chain', chain,
        'chain_id', chain_id,
        'network', network,
        'deployments', deployments
      ) ORDER BY deployments DESC, chain, chain_id)
      FROM chains
    ), '[]'::jsonb),
    'pay', jsonb_build_object(
      'enabled', (SELECT count(*) FROM public.pay_enablement),
      'subscriptions', jsonb_build_object(
        'active', coalesce((SELECT n FROM states WHERE state = 'active'), 0),
        'grace', coalesce((SELECT n FROM states WHERE state = 'grace'), 0),
        'locked', coalesce((SELECT n FROM states WHERE state = 'locked'), 0),
        'purged', coalesce((SELECT n FROM states WHERE state = 'purged'), 0),
        'none', greatest(
          (SELECT count(*) FROM groups) - coalesce((SELECT sum(n) FROM states WHERE state <> 'none'), 0),
          0
        )
      ),
      'collected_cents', coalesce((SELECT sum(price_cents) FROM subs WHERE source IN ('wallet', 'treasury') AND state IN ('active', 'grace')), 0),
      'granted_cents', coalesce((SELECT sum(price_cents) FROM subs WHERE source = 'compass' AND state IN ('active', 'grace')), 0)
    ),
    'upcoming', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'treasury_group_id', s.treasury_group_id,
        'name', g.name,
        'state', public.compass_subscription_state(s.period_end, s.purged_at),
        'period_end', s.period_end,
        'source', s.source,
        'term_months', s.term_months
      ) ORDER BY s.period_end)
      FROM (
        SELECT *
        FROM public.pay_subscriptions
        WHERE purged_at IS NULL AND period_end IS NOT NULL
        ORDER BY period_end
        LIMIT 8
      ) s
      JOIN (
        SELECT treasury_group_id, (array_agg(name ORDER BY created_at))[1] AS name
        FROM public.dao_registry
        GROUP BY treasury_group_id
      ) g ON g.treasury_group_id = s.treasury_group_id
    ), '[]'::jsonb),
    'books', jsonb_build_object(
      'invoices_by_status', coalesce((SELECT jsonb_object_agg(status, n) FROM invoices), '{}'::jsonb),
      'invoice_total_cents', coalesce((SELECT sum(cents) FROM invoices), 0),
      'customers', (SELECT count(*) FROM public.pay_customers),
      'vendors', (SELECT count(*) FROM public.pay_vendors),
      'bills', (SELECT count(*) FROM public.pay_bills),
      'employees', (SELECT count(*) FROM public.pay_employees),
      'active_employees', (SELECT count(*) FROM public.pay_employees WHERE status = 'active')
    ),
    'activity_24h', (SELECT count(*) FROM public.activity_logs WHERE created_at >= now() - interval '24 hours'),
    'activity_7d', (SELECT count(*) FROM public.activity_logs WHERE created_at >= now() - interval '7 days'),
    'proposals', coalesce((SELECT jsonb_object_agg(status, n) FROM proposals), '{}'::jsonb),
    'bridges', coalesce((SELECT jsonb_object_agg(status, n) FROM bridges), '{}'::jsonb),
    'snapshotted_value_usd', (SELECT value::text FROM aum),
    'watchers', (SELECT count(*) FROM public.watched_daos),
    'withheld', jsonb_build_array(
      'Payroll identities, wages, and tax forms',
      'Bank connections, tokens, and account numbers',
      'Customer and vendor contact details',
      'Invoice documents, payment links, and journal lines',
      'Signing keys, key envelopes, and raw chain payloads'
    )
  ) INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.compass_treasuries(p_query text DEFAULT '', p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text := left(btrim(coalesce(p_query, '')), 80);
  pattern text;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  result jsonb;
BEGIN
  PERFORM public.compass_require_service();
  pattern := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  WITH matched AS (
    SELECT DISTINCT treasury_group_id
    FROM public.dao_registry
    WHERE q = ''
       OR name ILIKE pattern ESCAPE '\'
       OR coalesce(slug, '') ILIKE pattern ESCAPE '\'
       OR dao_onchain_address ILIKE pattern ESCAPE '\'
       OR creator_wallet ILIKE pattern ESCAPE '\'
  ),
  grouped AS (
    SELECT
      d.treasury_group_id,
      (array_agg(d.name ORDER BY d.created_at))[1] AS name,
      (array_agg(d.slug ORDER BY d.created_at) FILTER (WHERE d.slug IS NOT NULL AND btrim(d.slug) <> ''))[1] AS slug,
      bool_or(d.privacy_enabled) AS privacy_enabled,
      min(d.created_at) AS created_at
    FROM public.dao_registry d
    JOIN matched m ON m.treasury_group_id = d.treasury_group_id
    GROUP BY d.treasury_group_id
  ),
  page AS (
    SELECT * FROM grouped
    ORDER BY created_at DESC
    LIMIT lim
  )
  SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.created_at DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      p.treasury_group_id,
      p.name,
      p.slug,
      p.privacy_enabled,
      p.created_at,
      (
        SELECT jsonb_agg(jsonb_build_object(
          'chain', d.chain,
          'chain_id', d.chain_id,
          'network', d.network,
          'dao_onchain_address', d.dao_onchain_address,
          'governance_type', d.governance_type,
          'name', d.name
        ) ORDER BY d.chain, d.chain_id)
        FROM public.dao_registry d
        WHERE d.treasury_group_id = p.treasury_group_id
      ) AS deployments,
      (e.treasury_group_id IS NOT NULL) AS pay_enabled,
      CASE
        WHEN s.treasury_group_id IS NULL THEN 'none'
        ELSE public.compass_subscription_state(s.period_end, s.purged_at)
      END AS subscription_state,
      s.period_end,
      s.term_months,
      s.source AS subscription_source,
      snap.latest_value_usd,
      snap.snapshot_at
    FROM page p
    LEFT JOIN public.pay_enablement e ON e.treasury_group_id = p.treasury_group_id
    LEFT JOIN public.pay_subscriptions s ON s.treasury_group_id = p.treasury_group_id
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN count(*) = 0 THEN NULL ELSE coalesce(sum(public.compass_marked_usd(v.chain, v.total_value_usd, v.sol_balance, v.usdc_balance)), 0)::text END AS latest_value_usd,
        max(v.snapshot_at) AS snapshot_at
      FROM (
        SELECT DISTINCT ON (t.dao_onchain_address, t.chain_id)
          t.chain,
          t.total_value_usd,
          t.sol_balance,
          t.usdc_balance,
          t.snapshot_at
        FROM public.treasury_snapshots t
        JOIN public.dao_registry d
          ON d.dao_onchain_address = t.dao_onchain_address
         AND d.chain_id IS NOT DISTINCT FROM t.chain_id
         AND d.treasury_group_id = p.treasury_group_id
        ORDER BY t.dao_onchain_address, t.chain_id, t.snapshot_at DESC
      ) v
    ) snap ON true
  ) row;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.compass_treasury(p_group uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_private boolean;
  result jsonb;
BEGIN
  PERFORM public.compass_require_service();
  IF p_group IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.dao_registry WHERE treasury_group_id = p_group
  ) THEN
    RETURN NULL;
  END IF;

  SELECT bool_or(privacy_enabled) INTO is_private
  FROM public.dao_registry
  WHERE treasury_group_id = p_group;

  SELECT jsonb_build_object(
    'treasury_group_id', p_group,
    'name', (array_agg(d.name ORDER BY d.created_at))[1],
    'slug', (array_agg(d.slug ORDER BY d.created_at) FILTER (WHERE d.slug IS NOT NULL AND btrim(d.slug) <> ''))[1],
    'privacy_enabled', is_private,
    'created_at', min(d.created_at),
    'description', CASE
      WHEN is_private THEN ''
      ELSE public.compass_clip((array_agg(d.description ORDER BY d.created_at))[1], 240)
    END,
    'website', CASE
      WHEN is_private THEN ''
      ELSE coalesce((array_agg(d.social_website ORDER BY d.created_at) FILTER (WHERE btrim(coalesce(d.social_website, '')) <> ''))[1], '')
    END,
    'deployments', jsonb_agg(jsonb_build_object(
      'chain', d.chain,
      'chain_id', d.chain_id,
      'network', d.network,
      'dao_onchain_address', d.dao_onchain_address,
      'governance_type', d.governance_type,
      'creator_wallet', d.creator_wallet,
      'voting_token_mint', nullif(d.voting_token_mint, ''),
      'name', d.name,
      'created_at', d.created_at
    ) ORDER BY d.chain, d.chain_id),
    'pay', jsonb_build_object(
      'enabled', exists(SELECT 1 FROM public.pay_enablement e WHERE e.treasury_group_id = p_group),
      'enabled_at', (SELECT e.enabled_at FROM public.pay_enablement e WHERE e.treasury_group_id = p_group),
      'subscription', (
        SELECT jsonb_build_object(
          'state', public.compass_subscription_state(s.period_end, s.purged_at),
          'period_end', s.period_end,
          'term_months', s.term_months,
          'price_cents', s.price_cents,
          'source', s.source,
          'updated_at', s.updated_at
        )
        FROM public.pay_subscriptions s
        WHERE s.treasury_group_id = p_group
      )
    ),
    'counts', jsonb_build_object(
      'invoices', (SELECT count(*) FROM public.pay_invoices WHERE treasury_group_id = p_group),
      'invoices_by_status', coalesce((
        SELECT jsonb_object_agg(status, n)
        FROM (
          SELECT status, count(*) AS n
          FROM public.pay_invoices
          WHERE treasury_group_id = p_group
          GROUP BY status
        ) invoice_counts
      ), '{}'::jsonb),
      'invoice_total_cents', coalesce((SELECT sum(total_cents) FROM public.pay_invoices WHERE treasury_group_id = p_group), 0),
      'customers', (SELECT count(*) FROM public.pay_customers WHERE treasury_group_id = p_group),
      'vendors', (SELECT count(*) FROM public.pay_vendors WHERE treasury_group_id = p_group),
      'bills', (SELECT count(*) FROM public.pay_bills WHERE treasury_group_id = p_group),
      'employees', (SELECT count(*) FROM public.pay_employees WHERE treasury_group_id = p_group),
      'active_employees', (SELECT count(*) FROM public.pay_employees WHERE treasury_group_id = p_group AND status = 'active'),
      'journal_entries', (SELECT count(*) FROM public.pay_journal_entries WHERE treasury_group_id = p_group),
      'watchers', (
        SELECT count(*)
        FROM public.watched_daos w
        JOIN public.dao_registry reg ON reg.dao_onchain_address = w.dao_onchain_address
        WHERE reg.treasury_group_id = p_group
      ),
      'authorized_wallets', (
        SELECT count(*)
        FROM public.dao_authorized_wallets w
        JOIN public.dao_registry reg ON reg.dao_onchain_address = w.dao_onchain_address
        WHERE reg.treasury_group_id = p_group
      )
    ),
    'snapshots', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'chain', v.chain,
        'chain_id', v.chain_id,
        'dao_onchain_address', v.dao_onchain_address,
        'total_value_usd', public.compass_marked_usd(v.chain, v.total_value_usd, v.sol_balance, v.usdc_balance)::text,
        'sol_balance', v.sol_balance::text,
        'usdc_balance', v.usdc_balance::text,
        'snapshot_at', v.snapshot_at,
        'reconciliation_status', v.reconciliation_status
      ) ORDER BY v.snapshot_at DESC)
      FROM (
        SELECT DISTINCT ON (t.dao_onchain_address, t.chain_id)
          t.chain,
          t.chain_id,
          t.dao_onchain_address,
          t.total_value_usd,
          t.sol_balance,
          t.usdc_balance,
          t.snapshot_at,
          t.reconciliation_status
        FROM public.treasury_snapshots t
        JOIN public.dao_registry reg
          ON reg.dao_onchain_address = t.dao_onchain_address
         AND reg.chain_id IS NOT DISTINCT FROM t.chain_id
        WHERE reg.treasury_group_id = p_group
        ORDER BY t.dao_onchain_address, t.chain_id, t.snapshot_at DESC
      ) v
    ), '[]'::jsonb),
    'recent_events', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'at', e.created_at,
        'event_type', e.event_type,
        'detail', public.compass_clip(e.description, 180),
        'chain', e.chain,
        'chain_id', e.chain_id
      ) ORDER BY e.created_at DESC)
      FROM (
        SELECT a.created_at, a.event_type, a.description, a.chain, a.chain_id
        FROM public.activity_logs a
        JOIN public.dao_registry reg ON reg.dao_onchain_address = a.dao_onchain_address
        WHERE reg.treasury_group_id = p_group
        ORDER BY a.created_at DESC
        LIMIT 12
      ) e
    ), '[]'::jsonb)
  ) INTO result
  FROM public.dao_registry d
  WHERE d.treasury_group_id = p_group;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.compass_happenings(p_limit integer DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lim integer := least(greatest(coalesce(p_limit, 40), 1), 80);
  result jsonb;
BEGIN
  PERFORM public.compass_require_service();

  WITH events AS (
    SELECT
      a.created_at AS at,
      'chain'::text AS kind,
      a.event_type AS title,
      public.compass_clip(a.description, 180) AS detail,
      reg.treasury_group_id,
      reg.name AS treasury_name,
      coalesce(reg.privacy_enabled, false) AS private
    FROM (
      SELECT created_at, event_type, description, dao_onchain_address, chain, chain_id
      FROM public.activity_logs
      ORDER BY created_at DESC
      LIMIT lim
    ) a
    LEFT JOIN LATERAL (
      SELECT treasury_group_id, name, privacy_enabled
      FROM public.dao_registry d
      WHERE d.dao_onchain_address = a.dao_onchain_address
      ORDER BY d.created_at
      LIMIT 1
    ) reg ON true

    UNION ALL

    SELECT
      d.created_at,
      'treasury',
      'Treasury registered',
      concat_ws(' · ', d.chain, nullif(d.network, '')),
      d.treasury_group_id,
      d.name,
      d.privacy_enabled
    FROM (
      SELECT created_at, chain, network, treasury_group_id, name, privacy_enabled
      FROM public.dao_registry
      ORDER BY created_at DESC
      LIMIT lim
    ) d

    UNION ALL

    SELECT
      p.created_at,
      'pay',
      p.kind,
      '',
      p.treasury_group_id,
      g.name,
      false
    FROM (
      SELECT treasury_group_id, kind, created_at
      FROM public.pay_activity
      ORDER BY created_at DESC
      LIMIT lim
    ) p
    LEFT JOIN LATERAL (
      SELECT (array_agg(name ORDER BY created_at))[1] AS name
      FROM public.dao_registry
      WHERE treasury_group_id = p.treasury_group_id
    ) g ON true

    UNION ALL

    SELECT
      s.updated_at,
      'subscription',
      'Nave Pay subscription',
      concat_ws(' · ', public.compass_subscription_state(s.period_end, s.purged_at), s.source, s.term_months::text || ' mo'),
      s.treasury_group_id,
      g.name,
      false
    FROM (
      SELECT updated_at, period_end, purged_at, source, term_months, treasury_group_id
      FROM public.pay_subscriptions
      ORDER BY updated_at DESC
      LIMIT lim
    ) s
    LEFT JOIN LATERAL (
      SELECT (array_agg(name ORDER BY created_at))[1] AS name
      FROM public.dao_registry
      WHERE treasury_group_id = s.treasury_group_id
    ) g ON true

    UNION ALL

    SELECT
      b.created_at,
      'bridge',
      b.direction,
      concat_ws(' · ', b.status, b.source_chain, b.dest_chain, nullif(b.network, '')),
      NULL::uuid,
      NULL::text,
      false
    FROM (
      SELECT direction, status, source_chain, dest_chain, network, created_at
      FROM public.bridge_transfers
      ORDER BY created_at DESC
      LIMIT lim
    ) b

    UNION ALL

    SELECT
      pr.created_at,
      'proposal',
      coalesce(nullif(pr.action_kind, ''), pr.protocol_id),
      concat_ws(' · ', pr.status, pr.protocol_id),
      reg.treasury_group_id,
      reg.name,
      coalesce(reg.privacy_enabled, false)
    FROM (
      SELECT created_at, action_kind, protocol_id, status, dao_onchain_address
      FROM public.agent_proposals
      ORDER BY created_at DESC
      LIMIT lim
    ) pr
    LEFT JOIN LATERAL (
      SELECT treasury_group_id, name, privacy_enabled
      FROM public.dao_registry d
      WHERE d.dao_onchain_address = pr.dao_onchain_address
      ORDER BY d.created_at
      LIMIT 1
    ) reg ON true

    UNION ALL

    SELECT
      c.created_at,
      'compass',
      c.action,
      public.compass_clip(coalesce(c.detail ->> 'reason', ''), 180),
      c.treasury_group_id,
      g.name,
      false
    FROM (
      SELECT created_at, action, detail, treasury_group_id
      FROM public.compass_audit
      ORDER BY created_at DESC
      LIMIT lim
    ) c
    LEFT JOIN LATERAL (
      SELECT (array_agg(name ORDER BY created_at))[1] AS name
      FROM public.dao_registry
      WHERE treasury_group_id = c.treasury_group_id
    ) g ON true
  )
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.at DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT * FROM events
    ORDER BY at DESC
    LIMIT lim
  ) h;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.compass_audit_feed(p_limit integer DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lim integer := least(greatest(coalesce(p_limit, 40), 1), 80);
  result jsonb;
BEGIN
  PERFORM public.compass_require_service();
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'actor', actor,
    'action', action,
    'treasury_group_id', treasury_group_id,
    'treasury_name', treasury_name,
    'detail', detail,
    'created_at', created_at
  ) ORDER BY created_at DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      a.id,
      a.actor,
      a.action,
      a.treasury_group_id,
      g.name AS treasury_name,
      (a.detail - 'previous_tx_hash' - 'payer') AS detail,
      a.created_at
    FROM (
      SELECT * FROM public.compass_audit ORDER BY created_at DESC LIMIT lim
    ) a
    LEFT JOIN LATERAL (
      SELECT (array_agg(name ORDER BY created_at))[1] AS name
      FROM public.dao_registry
      WHERE treasury_group_id = a.treasury_group_id
    ) g ON true
  ) rows;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.compass_grant_pay_subscription(
  p_treasury_group_id uuid,
  p_term integer,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reason text := public.compass_clip(btrim(coalesce(p_reason, '')), 500);
  price bigint;
  existing public.pay_subscriptions%ROWTYPE;
  start_at timestamptz;
  new_end timestamptz;
  recent jsonb;
  grants integer;
BEGIN
  PERFORM public.compass_require_service();
  IF p_treasury_group_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.dao_registry WHERE treasury_group_id = p_treasury_group_id
  ) THEN
    RAISE EXCEPTION 'unknown_treasury' USING ERRCODE = '02000';
  END IF;
  price := public.pay_price_cents(p_term);
  IF price IS NULL THEN
    RAISE EXCEPTION 'invalid_term' USING ERRCODE = '22023';
  END IF;
  IF reason IS NULL OR char_length(reason) < 1 THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO grants
  FROM public.compass_audit
  WHERE action = 'grant_subscription'
    AND created_at > now() - interval '1 hour';
  IF grants >= 30 THEN
    RAISE EXCEPTION 'grant_rate_limited' USING ERRCODE = '54000';
  END IF;

  SELECT * INTO existing
  FROM public.pay_subscriptions
  WHERE treasury_group_id = p_treasury_group_id
  FOR UPDATE;

  SELECT detail INTO recent
  FROM public.compass_audit
  WHERE action = 'grant_subscription'
    AND treasury_group_id = p_treasury_group_id
    AND created_at > now() - interval '30 seconds'
  ORDER BY created_at DESC
  LIMIT 1;
  IF recent IS NOT NULL
     AND recent ->> 'reason' = reason
     AND recent ->> 'term_months' = p_term::text
     AND existing.period_end IS NOT NULL THEN
    RETURN jsonb_build_object(
      'treasury_group_id', p_treasury_group_id,
      'term_months', existing.term_months,
      'price_cents', existing.price_cents,
      'period_end', existing.period_end,
      'state', public.compass_subscription_state(existing.period_end, existing.purged_at),
      'source', existing.source,
      'extended', false
    );
  END IF;

  start_at := now();
  IF existing.period_end IS NOT NULL AND existing.period_end > start_at AND existing.purged_at IS NULL THEN
    start_at := existing.period_end;
  END IF;
  new_end := start_at + make_interval(months => p_term);

  INSERT INTO public.pay_subscriptions (
    treasury_group_id, term_months, price_cents, period_end, payer, chain, tx_hash, source, purged_at, updated_at
  ) VALUES (
    p_treasury_group_id, p_term, price, new_end, 'compass', 'compass', 'compass:' || gen_random_uuid()::text, 'compass', NULL, now()
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

  INSERT INTO public.compass_audit (actor, action, treasury_group_id, detail)
  VALUES (
    'captain',
    'grant_subscription',
    p_treasury_group_id,
    jsonb_build_object(
      'term_months', p_term,
      'reason', reason,
      'price_cents', price,
      'period_end', new_end,
      'previous_source', existing.source,
      'previous_period_end', existing.period_end,
      'previous_tx_hash', existing.tx_hash
    )
  );

  RETURN jsonb_build_object(
    'treasury_group_id', p_treasury_group_id,
    'term_months', p_term,
    'price_cents', price,
    'period_end', new_end,
    'state', 'active',
    'source', 'compass',
    'extended', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compass_require_service() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_clip(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_marked_usd(text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_subscription_state(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_overview() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_treasuries(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_treasury(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_happenings(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_audit_feed(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compass_grant_pay_subscription(uuid, integer, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.compass_require_service() TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_clip(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_marked_usd(text, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_subscription_state(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_overview() TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_treasuries(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_treasury(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_happenings(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_audit_feed(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.compass_grant_pay_subscription(uuid, integer, text) TO service_role;
