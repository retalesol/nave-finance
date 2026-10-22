import Fi from '@/components/Fi';
import { type Proposal } from './types';

export function ProposalExecutePanels({
  proposal,
  chainKind,
  isFounder,
  isMember,
  alreadyRatified,
  ratifying,
  ratifyMsg,
  enabling,
  enableMsg,
  enableError,
  executingTransfer,
  executingPermission,
  executingSwitchVoting,
  haltedEr,
  clearingHalt,
  clearHaltMsg,
  clearHaltError,
  voteError,
  onRatifyConstitution,
  onExecuteEnableAgents,
  onRatifyTokenMint,
  onExecuteTreasuryTransfer,
  onExecutePermission,
  onExecuteSwitchVotingSystem,
  onClearProposalHalt,
}: {
  proposal: Proposal;
  chainKind: 'solana' | 'evm';
  isFounder: boolean;
  isMember: boolean;
  alreadyRatified: boolean;
  ratifying: boolean;
  ratifyMsg: string | null;
  enabling: boolean;
  enableMsg: string | null;
  enableError: string | null;
  executingTransfer: boolean;
  executingPermission: boolean;
  executingSwitchVoting: boolean;
  haltedEr: { address: string; reason: string } | null;
  clearingHalt: boolean;
  clearHaltMsg: string | null;
  clearHaltError: string | null;
  voteError: string | null;
  onRatifyConstitution: () => void;
  onExecuteEnableAgents: () => void;
  onRatifyTokenMint: () => void;
  onExecuteTreasuryTransfer: () => void;
  onExecutePermission: () => void;
  onExecuteSwitchVotingSystem: () => void;
  onClearProposalHalt: () => void;
}) {
  const blockStyle = {
    padding: '14px 0',
    borderTop: '1px solid hsl(var(--surface-2))',
    borderBottom: '1px solid hsl(var(--surface-2))',
  };

  return (
    <>
      {/* Activate a passed rules (policy) proposal */}
      {proposal.status === 'passed' && proposal.type === 'policy' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Activate new rules
          </div>
          {alreadyRatified ? (
            <div
              className="flex items-start gap-2"
              style={{ fontSize: '13px', color: '#2F7D4F', lineHeight: 1.5 }}
            >
              <Fi icon="circle-check" style={{ fontSize: '12px', flexShrink: 0, marginTop: '3px' }} />
              <span>
                <strong>Rules activated.</strong> Your agents now follow these rules on every move.
              </span>
            </div>
          ) : (
            <>
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
                Apply these approved rules to the treasury so your agents follow them on every move.
              </p>
              {isFounder ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRatifyConstitution();
                  }}
                  disabled={ratifying || !isMember}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                  style={{
                    fontSize: '13px',
                    backgroundColor: '#111827',
                    color: '#ffffff',
                    opacity: ratifying || !isMember ? 0.6 : 1,
                  }}
                >
                  <Fi icon={ratifying ? 'arrows-rotate' : 'scroll'} style={{ fontSize: '12px' }} className={ratifying ? 'animate-spin' : ''} />
                  {ratifying ? 'Activating…' : 'Activate new rules'}
                </button>
              ) : (
                <div
                  className="flex items-center gap-2"
                  style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
                >
                  <Fi icon="circle-info" style={{ fontSize: '11px' }} />
                  Awaiting founder to activate these rules.
                </div>
              )}
            </>
          )}
          {ratifyMsg && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: '#2F7D4F' }}>
              <Fi icon="circle-check" style={{ fontSize: '12px', color: '#2F7D4F' }} />
              {ratifyMsg}
            </div>
          )}
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Resume agents after a passed agent-enable proposal */}
      {proposal.status === 'passed' && proposal.type === 'agent-enable' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Resume agents
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This decision passed. Activate it so the four agents reconnect and resume working under your current rules.
          </p>
          {isFounder ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onExecuteEnableAgents();
              }}
              disabled={enabling || !isMember}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#111827',
                color: '#ffffff',
                opacity: enabling || !isMember ? 0.6 : 1,
              }}
            >
              <Fi icon={enabling ? 'arrows-rotate' : 'play'} style={{ fontSize: '12px' }} className={enabling ? 'animate-spin' : ''} />
              {enabling ? 'Resuming…' : 'Resume agents'}
            </button>
          ) : (
            <div className="flex items-center gap-2" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              <Fi icon="circle-info" style={{ fontSize: '11px' }} />
              Awaiting founder to resume the agents.
            </div>
          )}
          {enableMsg && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: '#2F7D4F' }}>
              <Fi icon="circle-check" style={{ fontSize: '12px', color: '#2F7D4F' }} />
              {enableMsg}
            </div>
          )}
          {enableError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {enableError}
            </div>
          )}
        </div>
      )}

      {/* Mint approved tokens */}
      {proposal.status === 'passed' && proposal.type === 'token-mint' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Mint approved tokens
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This decision passed. Mint the approved token amount into the treasury.
          </p>
          {isFounder ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRatifyTokenMint();
              }}
              disabled={ratifying || !isMember}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#111827',
                color: '#ffffff',
                opacity: ratifying || !isMember ? 0.6 : 1,
              }}
            >
              <Fi icon={ratifying ? 'arrows-rotate' : 'coins'} style={{ fontSize: '12px' }} className={ratifying ? 'animate-spin' : ''} />
              {ratifying ? 'Minting…' : 'Mint approved tokens'}
            </button>
          ) : (
            <div className="flex items-center gap-2" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              <Fi icon="circle-info" style={{ fontSize: '11px' }} />
              Awaiting founder to mint the approved tokens.
            </div>
          )}
          {ratifyMsg && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: '#2F7D4F' }}>
              <Fi icon="circle-check" style={{ fontSize: '12px', color: '#2F7D4F' }} />
              {ratifyMsg}
            </div>
          )}
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Send approved payment */}
      {proposal.status === 'passed' && proposal.type === 'transfer' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Send approved payment
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This decision passed. Send the approved payment to the recipient in the exact amount agreed by the vote.
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExecuteTreasuryTransfer();
            }}
            disabled={executingTransfer || !isMember}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: '#111827',
              color: '#ffffff',
              opacity: executingTransfer || !isMember ? 0.6 : 1,
            }}
          >
            <Fi icon={executingTransfer ? 'arrows-rotate' : 'paper-plane'} style={{ fontSize: '12px' }} className={executingTransfer ? 'animate-spin' : ''} />
            {executingTransfer ? 'Sending…' : 'Send approved payment'}
          </button>
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Update members (Permission proposal) */}
      {proposal.status === 'passed' && proposal.type === 'permission' && chainKind === 'evm' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Update members
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This decision passed. Apply the updated member and guardian list to the treasury.
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void onExecutePermission();
            }}
            disabled={executingPermission || !isMember}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: '#111827',
              color: '#ffffff',
              opacity: executingPermission || !isMember ? 0.6 : 1,
            }}
          >
            <Fi icon={executingPermission ? 'arrows-rotate' : 'shield'} style={{ fontSize: '12px' }} className={executingPermission ? 'animate-spin' : ''} />
            {executingPermission ? 'Updating…' : 'Update members'}
          </button>
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Update voting system */}
      {proposal.status === 'passed' && proposal.type === 'switch-voting' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Update voting system
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This decision passed. Update how members vote on future decisions.
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void onExecuteSwitchVotingSystem();
            }}
            disabled={executingSwitchVoting || !isMember}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: '#111827',
              color: '#ffffff',
              opacity: executingSwitchVoting || !isMember ? 0.6 : 1,
            }}
          >
            <Fi icon={executingSwitchVoting ? 'arrows-rotate' : 'scale-balanced'} style={{ fontSize: '12px' }} className={executingSwitchVoting ? 'animate-spin' : ''} />
            {executingSwitchVoting ? 'Updating…' : 'Update voting system'}
          </button>
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Halted strategy execution request recovery */}
      {haltedEr && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--destructive))' }}>
            Execution Halted
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--destructive))', lineHeight: 1.55, margin: 0 }}>
            {haltedEr.reason || 'This move is currently paused by the Watcher.'}
          </p>
          {isFounder && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void onClearProposalHalt();
              }}
              disabled={clearingHalt}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#111827',
                color: '#ffffff',
                opacity: clearingHalt ? 0.6 : 1,
              }}
            >
              <Fi icon={clearingHalt ? 'arrows-rotate' : 'shield-check'} style={{ fontSize: '12px' }} className={clearingHalt ? 'animate-spin' : ''} />
              {clearingHalt ? 'Clearing…' : 'Clear Halt'}
            </button>
          )}
          {clearHaltMsg && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: '#2F7D4F' }}>
              <Fi icon="circle-check" style={{ fontSize: '12px', color: '#2F7D4F' }} />
              {clearHaltMsg}
            </div>
          )}
          {clearHaltError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {clearHaltError}
            </div>
          )}
        </div>
      )}

      {/* Strategy execution — automatic agent review */}
      {proposal.status === 'passed' && proposal.type === 'strategy' && (
        <div className="flex items-start gap-2.5" style={blockStyle}>
          <Fi icon="clock" style={{ fontSize: '13px', color: '#B9974F', flexShrink: 0, marginTop: '3px' }} />
          <div>
            <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
              Agents carrying it out
            </div>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: '2px 0 0' }}>
              The Coordinator, Investor, and Guardrail are reviewing and signing this move under your rules.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
