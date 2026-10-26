import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAY_TERMS, subscriptionPriceCents, type PayTermMonths } from '../../lib/pay/billing';
import {
  compassRequest,
  CompassError,
  explainCompassError,
  type CompassAuditRow,
  type CompassGrant,
  type CompassHappening,
  type CompassOverview,
  type CompassSession,
  type CompassTreasuryDetail,
  type CompassTreasuryRow,
} from '../../lib/compass/api';
import {
  asNumber,
  chainLabel,
  formatCents,
  formatCount,
  formatUsd,
  formatWhen,
  recordEntries,
  safeHttpUrl,
  shortAddress,
} from '../../lib/compass/format';
import {
  Muted,
  Notice,
  Pill,
  Stat,
  StatePill,
  buttonStyle,
  cardStyle,
  inputStyle,
  labelStyle,
  quietButtonStyle,
  sectionTitleStyle,
} from './compassUi';

function useCompassQuery<T>(
  session: CompassSession,
  action: string,
  body: Record<string, unknown>,
  onUnauthorized: () => void,
) {
  return useQuery({
    queryKey: ['compass', session.expiresAt, action, body],
    queryFn: async () => {
      try {
        return await compassRequest<T>(session, action, body);
      } catch (error) {
        if (error instanceof CompassError && error.status === 401) onUnauthorized();
        throw error;
      }
    },
  });
}

