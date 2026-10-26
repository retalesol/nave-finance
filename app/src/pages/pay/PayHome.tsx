import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { signMessage as signEvmMessage } from '@wagmi/core';
import { chainFamilyLabel, chainKindFromAddress, type ChainFamily } from '../../lib/chain/types';
import { useChain } from '../../hooks/useChain';
import { useDaoContext } from '../../hooks/useDaoContext';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { solanaAccessSigner } from '../../lib/edgeFunctionClient';
import { wagmiConfig } from '../../lib/evm/wagmi';
import { uploadDaoLogo } from '../../lib/uploadLogo';
import type { PayBooksSnapshot, PayWalletAddressRow } from '../../lib/pay/api';
import { setPayLogo } from '../../lib/pay/api';
import { fetchPayActivity, payBooksMessage, updatePayRails } from '../../lib/pay/booksApi';

function chainLabel(chain: string): string {
  if (chain === 'solana' || chain === 'ethereum' || chain === 'base' || chain === 'robinhood' || chain === 'arc') {
    return chainFamilyLabel(chain as ChainFamily);
  }
  return chain;
}

function shorten(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function addressCaption(row: PayWalletAddressRow): string {
  return row.chain === 'solana' ? 'Vault authority' : 'Treasury';
}

export default function PayHome({
  snapshot,
  treasuryGroupId,
}: {
  snapshot: PayBooksSnapshot;
  treasuryGroupId: string;
}) {
  const membership = useDaoMembership();
  const activity = useQuery({
    queryKey: ['payActivity', treasuryGroupId],
    queryFn: () => fetchPayActivity(treasuryGroupId, membership.walletStr),
  });
  const legalName = snapshot.company?.legal_name || 'This treasury';
  const address = snapshot.company?.address?.trim() ?? '';
  const ein = snapshot.company?.ein?.trim() ?? '';
  const cash = snapshot.cashAccount;

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 400,
          fontSize: '34px',
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          margin: '0 0 8px',
          color: '#111827',
        }}
      >
        {legalName}
      </h1>
      <p style={{ fontSize: '14.5px', lineHeight: 1.6, color: '#6B7280', margin: '0 0 22px', maxWidth: '560px' }}>
        Send an invoice, share the link, and get paid in USDC. The same books cover every chain this treasury has deployed.
      </p>
      <LogoEditor
        treasuryGroupId={treasuryGroupId}
        wallet={membership.walletStr}
        logoUrl={snapshot.company?.logo_url ?? ''}
      />

      <section
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E7E2D6',
          borderRadius: '12px',
          padding: '16px 16px 6px',
        }}
      >
        <div className="nave-label" style={{ marginBottom: '8px' }}>Primary account</div>
        <div style={{ fontSize: '15px', fontWeight: 600, color: '#111827' }}>Nave treasury</div>
        <p style={{ fontSize: '13px', color: '#6B7280', margin: '4px 0 14px', lineHeight: 1.5 }}>
          {cash ? `${cash.name} (${cash.code})` : 'Digital assets (1200)'}. Watch-only. Mercury can be connected later.
        </p>
        {snapshot.addresses.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 12px' }}>
            No chain deployments were on this treasury when Pay was turned on.
          </p>
        ) : (
          snapshot.addresses.map((row) => (
            <div
              key={`${row.chain}-${row.chain_id ?? 'solana'}-${row.address}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '12px 0',
                borderTop: '1px solid #EFEAE0',
                fontSize: '13.5px',
              }}
            >
              <span style={{ color: '#6B7280' }}>
                {chainLabel(row.chain)}
                <span style={{ color: '#9CA3AF' }}> · {addressCaption(row)}</span>
              </span>
              <code className="nave-mono" style={{ color: '#111827', fontSize: '12px' }}>
                {shorten(row.address)}
              </code>
            </div>
          ))
        )}
      </section>

      <p style={{ fontSize: '13px', color: '#9CA3AF', margin: '16px 0 0', lineHeight: 1.5 }}>
        Legal address: {address || 'not set'}. EIN: {ein || 'not set'}.
      </p>

      <details style={{ marginTop: '22px', maxWidth: '560px' }}>
        <summary style={{ cursor: 'pointer', fontSize: '13px', color: '#6B7280' }}>Wire and ACH instructions</summary>
        <RailsEditor
          treasuryGroupId={treasuryGroupId}
          wallet={membership.walletStr}
          wire={snapshot.company?.wire_instructions ?? ''}
          ach={snapshot.company?.ach_instructions ?? ''}
        />
      </details>

      <section style={{ marginTop: '22px' }}>
        <div className="nave-label" style={{ marginBottom: '8px' }}>Recent activity</div>
        {activity.isLoading ? <p style={{ fontSize: '13px', color: '#6B7280' }}>Loading activity.</p> : null}
        {!activity.isLoading && (activity.data ?? []).length === 0 ? (
          <p style={{ fontSize: '13px', color: '#6B7280', margin: 0 }}>No payment activity yet.</p>
        ) : (
          (activity.data ?? []).map((row) => (
            <div key={row.id} style={{ padding: '10px 0', borderTop: '1px solid #EFEAE0', fontSize: '13.5px', color: '#111827' }}>
              {row.summary}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function LogoEditor({
  treasuryGroupId,
  wallet,
  logoUrl,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  logoUrl: string;
}) {
  const queryClient = useQueryClient();
  const { daoAddress } = useDaoContext();
  const { target } = useChain();
  const { publicKey, signMessage } = useWallet();
  const { address } = useAccount();
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <section style={{ display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '22px' }}>
      {logoUrl ? (
        <img src={logoUrl} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 10 }} />
      ) : (
        <div style={{ width: 48, height: 48, borderRadius: 10, background: '#E7E2D6' }} />
      )}
      <div>
        <div style={{ fontSize: '14px', color: '#111827' }}>Treasury logo</div>
        <p style={{ fontSize: '13px', color: '#6B7280', margin: '2px 0 8px' }}>
          Shown on invoices this treasury sends.
        </p>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={saving || !wallet || !daoAddress}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || !wallet || !daoAddress) return;
            setSaving(true);
            setMessage(null);
            const signer = chainKindFromAddress(daoAddress) === 'evm'
              ? (messageText: string) => signEvmMessage(wagmiConfig, { message: messageText })
              : signMessage
                ? solanaAccessSigner(signMessage)
                : null;
            if (!signer) {
              setSaving(false);
              setMessage('Connect the founder wallet to set the logo.');
              return;
            }
            const founder = chainKindFromAddress(daoAddress) === 'evm' ? (address ?? wallet) : (publicKey?.toBase58() ?? wallet);
            void uploadDaoLogo(file, daoAddress, founder, daoAddress, signer, {
              chain: target.family,
              chainId: target.evmChainId ?? null,
            })
              .then((url) => setPayLogo(treasuryGroupId, wallet, url))
              .then(async () => {
                await queryClient.invalidateQueries({ queryKey: ['payBooks', treasuryGroupId] });
                setMessage('Logo saved. New invoices will use it.');
              })
              .catch((err: unknown) => setMessage(err instanceof Error ? err.message : 'Logo was not saved.'))
              .finally(() => setSaving(false));
          }}
        />
        {message ? <p style={{ fontSize: '13px', color: '#6B7280', margin: '6px 0 0' }}>{message}</p> : null}
      </div>
    </section>
  );
}

function RailsEditor({
  treasuryGroupId,
  wallet,
  wire,
  ach,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  wire: string;
  ach: string;
}) {
  const queryClient = useQueryClient();
  const [wireText, setWireText] = useState(wire);
  const [achText, setAchText] = useState(ach);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section style={{ marginTop: '22px', maxWidth: '560px' }}>
      <div className="nave-label" style={{ marginBottom: '8px' }}>Wire and ACH</div>
      <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 10px', lineHeight: 1.5 }}>
        Optional. A sent invoice freezes this text with the treasury address. It is not shown on the public payment page.
      </p>
      <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '10px' }}>
        Wire instructions
        <textarea
          value={wireText}
          onChange={(event) => setWireText(event.target.value)}
          style={railInput}
        />
      </label>
      <label style={{ display: 'block', fontSize: '13px', color: '#374151' }}>
        ACH instructions
        <textarea
          value={achText}
          onChange={(event) => setAchText(event.target.value)}
          style={railInput}
        />
      </label>
      {message ? <p style={{ fontSize: '13px', color: '#6B7280', margin: '8px 0 0' }}>{message}</p> : null}
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setMessage(null);
          void updatePayRails(treasuryGroupId, wallet, wireText, achText)
            .then(async () => {
              await queryClient.invalidateQueries({ queryKey: ['payBooks', treasuryGroupId] });
              setMessage('Saved.');
            })
            .catch((err: unknown) => setMessage(payBooksMessage(err)))
            .finally(() => setSaving(false));
        }}
        style={{
          marginTop: '10px',
          fontSize: '13px',
          fontWeight: 600,
          borderRadius: '9px',
          padding: '8px 14px',
          border: '1px solid #111827',
          backgroundColor: '#111827',
          color: '#ffffff',
        }}
      >
        {saving ? 'Saving…' : 'Save instructions'}
      </button>
    </section>
  );
}

const railInput = {
  display: 'block',
  width: '100%',
  marginTop: '6px',
  minHeight: '72px',
  border: '1px solid #E7E2D6',
  borderRadius: '9px',
  padding: '8px 10px',
  fontSize: '14px',
  fontFamily: 'inherit',
} as const;
