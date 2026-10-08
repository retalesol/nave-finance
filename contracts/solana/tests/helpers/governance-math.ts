/** Governance math aligned with on-chain finalize_proposal rules. */

export const QUORUM_BPS = 3500; // 35% of snapshot supply must participate
export const BPS_DENOMINATOR = 10_000;

export enum VoteChoice {
  For = 0,
  Against = 1,
  Abstain = 2,
}

export interface VoteTally {
  for: bigint;
  against: bigint;
  abstain: bigint;
}

export function requiredQuorumWeight(snapshotSupply: bigint, quorumBps = QUORUM_BPS): bigint {
  return (snapshotSupply * BigInt(quorumBps)) / BigInt(BPS_DENOMINATOR);
}

export function minParticipantsForQuorum(
  totalParticipants: number,
  quorumBps = QUORUM_BPS
): number {
  return Number(requiredQuorumWeight(BigInt(totalParticipants), quorumBps));
}

/** Participation = for + against (abstain does not count toward quorum on-chain). */
export function participatingWeight(tally: VoteTally): bigint {
  return tally.for + tally.against;
}

export function meetsQuorum(snapshotSupply: bigint, tally: VoteTally, quorumBps = QUORUM_BPS): boolean {
  return participatingWeight(tally) >= requiredQuorumWeight(snapshotSupply, quorumBps);
}

/** On-chain: passed when votes_for > votes_against after quorum is met. */
export function proposalPasses(snapshotSupply: bigint, tally: VoteTally, quorumBps = QUORUM_BPS): boolean {
  if (!meetsQuorum(snapshotSupply, tally, quorumBps)) return false;
  return tally.for > tally.against;
}

export function majorityAmongParticipants(tally: VoteTally): "for" | "against" | "tie" {
  if (tally.for > tally.against) return "for";
  if (tally.against > tally.for) return "against";
  return "tie";
}

/** Build token-weighted vote plan: equal 1-token holders, `forCount` vote for, rest abstain or against. */
export function buildEqualMemberVotes(
  memberCount: number,
  forCount: number,
  againstCount: number,
  abstainCount: number
): VoteTally {
  if (forCount + againstCount + abstainCount > memberCount) {
    throw new Error("vote counts exceed member count");
  }
  return {
    for: BigInt(forCount),
    against: BigInt(againstCount),
    abstain: BigInt(abstainCount),
  };
}

export interface DaoSizePreset {
  label: string;
  members: number;
  depositPerMemberUsdc: number;
  guardianCount: number;
  guardianThreshold: number;
}

export const DAO_PRESETS: DaoSizePreset[] = [
  {
    label: "micro-cooperative",
    members: 3,
    depositPerMemberUsdc: 10_000,
    guardianCount: 2,
    guardianThreshold: 2,
  },
  {
    label: "small-family",
    members: 5,
    depositPerMemberUsdc: 10_000,
    guardianCount: 3,
    guardianThreshold: 2,
  },
  {
    label: "chen-family-20",
    members: 20,
    depositPerMemberUsdc: 10_000,
    guardianCount: 7,
    guardianThreshold: 7,
  },
  {
    label: "mid-size-club",
    members: 50,
    depositPerMemberUsdc: 5_000,
    guardianCount: 7,
    guardianThreshold: 5,
  },
  {
    label: "large-community",
    members: 100,
    depositPerMemberUsdc: 50_000,
    guardianCount: 10,
    guardianThreshold: 7,
  },
];
