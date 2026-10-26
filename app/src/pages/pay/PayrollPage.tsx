import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NaveEmptyState from '../../components/NaveEmptyState';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { formatCents, localToday, moneyIn } from '../../lib/pay/invoiceMath';
import {
  activateEmployee,
  approveRun,
  createRun,
  deleteRun,
  employeeName,
  fetchPayrollBundle,
  payrollMessage,
  personFromEmployee,
  revealEmployee,
  saveEmployee,
  saveOffer,
  saveStub,
  sendOffer,
  setOnboarding,
  signOffer,
  voidRun,
  type PayEmployee,
  type PayOffer,
  type PayStub,
  type PayrollBundle,
} from '../../lib/pay/payrollApi';
import {
  payrollCompute,
  payrollJournalDraft,
  payrollPeriodFor,
  type PayFrequency,
  type PayrollCalc,
  type StubInputs,
} from '../../lib/pay/payrollCalc';
import { payrollFilings } from '../../lib/pay/payrollFilings';
import { offerCanonical, onboardingChecklist, renderOffer, type OfferTerms } from '../../lib/pay/payrollOffer';
import { PayChips, PayPage } from './PayDesk';
import { payBody, payCard, payField, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

const TABS = [
  { path: '/pay/payroll', label: 'Runs' },
  { path: '/pay/payroll/people', label: 'People' },
  { path: '/pay/payroll/hiring', label: 'Hiring' },
  { path: '/pay/payroll/filings', label: 'Filings' },
];

function areaOf(path: string): 'runs' | 'people' | 'hiring' | 'filings' {
  if (path.startsWith('/pay/payroll/people')) return 'people';
  if (path.startsWith('/pay/payroll/hiring')) return 'hiring';
  if (path.startsWith('/pay/payroll/filings')) return 'filings';
  return 'runs';
}

export default function PayrollPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const membership = useDaoMembership();
  const path = location.pathname.replace(/\/+$/, '') || '/pay/payroll';
  const area = areaOf(path);
  const bundle = useQuery({
    queryKey: ['payPayroll', treasuryGroupId, membership.walletStr],
    queryFn: () => fetchPayrollBundle(treasuryGroupId, membership.walletStr),
  });

  const activePeople = (bundle.data?.employees ?? []).filter((person) => person.status === 'active').length;
  const openRuns = (bundle.data?.runs ?? []).filter((run) => run.status !== 'void' && run.status !== 'approved').length;
  const tab = TABS.find((item) => (item.path === '/pay/payroll' ? area === 'runs' : path.startsWith(item.path)))?.path ?? '/pay/payroll';

  return (
    <PayPage
      kicker="Pay"
      title="Payroll"
      purpose="Record wages, withholding, and net pay. Approving a run posts a journal entry. Nave Pay does not send ACH or move money."
      metrics={[
        { label: 'Active people', value: bundle.data ? String(activePeople) : '…', detail: 'W-2 and 1099' },
        { label: 'Open runs', value: bundle.data ? String(openRuns) : '…', detail: 'Not yet approved' },
        { label: 'Runs on file', value: bundle.data ? String(bundle.data.runs.length) : '…', detail: 'Including void' },
      ]}
      actions={path === '/pay/payroll' ? (
        <button type="button" style={payPrimary} onClick={() => navigate('/pay/payroll/runs/new')}>New pay run</button>
      ) : null}
    >
      <PayChips
        value={tab}
        onChange={(next) => navigate(next)}
        options={TABS.map((item) => ({ id: item.path, label: item.label }))}
      />
      {bundle.isLoading ? <p style={payBody}>Loading payroll.</p> : null}
      {bundle.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payrollMessage(bundle.error)}</p> : null}
      {bundle.data && area === 'runs' ? (
        <Runs
          path={path}
          data={bundle.data}
          treasuryGroupId={treasuryGroupId}
          wallet={membership.walletStr}
          onOpen={(id) => navigate(id ? `/pay/payroll/runs/${id}` : '/pay/payroll')}
        />
      ) : null}
      {bundle.data && area === 'people' ? (
        <People
          path={path}
          data={bundle.data}
          treasuryGroupId={treasuryGroupId}
          wallet={membership.walletStr}
          onOpen={(id) => navigate(id ? `/pay/payroll/people/${id}` : '/pay/payroll/people')}
        />
      ) : null}
      {bundle.data && area === 'hiring' ? (
        <Hiring
          path={path}
          data={bundle.data}
          treasuryGroupId={treasuryGroupId}
          wallet={membership.walletStr}
          onOpen={(id) => navigate(`/pay/payroll/hiring/${id}`)}
        />
      ) : null}
      {bundle.data && area === 'filings' ? <Filings data={bundle.data} /> : null}
    </PayPage>
  );
}

function useRefresh(treasuryGroupId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['payPayroll', treasuryGroupId] });
}

