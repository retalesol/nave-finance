import Fi from '@/components/Fi';
import {
  isUndefeatable,
  votingWindowClosed,
  type Proposal,
} from './types';

export function ProposalVoteFinalizePanel({
  proposal,
  voted,
  myVote,
  isTokenGov,
  lockAmount,
  setLockAmount,
  voting,
  isMember,
  voteError,
  guardianCount,
  quorumRounding,
  finalizing,
  finalizable,
  onVote,
  onFinalize,
}: {
  proposal: Proposal;
  voted: boolean;
  myVote: 'for' | 'against' | 'abstain' | null;
  isTokenGov: boolean;
  lockAmount: string;
  setLockAmount: (v: string) => void;
  voting: boolean;
  isMember: boolean;
  voteError: string | null;
  guardianCount: number;
  quorumRounding: 'ceil' | 'floor';
  finalizing: boolean;
  finalizable: boolean;
  onVote: (vote: 'for' | 'against') => void;
  onFinalize: () => void;
}) {
  return (
    <div
      style={{
        padding: '14px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      {voted ? (
        <div className="flex items-center gap-2">
          <span style={{ fontSize: '13px', color: '#2F7D4F', fontWeight: 600 }}>
            ✓ You voted {myVote === 'for' ? 'in favour' : myVote}
          </span>
        </div>
      ) : (
        <div>
          {isTokenGov && (
            <div className="mb-3">
              <label
                className="nave-label"
                style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '6px' }}
              >
                Tokens to lock for this vote
              </label>
              <input
                type="number"
                min="0"
                value={lockAmount}
                onChange={(e) => setLockAmount(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="e.g. 1000"
                className="w-full max-w-xs px-3 py-2 rounded-[10px] border outline-none"
                style={{
                  fontSize: '13.5px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onVote('for');
              }}
              disabled={voting || !isMember}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] border font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#111827',
                borderColor: '#111827',
                color: '#ffffff',
                opacity: !isMember ? 0.5 : 1,
                cursor: !isMember ? 'not-allowed' : 'pointer',
              }}
              title={!isMember ? 'Connect a wallet that is a member of this DAO to vote' : undefined}
            >
              Vote in favour
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onVote('against');
              }}
              disabled={voting || !isMember}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] border font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
                opacity: !isMember ? 0.5 : 1,
                cursor: !isMember ? 'not-allowed' : 'pointer',
              }}
              title={!isMember ? 'Connect a wallet that is a member of this DAO to vote' : undefined}
            >
              Vote against
            </button>
          </div>
          {!isMember && (
            <div className="flex items-center gap-2 mt-2.5" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              <Fi icon="lock" style={{ fontSize: '11px' }} />
              Only treasury members can vote. Connect a member wallet or acquire the DAO token to participate.
            </div>
          )}
          {voting && (
            <div className="flex items-center gap-2 mt-2.5" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              <Fi icon="arrows-rotate" style={{ fontSize: '12px' }} className="animate-spin" />
              Submitting vote on-chain…
            </div>
          )}
          {voteError && (
            <div className="flex items-center gap-2 mt-2.5" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Finalize — tallies votes once the window has closed (or outcome is certain). */}
      <div className="mt-3 pt-3 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
        {isUndefeatable(proposal, guardianCount, quorumRounding) && !votingWindowClosed(proposal) && (
          <div
            className="flex items-center gap-1.5 mb-2"
            style={{ fontSize: '12px', color: '#2F7D4F' }}
          >
            <Fi icon="circle-check" style={{ fontSize: '10px' }} />
            Outcome is mathematically certain — early finalization is available.
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onFinalize();
          }}
          disabled={finalizing || !isMember || !finalizable}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-[9px] border font-semibold transition-all"
          style={{
            fontSize: '12.5px',
            backgroundColor: finalizable ? '#ffffff' : 'transparent',
            borderColor: finalizable ? 'hsl(var(--border-strong))' : 'hsl(var(--border))',
            color: finalizable ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
            opacity: finalizing || !isMember ? 0.6 : finalizable ? 1 : 0.5,
            cursor: !isMember || !finalizable ? 'not-allowed' : 'pointer',
          }}
          title={
            !isMember
              ? 'Connect a wallet that is a member of this DAO to finalize'
              : finalizable
                ? undefined
                : 'Voting window is still open — waiting for more votes or window close'
          }
        >
          <Fi icon="gavel" style={{ fontSize: '11px' }} />
          {finalizing
            ? 'Finalizing…'
            : votingWindowClosed(proposal)
              ? 'Finalize voting'
              : `Finalize (${proposal.deadline})`}
        </button>
        {finalizing && (
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
            <Fi icon="arrows-rotate" style={{ fontSize: '11px' }} className="animate-spin" />
            Checking on-chain state…
          </div>
        )}
        {voteError && !voting && (
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
            <Fi icon="circle-xmark" style={{ fontSize: '11px' }} />
            {voteError}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProposalEscrowPanel({
  proposalStatus,
  releasing,
  isMember,
  walletStr,
  releaseMsg,
  voteError,
  onReleaseEscrow,
}: {
  proposalStatus: Proposal['status'];
  releasing: boolean;
  isMember: boolean;
  walletStr: string | null;
  releaseMsg: string | null;
  voteError: string | null;
  onReleaseEscrow: () => void;
}) {
  return (
    <div
      className="space-y-2.5"
      style={{
        padding: '14px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
        {proposalStatus === 'rejected' ? 'Failed — release your escrow' : 'Reclaim Locked Tokens'}
      </div>
      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
        {proposalStatus === 'rejected'
          ? 'This proposal did not pass (voted down or quorum was not met when it was finalized). If you locked governance tokens to vote, release them back to your wallet.'
          : 'If you locked governance tokens to vote on this proposal, voting has now ended — you can withdraw them back to your wallet.'}
      </p>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReleaseEscrow();
        }}
        disabled={releasing || !isMember || !walletStr}
        className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-[9px] border font-semibold transition-all"
        style={{
          fontSize: '12.5px',
          borderColor: 'hsl(var(--border-strong))',
          backgroundColor: '#ffffff',
          color: 'hsl(var(--foreground))',
          opacity: releasing || !isMember || !walletStr ? 0.6 : 1,
          cursor: releasing || !isMember || !walletStr ? 'not-allowed' : 'pointer',
        }}
        title={!walletStr ? 'Connect the wallet you voted with to reclaim locked tokens' : undefined}
      >
        <Fi icon={releasing ? 'arrows-rotate' : 'lock-open'} style={{ fontSize: '11px' }} className={releasing ? 'animate-spin' : ''} />
        {releasing ? 'Reclaiming…' : 'Reclaim locked tokens'}
      </button>
      {releaseMsg && (
        <div className="flex items-center gap-2" style={{ fontSize: '12px', color: '#2F7D4F' }}>
          <Fi icon="circle-check" style={{ fontSize: '12px', color: '#2F7D4F' }} />
          {releaseMsg}
        </div>
      )}
      {voteError && (
        <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
          <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
          {voteError}
        </div>
      )}
    </div>
  );
}
