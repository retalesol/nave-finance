import { useState } from 'react';
import Fi from './Fi';
import ChainIcon from './ChainIcon';
import { useBridge } from '../hooks/useBridge';
import { chainFamilyLabel, evmTarget, type EvmChainId } from '../lib/chain/types';
import {
  EVM_WRAPPED_NAVE_ADDRESSES,
  SOLANA_NAVE_MINT,
} from '../lib/programConfig';

function shorten(addr: string) {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Compact contract-address card for the Bridge & Stake column: official Solana
 * NAVE mint + wNAVE on the currently selected EVM chain (same CREATE address on
 * Ethereum / Base / Robinhood). Sits under Stake and stretches to the bridge
 * card's bottom via the parent flex column.
 */
export default function BridgeContractAddresses() {
  const { evmChainId, supportedRoutes, setEvmChainId } = useBridge();
  const [copied, setCopied] = useState<'nave' | 'wnave' | null>(null);

  const evmChoices = Array.from(new Set(supportedRoutes.map((r) => r.evmChainId)));
  const activeChainId: EvmChainId | null =
    evmChainId ?? (evmChoices.length > 0 ? evmChoices[0] : null);
  const wnave =
    activeChainId != null ? EVM_WRAPPED_NAVE_ADDRESSES[activeChainId] ?? null : null;
  const nave = SOLANA_NAVE_MINT.toBase58();
  const chainLabel =
    activeChainId != null ? chainFamilyLabel(evmTarget(activeChainId).family) : 'EVM';

  function copy(kind: 'nave' | 'wnave', value: string) {
    void navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return (
    <div
      className="rounded-xl border p-4 space-y-3"
      style={{ backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))' }}
    >
      <div className="flex items-center justify-between gap-2">
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))' }}>
          Contract addresses
        </div>
        {evmChoices.length > 1 && activeChainId != null && (
          <select
            aria-label="wNAVE chain"
            value={String(activeChainId)}
            onChange={(e) => setEvmChainId(Number(e.target.value) as EvmChainId)}
            style={{
              fontSize: 11,
              color: 'hsl(var(--foreground))',
              backgroundColor: 'hsl(var(--surface-1))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              padding: '3px 6px',
            }}
          >
            {evmChoices.map((id) => (
              <option key={id} value={String(id)}>
                {evmTarget(id).label}
              </option>
            ))}
          </select>
        )}
      </div>

      <AddressRow
        label="NAVE"
        sublabel="Solana mint"
        iconFamily="solana"
        address={nave}
        copied={copied === 'nave'}
        onCopy={() => copy('nave', nave)}
      />
      <AddressRow
        label="wNAVE"
        sublabel={chainLabel}
        iconFamily={activeChainId != null ? evmTarget(activeChainId).family : 'ethereum'}
        address={wnave}
        copied={copied === 'wnave'}
        onCopy={() => wnave && copy('wnave', wnave)}
      />
    </div>
  );
}

function AddressRow({
  label,
  sublabel,
  iconFamily,
  address,
  copied,
  onCopy,
}: {
  label: string;
  sublabel: string;
  iconFamily: 'solana' | 'ethereum' | 'base' | 'robinhood';
  address: string | null;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
      style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
    >
      <ChainIcon family={iconFamily} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--foreground))' }}>{label}</span>
          <span style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}>{sublabel}</span>
        </div>
        <div
          className="truncate"
          style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))', marginTop: 2 }}
          title={address ?? undefined}
        >
          {address ? shorten(address) : 'Not configured'}
        </div>
      </div>
      <button
        type="button"
        disabled={!address}
        onClick={onCopy}
        aria-label={`Copy ${label} address`}
        className="flex items-center justify-center rounded-md border shrink-0"
        style={{
          width: 30,
          height: 30,
          borderColor: 'hsl(var(--border))',
          backgroundColor: 'hsl(var(--surface-0))',
          color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))',
          cursor: address ? 'pointer' : 'not-allowed',
          opacity: address ? 1 : 0.5,
        }}
      >
        <Fi icon={copied ? 'check' : 'clone'} style={{ fontSize: 11 }} />
      </button>
    </div>
  );
}
