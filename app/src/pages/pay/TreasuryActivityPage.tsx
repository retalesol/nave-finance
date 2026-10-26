import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NaveEmptyState from '../../components/NaveEmptyState';
import { useDaoContext } from '../../hooks/useDaoContext';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { useTreasuryAssets } from '../../hooks/useTreasuryAssets';
import { kindsForDirection, type FlowKind } from '../../lib/pay/lots';
import {
  classifyTreasuryEvent,
  fetchTreasuryActivity,
  formatAtomic,
  liveChainAtomic,
  recordTreasuryEvent,
  refreshTreasuryActivity,
  setLotMethod,
  treasuryActivityMessage,
  type PayCryptoAsset,
  type PayCryptoEvent,
} from '../../lib/pay/treasuryActivity';
import { PayPage } from './PayDesk';
import { payBody, payCard, payField, payInput, payPrimary, paySecondary } from './payStyles';

function centsFromDollars(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('invalid_amount');
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

function sumRemaining(lots: { asset_id: string; remaining_atomic: string }[], assetId: string): string {
  return lots
    .filter((lot) => lot.asset_id === assetId)
    .reduce((sum, lot) => sum + BigInt(lot.remaining_atomic.split('.')[0] || '0'), 0n)
    .toString();
}

export default function TreasuryActivityPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const queryClient = useQueryClient();
  const membership = useDaoMembership();
  const { daoAddress } = useDaoContext();
  const live = useTreasuryAssets(daoAddress);
  const wallet = membership.walletStr;
  const refreshed = useRef('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const activity = useQuery({
    queryKey: ['payTreasuryActivity', treasuryGroupId, wallet],
    queryFn: () => fetchTreasuryActivity(treasuryGroupId, wallet),
  });

  const liveChain = useMemo(() => {
    if (!daoAddress || !activity.data) return null;
    const match = activity.data.addresses.find((row) =>
      row.dao_onchain_address === daoAddress
      || row.dao_onchain_address.toLowerCase() === daoAddress.toLowerCase(),
    );
    return match?.chain ?? null;
  }, [activity.data, daoAddress]);

  const held = useMemo(() => {
    if (!liveChain) return [];
    return live.assets
      .filter((asset) => asset.symbol && asset.decimals >= 0)
      .map((asset) => ({
        chain: liveChain,
        symbol: asset.symbol,
        name: asset.name,
        contract: asset.mint === 'SOL' || asset.mint === 'ETH' ? '' : asset.mint,
        decimals: asset.decimals,
        is_stable: asset.isStablecoin || asset.symbol.toUpperCase() === 'USDC',
      }));
  }, [live.assets, liveChain]);

  const heldKey = held.map((asset) => `${asset.chain}:${asset.contract}:${asset.symbol}`).join('|');

  useEffect(() => {
    if (!wallet || activity.isLoading) return;
    const key = `${treasuryGroupId}|${heldKey}`;
    if (refreshed.current === key) return;
    refreshed.current = key;
    void refreshTreasuryActivity(treasuryGroupId, wallet, held)
      .then(() => queryClient.invalidateQueries({ queryKey: ['payTreasuryActivity', treasuryGroupId] }))
      .catch((err: unknown) => setError(treasuryActivityMessage(err)));
  }, [activity.isLoading, held, heldKey, queryClient, treasuryGroupId, wallet]);

  const data = activity.data;
  const unclassified = (data?.events ?? []).filter((event) => event.kind === 'unclassified' && event.status === 'confirmed');
  const selectedEvent = unclassified.find((event) => event.id === selected) ?? unclassified[0] ?? null;

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      await queryClient.invalidateQueries({ queryKey: ['payTreasuryActivity', treasuryGroupId] });
    } catch (err) {
      setError(treasuryActivityMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (activity.isLoading && !data) {
    return <p style={payBody}>Loading treasury activity.</p>;
  }
  if (activity.isError || !data) {
    return <p style={{ ...payBody, color: '#B42318' }}>{treasuryActivityMessage(activity.error)}</p>;
  }

  const classified = (data.events ?? []).filter((event) => event.kind !== 'unclassified' && event.status === 'confirmed').length;
  return (
    <PayPage
      kicker="Record"
      title="Treasury activity"
      purpose="Chain activity that is not an invoice payment. Classify it so the journal knows what the transfer was. Nothing here is signed or broadcast."
      actions={(
        <label style={{ ...payField, minWidth: '140px' }}>
          Lot method
          <select
            style={payInput}
            value={data.lotMethod}
            disabled={busy}
            onChange={(event) => {
              const method = event.target.value === 'HIFO' ? 'HIFO' : 'FIFO';
              void run(() => setLotMethod(treasuryGroupId, wallet, method));
            }}
          >
            <option value="FIFO">FIFO</option>
            <option value="HIFO">HIFO</option>
          </select>
        </label>
      )}
      metrics={[
        { label: 'Unclassified', value: String(unclassified.length), detail: 'Still need a category', tone: unclassified.length > 0 ? 'attention' : 'good' },
        { label: 'Classified', value: String(classified), detail: 'Confirmed and labeled' },
        { label: 'Lot method', value: data.lotMethod, detail: 'Used when a sale needs a cost basis' },
      ]}
    >
      {error ? <p style={{ ...payBody, color: '#B42318', marginBottom: '14px' }}>{error}</p> : null}

      <h2 style={sectionTitle}>Unclassified</h2>
      {unclassified.length === 0 ? (
        <NaveEmptyState
          icon="right-left"
          title="No unclassified treasury activity"
          description="Invoice settlements are excluded. Record another inflow or outflow if it is not already on an invoice."
        />
      ) : (
        <div style={{ ...payCard, marginBottom: '18px' }}>
          {unclassified.map((event) => {
            const asset = data.assets.find((row) => row.id === event.asset_id);
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => setSelected(event.id)}
                style={rowButton(selectedEvent?.id === event.id)}
              >
                <span>{event.event_date} · {event.direction === 'in' ? 'In' : 'Out'} · {asset?.symbol ?? 'Asset'} {asset ? formatAtomic(String(event.qty_atomic), asset.decimals) : event.qty_atomic}</span>
                <span style={{ color: '#6B7280' }}>{event.tx_hash.slice(0, 10)}</span>
              </button>
            );
          })}
        </div>
      )}
      {selectedEvent ? (
        <ClassifyForm
          event={selectedEvent}
          asset={data.assets.find((row) => row.id === selectedEvent.asset_id) ?? null}
          accounts={data.accounts}
          disabled={busy}
          onSubmit={(kind, accountId, memo, usdCents) => run(() => classifyTreasuryEvent(
            treasuryGroupId,
            wallet,
            selectedEvent.id,
            kind,
            accountId,
            memo,
            usdCents,
          ))}
        />
      ) : null}

      <h2 style={sectionTitle}>Lot tie-out</h2>
      <p style={{ ...payBody, margin: '0 0 10px' }}>
        Chain quantity is the live treasury read on this network. Other chains use the latest stored snapshot.
      </p>
      <div style={{ ...payCard, marginBottom: '22px', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' }}>
          <thead>
            <tr style={{ color: '#6B7280', textAlign: 'left' }}>
              <th style={th}>Asset</th>
              <th style={th}>Chain quantity</th>
              <th style={th}>Remaining lots</th>
              <th style={th}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {data.assets.map((asset) => {
              const remaining = sumRemaining(data.lots, asset.id);
              const liveQty = liveChainAtomic(asset, liveChain, live.assets);
              const snapshotQty = data.balances.find((row) => row.asset_id === asset.id)?.qty_atomic ?? null;
              const chainQty = liveQty ?? (snapshotQty != null ? String(snapshotQty).split('.')[0] : null);
              const difference = chainQty == null ? null : (BigInt(chainQty) - BigInt(remaining)).toString();
              return (
                <tr key={asset.id}>
                  <td style={td}>{asset.symbol} · {asset.chain}{asset.is_stable ? ' · par' : ''}</td>
                  <td style={td}>{chainQty == null ? 'Not read' : formatAtomic(chainQty, asset.decimals)}</td>
                  <td style={td}>{formatAtomic(remaining, asset.decimals)}</td>
                  <td style={td}>{difference == null ? '—' : formatAtomic(difference, asset.decimals)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {live.loading ? <p style={{ ...payBody, marginTop: '10px' }}>Reading the treasury balance.</p> : null}
      </div>

      <h2 style={sectionTitle}>Record a transfer</h2>
      <RecordForm
        assets={data.assets}
        addresses={data.addresses}
        accounts={data.accounts}
        disabled={busy}
        onSubmit={(body) => run(() => recordTreasuryEvent(treasuryGroupId, wallet, body))}
      />
    </PayPage>
  );
}

function ClassifyForm({
  event,
  asset,
  accounts,
  disabled,
  onSubmit,
}: {
  event: PayCryptoEvent;
  asset: PayCryptoAsset | null;
  accounts: { id: string; code: string; name: string; account_type: string }[];
  disabled: boolean;
  onSubmit: (kind: FlowKind, accountId: string | null, memo: string, usdCents: number | null) => void;
}) {
  const kinds = kindsForDirection(event.direction);
  const [kind, setKind] = useState<FlowKind>(kinds[0]);
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState(event.memo);
  const [dollars, setDollars] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setKind(kindsForDirection(event.direction)[0]);
    setMemo(event.memo);
    setDollars('');
    setLocalError(null);
  }, [event.id, event.direction, event.memo]);
  const choices = accounts.filter((account) => {
    if (kind === 'income') return account.account_type === 'income';
    if (kind === 'expense') return account.account_type === 'expense';
    if (kind === 'capital') return account.account_type === 'equity' || account.account_type === 'liability';
    return false;
  });

  return (
    <form
      style={{ ...payCard, marginBottom: '22px', display: 'grid', gap: '12px' }}
      onSubmit={(submit) => {
        submit.preventDefault();
        setLocalError(null);
        try {
          const needsValue = !asset?.is_stable && (kind === 'income' || kind === 'expense' || kind === 'capital');
          const usd = needsValue ? centsFromDollars(dollars) : null;
          if (needsValue && usd == null) throw new Error('invalid_amount');
          onSubmit(kind, accountId || null, memo, usd);
        } catch (err) {
          setLocalError(treasuryActivityMessage(err));
        }
      }}
    >
      <strong style={{ fontSize: '14px' }}>Classify {asset?.symbol ?? 'this transfer'}</strong>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
        <label style={payField}>
          Kind
          <select style={payInput} value={kind} onChange={(input) => setKind(input.target.value as FlowKind)}>
            {kinds.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        {choices.length > 0 ? (
          <label style={payField}>
            Account
            <select style={payInput} value={accountId} onChange={(input) => setAccountId(input.target.value)}>
              <option value="">Default chart account</option>
              {choices.map((account) => (
                <option key={account.id} value={account.id}>{account.code} {account.name}</option>
              ))}
            </select>
          </label>
        ) : null}
        {!asset?.is_stable && kind !== 'transfer' && kind !== 'unclassified' ? (
          <label style={payField}>
            USD value
            <input style={payInput} value={dollars} onChange={(input) => setDollars(input.target.value)} placeholder="0.00" />
          </label>
        ) : null}
      </div>
      {asset?.is_stable ? <p style={payBody}>Stablecoin value stays at par.</p> : null}
      <label style={payField}>
        Memo
        <input style={payInput} value={memo} onChange={(input) => setMemo(input.target.value)} />
      </label>
      {localError ? <p style={{ ...payBody, color: '#B42318' }}>{localError}</p> : null}
      <div>
        <button type="submit" style={payPrimary} disabled={disabled}>Classify</button>
      </div>
    </form>
  );
}

function RecordForm({
  assets,
  addresses,
  accounts,
  disabled,
  onSubmit,
}: {
  assets: PayCryptoAsset[];
  addresses: { id: string; chain: string; address: string }[];
  accounts: { id: string; code: string; name: string; account_type: string }[];
  disabled: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [addressId, setAddressId] = useState(addresses[0]?.id ?? '');
  const address = addresses.find((row) => row.id === addressId) ?? addresses[0];
  const chainAssets = assets.filter((asset) => asset.chain === address?.chain);
  const [assetId, setAssetId] = useState(chainAssets[0]?.id ?? '');
  const asset = chainAssets.find((row) => row.id === assetId) ?? chainAssets[0];
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [qty, setQty] = useState('');
  const [txHash, setTxHash] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [counterparty, setCounterparty] = useState('');
  const [kind, setKind] = useState<FlowKind>('unclassified');
  const [dollars, setDollars] = useState('');
  const [memo, setMemo] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const kinds = kindsForDirection(direction);

  return (
    <form
      style={{ ...payCard, display: 'grid', gap: '12px' }}
      onSubmit={(submit) => {
        submit.preventDefault();
        setLocalError(null);
        if (!address || !asset) {
          setLocalError('This treasury has no wallet address yet.');
          return;
        }
        try {
          const needsValue = !asset.is_stable && (kind === 'income' || kind === 'expense' || kind === 'capital');
          const usd = needsValue ? centsFromDollars(dollars) : null;
          if (needsValue && usd == null) throw new Error('invalid_amount');
          onSubmit({
            wallet_address_id: address.id,
            asset_id: asset.id,
            tx_hash: txHash,
            occurred_at: new Date(`${occurredAt}T00:00:00Z`).toISOString(),
            direction,
            qty,
            counterparty,
            kind,
            memo,
            usd_cents: usd,
            account_id: accounts.find((account) => (
              (kind === 'income' && account.account_type === 'income' && account.code === '4900')
              || (kind === 'expense' && account.account_type === 'expense' && account.code === '6900')
              || (kind === 'capital' && account.code === '3100')
            ))?.id ?? null,
          });
        } catch (err) {
          setLocalError(treasuryActivityMessage(err));
        }
      }}
    >
      <p style={payBody}>Record a transfer that is already on the treasury. This does not send it.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
        <label style={payField}>
          Address
          <select style={payInput} value={address?.id ?? ''} onChange={(input) => { setAddressId(input.target.value); setAssetId(''); }}>
            {addresses.map((row) => (
              <option key={row.id} value={row.id}>{row.chain} {row.address.slice(0, 6)}</option>
            ))}
          </select>
        </label>
        <label style={payField}>
          Asset
          <select style={payInput} value={asset?.id ?? ''} onChange={(input) => setAssetId(input.target.value)}>
            {chainAssets.map((row) => (
              <option key={row.id} value={row.id}>{row.symbol}{row.contract ? '' : ' native'}</option>
            ))}
          </select>
        </label>
        <label style={payField}>
          Direction
          <select style={payInput} value={direction} onChange={(input) => {
            const next = input.target.value === 'out' ? 'out' : 'in';
            setDirection(next);
            setKind('unclassified');
          }}>
            <option value="in">In</option>
            <option value="out">Out</option>
          </select>
        </label>
        <label style={payField}>
          Quantity
          <input style={payInput} value={qty} onChange={(input) => setQty(input.target.value)} placeholder="0.00" />
        </label>
        <label style={payField}>
          Transaction
          <input style={payInput} value={txHash} onChange={(input) => setTxHash(input.target.value)} />
        </label>
        <label style={payField}>
          Date
          <input style={payInput} type="date" value={occurredAt} onChange={(input) => setOccurredAt(input.target.value)} />
        </label>
        <label style={payField}>
          Kind
          <select style={payInput} value={kind} onChange={(input) => setKind(input.target.value as FlowKind)}>
            {kinds.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      </div>
      <label style={payField}>
        Counterparty
        <input style={payInput} value={counterparty} onChange={(input) => setCounterparty(input.target.value)} />
      </label>
      {!asset?.is_stable && kind !== 'transfer' && kind !== 'unclassified' ? (
        <label style={payField}>
          USD value
          <input style={payInput} value={dollars} onChange={(input) => setDollars(input.target.value)} placeholder="0.00" />
        </label>
      ) : null}
      <label style={payField}>
        Memo
        <input style={payInput} value={memo} onChange={(input) => setMemo(input.target.value)} />
      </label>
      {localError ? <p style={{ ...payBody, color: '#B42318' }}>{localError}</p> : null}
      <div>
        <button type="submit" style={paySecondary} disabled={disabled}>Record activity</button>
      </div>
    </form>
  );
}

const sectionTitle = {
  fontSize: '16px',
  fontWeight: 600,
  margin: '8px 0 10px',
  color: '#111827',
} as const;

const th = { padding: '0 8px 8px 0', fontWeight: 600 } as const;
const td = { padding: '8px 8px 8px 0', borderTop: '1px solid #E7E2D6', verticalAlign: 'top' } as const;

function rowButton(active: boolean) {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    width: '100%',
    textAlign: 'left' as const,
    background: active ? '#F6F3EC' : 'transparent',
    border: 'none',
    borderBottom: '1px solid #E7E2D6',
    padding: '10px 4px',
    cursor: 'pointer',
    font: 'inherit',
    color: '#111827',
  };
}