function Runs({
  path,
  data,
  treasuryGroupId,
  wallet,
  onOpen,
}: {
  path: string;
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
  onOpen: (id: string | null) => void;
}) {
  const runId = path.startsWith('/pay/payroll/runs/') ? path.split('/')[4] : null;
  if (path === '/pay/payroll/runs/new') {
    return <NewRun data={data} treasuryGroupId={treasuryGroupId} wallet={wallet} onDone={onOpen} />;
  }
  if (runId) {
    const run = data.runs.find((row) => row.id === runId);
    if (!run) return <p style={payBody}>That pay run is not in this treasury.</p>;
    return (
      <RunDetail
        run={run}
        data={data}
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        onBack={() => onOpen(null)}
      />
    );
  }
  return (
    <div>
      {data.runs.length === 0 ? (
        <NaveEmptyState
          icon="users"
          title="No pay runs yet"
          description="A pay run records gross pay, taxes, and net pay. Approving it posts a journal entry. It does not send the money."
          action={{ label: 'New pay run', onClick: () => onOpen('new') }}
        />
      ) : (
        <div style={payCard}>
          {data.runs.map((run) => {
            const stubs = data.stubs.filter((stub) => stub.run_id === run.id && stub.status !== 'void');
            const net = stubs.reduce((sum, stub) => sum + stub.net_cents, 0);
            return (
              <button key={run.id} type="button" onClick={() => onOpen(run.id)} style={rowButton}>
                <span>
                  <strong style={{ color: '#111827' }}>{run.pay_date}</strong>
                  <span style={{ color: '#6B7280' }}> · {run.kind} · {run.status}</span>
                </span>
                <span style={{ color: '#111827' }}>{formatCents(net)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewRun({
  data,
  treasuryGroupId,
  wallet,
  onDone,
}: {
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
  onDone: (id: string) => void;
}) {
  const refresh = useRefresh(treasuryGroupId);
  const today = localToday();
  const [payDate, setPayDate] = useState(today.startsWith('2026') ? today : '2026-01-15');
  const [kind, setKind] = useState<'regular' | 'offcycle' | 'contractor'>('regular');
  const [frequency, setFrequency] = useState<PayFrequency>('semimonthly');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const people = data.employees.filter((row) => row.status === 'active' && (kind === 'contractor' ? row.kind === '1099' : row.kind === 'w2'));
  const assets = data.accounts.filter((account) => account.account_type === 'asset');

  return (
    <form
      style={{ ...payCard, display: 'grid', gap: '12px' }}
      onSubmit={(event) => {
        event.preventDefault();
        const ids = people.filter((row) => picked[row.id]).map((row) => row.id);
        if (ids.length === 0) {
          setError('Choose at least one person.');
          return;
        }
        setSaving(true);
        setError(null);
        const period = payrollPeriodFor(frequency, payDate);
        try {
          const stubs = ids.map((id) => {
            const employee = data.employees.find((row) => row.id === id) as PayEmployee;
            const person = personFromEmployee(employee);
            const prior = data.stubs
              .filter((stub) => stub.employee_id === id && stub.status === 'approved')
              .map((stub) => ({ id: stub.id, payDate: stub.pay_date, calc: stub.calc }));
            const inputs: StubInputs = employee.kind === '1099' && employee.contract_rate_cents > 0
              ? { amount: (employee.contract_rate_cents / 100).toFixed(2), description: 'Services' }
              : {};
            const calc = payrollCompute(person, { pay_date: payDate, kind }, inputs, prior, data.settings);
            return { employee_id: id, inputs, calc, pay_method: employee.pay_method };
          });
          void createRun(treasuryGroupId, wallet, {
            pay_date: payDate,
            period_start: period.start,
            period_end: period.end,
            frequency,
            kind,
            cash_account_id: cash,
            stubs,
          }).then(async (id) => {
            await refresh();
            onDone(id);
          }).catch((err: unknown) => setError(payrollMessage(err)))
            .finally(() => setSaving(false));
        } catch (err) {
          setSaving(false);
          setError(payrollMessage(err));
        }
      }}
    >
      <p style={payBody}>Net pay is recorded as wages payable unless you pick a cash account. Either way, nothing is sent.</p>
      <div style={grid}>
        <label style={payField}>Pay date<input style={payInput} type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} /></label>
        <label style={payField}>Kind
          <select style={payInput} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="regular">Regular</option>
            <option value="offcycle">Off-cycle bonus</option>
            <option value="contractor">Contractor</option>
          </select>
        </label>
        <label style={payField}>Frequency
          <select style={payInput} value={frequency} onChange={(event) => setFrequency(event.target.value as PayFrequency)}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="semimonthly">Semimonthly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label style={payField}>Record net pay to
          <select style={payInput} value={cash} onChange={(event) => setCash(event.target.value)}>
            <option value="">Wages payable</option>
            {assets.map((account) => (
              <option key={account.id} value={account.id}>{account.code} {account.name}</option>
            ))}
          </select>
        </label>
      </div>
      {people.length === 0 ? <p style={payBody}>No active people for this run. Add someone and finish hiring first.</p> : (
        <div>
          {people.map((row) => (
            <label key={row.id} style={{ display: 'flex', gap: '8px', padding: '6px 0', fontSize: '14px' }}>
              <input
                type="checkbox"
                checked={picked[row.id] === true}
                onChange={(event) => setPicked((current) => ({ ...current, [row.id]: event.target.checked }))}
              />
              {employeeName(row)}
              <span style={{ color: '#6B7280' }}>{row.kind === 'w2' ? row.work_state : '1099'}{row.is_officer ? ' · officer' : ''}</span>
            </label>
          ))}
        </div>
      )}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="submit" style={payPrimary} disabled={saving}>{saving ? 'Saving…' : 'Create draft'}</button>
        <button type="button" style={paySecondary} onClick={() => onDone('')}>Cancel</button>
      </div>
    </form>
  );
}

function RunDetail({
  run,
  data,
  treasuryGroupId,
  wallet,
  onBack,
}: {
  run: PayrollBundle['runs'][number];
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
  onBack: () => void;
}) {
  const refresh = useRefresh(treasuryGroupId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stubs = data.stubs.filter((stub) => stub.run_id === run.id);
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void work().then(() => refresh()).catch((err: unknown) => setError(payrollMessage(err))).finally(() => setBusy(false));
  };

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <div>
          <strong>{run.pay_date}</strong>
          <span style={{ color: '#6B7280' }}> · {run.period_start} to {run.period_end} · {run.status}</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {run.status === 'draft' ? (
            <button type="button" style={payPrimary} disabled={busy} onClick={() => act(() => approveRun(treasuryGroupId, wallet, run.id))}>Approve</button>
          ) : null}
          {run.status === 'approved' ? (
            <button type="button" style={paySecondary} disabled={busy} onClick={() => act(() => voidRun(treasuryGroupId, wallet, run.id, 'Voided'))}>Void</button>
          ) : null}
          {run.status === 'draft' ? (
            <button type="button" style={paySecondary} disabled={busy} onClick={() => act(async () => { await deleteRun(treasuryGroupId, wallet, run.id); onBack(); })}>Delete draft</button>
          ) : null}
          <button type="button" style={paySecondary} onClick={onBack}>All runs</button>
        </div>
      </div>
      <p style={payBody}>
        {run.cash_account_id
          ? 'Approval credits the cash account you picked. That entry is a record. The money is not sent.'
          : 'Approval credits wages payable. Net pay is recorded and not sent.'}
      </p>
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      {stubs.map((stub) => {
        const employee = data.employees.find((row) => row.id === stub.employee_id);
        return (
          <StubCard
            key={stub.id}
            stub={stub}
            employee={employee}
            run={run}
            data={data}
            treasuryGroupId={treasuryGroupId}
            wallet={wallet}
          />
        );
      })}
    </div>
  );
}

function StubCard({
  stub,
  employee,
  run,
  data,
  treasuryGroupId,
  wallet,
}: {
  stub: PayStub;
  employee: PayEmployee | undefined;
  run: PayrollBundle['runs'][number];
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
}) {
  const refresh = useRefresh(treasuryGroupId);
  const [bonus, setBonus] = useState('');
  const [hours, setHours] = useState('');
  const [error, setError] = useState<string | null>(null);
  const calc = stub.calc;
  const journal = employee && calc?.lines
    ? payrollJournalDraft(calc, { kind: employee.kind, is_officer: employee.is_officer }, run.cash_account_id ? 'cash' : 'wages_payable')
    : [];
  const amount = (code: string) => (calc?.lines ?? []).filter((line) => line.code === code).reduce((sum, line) => sum + line.amount_cents, 0);

  return (
    <div style={payCard}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <strong>{employee ? employeeName(employee) : 'Person'}</strong>
        <span>{formatCents(stub.net_cents)} net</span>
      </div>
      <p style={{ ...payBody, marginTop: '6px' }}>
        Gross {formatCents(stub.gross_cents)} · Federal {formatCents(amount('fit'))} · Social Security {formatCents(amount('ss'))} · Medicare {formatCents(amount('med'))} · State {formatCents(amount('state_wh'))} · SDI {formatCents(amount('sdi'))}
      </p>
      {(calc?.warnings ?? []).slice(0, 3).map((warning) => (
        <p key={warning} style={{ ...payBody, color: '#92400E' }}>{warning}</p>
      ))}
      {stub.status === 'draft' && employee ? (
        <form
          style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const person = personFromEmployee(employee);
              const prior = data.stubs
                .filter((row) => row.employee_id === employee.id && row.status === 'approved' && row.id !== stub.id)
                .map((row) => ({ id: row.id, payDate: row.pay_date, calc: row.calc }));
              const inputs: StubInputs = { ...(stub.inputs ?? {}) };
              if (hours.trim()) inputs.regular_hours = hours;
              if (bonus.trim()) inputs.earnings = [{ type: 'bonus', amount: bonus, label: 'Bonus' }];
              const next = payrollCompute(person, { pay_date: run.pay_date, kind: run.kind }, inputs, prior, data.settings);
              void saveStub(treasuryGroupId, wallet, stub.id, { inputs, calc: next, pay_method: stub.pay_method })
                .then(() => refresh())
                .catch((err: unknown) => setError(payrollMessage(err)));
            } catch (err) {
              setError(payrollMessage(err));
            }
          }}
        >
          {employee.pay_type === 'hourly' ? (
            <label style={payField}>Regular hours<input style={payInput} value={hours} onChange={(event) => setHours(event.target.value)} placeholder="80" /></label>
          ) : null}
          {run.kind === 'offcycle' ? (
            <label style={payField}>Bonus<input style={payInput} value={bonus} onChange={(event) => setBonus(event.target.value)} placeholder="1000.00" /></label>
          ) : null}
          <button type="submit" style={{ ...paySecondary, alignSelf: 'end' }}>Recalculate</button>
        </form>
      ) : null}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      {run.status === 'approved' ? (
        <p style={{ ...payBody, marginTop: '8px' }}>
          Journal: {journal.filter((line) => line.debitCents).map((line) => line.systemKey).join(', ') || 'posted'} · credit includes {run.cash_account_id ? 'cash' : 'wages payable'}.
        </p>
      ) : null}
    </div>
  );
}

function People({
  path,
  data,
  treasuryGroupId,
  wallet,
  onOpen,
}: {
  path: string;
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
  onOpen: (id: string | null) => void;
}) {
  const creating = path === '/pay/payroll/people/new';
  const editingId = path.startsWith('/pay/payroll/people/') && !creating ? path.split('/')[4] : null;
  if (creating || editingId) {
    const existing = data.employees.find((row) => row.id === editingId) ?? null;
    if (editingId && !existing) return <p style={payBody}>That person is not in this treasury.</p>;
    return (
      <PersonForm
        existing={existing}
        kind={existing?.kind ?? 'w2'}
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        onClose={() => onOpen(null)}
      />
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <button type="button" style={paySecondary} onClick={() => onOpen('new')}>Add person</button>
      </div>
      {data.employees.length === 0 ? (
        <NaveEmptyState icon="users" title="No people yet" description="Add a W-2 employee or a 1099 contractor. Tax ids are encrypted before they are stored." action={{ label: 'Add person', onClick: () => onOpen('new') }} />
      ) : (
        <div style={payCard}>
          {data.employees.map((row) => (
            <button key={row.id} type="button" style={rowButton} onClick={() => onOpen(row.id)}>
              <span>
                <strong style={{ color: '#111827' }}>{employeeName(row)}</strong>
                <span style={{ color: '#6B7280' }}> · {row.kind === 'w2' ? 'W-2' : '1099'} · {row.status}{row.is_officer ? ' · officer' : ''}{row.flsa_exempt ? ' · exempt' : ''}</span>
              </span>
              <span style={{ color: '#6B7280' }}>{row.tin_last4 ? `••${row.tin_last4}` : 'No tax id'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PersonForm({
  existing,
  treasuryGroupId,
  wallet,
  onClose,
}: {
  existing: PayEmployee | null;
  kind: 'w2' | '1099';
  treasuryGroupId: string;
  wallet: string | null;
  onClose: () => void;
}) {
  const refresh = useRefresh(treasuryGroupId);
  const [kind, setKind] = useState<'w2' | '1099'>(existing?.kind ?? 'w2');
  const [first, setFirst] = useState(existing?.first_name ?? '');
  const [last, setLast] = useState(existing?.last_name ?? '');
  const [business, setBusiness] = useState(existing?.business_name ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [status, setStatus] = useState(existing?.status ?? (kind === 'w2' ? 'candidate' : 'active'));
  const [workState, setWorkState] = useState(existing?.work_state ?? 'CA');
  const [officer, setOfficer] = useState(existing?.is_officer ?? false);
  const [exempt, setExempt] = useState(existing?.flsa_exempt ?? kind === 'w2');
  const [payType, setPayType] = useState(existing?.pay_type ?? 'salary');
  const [rate, setRate] = useState(existing ? (existing.pay_rate_cents / 100).toFixed(2) : '');
  const [frequency, setFrequency] = useState<PayFrequency>(existing?.frequency ?? 'semimonthly');
  const [fedStatus, setFedStatus] = useState(existing?.fed_status ?? 'single');
  const [step2, setStep2] = useState(existing?.fed_step2 ?? false);
  const [k401, setK401] = useState(existing?.k401_type ?? 'none');
  const [k401Pct, setK401Pct] = useState(existing ? String(existing.k401_pct_bp / 100) : '0');
  const [health, setHealth] = useState(existing ? (existing.health_pretax_cents / 100).toFixed(2) : '0');
  const [sick, setSick] = useState(existing?.sick_policy ?? 'accrue');
  const [method, setMethod] = useState(existing?.pay_method ?? 'direct_deposit');
  const [routing, setRouting] = useState(existing?.dd_routing ?? '');
  const [account, setAccount] = useState(existing?.dd_last4 ? `••••${existing.dd_last4}` : '');
  const [tin, setTin] = useState(existing?.tin_last4 ? `•••-••-${existing.tin_last4}` : '');
  const [tinType, setTinType] = useState(existing?.tin_type ?? (kind === '1099' ? 'EIN' : 'SSN'));
  const [address1, setAddress1] = useState(existing?.address1 ?? '');
  const [city, setCity] = useState(existing?.city ?? '');
  const [zip, setZip] = useState(existing?.zip ?? '');
  const [birthYear, setBirthYear] = useState(existing?.birth_year ? String(existing.birth_year) : '');
  const [garnishment, setGarnishment] = useState(existing?.posttax?.[0]?.label ?? '');
  const [garnishmentAmt, setGarnishmentAmt] = useState(existing?.posttax?.[0] ? (existing.posttax[0].amount_cents / 100).toFixed(2) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      style={{ ...payCard, display: 'grid', gap: '12px' }}
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
          const posttax = garnishment.trim()
            ? [{ label: garnishment.trim(), amount_cents: moneyIn(garnishmentAmt || '0', 'Garnishment'), garnishment: true }]
            : [];
          const body = {
            id: existing?.id,
            kind,
            status,
            first_name: first,
            last_name: last,
            business_name: business,
            email,
            work_state: workState.toUpperCase(),
            is_officer: officer,
            flsa_exempt: exempt,
            pay_type: payType,
            pay_rate_cents: moneyIn(rate || '0', payType === 'salary' ? 'Annual salary' : 'Hourly rate'),
            frequency,
            fed_status: fedStatus,
            fed_step2: step2,
            k401_type: k401,
            k401_pct_bp: Math.round(Number(k401Pct || '0') * 100),
            k401_flat_cents: 0,
            health_pretax_cents: moneyIn(health || '0', 'Health'),
            sick_policy: sick,
            sick_cap_e2: 8000,
            pay_method: method,
            dd_routing: routing,
            dd_account: account,
            tin,
            tin_type: tinType,
            address1,
            city,
            zip,
            birth_year: birthYear ? Number(birthYear) : 0,
            posttax,
          };
          void saveEmployee(treasuryGroupId, wallet, body)
            .then(async () => {
              await refresh();
              onClose();
            })
            .catch((err: unknown) => setError(payrollMessage(err)))
            .finally(() => setSaving(false));
        } catch (err) {
          setSaving(false);
          setError(payrollMessage(err));
        }
      }}
    >
      <div style={grid}>
        {!existing ? (
          <label style={payField}>Type
            <select style={payInput} value={kind} onChange={(event) => setKind(event.target.value as 'w2' | '1099')}>
              <option value="w2">W-2 employee</option>
              <option value="1099">1099 contractor</option>
            </select>
          </label>
        ) : null}
        <label style={payField}>Status
          <select style={payInput} value={status} onChange={(event) => setStatus(event.target.value as PayEmployee['status'])}>
            <option value="candidate">Candidate</option>
            <option value="active">Active</option>
            <option value="terminated">Terminated</option>
          </select>
        </label>
        <label style={payField}>First name<input style={payInput} value={first} onChange={(event) => setFirst(event.target.value)} /></label>
        <label style={payField}>Last name<input style={payInput} value={last} onChange={(event) => setLast(event.target.value)} /></label>
        {kind === '1099' ? <label style={payField}>Business name<input style={payInput} value={business} onChange={(event) => setBusiness(event.target.value)} /></label> : null}
        <label style={payField}>Email<input style={payInput} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label style={payField}>Work state<input style={payInput} value={workState} maxLength={2} onChange={(event) => setWorkState(event.target.value)} /></label>
        <label style={payField}>Pay
          <select style={payInput} value={payType} onChange={(event) => setPayType(event.target.value as 'salary' | 'hourly')}>
            <option value="salary">Salary</option>
            <option value="hourly">Hourly</option>
          </select>
        </label>
        <label style={payField}>{payType === 'salary' ? 'Annual salary' : 'Hourly rate'}<input style={payInput} value={rate} onChange={(event) => setRate(event.target.value)} /></label>
        <label style={payField}>Frequency
          <select style={payInput} value={frequency} onChange={(event) => setFrequency(event.target.value as PayFrequency)}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="semimonthly">Semimonthly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label style={payField}>Federal status
          <select style={payInput} value={fedStatus} onChange={(event) => setFedStatus(event.target.value as PayEmployee['fed_status'])}>
            <option value="single">Single</option>
            <option value="mfj">Married filing jointly</option>
            <option value="hoh">Head of household</option>
          </select>
        </label>
        <label style={payField}>401(k)
          <select style={payInput} value={k401} onChange={(event) => setK401(event.target.value as PayEmployee['k401_type'])}>
            <option value="none">None</option>
            <option value="traditional">Traditional</option>
            <option value="roth">Roth</option>
          </select>
        </label>
        <label style={payField}>401(k) percent<input style={payInput} value={k401Pct} onChange={(event) => setK401Pct(event.target.value)} /></label>
        <label style={payField}>Section 125 health / paycheck<input style={payInput} value={health} onChange={(event) => setHealth(event.target.value)} /></label>
        <label style={payField}>Sick leave
          <select style={payInput} value={sick} onChange={(event) => setSick(event.target.value as PayEmployee['sick_policy'])}>
            <option value="accrue">Accrue (1 hour / 30 worked)</option>
            <option value="frontload">Front-load</option>
            <option value="none">None</option>
          </select>
        </label>
        <label style={payField}>Pay method
          <select style={payInput} value={method} onChange={(event) => setMethod(event.target.value as PayEmployee['pay_method'])}>
            <option value="direct_deposit">Direct deposit</option>
            <option value="check">Paper check</option>
          </select>
        </label>
        <label style={payField}>Routing<input style={payInput} value={routing} onChange={(event) => setRouting(event.target.value)} autoComplete="off" /></label>
        <label style={payField}>Account<input style={payInput} value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="off" /></label>
        <label style={payField}>Tax id<input style={payInput} value={tin} onChange={(event) => setTin(event.target.value)} autoComplete="off" /></label>
        <label style={payField}>Tax id type
          <select style={payInput} value={tinType} onChange={(event) => setTinType(event.target.value as PayEmployee['tin_type'])}>
            <option value="SSN">SSN</option>
            <option value="ITIN">ITIN</option>
            <option value="EIN">EIN</option>
          </select>
        </label>
        <label style={payField}>Address<input style={payInput} value={address1} onChange={(event) => setAddress1(event.target.value)} /></label>
        <label style={payField}>City<input style={payInput} value={city} onChange={(event) => setCity(event.target.value)} /></label>
        <label style={payField}>ZIP<input style={payInput} value={zip} onChange={(event) => setZip(event.target.value)} /></label>
        <label style={payField}>Birth year<input style={payInput} value={birthYear} onChange={(event) => setBirthYear(event.target.value)} /></label>
        <label style={payField}>Garnishment<label style={{ fontWeight: 400, color: '#6B7280' }}>label</label><input style={payInput} value={garnishment} onChange={(event) => setGarnishment(event.target.value)} /></label>
        <label style={payField}>Garnishment amount<input style={payInput} value={garnishmentAmt} onChange={(event) => setGarnishmentAmt(event.target.value)} /></label>
      </div>
      <label style={{ display: 'flex', gap: '8px', fontSize: '14px' }}>
        <input type="checkbox" checked={officer} onChange={(event) => setOfficer(event.target.checked)} /> Officer
      </label>
      <label style={{ display: 'flex', gap: '8px', fontSize: '14px' }}>
        <input type="checkbox" checked={exempt} onChange={(event) => setExempt(event.target.checked)} /> FLSA exempt
      </label>
      <label style={{ display: 'flex', gap: '8px', fontSize: '14px' }}>
        <input type="checkbox" checked={step2} onChange={(event) => setStep2(event.target.checked)} /> W-4 step 2 multiple jobs
      </label>
      {existing ? (
        <button
          type="button"
          style={paySecondary}
          onClick={() => {
            void revealEmployee(treasuryGroupId, wallet, existing.id).then((revealed) => {
              setTin(revealed.tin);
              setAccount(revealed.dd_account);
            }).catch((err: unknown) => setError(payrollMessage(err)));
          }}
        >
          Show stored identifiers
        </button>
      ) : null}
      <p style={payBody}>Identifiers are encrypted before storage. Activity and the audit log keep a hash, not the number.</p>
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="submit" style={payPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" style={paySecondary} onClick={onClose}>Back</button>
      </div>
    </form>
  );
}

function Hiring({
  path,
  data,
  treasuryGroupId,
  wallet,
  onOpen,
}: {
  path: string;
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
  onOpen: (id: string) => void;
}) {
  const id = path.startsWith('/pay/payroll/hiring/') ? path.split('/')[4] : null;
  const people = data.employees.filter((row) => row.status === 'candidate' || row.status === 'active');
  if (id) {
    const employee = data.employees.find((row) => row.id === id);
    if (!employee) return <p style={payBody}>That person is not in this treasury.</p>;
    return <HireDetail employee={employee} data={data} treasuryGroupId={treasuryGroupId} wallet={wallet} />;
  }
  return (
    <div>
      {people.length === 0 ? (
        <NaveEmptyState icon="users" title="No candidates" description="Add a person as a candidate, then complete I-9, W-4, DE 4, direct deposit, and the CIIAA." />
      ) : (
        <div style={payCard}>
          {people.map((row) => (
            <button key={row.id} type="button" style={rowButton} onClick={() => onOpen(row.id)}>
              <span><strong style={{ color: '#111827' }}>{employeeName(row)}</strong> <span style={{ color: '#6B7280' }}>{row.status}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HireDetail({
  employee,
  data,
  treasuryGroupId,
  wallet,
}: {
  employee: PayEmployee;
  data: PayrollBundle;
  treasuryGroupId: string;
  wallet: string | null;
}) {
  const refresh = useRefresh(treasuryGroupId);
  const [error, setError] = useState<string | null>(null);
  const items = onboardingChecklist(personFromEmployee(employee));
  const saved = data.onboarding.filter((row) => row.employee_id === employee.id);
  const offer = data.offers.find((row) => row.employee_id === employee.id && row.status !== 'withdrawn') ?? null;
  const company = { legal_name: 'the Company', address: '' };

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <h2 style={{ ...payTitle, fontSize: '24px' }}>{employeeName(employee)}</h2>
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      <div style={payCard}>
        {items.map((item) => {
          const row = saved.find((entry) => entry.item === item.key);
          const status = item.key === 'offer' && offer?.status === 'signed' ? 'done' : (row?.status ?? 'todo');
          return (
            <div key={item.key} style={{ padding: '10px 0', borderTop: '1px solid #EFEAE0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <div>
                  <strong>{item.label}</strong>
                  <p style={{ ...payBody, marginTop: '4px' }}>{item.help}</p>
                </div>
                <button
                  type="button"
                  style={paySecondary}
                  onClick={() => {
                    const next = status === 'done' ? 'todo' : 'done';
                    void setOnboarding(treasuryGroupId, wallet, employee.id, item.key, next)
                      .then(() => refresh())
                      .catch((err: unknown) => setError(payrollMessage(err)));
                  }}
                >
                  {status === 'done' ? 'Done' : 'Mark done'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {employee.kind === 'w2' ? (
        <OfferBox
          employee={employee}
          offer={offer}
          company={company}
          treasuryGroupId={treasuryGroupId}
          wallet={wallet}
          onError={setError}
        />
      ) : null}
      {employee.status === 'candidate' ? (
        <button
          type="button"
          style={payPrimary}
          onClick={() => {
            void activateEmployee(treasuryGroupId, wallet, employee.id)
              .then(() => refresh())
              .catch((err: unknown) => setError(payrollMessage(err)));
          }}
        >
          Activate on payroll
        </button>
      ) : null}
    </div>
  );
}

function OfferBox({
  employee,
  offer,
  company,
  treasuryGroupId,
  wallet,
  onError,
}: {
  employee: PayEmployee;
  offer: PayOffer | null;
  company: { legal_name: string; address: string };
  treasuryGroupId: string;
  wallet: string | null;
  onError: (message: string | null) => void;
}) {
  const refresh = useRefresh(treasuryGroupId);
  const [title, setTitle] = useState(String(offer?.terms?.title ?? employee.title ?? ''));
  const [start, setStart] = useState(String(offer?.terms?.start_date ?? '2026-02-02'));
  const [rate, setRate] = useState(offer?.terms?.rate_cents ? (Number(offer.terms.rate_cents) / 100).toFixed(2) : '');
  const [signer, setSigner] = useState(String(offer?.terms?.signer_name ?? ''));
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState(offer?.letter_text ?? '');

  const terms = (): OfferTerms => ({
    letter_date: localToday().startsWith('2026') ? localToday() : '2026-01-05',
    title,
    department: employee.department,
    manager_name: '',
    manager_title: '',
    start_date: start,
    work_location: 'Remote (California)',
    employment_type: 'full_time',
    pay_type: employee.pay_type,
    rate_cents: moneyIn(rate || '0', 'Pay'),
    frequency: employee.frequency,
    exempt: employee.flsa_exempt,
    bonus_text: '',
    equity_type: '',
    equity_amount: '',
    equity_vesting: '',
    benefits_text: 'You will be eligible for the benefit plans the Company offers.',
    pto_text: 'Paid sick leave accrues as required by California law, and PTO accrues on the employee record.',
    background_check: false,
    ciiaa: true,
    other_contingency: '',
    custom_text: '',
    expires_on: '2026-12-31',
    signer_name: signer,
    signer_title: 'Chief Executive Officer',
  });

  return (
    <div style={{ ...payCard, display: 'grid', gap: '10px' }}>
      <strong>Offer letter</strong>
      <p style={payBody}>Sending the letter stores it with a SHA-256 hash. Later edits start a new draft.</p>
      {offer?.content_hash ? <p style={payBody}>Hash {offer.content_hash}</p> : null}
      <div style={grid}>
        <label style={payField}>Title<input style={payInput} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label style={payField}>Start<input style={payInput} type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
        <label style={payField}>Pay<input style={payInput} value={rate} onChange={(event) => setRate(event.target.value)} /></label>
        <label style={payField}>Company signer<input style={payInput} value={signer} onChange={(event) => setSigner(event.target.value)} /></label>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={paySecondary}
          onClick={() => {
            void saveOffer(treasuryGroupId, wallet, { id: offer?.status === 'draft' ? offer.id : undefined, employee_id: employee.id, terms: terms() })
              .then(async (saved) => {
                const letter = renderOffer(terms(), personFromEmployee(employee), company, [], employee.work_state);
                setPreview(offerCanonical(letter));
                await refresh();
                return saved;
              })
              .catch((err: unknown) => onError(payrollMessage(err)));
          }}
        >
          Save draft
        </button>
        {offer?.status === 'draft' ? (
          <button
            type="button"
            style={payPrimary}
            onClick={() => {
              try {
                const letter = renderOffer(terms(), personFromEmployee(employee), company, [], employee.work_state);
                const text = offerCanonical(letter);
                setPreview(text);
                void sendOffer(treasuryGroupId, wallet, offer.id, text)
                  .then(() => refresh())
                  .catch((err: unknown) => onError(payrollMessage(err)));
              } catch (err) {
                onError(payrollMessage(err));
              }
            }}
          >
            Send and hash
          </button>
        ) : null}
      </div>
      {offer?.status === 'sent' ? (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input style={{ ...payInput, maxWidth: '280px' }} value={typed} placeholder="Typed legal name" onChange={(event) => setTyped(event.target.value)} />
          <button
            type="button"
            style={payPrimary}
            onClick={() => {
              void signOffer(treasuryGroupId, wallet, offer.id, typed)
                .then(() => refresh())
                .catch((err: unknown) => onError(payrollMessage(err)));
            }}
          >
            Sign
          </button>
        </div>
      ) : null}
      {preview ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px', color: '#374151' }}>{preview.slice(0, 1200)}</pre> : null}
    </div>
  );
}

function Filings({ data }: { data: PayrollBundle }) {
  const [period, setPeriod] = useState('2026-Q1');
  const range = period === '2026-Y'
    ? { from: '2026-01-01', to: '2026-12-31' }
    : period === '2026-Q2'
      ? { from: '2026-04-01', to: '2026-06-30' }
      : period === '2026-Q3'
        ? { from: '2026-07-01', to: '2026-09-30' }
        : period === '2026-Q4'
          ? { from: '2026-10-01', to: '2026-12-31' }
          : { from: '2026-01-01', to: '2026-03-31' };
  const packet = payrollFilings(data.stubs.map((stub) => {
    const employee = data.employees.find((row) => row.id === stub.employee_id);
    return {
      employeeId: stub.employee_id,
      payDate: stub.pay_date,
      status: stub.status,
      kind: employee?.kind ?? stub.calc?.kind ?? 'w2',
      name: employee ? employeeName(employee) : 'Person',
      workState: employee?.work_state ?? 'CA',
      isOfficer: employee?.is_officer ?? false,
      tinLast4: employee?.tin_last4 ?? '',
      netCents: stub.net_cents,
      calc: stub.calc,
    };
  }), range.from, range.to);

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <label style={payField}>Period
        <select style={{ ...payInput, maxWidth: '220px' }} value={period} onChange={(event) => setPeriod(event.target.value)}>
          <option value="2026-Q1">2026 Q1</option>
          <option value="2026-Q2">2026 Q2</option>
          <option value="2026-Q3">2026 Q3</option>
          <option value="2026-Q4">2026 Q4</option>
          <option value="2026-Y">2026 full year</option>
        </select>
      </label>
      <p style={payBody}>{packet.note}</p>
      <div style={payCard}>
        <strong>Form 941</strong>
        <FilingLine label="Line 1 employees" value={String(packet.f941.employees)} />
        <FilingLine label="Line 2 wages" value={formatCents(packet.f941.line2_wages)} />
        <FilingLine label="Line 3 federal income tax" value={formatCents(packet.f941.line3_fit)} />
        <FilingLine label="Line 5a Social Security wages" value={formatCents(packet.f941.line5a_ss_wages)} />
        <FilingLine label="Line 5a Social Security tax" value={formatCents(packet.f941.line5a_ss_tax)} />
        <FilingLine label="Line 5c Medicare wages" value={formatCents(packet.f941.line5c_med_wages)} />
        <FilingLine label="Line 12 total" value={formatCents(packet.f941.line12_total)} />
      </div>
      <div style={payCard}>
        <strong>Form 940</strong>
        <FilingLine label="Payments" value={formatCents(packet.f940.total_payments)} />
        <FilingLine label="Exempt (Section 125)" value={formatCents(packet.f940.exempt_payments)} />
        <FilingLine label="Over the $7,000 base" value={formatCents(packet.f940.over_base)} />
        <FilingLine label="FUTA taxable wages" value={formatCents(packet.f940.taxable)} />
        <FilingLine label="FUTA tax" value={formatCents(packet.f940.tax)} />
      </div>
      <div style={payCard}>
        <strong>DE 9</strong>
        <FilingLine label="UI subject wages" value={formatCents(packet.de9.ui_subject)} />
        <FilingLine label="UI taxable" value={formatCents(packet.de9.ui_taxable)} />
        <FilingLine label="SDI taxable" value={formatCents(packet.de9.sdi_taxable)} />
        <FilingLine label="PIT wages" value={formatCents(packet.de9.pit_wages)} />
        <FilingLine label="UI" value={formatCents(packet.de9.ui)} />
        <FilingLine label="ETT" value={formatCents(packet.de9.ett)} />
        <FilingLine label="SDI" value={formatCents(packet.de9.sdi)} />
        <FilingLine label="PIT withheld" value={formatCents(packet.de9.pit)} />
      </div>
      <div style={payCard}>
        <strong>W-2 boxes</strong>
        {packet.w2.length === 0 ? <p style={payBody}>No approved W-2 wages in this period.</p> : packet.w2.map((row) => (
          <div key={row.employeeId} style={{ padding: '8px 0', borderTop: '1px solid #EFEAE0' }}>
            <div>{row.name} {row.ssn_masked}{row.isOfficer ? ' · officer' : ''}</div>
            <p style={payBody}>
              Box 1 {formatCents(row.box1)} · Box 2 {formatCents(row.box2)} · Box 3 {formatCents(row.box3)} · Box 4 {formatCents(row.box4)} · Box 5 {formatCents(row.box5)} · Box 6 {formatCents(row.box6)} · Box 16 {formatCents(row.box16)} · Box 17 {formatCents(row.box17)} · CASDI {formatCents(row.box14_casdi)}
            </p>
          </div>
        ))}
      </div>
      {packet.de9c.length > 0 ? (
        <div style={payCard}>
          <strong>DE 9C wage detail</strong>
          {packet.de9c.map((row) => (
            <p key={row.name} style={payBody}>{row.name} {row.ssn_masked} · subject {formatCents(row.ui_subject)} · PIT wages {formatCents(row.pit_wages)} · PIT {formatCents(row.pit)}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilingLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0', fontSize: '14px' }}>
      <span style={{ color: '#6B7280' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' };

const rowButton = {
  display: 'flex',
  justifyContent: 'space-between',
  width: '100%',
  textAlign: 'left' as const,
  gap: '12px',
  padding: '12px 0',
  border: 0,
  borderTop: '1px solid #EFEAE0',
  background: 'transparent',
  cursor: 'pointer',
};
