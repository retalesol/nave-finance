import { NATIVE_MINT } from '@solana/spl-token';
import Fi from '@/components/Fi';
import { MARGINFI_STRATEGY_ENABLED } from '@/lib/programConfig';
import { type Proposal } from './types';
import { hasStoredStrategyPayload } from './proposalStorage';

export function ProposalExecutePanels({
  proposal,
  daoAddress,
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
  createReqAmount,
  setCreateReqAmount,
  createReqProtocol,
  setCreateReqProtocol,
  createReqAssetMint,
  setCreateReqAssetMint,
  registeredTreasuryAssets,
  votingMint,
  creatingReq,
  voteError,
  navigate,
  onRatifyConstitution,
  onExecuteEnableAgents,
  onRatifyTokenMint,
  onExecuteTreasuryTransfer,
  onExecutePermission,
  onExecuteSwitchVotingSystem,
  onClearProposalHalt,
  onCreateExecutionRequest,
}: {
  proposal: Proposal;
  daoAddress: string | null;
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
  createReqAmount: string;
  setCreateReqAmount: (v: string) => void;
  createReqProtocol: 'kamino' | 'jito' | 'marginfi' | 'jupiter';
  setCreateReqProtocol: (v: 'kamino' | 'jito' | 'marginfi' | 'jupiter') => void;
  createReqAssetMint: string;
  setCreateReqAssetMint: (v: string) => void;
  registeredTreasuryAssets: Array<{ mint: string; symbol: string }>;
  votingMint: string | null;
  creatingReq: boolean;
  voteError: string | null;
  navigate: (p: string) => void;
  onRatifyConstitution: () => void;
  onExecuteEnableAgents: () => void;
  onRatifyTokenMint: () => void;
  onExecuteTreasuryTransfer: () => void;
  onExecutePermission: () => void;
  onExecuteSwitchVotingSystem: () => void;
  onClearProposalHalt: () => void;
  onCreateExecutionRequest: () => void;
}) {
  const blockStyle = {
    padding: '14px 0',
    borderTop: '1px solid hsl(var(--surface-2))',
    borderBottom: '1px solid hsl(var(--surface-2))',
  };

  return (
    <>
      {/* Ratify a passed constitution (policy) proposal — founder applies it on-chain */}
      {proposal.status === 'passed' && proposal.type === 'policy' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Ratify Constitution
          </div>
          {alreadyRatified ? (
            <div className="space-y-2.5">
              <div
                className="flex items-start gap-2"
                style={{ fontSize: '13px', color: '#2F7D4F', lineHeight: 1.5 }}
              >
                <Fi icon="circle-check" style={{ fontSize: '12px', flexShrink: 0, marginTop: '3px' }} />
                <span>
                  <strong>Constitution applied on-chain.</strong> Your agents are ready — go to the Agent page and click <strong>Propose to Enable Agents</strong> to put resuming them to a DAO vote.
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate('/agents');
                }}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                style={{ fontSize: '13px', backgroundColor: '#111827', color: '#ffffff' }}
              >
                <Fi icon="scale-balanced" style={{ fontSize: '10px' }} />
                Propose to Enable Agents →
              </button>
            </div>
          ) : (
            <>
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
                Apply this approved policy to the treasury constitution on-chain. Once ratified, go to the <strong>Agent page</strong> and click <strong>Propose to Enable Agents</strong> to put resuming them to a DAO vote, after which the agents operate under these constraints.
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
                  {ratifying ? 'Ratifying…' : 'Ratify & apply constitution'}
                </button>
              ) : (
                <div
                  className="flex items-center gap-2"
                  style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
                >
                  <Fi icon="circle-info" style={{ fontSize: '11px' }} />
                  Awaiting founder ratification to apply this constitution on-chain.
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

      {/* Execute a passed agent-enable proposal — founder resumes the agents on-chain */}
      {proposal.status === 'passed' && proposal.type === 'agent-enable' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Execute: Enable Agents
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This proposal passed. Executing reconnects this DAO to the four autonomous agents (Executive, Financial, Operational, Oversight), which will resume checking the treasury for necessary actions under the current constitution.
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
              {enabling ? 'Enabling…' : 'Execute: Enable Agents'}
            </button>
          ) : (
            <div className="flex items-center gap-2" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              <Fi icon="circle-info" style={{ fontSize: '11px' }} />
              Awaiting founder to execute and resume the agents on-chain.
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

      {/* Ratify a passed token-mint proposal — founder executes the on-chain mint */}
      {proposal.status === 'passed' && proposal.type === 'token-mint' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Execute Token Mint
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This proposal passed. Executing will mint the approved token amount into the treasury vault on-chain.
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
              {ratifying ? 'Minting…' : 'Execute Mint'}
            </button>
          ) : (
            <div className="flex items-center gap-2" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              <Fi icon="circle-info" style={{ fontSize: '11px' }} />
              Awaiting founder to execute this mint on-chain.
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

      {/* Passed treasury transfer — direct execution (no agent execution pipeline) */}
      {proposal.status === 'passed' && proposal.type === 'transfer' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Execute treasury transfer
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            {chainKind === 'evm'
              ? 'This proposal passed. The governor only stores a hash on-chain — execution needs the raw recipient/asset/amount from when the proposal was created (saved in this browser).'
              : 'This proposal passed. Execution moves native SOL from the vault authority PDA, or SPL from the DAO asset vault to the recipient ATA in the exact amounts fixed when the proposal was created.'}
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
            {executingTransfer ? 'Executing…' : 'Execute transfer'}
          </button>
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Passed Permission — apply guardian set via governor */}
      {proposal.status === 'passed' && proposal.type === 'permission' && chainKind === 'evm' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Apply guardian config
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            Calls <code>executePermissionProposal</code>, which applies wallets + threshold through
            the treasury governor path (<code>applyGuardianConfigFromGovernor</code>).
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
            {executingPermission ? 'Applying…' : 'Execute permission proposal'}
          </button>
          {voteError && (
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
              <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
              {voteError}
            </div>
          )}
        </div>
      )}

      {/* Ratify a passed switch-voting proposal — execute the governance change on-chain */}
      {proposal.status === 'passed' && proposal.type === 'switch-voting' && (
        <div className="space-y-3" style={blockStyle}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Apply Voting System Change
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This proposal passed. Execute the voting system switch on-chain to transition this DAO&apos;s governance model.
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
            {executingSwitchVoting ? 'Switching…' : 'Execute voting system switch'}
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
            Execution Request Halted
          </div>
          <p style={{ fontSize: '13px', color: 'hsl(var(--destructive))', lineHeight: 1.55, margin: 0 }}>
            {haltedEr.reason || 'This execution request is currently halted by the Oversight agent.'}
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

      {/* Strategy execution — auto-chained or manual fallback */}
      {proposal.status === 'passed' && proposal.type === 'strategy' && (
        hasStoredStrategyPayload(daoAddress, proposal.number) ? (
          <div className="flex items-start gap-2.5" style={blockStyle}>
            <Fi icon="clock" style={{ fontSize: '13px', color: '#B9974F', flexShrink: 0, marginTop: '3px' }} />
            <div>
              <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                Queued for Agent Review
              </div>
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: '2px 0 0' }}>
                This strategy is queued for agent review. The approval pipeline will execute it once the review window elapses.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3" style={blockStyle}>
            <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
              Move Passed Strategy to Execution
            </div>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
              Create an execution request so the agent approval pipeline can review, sign, and execute this proposal.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <input
                type="number"
                min="0"
                step="any"
                value={createReqAmount}
                onChange={(e) => setCreateReqAmount(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="px-3 py-2 rounded-[10px] border"
                style={{
                  fontSize: '12.5px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              />
              <select
                value={createReqProtocol}
                onChange={(e) => setCreateReqProtocol(e.target.value as 'kamino' | 'jito' | 'marginfi' | 'jupiter')}
                onClick={(e) => e.stopPropagation()}
                className="px-3 py-2 rounded-[10px] border"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              >
                <option value="kamino">Kamino</option>
                <option value="jito">Jito</option>
                <option value="jupiter">Jupiter</option>
                {MARGINFI_STRATEGY_ENABLED && <option value="marginfi">Marginfi</option>}
              </select>
              <select
                value={createReqAssetMint}
                onChange={(e) => setCreateReqAssetMint(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="px-3 py-2 rounded-[10px] border"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              >
                {registeredTreasuryAssets.length > 0 ? (
                  registeredTreasuryAssets.map((a) => (
                    <option key={a.mint} value={a.mint}>
                      {a.symbol}
                    </option>
                  ))
                ) : (
                  <option value={votingMint ?? NATIVE_MINT.toBase58()}>
                    {votingMint ? `${votingMint.slice(0, 6)}…` : 'wSOL'}
                  </option>
                )}
              </select>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateExecutionRequest();
                }}
                disabled={creatingReq || !isMember}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[9px] font-semibold"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: '#111827',
                  color: '#ffffff',
                  opacity: creatingReq || !isMember ? 0.6 : 1,
                }}
              >
                <Fi icon={creatingReq ? 'arrows-rotate' : 'bolt'} style={{ fontSize: '11px' }} className={creatingReq ? 'animate-spin' : ''} />
                {creatingReq ? 'Creating…' : 'Create request'}
              </button>
            </div>
          </div>
        )
      )}
    </>
  );
}
