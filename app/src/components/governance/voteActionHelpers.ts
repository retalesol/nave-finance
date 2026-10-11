/** Pure helpers shared by vote/finalize handlers in ProposalCard. */

export type VoteChoice = 'for' | 'against' | 'abstain';

export function isAlreadyVotedError(errLower: string): boolean {
  return (
    errLower.includes('already') ||
    errLower.includes('duplicate') ||
    errLower.includes('vote_already_cast') ||
    errLower.includes('guardianduplicatesig') ||
    errLower.includes('double')
  );
}

export function formatVoteSubmissionError(rawErr: string): string {
  const errLower = rawErr.toLowerCase();
  if (errLower.includes('guardian') && !errLower.includes('already')) {
    return 'Vote failed — the connected wallet is not a guardian of this DAO. Connect a guardian wallet to vote.';
  }
  if (errLower.includes('not active') || errLower.includes('voting_closed')) {
    return 'Voting on this proposal has closed.';
  }
  return rawErr;
}

/** Remaining vote time. Sub-day windows stay in hours or minutes so a 60s testnet vote is not shown as 1 day. */
export function formatVotingTimeLeft(secsLeft: number): string {
  if (!(secsLeft > 0)) return 'Ended';
  if (secsLeft >= 86_400) return `${Math.ceil(secsLeft / 86_400)}d`;
  if (secsLeft >= 3_600) return `${Math.ceil(secsLeft / 3_600)}h`;
  if (secsLeft >= 60) return `${Math.ceil(secsLeft / 60)}m`;
  return `${Math.ceil(secsLeft)}s`;
}

export function formatFinalizeWindowError(votingEndTimestamp: number): string {
  const secsLeft = votingEndTimestamp - Math.floor(Date.now() / 1000);
  const label = secsLeft > 0 ? formatVotingTimeLeft(secsLeft) : 'shortly';
  return `Not enough yes votes to close early. Another guardian can vote, or wait about ${label} for the voting window to end.`;
}

export function classifyFinalizeSimulationError(errorLine: string): string | null {
  if (errorLine.includes('VotingPeriodNotEnded')) {
    return 'Voting window is still open — finalize will unlock once voting ends or the outcome is certain.';
  }
  if (errorLine.includes('ProposalNotActive')) {
    return 'This proposal has already been finalized or cancelled.';
  }
  if (errorLine.includes('QuorumNotMet')) {
    return 'Quorum has not been reached yet.';
  }
  return null;
}

export function formatFinalizeSubmissionError(err: string): string {
  if (err.includes('VotingPeriodNotEnded') || err.includes('VotingStillOpen') || err.toLowerCase().includes('still open')) {
    return 'Not enough yes votes to close early. Another guardian can vote, or wait until the voting window ends.';
  }
  if (err.includes('ProposalNotActive') || err.toLowerCase().includes('not active')) {
    return 'This proposal has already been finalized.';
  }
  return err;
}
