import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CreateTransactionModal } from '../../components/TreasuryActions';
import { useChain } from '../../hooks/useChain';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { useDaoRegistry } from '../../hooks/useDaoRegistry';
import { useTokenRegistry } from '../../hooks/useTokenRegistry';
import { useTreasuryAssets } from '../../hooks/useTreasuryAssets';
import { supabase } from '../../lib/supabaseClient';
import { chainFamilyLabel, type ChainFamily } from '../../lib/chain/types';
import {
  PAY_TERMS,
  subscriptionPriceCents,
  type PayTermMonths,
} from '../../lib/pay/billing';
import { activatePaySubscription, type PaySubscription } from '../../lib/pay/api';
import { payBillingDestination, payUsdc } from '../../lib/pay/payConfig';
import { formatCents } from '../../lib/pay/invoiceMath';
import UsdcPayButton from './UsdcPayButton';
import { payBody, payCard, paySecondary, payTitle } from './payStyles';

export default function SubscribePage({
  treasuryGroupId,
  daoAddress,
  status,
}: {
  treasuryGroupId: string;
  daoAddress: string;
  status: PaySubscription | null;
}) {
  const [term, setTerm] = useState<PayTermMonths>(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [propose, setPropose] = useState(false);
  const queryClient = useQueryClient();
  const membership = useDaoMembership();
  const { chainFamily, target } = useChain();
  const evm = chainFamily !== 'solana';
  const destination = payBillingDestination(evm ? 'evm' : 'solana');
  const chainId = target.evmChainId ?? null;
  const usdc = payUsdc(chainFamily, chainId);
  const price = subscriptionPriceCents(term);
  const locked = status?.state === 'locked';
  const grace = status?.state === 'grace';

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>{locked ? 'Nave Pay is locked.' : 'Activate Nave Pay.'}</h1>
      <p style={payBody}>
        {locked
          ? 'The paid period ended more than 7 days ago. The books stay stored until 30 days after the period ended, then they are deleted.'
          : grace
            ? 'The paid period has ended. Pay stays open for 7 days, then it locks.'
            : '$49 a month. Three months are 10% off. Twelve months are 25% off. After the period, Pay stays open for 7 days, then locks. The books are deleted 30 days after the period ends.'}
      </p>
      <div style={{ display: 'flex', gap: '8px', margin: '16px 0', flexWrap: 'wrap' }}>
        {PAY_TERMS.map((months) => (
          <button
            key={months}
            type="button"
            onClick={() => setTerm(months)}
            style={{
              ...paySecondary,
              borderColor: term === months ? '#111827' : '#E7E2D6',
              background: term === months ? '#111827' : '#fff',
              color: term === months ? '#fff' : '#111827',
            }}
          >
            {months === 1 ? '1 month' : `${months} months`} · {formatCents(subscriptionPriceCents(months))}
          </button>
        ))}
      </div>
      <section style={{ ...payCard, maxWidth: '560px' }}>
        <p style={payBody}>
          Paying on <strong style={{ color: '#111827' }}>{chainFamilyLabel(chainFamily as ChainFamily)}</strong> in USDC.
          {usdc ? '' : ' USDC is not listed on this network. Switch the network pill to a deployed network that has USDC.'}
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
          <UsdcPayButton
            label={busy ? 'Paying…' : `Pay ${formatCents(price)} from wallet`}
            disabled={busy || !destination}
            evm={evm}
            chainId={chainId}
            destination={destination ?? ''}
            token={usdc}
            cents={price}
            onError={setError}
            onSent={async (txHash) => {
              setBusy(true);
              setError(null);
              try {
                const { data, error: claimError } = await supabase.functions.invoke('pay-claim', {
                  body: {
                    kind: 'subscription',
                    treasuryGroupId,
                    termMonths: term,
                    chain: chainFamily,
                    chainId,
                    txHash,
                    payer: membership.walletStr,
                  },
                });
                if (claimError) throw new Error(claimError.message);
                if (data && typeof data === 'object' && 'error' in data && data.error) {
                  throw new Error(String(data.error));
                }
                await queryClient.invalidateQueries({ queryKey: ['paySubscription', treasuryGroupId] });
              } finally {
                setBusy(false);
              }
            }}
          />
          <button type="button" style={paySecondary} disabled={!destination || !usdc} onClick={() => setPropose(true)}>
            Pay from treasury
          </button>
        </div>
        {!destination ? (
          <p style={{ ...payBody, marginTop: '10px' }}>The Nave Pay receiving address is not configured for this network.</p>
        ) : null}
        {error ? <p style={{ ...payBody, color: '#B42318', marginTop: '10px' }}>{error}</p> : null}
      </section>
      {propose && destination ? (
        <TreasurySubscribe
          daoAddress={daoAddress}
          destination={destination}
          amount={(price / 100).toFixed(2)}
          term={term}
          chain={chainFamily}
          wallet={membership.walletStr}
          treasuryGroupId={treasuryGroupId}
          onClose={() => setPropose(false)}
          onDone={() => {
            setPropose(false);
            void queryClient.invalidateQueries({ queryKey: ['paySubscription', treasuryGroupId] });
          }}
        />
      ) : null}
    </div>
  );
}

function TreasurySubscribe({
  daoAddress,
  destination,
  amount,
  term,
  chain,
  wallet,
  treasuryGroupId,
  onClose,
  onDone,
}: {
  daoAddress: string;
  destination: string;
  amount: string;
  term: PayTermMonths;
  chain: string;
  wallet: string | null;
  treasuryGroupId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { dao } = useDaoRegistry(daoAddress);
  const assets = useTreasuryAssets(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const proposalCount = (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
  const [note, setNote] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  if (!dao) return null;
  return (
    <>
      {note ? <p style={{ ...payBody, marginTop: '10px' }}>{note}</p> : null}
      <CreateTransactionModal
        daoAddress={daoAddress}
        proposalCount={proposalCount}
        governanceType={dao.governanceType}
        votingMint={tokenRegistry.tokens[0]?.mint ?? null}
        assets={assets.assets}
        initialRecipient={destination}
        initialAmount={amount}
        initialReason={`Nave Pay ${term} month subscription`}
        preferredSymbol="USDC"
        onClose={onClose}
        onCreated={(draft) => {
          const hash = draft?.proposalIndex != null ? `proposal:${draft.proposalIndex}` : '';
          if (!hash) {
            setNote('The proposal was created. After it executes, confirm it below.');
            return;
          }
          setPendingHash(hash);
          setNote(`Proposal ${draft?.proposalIndex} does not move funds until it executes. Confirm after it has executed.`);
        }}
      />
      {pendingHash ? (
        <button
          type="button"
          style={{ ...paySecondary, marginTop: '10px' }}
          onClick={() => {
            void activatePaySubscription({
              treasuryGroupId,
              wallet,
              termMonths: term,
              txHash: pendingHash,
              chain,
            }).then(onDone).catch((err: unknown) => {
              setNote(err instanceof Error ? err.message : 'Activation was not recorded.');
            });
          }}
        >
          Proposal executed — start Pay
        </button>
      ) : null}
    </>
  );
}
