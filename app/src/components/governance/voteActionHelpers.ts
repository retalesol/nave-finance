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

export function formatFinalizeWindowError(votingEndTimestamp: number): string {
  const secsLeft = votingEndTimestamp - Math.floor(Date.now() / 1000);
  const label = secsLeft > 0
    ? secsLeft > 86400
      ? `${Math.ceil(secsLeft / 86400)}d`
      : `${Math.ceil(secsLeft / 3600)}h`
    : 'shortly';
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
