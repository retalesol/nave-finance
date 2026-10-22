import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import Fi from '../Fi';
import Toggle from '../Toggle';
import { Section } from '../calm';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import { buildSetDaoPrivacyEvm } from '../../lib/evm/writers';
import { updateDaoPrivacy } from '../../lib/edgeFunctionClient';

export default function PrivacyAccessSection({
  daoAddress,
  governanceType,
  privacyEnabled,
  onRefetch,
}: {
  daoAddress: string | null;
  governanceType: 'wallet' | 'token';
  privacyEnabled: boolean;
  onRefetch: () => void;
}) {
  const { publicKey, signMessage } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const { address: evmAddress } = useAccount();
  const tx = useSendTransaction();
  const [target, setTarget] = useState(privacyEnabled);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTarget(privacyEnabled);
  }, [privacyEnabled]);

  async function savePrivacy() {
    if (!daoAddress) return;
    if (chainKind === 'evm') {
      if (!evmChainId) {
        setError('Select an Ethereum or Base network.');
        return;
      }
      if (!evmAddress) {
        setError('Connect your Ethereum/Base wallet to update DAO privacy.');
        return;
      }
      setSaving(true);
      setError(null);
      setDone(false);
      const result = await tx.sendEvm(
        buildSetDaoPrivacyEvm(evmChainId, daoAddress, target ? 2 : 0),
        { successLabel: 'Privacy mode updated', quietMock: true },
      );
      setSaving(false);
      if (result.status === 'success' || result.status === 'mock') {
        setDone(true);
        onRefetch();
        window.setTimeout(() => setDone(false), 2200);
      } else if (result.status === 'error') {
        setError(result.error);
      }
      return;
    }
    if (!publicKey || !signMessage) {
      setError('Connect a wallet with message-signing support to update DAO privacy.');
      return;
    }
    setSaving(true);
    setError(null);
    setDone(false);
    const { data, error: saveError } = await updateDaoPrivacy(
      daoAddress,
      publicKey.toBase58(),
      signMessage,
      target,
    );
    setSaving(false);
    if (saveError || !data?.success) {
      setError(saveError || 'Failed to update privacy mode.');
      return;
    }
    setDone(true);
    onRefetch();
    window.setTimeout(() => setDone(false), 2200);
  }

  return (
    <Section
      title="DAO privacy access"
      hint={target ? 'Private membership checks enabled' : 'Public join enabled'}
    >
      <div className="space-y-3">
        <div
          className="flex items-start justify-between gap-4 py-3"
          style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
        >
          <div className="min-w-0 flex-1">
            <div style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
              Privacy mode
            </div>
            <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: 3, lineHeight: 1.55 }}>
              When privacy is on, people cannot add this treasury from the lobby unless they are already allowed in
              {governanceType === 'wallet' ? ' as a trusted wallet' : ' by holding the voting token'}.
            </div>
          </div>
          <div className="pt-1 flex-shrink-0">
            <Toggle value={target} onChange={setTarget} />
          </div>
        </div>

        {error && (
          <div
            className="flex items-center gap-2 py-1"
            style={{ color: 'hsl(var(--destructive))', fontSize: '12.5px' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px' }} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={savePrivacy}
            disabled={saving || target === privacyEnabled}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              opacity: saving || target === privacyEnabled ? 0.45 : 1,
              cursor: saving || target === privacyEnabled ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving privacy mode…' : target === privacyEnabled ? 'No changes' : 'Save privacy mode'}
          </button>
          {done && (
            <span style={{ fontSize: '13px', color: 'hsl(var(--success))', fontWeight: 500 }}>
              Updated ✓
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}
