import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage, useSignTypedData } from 'wagmi';
import Fi from './Fi';
import { useAgentStatus } from '../hooks/useAgentStatus';
import { useDaoMembership } from '../hooks/useDaoMembership';
import { useChain } from '../hooks/useChain';
import { isTreasuryOpsFamily } from '../lib/chain/types';
import { setAgentsEnabledViaProxy, setAgentsEnabledViaProxyEvm } from '../lib/edgeFunctionClient';
import { toast } from '../hooks/use-toast';

/**
 * C1 recovery surface. A treasury can finish creation with on-chain
 * `agents_enabled = false` when the (deliberately non-fatal) "Start agents" step
 * of the activation flow fails. Nothing auto-retries it, so the treasury looks
 * "live" but never automates. This banner DETECTS that state and gives the
 * founder a one-click, founder-gated retry — the same direct
 * `setAgentsEnabledViaProxy(true)` path the creation flow uses (agent-admin
 * verifies the founder and forwards to the signer; the agent secret never
 * touches the browser).
 *
 * Only renders for the founder when the on-chain gate is readable AND disabled.
 * It is intentionally NOT shown for a deliberate, governance-driven pause —
 * resuming after a pause is a separate governance flow on the Agent page; this
 * is strictly the never-enabled-at-creation recovery.
 */
export default function AgentsDisabledBanner({ daoAddress }: { daoAddress: string | null }) {
  const agentStatus = useAgentStatus(daoAddress);
  const { isFounder } = useDaoMembership();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const { publicKey, signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Surface only to the founder, only once the on-chain gate is readable and
  // explicitly disabled. While loading we assume enabled (the hook's default)
  // so the banner never flashes on a healthy treasury.
  if (!daoAddress || agentStatus.loading || agentStatus.agentsEnabled || !isFounder) {
    return null;
  }

  async function handleReenable() {
    if (!daoAddress) return;
    setError(null);
    setBusy(true);
    try {
      if (chainKind === 'evm') {
        if (!evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
          setError('Select an Ethereum, Base, Robinhood, or Arc network to re-enable agents.');
          return;
        }
        if (!evmAddress) { setError('Connect your founder wallet to re-enable agents.'); return; }
        const { data, error: err } = await setAgentsEnabledViaProxyEvm(
          daoAddress,
          evmAddress,
          (m) => signMessageAsync({ message: m }),
          true,
          evmChainId,
          chainFamily,
          {
            signGuardianAction: signTypedDataAsync
              ? (typed) =>
                  signTypedDataAsync({
                    domain: typed.domain,
                    types: typed.types,
                    primaryType: typed.primaryType,
                    message: typed.message,
                  })
              : undefined,
          },
        );
        if (err || !data?.success) { setError(err || data?.error || 'Failed to re-enable agents.'); return; }
      } else {
        if (!publicKey || !signMessage) { setError('Connect your founder wallet to re-enable agents.'); return; }
        const { data, error: err } = await setAgentsEnabledViaProxy(
          daoAddress,
          publicKey.toBase58(),
          signMessage,
          true,
        );
        if (err || !data?.success) { setError(err || 'Failed to re-enable agents.'); return; }
      }
      toast({ title: 'Agents re-enabled', description: 'Your autonomous agents are active again.' });
      agentStatus.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to re-enable agents.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center gap-3"
      style={{ backgroundColor: 'hsl(var(--warning) / 0.08)', borderColor: 'hsl(var(--warning) / 0.4)' }}
    >
      <div className="flex items-start gap-3 flex-1">
        <Fi icon="triangle-exclamation" style={{ fontSize: 16, color: 'hsl(var(--warning))', marginTop: 2 }} />
        <div>
          <div className="text-display font-semibold" style={{ fontSize: 13.5 }}>
            Autonomous agents are not enabled
          </div>
          <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, marginTop: 2 }}>
            This treasury was created but the agents never started, so it is not automating.
            Re-enable them to resume autonomous monitoring and execution under your constitution.
          </p>
          {error && (
            <p style={{ fontSize: 12, color: 'hsl(var(--destructive))', marginTop: 6 }}>{error}</p>
          )}
        </div>
      </div>
      <button
        onClick={handleReenable}
        disabled={busy}
        className="px-4 py-2 rounded-lg font-medium whitespace-nowrap"
        style={{
          fontSize: 13,
          backgroundColor: 'hsl(var(--warning))',
          color: 'hsl(var(--warning-foreground, 0 0% 100%))',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Re-enabling…' : 'Re-enable Agents'}
      </button>
    </div>
  );
}
