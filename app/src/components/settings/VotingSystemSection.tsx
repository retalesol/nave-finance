import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import Fi from '../Fi';
import { Section } from '../calm';
import { type GuardianInfo } from '../../hooks/useGuardianConfig';
import { useChain } from '../../hooks/useChain';
import { SWITCH_VOTING_QUORUM_PCT } from '../../lib/programConfig';
import { encodeEvmSwitchVotingPayload } from '../../lib/constitutionPayload';

export default function VotingSystemSection({
  daoAddress,
  governanceType,
  votingMint,
}: {
  daoAddress: string | null;
  governanceType: 'wallet' | 'token';
  guardians: GuardianInfo[];
  threshold: number;
  votingMint: string | null;
}) {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const { chainKind } = useChain();
  const { address: evmAddress } = useAccount();
  const [target, setTarget] = useState<'wallet' | 'token'>(governanceType === 'token' ? 'wallet' : 'token');
  const [error, setError] = useState<string | null>(null);

  function handleProposeSwitch() {
    setError(null);
    if (!daoAddress || (chainKind === 'evm' ? !evmAddress : !publicKey)) {
      setError('Connect your wallet to propose a voting system change.');
      return;
    }
    const toTokenGov = target === 'token';
    if (toTokenGov && !votingMint) {
      setError('Register a governance token first — token governance requires exactly one voting token.');
      return;
    }

    let payload: number[];
    if (chainKind === 'evm') {
      try {
        payload = encodeEvmSwitchVotingPayload({
          governanceType: toTokenGov ? 1 : 0,
          votingToken: (toTokenGov && votingMint ? votingMint : '0x0000000000000000000000000000000000000000') as `0x${string}`,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to encode EVM voting payload.');
        return;
      }
    } else {
      // Payload: [governance_type (1 byte)] + [voting_token_or_zero (32 bytes)] = 33 bytes
      const solanaPayload = new Uint8Array(33);
      solanaPayload[0] = toTokenGov ? 1 : 0;
      if (toTokenGov && votingMint) {
        try { solanaPayload.set(new PublicKey(votingMint).toBytes(), 1); } catch { /* ignore */ }
      }
      payload = Array.from(solanaPayload);
    }

    const targetLabel = toTokenGov ? 'Token-Weighted' : 'Authorized-Wallet';
    navigate('/decisions', {
      state: {
        proposeSwitchVoting: {
          title: `Voting System Change — Switch to ${targetLabel} Governance`,
          description:
            `Proposal to switch the DAO's governance model from ` +
            `${toTokenGov ? 'authorized-wallet' : 'token-weighted'} voting to ` +
            `${toTokenGov ? 'token-weighted' : 'authorized-wallet'} voting.\n\n` +
            (toTokenGov
              ? `Under token governance, voting weight is proportional to token holdings. ` +
                `Quorum is measured against the total token supply.\n\n` +
                `Voting token: ${votingMint?.slice(0, 8)}…\n\n`
              : `Under wallet governance, each authorized guardian wallet has equal voting weight.\n\n`) +
            `This is a high-impact, irreversible change. It requires a ${SWITCH_VOTING_QUORUM_PCT}% quorum to pass. ` +
            `Once approved, the founder applies the change on-chain from the Settings → Voting System page.`,
          payload,
        },
      },
    });
  }

  const busy = false;

  return (
    <Section
      title="Voting system"
      hint={governanceType === 'token' ? 'Token-weighted governance' : 'Authorized-wallet governance'}
    >
      <div className="space-y-4">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
          This DAO currently uses <strong>{governanceType === 'token' ? 'token-weighted voting' : 'authorized-wallet voting'}</strong>.
          Switching the voting system is a high-impact change and requires a {SWITCH_VOTING_QUORUM_PCT}% quorum to approve.
          Token governance allows exactly one voting token.
        </p>

        <div>
          <div className="nave-label mb-2">Switch to</div>
          <div className="flex flex-wrap gap-2">
            {(['wallet', 'token'] as const).map(t => {
              const sel = target === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  className="px-3.5 py-2 rounded-full border transition-all"
                  style={{
                    fontSize: '13px',
                    fontWeight: sel ? 600 : 400,
                    backgroundColor: sel ? 'hsl(var(--foreground))' : '#ffffff',
                    borderColor: sel ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                    color: sel ? '#ffffff' : 'hsl(var(--foreground))',
                  }}
                >
                  {t === 'wallet' ? 'Authorized Wallets' : 'Token-weighted'}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div
            className="flex items-center gap-2 py-1"
            style={{ color: 'hsl(var(--destructive))', fontSize: '12.5px' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px' }} />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} style={{ fontSize: '11.5px', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={handleProposeSwitch}
            disabled={busy || target === governanceType}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              opacity: busy || target === governanceType ? 0.45 : 1,
              cursor: busy || target === governanceType ? 'not-allowed' : 'pointer',
            }}
          >
            {target === governanceType ? 'Already active' : `Propose switch to ${target === 'token' ? 'token-weighted' : 'authorized-wallet'} voting →`}
          </button>
          <span style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
            Requires {SWITCH_VOTING_QUORUM_PCT}% quorum
          </span>
        </div>
      </div>
    </Section>
  );
}