export function OverviewPanel({
  session,
  onUnauthorized,
  onOpenTreasury,
}: {
  session: CompassSession;
  onUnauthorized: () => void;
  onOpenTreasury: (id: string) => void;
}) {
  const query = useCompassQuery<CompassOverview>(session, 'overview', {}, onUnauthorized);
  if (query.isLoading) return <Muted>Gathering the platform picture.</Muted>;
  if (query.isError) return <Notice>{explainCompassError(query.error)}</Notice>;
  const data = query.data;
  if (!data) return <Notice>Compass returned an empty overview.</Notice>;
  const subs = data.pay.subscriptions;

  return (
    <div style={{ display: 'grid', gap: '22px' }}>
      <div>
        <h1 style={sectionTitleStyle()}>Platform</h1>
        <Muted>Figures are counts and balances. Compass does not open a treasury's books.</Muted>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
        <Stat label="Treasury groups" value={formatCount(data.treasuries.groups)} detail={`${formatCount(data.treasuries.deployments)} chain deployments`} />
        <Stat label="Private groups" value={formatCount(data.treasuries.private_groups)} detail={`${formatCount(data.treasuries.created_7d)} new in 7 days`} />
        <Stat label="Snapshotted value" value={formatUsd(data.snapshotted_value_usd)} detail="Latest snapshot per deployment" />
        <Stat label="Chain events" value={formatCount(data.activity_24h)} detail={`${formatCount(data.activity_7d)} in 7 days`} />
        <Stat label="Nave Pay enabled" value={formatCount(data.pay.enabled)} detail={`${formatCount(subs.active)} active subscriptions`} />
        <Stat label="Paid catalog" value={formatCents(data.pay.collected_cents)} detail="Active wallet and treasury terms" />
        <Stat label="Granted catalog" value={formatCents(data.pay.granted_cents)} detail="Active Compass terms" />
        <Stat label="Watchers" value={formatCount(data.watchers)} detail={`${formatCount(data.treasuries.created_30d)} groups in 30 days`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
        <section style={{ ...cardStyle, padding: '16px' }}>
          <h2 style={{ ...labelStyle, marginBottom: '12px' }}>Subscriptions</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <StatePill state="active" /> <span>{formatCount(subs.active)}</span>
            <StatePill state="grace" /> <span>{formatCount(subs.grace)}</span>
            <StatePill state="locked" /> <span>{formatCount(subs.locked)}</span>
            <StatePill state="purged" /> <span>{formatCount(subs.purged)}</span>
            <StatePill state="none" /> <span>{formatCount(subs.none)}</span>
          </div>
        </section>
        <section style={{ ...cardStyle, padding: '16px' }}>
          <h2 style={{ ...labelStyle, marginBottom: '12px' }}>Chains</h2>
          {data.chains.length === 0 ? <Muted>No deployments yet.</Muted> : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' }}>
              {data.chains.map((chain) => (
                <li key={`${chain.chain}-${chain.chain_id}-${chain.network}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '14px' }}>
                  <span>{chainLabel(chain.chain, chain.chain_id)}{chain.network ? ` · ${chain.network}` : ''}</span>
                  <strong>{formatCount(chain.deployments)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section style={{ ...cardStyle, padding: '16px' }}>
          <h2 style={{ ...labelStyle, marginBottom: '12px' }}>Books, counted only</h2>
          <CountList rows={[
            ['Invoice volume', formatCents(data.books.invoice_total_cents)],
            ...recordEntries(data.books.invoices_by_status).map(([status, count]) => [`Invoices ${status}`, formatCount(count)] as [string, string]),
            ['Customers', formatCount(data.books.customers)],
            ['Vendors', formatCount(data.books.vendors)],
            ['Bills', formatCount(data.books.bills)],
            ['Payroll profiles', formatCount(data.books.employees)],
            ['Active payroll profiles', formatCount(data.books.active_employees)],
          ]} />
        </section>
        <section style={{ ...cardStyle, padding: '16px' }}>
          <h2 style={{ ...labelStyle, marginBottom: '12px' }}>Proposals and bridges</h2>
          <CountList rows={[
            ...recordEntries(data.proposals).map(([status, count]) => [`Proposals ${status}`, formatCount(count)] as [string, string]),
            ...recordEntries(data.bridges).map(([status, count]) => [`Bridges ${status}`, formatCount(count)] as [string, string]),
          ]} />
        </section>
      </div>

      <section style={{ ...cardStyle, padding: '16px' }}>
        <h2 style={{ ...labelStyle, marginBottom: '12px' }}>Soonest Nave Pay period ends</h2>
        {data.upcoming.length === 0 ? <Muted>No subscription periods on file.</Muted> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr>{['Treasury', 'State', 'Source', 'Term', 'Period end'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr>
              </thead>
              <tbody>
                {data.upcoming.map((row) => (
                  <tr key={row.treasury_group_id}>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => onOpenTreasury(row.treasury_group_id)} style={linkButton}>
                        {row.name || 'Untitled treasury'}
                      </button>
                    </td>
                    <td style={tdStyle}><StatePill state={row.state} /></td>
                    <td style={tdStyle}>{row.source || '—'}</td>
                    <td style={tdStyle}>{row.term_months ? `${row.term_months} mo` : '—'}</td>
                    <td style={tdStyle}>{formatWhen(row.period_end)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 style={{ ...labelStyle, marginBottom: '8px' }}>Kept out of Compass</h2>
        <ul style={{ margin: 0, paddingLeft: '18px', color: 'hsl(var(--muted-foreground))', fontSize: '14px', lineHeight: 1.6 }}>
          {data.withheld.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </div>
  );
}

function CountList({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) return <Muted>Nothing recorded.</Muted>;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' }}>
      {rows.map(([label, value]) => (
        <li key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '14px' }}>
          <span style={{ textTransform: 'capitalize' }}>{label}</span>
          <strong>{value}</strong>
        </li>
      ))}
    </ul>
  );
}

export function TreasuriesPanel({
  session,
  onUnauthorized,
  selectedId,
  onSelect,
}: {
  session: CompassSession;
  onUnauthorized: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const list = useCompassQuery<{ treasuries: CompassTreasuryRow[] }>(
    session,
    'treasuries',
    { query },
    onUnauthorized,
  );

  return (
    <div style={{ display: 'grid', gap: '18px' }}>
      <div>
        <h1 style={sectionTitleStyle()}>Treasuries</h1>
        <Muted>Search by name, slug, treasury address, or founder wallet. Up to 100 groups, newest first.</Muted>
      </div>
      <label style={{ ...labelStyle, textTransform: 'none', letterSpacing: 0, fontSize: '13px' }}>
        Search
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name, slug, or address"
          style={{ ...inputStyle, marginTop: '6px' }}
          className="compass-input"
        />
      </label>
      {list.isLoading ? <Muted>Loading treasuries.</Muted> : null}
      {list.isError ? <Notice>{explainCompassError(list.error)}</Notice> : null}
      {list.data && list.data.treasuries.length === 0 ? <Muted>No treasuries match.</Muted> : null}
      {list.data && list.data.treasuries.length > 0 ? (
        <div style={{ ...cardStyle, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr>{['Treasury', 'Chains', 'Pay', 'Subscription', 'Snapshot'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr>
            </thead>
            <tbody>
              {list.data.treasuries.map((row) => (
                <tr key={row.treasury_group_id} style={{ backgroundColor: row.treasury_group_id === selectedId ? 'hsl(var(--surface-1))' : 'transparent' }}>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => onSelect(row.treasury_group_id)} style={{ ...linkButton, fontWeight: 600 }}>
                      {row.name || 'Untitled treasury'}
                    </button>
                    <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: '12px', marginTop: '4px' }}>
                      {row.slug ? `${row.slug}.dao` : 'No slug'}
                      {row.privacy_enabled ? ' · Private' : ''}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {(row.deployments ?? []).map((deployment) => chainLabel(deployment.chain, deployment.chain_id)).join(', ') || '—'}
                  </td>
                  <td style={tdStyle}>{row.pay_enabled ? 'Enabled' : 'Not enabled'}</td>
                  <td style={tdStyle}><StatePill state={row.subscription_state} /></td>
                  <td style={tdStyle}>{row.snapshot_at ? formatUsd(row.latest_value_usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {selectedId ? (
        <TreasuryDetail session={session} treasuryGroupId={selectedId} onUnauthorized={onUnauthorized} />
      ) : null}
    </div>
  );
}

function TreasuryDetail({
  session,
  treasuryGroupId,
  onUnauthorized,
}: {
  session: CompassSession;
  treasuryGroupId: string;
  onUnauthorized: () => void;
}) {
  const query = useCompassQuery<CompassTreasuryDetail>(
    session,
    'treasury',
    { treasuryGroupId },
    onUnauthorized,
  );
  if (query.isLoading) return <Muted>Loading the treasury.</Muted>;
  if (query.isError) return <Notice>{explainCompassError(query.error)}</Notice>;
  const treasury = query.data;
  if (!treasury) return <Notice>That treasury is not in the registry.</Notice>;
  const website = treasury.privacy_enabled ? null : safeHttpUrl(treasury.website);
  const subscription = treasury.pay.subscription;

  return (
    <section style={{ ...cardStyle, padding: '18px', display: 'grid', gap: '18px' }}>
      <div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ ...sectionTitleStyle(), fontSize: '28px', margin: 0 }}>{treasury.name || 'Untitled treasury'}</h2>
          {treasury.privacy_enabled ? <Pill tone="private">Private</Pill> : null}
          {subscription ? <StatePill state={subscription.state} /> : <StatePill state="none" />}
        </div>
        <p style={{ margin: '8px 0 0', color: 'hsl(var(--muted-foreground))', fontSize: '14px' }}>
          {treasury.slug ? `${treasury.slug}.dao · ` : ''}Created {formatWhen(treasury.created_at)}
          {treasury.pay.enabled ? ` · Pay enabled ${formatWhen(treasury.pay.enabled_at)}` : ' · Pay not enabled'}
        </p>
        {treasury.description ? <p style={{ margin: '10px 0 0', fontSize: '14px', lineHeight: 1.5 }}>{treasury.description}</p> : null}
        {website ? <p style={{ margin: '8px 0 0' }}><a href={website} rel="noreferrer noopener" style={{ color: 'inherit' }}>{website}</a></p> : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
        <Stat label="Invoices" value={formatCount(treasury.counts.invoices)} detail={formatCents(treasury.counts.invoice_total_cents)} />
        <Stat label="Customers" value={formatCount(treasury.counts.customers)} />
        <Stat label="Vendors" value={formatCount(treasury.counts.vendors)} />
        <Stat label="Bills" value={formatCount(treasury.counts.bills)} />
        <Stat label="Payroll profiles" value={formatCount(treasury.counts.employees)} detail={`${formatCount(treasury.counts.active_employees)} active`} />
        <Stat label="Journal entries" value={formatCount(treasury.counts.journal_entries)} />
        <Stat label="Watchers" value={formatCount(treasury.counts.watchers)} />
        <Stat label="Authorized wallets" value={formatCount(treasury.counts.authorized_wallets)} />
      </div>

      <div>
        <h3 style={labelStyle}>Deployments</h3>
        <div style={{ display: 'grid', gap: '8px' }}>
          {treasury.deployments.map((deployment) => (
            <div key={`${deployment.chain_id ?? 'sol'}-${deployment.dao_onchain_address}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', fontSize: '14px' }}>
              <div>
                <strong>{chainLabel(deployment.chain, deployment.chain_id)}</strong>
                <span style={{ color: 'hsl(var(--muted-foreground))' }}> · {deployment.governance_type}{deployment.network ? ` · ${deployment.network}` : ''}</span>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', marginTop: '4px' }}>{deployment.dao_onchain_address}</div>
              </div>
              <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: '12px' }}>
                Founder {shortAddress(deployment.creator_wallet || '')}
                <div style={{ fontFamily: 'var(--font-mono)' }}>{deployment.creator_wallet}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {treasury.snapshots.length > 0 ? (
        <div>
          <h3 style={labelStyle}>Latest snapshots</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr>{['Chain', 'Value', 'SOL', 'USDC', 'Check', 'When'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr>
              </thead>
              <tbody>
                {treasury.snapshots.map((snapshot) => (
                  <tr key={`${snapshot.chain_id ?? 'sol'}-${snapshot.dao_onchain_address}`}>
                    <td style={tdStyle}>{chainLabel(snapshot.chain, snapshot.chain_id)}</td>
                    <td style={tdStyle}>{formatUsd(snapshot.total_value_usd)}</td>
                    <td style={tdStyle}>{asNumber(snapshot.sol_balance).toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td style={tdStyle}>{asNumber(snapshot.usdc_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                    <td style={tdStyle}>{snapshot.reconciliation_status}</td>
                    <td style={tdStyle}>{formatWhen(snapshot.snapshot_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div>
        <h3 style={labelStyle}>Recent chain events</h3>
        {treasury.recent_events.length === 0 ? <Muted>No indexed events for this treasury.</Muted> : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' }}>
            {treasury.recent_events.map((event) => (
              <li key={`${event.at}-${event.event_type}`} style={{ fontSize: '14px' }}>
                <strong>{event.event_type}</strong>
                <span style={{ color: 'hsl(var(--muted-foreground))' }}> · {formatWhen(event.at)}</span>
                {event.detail ? <div>{event.detail}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <GrantForm
        session={session}
        treasuryGroupId={treasury.treasury_group_id}
        treasuryName={treasury.name || 'this treasury'}
        onUnauthorized={onUnauthorized}
      />
    </section>
  );
}

function GrantForm({
  session,
  treasuryGroupId,
  treasuryName,
  onUnauthorized,
}: {
  session: CompassSession;
  treasuryGroupId: string;
  treasuryName: string;
  onUnauthorized: () => void;
}) {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState<PayTermMonths | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<CompassGrant | null>(null);
  const mutation = useMutation({
    mutationFn: () => compassRequest<CompassGrant>(session, 'grant_subscription', {
      treasuryGroupId,
      termMonths: term,
      reason: reason.trim(),
    }),
    onSuccess: async (grant) => {
      setResult(grant);
      setReason('');
      setConfirmed(false);
      await queryClient.invalidateQueries({ queryKey: ['compass'] });
    },
    onError: (error) => {
      if (error instanceof CompassError && error.status === 401) onUnauthorized();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!term || reason.trim().length < 12 || !confirmed) return;
    setResult(null);
    mutation.mutate();
  }

  const ready = term !== null && reason.trim().length >= 12 && confirmed && !mutation.isPending;

  return (
    <form onSubmit={submit} style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '16px', display: 'grid', gap: '12px' }}>
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: '16px' }}>Add a Nave Pay subscription</h3>
        <Muted>
          This extends {treasuryName} from the current period end when that period is still open. The catalog price is recorded, and no USDC is collected. Deleted books are not restored.
        </Muted>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {PAY_TERMS.map((months) => (
          <button
            key={months}
            type="button"
            aria-pressed={term === months}
            onClick={() => setTerm(months)}
            className="compass-button"
            style={{
              ...(term === months ? buttonStyle : quietButtonStyle),
              backgroundColor: term === months ? 'hsl(var(--foreground))' : 'transparent',
            }}
          >
            {months === 1 ? '1 month' : `${months} months`} · {formatCents(subscriptionPriceCents(months))}
          </button>
        ))}
      </div>
      <label style={{ ...labelStyle, textTransform: 'none', letterSpacing: 0, fontSize: '13px' }}>
        Reason
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          rows={3}
          required
          minLength={12}
          placeholder="Why this treasury is being granted a term"
          style={{ ...inputStyle, marginTop: '6px', resize: 'vertical' }}
          className="compass-input"
        />
      </label>
      <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '14px' }}>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>Record this as an operator grant, not a customer payment.</span>
      </label>
      <div>
        <button type="submit" disabled={!ready} className="compass-button" style={{ ...buttonStyle, opacity: ready ? 1 : 0.45, cursor: ready ? 'pointer' : 'not-allowed' }}>
          {mutation.isPending ? 'Recording grant' : 'Add subscription'}
        </button>
      </div>
      {mutation.isError ? <Notice>{explainCompassError(mutation.error)}</Notice> : null}
      {result ? (
        <Muted>
          {result.extended
            ? `Subscription recorded through ${formatWhen(result.period_end)}.`
            : `That same grant was just recorded. The period still ends ${formatWhen(result.period_end)}.`}
        </Muted>
      ) : null}
    </form>
  );
}

export function HappeningsPanel({
  session,
  onUnauthorized,
  onOpenTreasury,
}: {
  session: CompassSession;
  onUnauthorized: () => void;
  onOpenTreasury: (id: string) => void;
}) {
  const [kind, setKind] = useState('all');
  const query = useCompassQuery<{ happenings: CompassHappening[] }>(session, 'happenings', { limit: 60 }, onUnauthorized);
  if (query.isLoading) return <Muted>Loading happenings.</Muted>;
  if (query.isError) return <Notice>{explainCompassError(query.error)}</Notice>;
  const rows = (query.data?.happenings ?? []).filter((row) => kind === 'all' || row.kind === kind);
  const kinds = ['all', ...Array.from(new Set((query.data?.happenings ?? []).map((row) => row.kind)))];

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div>
        <h1 style={sectionTitleStyle()}>Happenings</h1>
        <Muted>Chain events, registrations, Pay activity kinds, subscriptions, bridges, proposals, and Compass actions. Pay summaries and bridge wallets stay out.</Muted>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {kinds.map((item) => (
          <button key={item} type="button" onClick={() => setKind(item)} className="compass-button" style={kind === item ? buttonStyle : quietButtonStyle}>
            {item}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <Muted>Nothing in this feed.</Muted> : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' }}>
          {rows.map((row, index) => (
            <li key={`${row.at}-${row.kind}-${index}`} style={{ ...cardStyle, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '14px' }}>{row.title || row.kind}</strong>
                <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: '12px' }}>{formatWhen(row.at)}</span>
              </div>
              <div style={{ marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px' }}>
                <Pill tone="none">{row.kind}</Pill>
                {row.private ? <Pill tone="private">Private</Pill> : null}
                {row.treasury_group_id ? (
                  <button type="button" onClick={() => onOpenTreasury(row.treasury_group_id!)} style={linkButton}>
                    {row.treasury_name || 'Treasury'}
                  </button>
                ) : null}
              </div>
              {row.detail ? <p style={{ margin: '8px 0 0', fontSize: '14px' }}>{row.detail}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AuditPanel({
  session,
  onUnauthorized,
  onOpenTreasury,
}: {
  session: CompassSession;
  onUnauthorized: () => void;
  onOpenTreasury: (id: string) => void;
}) {
  const query = useCompassQuery<{ audit: CompassAuditRow[] }>(session, 'audit', { limit: 50 }, onUnauthorized);
  if (query.isLoading) return <Muted>Loading the audit log.</Muted>;
  if (query.isError) return <Notice>{explainCompassError(query.error)}</Notice>;
  const rows = query.data?.audit ?? [];
  if (rows.length === 0) return <Muted>No Compass actions yet.</Muted>;

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div>
        <h1 style={sectionTitleStyle()}>Audit</h1>
        <Muted>Sign-ins and subscription grants. Payment transaction hashes are kept in the database and are not shown here.</Muted>
      </div>
      <div style={{ ...cardStyle, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr>{['When', 'Action', 'Treasury', 'Detail'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={tdStyle}>{formatWhen(row.created_at)}</td>
                <td style={tdStyle}>{row.action.replaceAll('_', ' ')}</td>
                <td style={tdStyle}>
                  {row.treasury_group_id ? (
                    <button type="button" onClick={() => onOpenTreasury(row.treasury_group_id!)} style={linkButton}>
                      {row.treasury_name || 'Treasury'}
                    </button>
                  ) : '—'}
                </td>
                <td style={tdStyle}>
                  {row.detail?.reason ? row.detail.reason : '—'}
                  {row.detail?.term_months ? ` · ${row.detail.term_months} mo` : ''}
                  {row.detail?.period_end ? ` · through ${formatWhen(row.detail.period_end)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: 'left' as const,
  fontSize: '11px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase' as const,
  color: 'hsl(var(--muted-foreground))',
  fontWeight: 600,
  padding: '10px 12px',
  borderBottom: '1px solid hsl(var(--border))',
  whiteSpace: 'nowrap' as const,
};

const tdStyle = {
  padding: '12px',
  borderBottom: '1px solid hsl(var(--border))',
  verticalAlign: 'top' as const,
};

const linkButton = {
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left' as const,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
};
