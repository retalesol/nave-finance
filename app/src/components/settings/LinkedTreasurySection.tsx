import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import Fi from '../Fi';
import { Section } from '../calm';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import {
  isEvmAddress,
  chainKindFromAddress,
  daoNetworkLabel,
  recommendedSisterChainId,
  sisterDestChainIds,
  isEvmChainId,
  type EvmChainId,
} from '../../lib/chain/types';
import { supabase, type DaoRegistryRow } from '../../lib/supabaseClient';
import { useWatchedDaos } from '../../hooks/useWatchedDaos';
import { buildSetLinkedTreasuryEvm } from '../../lib/evm/writers';
import { fetchLinkedTreasuryEvm } from '../../lib/evm/readers';

interface SisterCandidate {
  key: string;
  name: string;
  address: string;
  chainId: EvmChainId;
  source: 'created' | 'watched';
}

export default function LinkedTreasurySection({ daoAddress }: { daoAddress: string | null }) {
  const { evmChainId } = useChain();
  const { address: evmAddress } = useAccount();
  const watched = useWatchedDaos(evmAddress ?? null);
  const tx = useSendTransaction();
  const recommended = evmChainId ? recommendedSisterChainId(evmChainId) : 1;
  const [destChainId, setDestChainId] = useState<EvmChainId>(recommended);
  const [destTreasury, setDestTreasury] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [candidates, setCandidates] = useState<SisterCandidate[]>([]);
  const [loadingSisters, setLoadingSisters] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (evmChainId) setDestChainId(recommendedSisterChainId(evmChainId));
  }, [evmChainId]);

  useEffect(() => {
    let cancelled = false;
    async function loadSisters() {
      if (!daoAddress || !evmChainId || !evmAddress) {
        setCandidates([]);
        return;
      }
      setLoadingSisters(true);
      const created: SisterCandidate[] = [];
      const { data } = await supabase
        .from('dao_registry')
        .select('name, slug, dao_onchain_address, chain_id, creator_wallet')
        .ilike('creator_wallet', evmAddress);
      for (const row of (data as DaoRegistryRow[] | null) ?? []) {
        const chainId = row.chain_id;
        if (typeof chainId !== 'number' || !isEvmChainId(chainId)) continue;
        if (chainId === evmChainId) continue;
        if (row.dao_onchain_address.toLowerCase() === daoAddress.toLowerCase()) continue;
        created.push({
          key: `created:${chainId}:${row.dao_onchain_address.toLowerCase()}`,
          name: row.name || row.slug || 'Unnamed treasury',
          address: row.dao_onchain_address,
          chainId,
          source: 'created',
        });
      }
      const extra: SisterCandidate[] = [];
      for (const dao of watched.daos) {
        const chainId = dao.chainId;
        if (typeof chainId !== 'number' || !isEvmChainId(chainId)) continue;
        if (chainId === evmChainId) continue;
        if (dao.daoOnchainAddress.toLowerCase() === daoAddress.toLowerCase()) continue;
        const key = `watched:${chainId}:${dao.daoOnchainAddress.toLowerCase()}`;
        if (created.some((c) => c.address.toLowerCase() === dao.daoOnchainAddress.toLowerCase() && c.chainId === chainId)) {
          continue;
        }
        extra.push({
          key,
          name: dao.name || dao.label || 'Watched treasury',
          address: dao.daoOnchainAddress,
          chainId,
          source: 'watched',
        });
      }
      if (!cancelled) {
        setCandidates([...created, ...extra]);
        setLoadingSisters(false);
      }
    }
    void loadSisters();
    return () => { cancelled = true; };
  }, [daoAddress, evmChainId, evmAddress, watched.daos]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!daoAddress || !evmChainId) {
        setCurrent(null);
        return;
      }
      const addr = await fetchLinkedTreasuryEvm(evmChainId, daoAddress, destChainId);
      if (!cancelled) setCurrent(addr);
    }
    void load();
    return () => { cancelled = true; };
  }, [daoAddress, evmChainId, destChainId]);

  if (!daoAddress || !evmChainId || chainKindFromAddress(daoAddress) !== 'evm') return null;

  function pickSister(candidate: SisterCandidate) {
    setSelectedKey(candidate.key);
    setDestChainId(candidate.chainId);
    setDestTreasury(candidate.address);
    setSaved(false);
    setError(null);
  }

  async function save() {
    setError(null);
    setSaved(false);
    if (!isEvmChainId(destChainId)) {
      setError('Choose a destination network.');
      return;
    }
    if (!isEvmAddress(destTreasury)) {
      setError('Choose a sister treasury, or enter an address under Advanced.');
      return;
    }
    const outcome = await tx.sendEvm(
      buildSetLinkedTreasuryEvm(evmChainId!, daoAddress!, destChainId, destTreasury.trim()),
      { successLabel: 'Sister treasury linked', quietMock: true },
    );
    if (outcome.status === 'error') setError(outcome.error);
    else {
      setSaved(true);
      setCurrent(destTreasury.trim());
    }
  }

  const destOptions = sisterDestChainIds(evmChainId);
  const recommendedLabel = daoNetworkLabel(recommended);

  return (
    <Section
      title="Sister treasury"
      hint="Link another of your treasuries so agents can move funds for yield"
    >
      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '12px' }}>
        Agents bridge to a treasury you already created on another network — usually {recommendedLabel}.
        Pick one below. You can change this later.
      </p>

      {loadingSisters ? (
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginBottom: '10px' }}>
          Looking for your other treasuries…
        </p>
      ) : candidates.length > 0 ? (
        <div className="mb-3">
          {candidates.map((c, idx) => {
            const sel = selectedKey === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => pickSister(c)}
                className="w-full flex items-start gap-3 py-3 text-left transition-colors"
                style={{
                  borderBottom: '1px solid hsl(var(--surface-2))',
                  borderTop: idx === 0 ? '1px solid hsl(var(--surface-2))' : 'none',
                }}
              >
                <span
                  style={{
                    width: '17px',
                    height: '17px',
                    borderRadius: '50%',
                    border: sel ? '1.5px solid hsl(var(--foreground))' : '1.5px solid hsl(var(--border-strong))',
                    marginTop: '2px',
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {sel && (
                    <span
                      style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: 'hsl(var(--foreground))',
                      }}
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>{c.name}</div>
                  <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                    {daoNetworkLabel(c.chainId)}
                    {c.source === 'watched' ? ' · watched' : ''}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '12px' }}>
          No other treasuries found for this wallet. Create one on {recommendedLabel}, then come back — or use Advanced to paste an address.
        </p>
      )}

      {current && (
        <div
          className="flex items-center justify-between py-2.5 mb-2"
          style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13px' }}
        >
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>Currently linked on {daoNetworkLabel(destChainId)}</span>
          <span className="nave-mono" style={{ fontWeight: 500 }}>{current.slice(0, 6)}…{current.slice(-4)}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 mb-2 hover:underline underline-offset-4"
        style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={showAdvanced ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — paste a treasury address
      </button>
      {showAdvanced && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 pt-1">
          <div>
            <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600 }}>Network</label>
            <select
              value={destChainId}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (isEvmChainId(id)) {
                  setDestChainId(id);
                  setSelectedKey('');
                }
              }}
              className="w-full px-3 py-2.5 rounded-[10px] border outline-none"
              style={{
                fontSize: '13.5px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            >
              {destOptions.map((id) => (
                <option key={id} value={id}>{daoNetworkLabel(id)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600 }}>Treasury address</label>
            <input
              value={destTreasury}
              onChange={(e) => {
                setDestTreasury(e.target.value);
                setSelectedKey('');
              }}
              placeholder="0x…"
              className="w-full px-3 py-2.5 rounded-[10px] border outline-none"
              style={{
                fontSize: '13.5px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-2" style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</div>
      )}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={tx.status === 'signing' || tx.status === 'confirming' || !destTreasury.trim()}
          className="px-4 py-2 rounded-[9px] font-semibold"
          style={{
            fontSize: '13px',
            backgroundColor: 'hsl(var(--foreground))',
            color: '#ffffff',
            opacity: tx.status === 'signing' || tx.status === 'confirming' || !destTreasury.trim() ? 0.45 : 1,
          }}
        >
          {saved ? 'Linked' : 'Link sister treasury'}
        </button>
        {saved && (
          <span style={{ fontSize: '13px', color: 'hsl(var(--success))', fontWeight: 500 }}>
            Saved ✓
          </span>
        )}
      </div>
    </Section>
  );
}

export function ConstitutionRulesLink({ first = false }: { first?: boolean }) {
  return (
    <Section
      first={first}
      title="Treasury rules & protocols"
      action={
        <Link
          to="/rules"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold no-underline transition-colors"
          style={{
            fontSize: '13px',
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        >
          Open Constitution →
        </Link>
      }
    >
      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.55 }}>
        Approved protocols, risk limits, and constitution parameters live on the Constitution page — not here.
      </p>
    </Section>
  );
}
