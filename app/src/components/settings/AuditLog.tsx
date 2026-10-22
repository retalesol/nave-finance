import { useState } from 'react';
import Fi from '../Fi';
import { Section } from '../calm';
import { useActivityLog } from '../../hooks/useActivityLog';
import { useChain } from '../../hooks/useChain';
import { useDaoRegistry } from '../../hooks/useDaoRegistry';
import { isEvmAddress, evmExplorerUrl } from '../../lib/chain/types';

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  time: string;
  status: 'success' | 'failed' | 'pending';
  hash?: string;
}

const AUDIT_PAGE_SIZE = 10;

function statusColor(s: string) {
  if (s === 'success' || s === 'pass') return 'hsl(var(--success))';
  if (s === 'failed' || s === 'fail') return 'hsl(var(--destructive))';
  return 'hsl(var(--warning))';
}

function getAuditExplorerUrl(
  hash: string,
  isEvmDao: boolean,
  evmChainId?: number,
): { url: string; label: string } {
  if (!isEvmDao) {
    return { url: `https://solscan.io/tx/${hash}`, label: 'Solscan' };
  }
  // Chain-id driven (Etherscan / Basescan / Robinhood Blockscout); Ethereum fallback.
  return evmExplorerUrl(evmChainId, 'tx', hash) ?? { url: `https://etherscan.io/tx/${hash}`, label: 'Etherscan' };
}

/**
 * activity_logs.tx_signature is a per-event dedup key: `${sig}:${eventIndex}`
 * (Solana) or `${txHash}:${logIndex}` (EVM). Strip the suffix to get the
 * explorer-linkable hash. Synthetic entries (e.g. `recon:…` reconciliation
 * alerts) have no on-chain tx and return undefined.
 */
function explorerHashFromDedupKey(dedupKey: string | undefined): string | undefined {
  if (!dedupKey) return undefined;
  const hash = dedupKey.split(':')[0];
  // Solana sigs are base58 (64 bytes → ~87 chars); EVM hashes are 0x + 64 hex.
  if (/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,88})$/.test(hash)) return hash;
  return undefined;
}

function deriveAuditStatus(eventType: string): AuditEntry['status'] {
  const t = eventType.toLowerCase();
  if (t.includes('fail') || t.includes('error') || t.includes('revert') || t.includes('cancelled')) {
    return 'failed';
  }
  if (t.includes('pending') || t.includes('queued') || t.includes('created')) {
    return 'pending';
  }
  return 'success';
}

export default function AuditLog({ daoAddress, first = false }: { daoAddress: string | null; first?: boolean }) {
  const { activities, loading } = useActivityLog(daoAddress);
  const { evmChainId } = useChain();
  const { dao } = useDaoRegistry(daoAddress);
  const explorerChainId = dao?.chainId ?? evmChainId ?? undefined;
  const [page, setPage] = useState(0);

  const entries: AuditEntry[] = activities.map((a) => ({
    id: a.id,
    action: a.description,
    actor: a.agentRole || a.actor || a.eventType,
    time: a.blockTime ? new Date(a.blockTime).toLocaleString() : new Date(a.createdAt).toLocaleString(),
    status: deriveAuditStatus(a.eventType),
    hash: explorerHashFromDedupKey(a.txSignature),
  }));

  const totalPages = Math.ceil(entries.length / AUDIT_PAGE_SIZE);
  const pageEntries = entries.slice(page * AUDIT_PAGE_SIZE, (page + 1) * AUDIT_PAGE_SIZE);

  return (
    <Section
      first={first}
      title="Audit log"
      hint="Indexed activity feed of recorded treasury operations"
    >
      {entries.length === 0 ? (
        <div className="py-6" style={{ color: 'hsl(var(--muted-foreground))', fontSize: '13.5px' }}>
          {loading ? 'Loading activity…' : 'No on-chain activity recorded yet.'}
        </div>
      ) : (
        <>
          <div>
            {pageEntries.map((entry, idx) => {
              const dotColor = statusColor(entry.status);
              const explorerUrl = entry.hash
                ? getAuditExplorerUrl(entry.hash, isEvmAddress(daoAddress), explorerChainId)
                : null;
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 py-3.5"
                  style={{
                    borderTop: idx === 0 ? '1px solid hsl(var(--surface-2))' : 'none',
                    borderBottom: '1px solid hsl(var(--surface-2))',
                  }}
                >
                  <div
                    className="rounded-full flex-shrink-0"
                    style={{ width: '7px', height: '7px', marginTop: '7px', backgroundColor: dotColor }}
                  />
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))', lineHeight: 1.4 }}>
                      {entry.action}
                    </div>
                    <div
                      className="flex items-center gap-2 mt-1 flex-wrap"
                      style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
                    >
                      <span className="nave-mono" style={{ fontSize: '11.5px' }}>{entry.actor}</span>
                      <span>·</span>
                      <span>{entry.time}</span>
                      {entry.hash && explorerUrl && (
                        <>
                          <span>·</span>
                          <a
                            href={explorerUrl.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline underline-offset-4 nave-mono"
                            style={{
                              fontSize: '11.5px',
                              color: 'hsl(var(--foreground))',
                            }}
                          >
                            {explorerUrl.label}: {entry.hash.slice(0, 6)}…{entry.hash.slice(-4)}
                            <Fi icon="arrow-up-right" style={{ fontSize: '9px', marginLeft: '3px', display: 'inline' }} />
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className="flex-shrink-0 ml-auto pt-0.5"
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: dotColor,
                    }}
                  >
                    {entry.status}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 mt-2">
              <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                {page * AUDIT_PAGE_SIZE + 1}–{Math.min((page + 1) * AUDIT_PAGE_SIZE, entries.length)} of {entries.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="flex items-center justify-center w-7 h-7 rounded-md border transition-colors"
                  style={{
                    borderColor: 'hsl(var(--border))',
                    color: page === 0 ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                    opacity: page === 0 ? 0.4 : 1,
                  }}
                >
                  <Fi icon="chevron-left" style={{ fontSize: '11px' }} />
                </button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setPage(i)}
                    className="flex items-center justify-center w-7 h-7 rounded-md border transition-colors"
                    style={{
                      fontSize: '11.5px',
                      fontFamily: 'var(--font-mono)',
                      borderColor: i === page ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                      backgroundColor: i === page ? 'hsl(var(--foreground))' : 'transparent',
                      color: i === page ? 'hsl(var(--background))' : 'hsl(var(--foreground))',
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="flex items-center justify-center w-7 h-7 rounded-md border transition-colors"
                  style={{
                    borderColor: 'hsl(var(--border))',
                    color: page === totalPages - 1 ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                    opacity: page === totalPages - 1 ? 0.4 : 1,
                  }}
                >
                  <Fi icon="chevron-right" style={{ fontSize: '11px' }} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
