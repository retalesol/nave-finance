import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { formatUnits } from 'viem';
import {
  decodeConstitutionPayload,
  decodeEvmStrategyRequestPayload,
  decodeEvmTokenMintPayload,
  decodeEvmTransferRequestPayload,
} from '@/lib/constitutionPayload';
import { decodeSolanaTransferProposalPayload } from '@/lib/transactionBuilders';
import { fetchProposalPayloadBytes } from '@/lib/onChainFetcher';
import { resolveEvmProposalPayload, loadSolanaStrategyPayload } from './proposalStorage';
import { SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER, getProposalDescription, type Proposal } from './types';

function shorten(addr: string) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function SummaryTable({ title, rows }: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div>
      <div className="nave-label" style={{ marginBottom: '6px' }}>{title}</div>
      <div>
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between gap-4"
            style={{
              padding: '10px 0',
              borderBottom: '1px solid hsl(var(--surface-2))',
              fontSize: '13px',
            }}
          >
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>{r.label}</span>
            <span
              className="nave-mono text-right"
              style={{ fontSize: '12.5px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PolicySummaryFromPayload({ payloadBytes }: { payloadBytes: number[] }) {
  const decoded = useMemo(() => {
    try { return decodeConstitutionPayload(payloadBytes); } catch { return null; }
  }, [payloadBytes]);
  if (!decoded) {
    return (
      <SummaryTable
        title="Rules change"
        rows={[{ label: 'Details', value: 'Could not decode rules payload' }]}
      />
    );
  }
  const approved = decoded.protocols.filter(p => p.approved).map(p => p.id.charAt(0).toUpperCase() + p.id.slice(1)).join(', ') || 'none';
  return (
    <SummaryTable
      title="Rules change"
      rows={[
        { label: 'Risk preset', value: decoded.riskPreset ? decoded.riskPreset.charAt(0).toUpperCase() + decoded.riskPreset.slice(1) : '—' },
        { label: 'Approved protocols', value: approved },
        { label: 'Min stablecoin', value: decoded.minStablecoin != null ? `${decoded.minStablecoin}%` : '—' },
        { label: 'Max deployment', value: decoded.maxDeployment != null ? `${decoded.maxDeployment}%` : '—' },
        { label: 'Max lending', value: decoded.maxLending != null ? `${decoded.maxLending}%` : '—' },
        { label: 'Liquidity reserve', value: decoded.liquidityReserve != null ? `${decoded.liquidityReserve}%` : '—' },
        { label: 'Rebalancing', value: decoded.rebalanceFreq ?? '—' },
      ]}
    />
  );
}

function TransferSummaryFromPayload({
  payloadBytes,
  chainKind,
}: {
  payloadBytes: number[];
  chainKind: 'solana' | 'evm';
}) {
  const rows = useMemo(() => {
    try {
      if (chainKind === 'evm') {
        const { asset, recipient, amount } = decodeEvmTransferRequestPayload(payloadBytes);
        return [
          { label: 'Asset', value: shorten(asset) },
          { label: 'Recipient', value: shorten(recipient) },
          { label: 'Amount', value: `${formatUnits(amount, 18)} (token units)` },
        ];
      }
      const dec = decodeSolanaTransferProposalPayload(Buffer.from(payloadBytes));
      const isNative = dec.mint.equals(SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER);
      const amountLabel = isNative
        ? `${(Number(dec.amount) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`
        : `${dec.amount.toString()} base units`;
      return [
        { label: 'Asset', value: isNative ? 'Native SOL' : shorten(dec.mint.toBase58()) },
        { label: 'Recipient', value: shorten(dec.recipient.toBase58()) },
        { label: 'Amount', value: amountLabel },
      ];
    } catch {
      return [{ label: 'Details', value: 'Could not decode transfer payload' }];
    }
  }, [payloadBytes, chainKind]);

  return <SummaryTable title="Transfer summary" rows={rows} />;
}

function compactSummaryLine(
  proposal: Proposal,
  payloadBytes: number[] | null,
  chainKind: 'solana' | 'evm',
  daoAddress?: string | null,
): string {
  if (proposal.description?.trim()) return proposal.description.trim();

  if (payloadBytes?.length || proposal.type === 'strategy') {
    try {
      if (proposal.type === 'policy' && payloadBytes?.length) {
        const decoded = decodeConstitutionPayload(payloadBytes);
        if (!decoded) throw new Error('decode failed');
        const approved = decoded.protocols.filter(p => p.approved).map(p => p.id).join(', ') || 'none';
        const preset = decoded.riskPreset
          ? decoded.riskPreset.charAt(0).toUpperCase() + decoded.riskPreset.slice(1)
          : 'custom';
        return `Updates treasury rules — ${preset} preset, protocols: ${approved}.`;
      }
      if (proposal.type === 'transfer' && payloadBytes?.length) {
        if (chainKind === 'evm') {
          const { asset, recipient, amount } = decodeEvmTransferRequestPayload(payloadBytes);
          return `Moves funds to ${shorten(recipient)} (${shorten(asset)}, ${formatUnits(amount, 18)} units).`;
        }
        const dec = decodeSolanaTransferProposalPayload(Buffer.from(payloadBytes));
        const isNative = dec.mint.equals(SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER);
        const amt = isNative
          ? `${(Number(dec.amount) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`
          : `${dec.amount.toString()} units`;
        return `Moves ${amt} to ${shorten(dec.recipient.toBase58())}.`;
      }
      if (proposal.type === 'token-mint' && payloadBytes?.length) {
        const decoded = decodeEvmTokenMintPayload(payloadBytes);
        return `Mints governance tokens to ${shorten(decoded.to)}.`;
      }
      if (proposal.type === 'strategy') {
        if (chainKind === 'evm' && payloadBytes?.length) {
          const decoded = decodeEvmStrategyRequestPayload(payloadBytes);
          return `Deploys strategy via ${shorten(decoded.adapter)} for ${shorten(decoded.asset)}.`;
        }
        if (daoAddress) {
          const stored = loadSolanaStrategyPayload(daoAddress, proposal.number);
          if (stored) {
            return `Deploys strategy via ${shorten(stored.adapter)} for ${shorten(stored.mint)}.`;
          }
        }
      }
    } catch {
      /* fall through to type description */
    }
  }

  if (proposal.type === 'agent-enable') {
    return 'Resumes the four autonomous agents under current treasury rules.';
  }

  return getProposalDescription(proposal.type).split('.')[0] + '.';
}

/** Human-readable policy/transfer summary — compact line on cards, full table when expanded. */
export default function ProposalPayloadSummary({
  proposal,
  daoAddress,
  chainKind,
  evmChainId,
  expanded,
  compact = false,
}: {
  proposal: Proposal;
  daoAddress: string | null;
  chainKind: 'solana' | 'evm';
  evmChainId: number | null | undefined;
  expanded: boolean;
  /** One-line teaser shown on the collapsed proposal card. */
  compact?: boolean;
}) {
  const [payloadBytes, setPayloadBytes] = useState<number[] | null>(null);
  const shouldLoad = (expanded || compact) && !!daoAddress;

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    void (async () => {
      try {
        if (chainKind === 'evm') {
          if (!evmChainId) return;
          if (proposal.type === 'policy' || proposal.type === 'transfer' || proposal.type === 'token-mint' || proposal.type === 'strategy') {
            const bytes = await resolveEvmProposalPayload(
              daoAddress!,
              evmChainId,
              proposal.number,
              proposal.type,
            );
            if (!cancelled) setPayloadBytes(bytes ?? []);
          }
        } else if (proposal.type === 'policy' || proposal.type === 'transfer' || proposal.type === 'strategy') {
          const raw = await fetchProposalPayloadBytes(new PublicKey(daoAddress!), proposal.number);
          if (!cancelled) setPayloadBytes(raw ? [...raw] : []);
        }
      } catch {
        if (!cancelled) setPayloadBytes([]);
      }
    })();
    return () => { cancelled = true; };
  }, [shouldLoad, daoAddress, proposal.number, proposal.type, chainKind, evmChainId]);

  if (compact && !expanded) {
    const line = compactSummaryLine(proposal, payloadBytes, chainKind);
    return (
      <p
        style={{
          fontSize: '12.5px',
          color: 'hsl(var(--muted-foreground))',
          lineHeight: 1.55,
          marginTop: '6px',
        }}
      >
        {line}
      </p>
    );
  }

  if (!expanded || !payloadBytes?.length) return null;

  if (proposal.type === 'policy') {
    return <PolicySummaryFromPayload payloadBytes={payloadBytes} />;
  }
  if (proposal.type === 'transfer') {
    return <TransferSummaryFromPayload payloadBytes={payloadBytes} chainKind={chainKind} />;
  }
  return null;
}
