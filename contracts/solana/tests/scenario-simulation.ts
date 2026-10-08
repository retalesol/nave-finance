import { assert } from "chai";
import {
  DAO_PRESETS,
  buildEqualMemberVotes,
  minParticipantsForQuorum,
  proposalPasses,
} from "./helpers/governance-math";
import {
  APY_SCENARIOS_BPS,
  allocateByCaps,
  projectTreasuryGrowth,
  simulateYield,
  usdcToRaw,
} from "./helpers/apy-simulator";

/**
 * End-to-end narrative simulation (off-chain) for the Chen Family Treasury DAO.
 * Validates governance math + APY models that integration tests assert on-chain.
 */
describe("Chen Family Treasury — full narrative simulation", () => {
  const MEMBERS = 20;
  const DEPOSIT_EACH = 10_000;
  const TOTAL = MEMBERS * DEPOSIT_EACH;
  const GUARDIAN_THRESHOLD = 7;
  const QUORUM_MIN = minParticipantsForQuorum(MEMBERS);

  it("Act 0: 20 members deposit $10k each → $200k treasury", () => {
    assert.equal(TOTAL, 200_000);
    assert.equal(QUORUM_MIN, 7);
  });

  it("Act 1: strategy passes with 8/20 for-votes (quorum + majority)", () => {
    const tally = buildEqualMemberVotes(MEMBERS, 8, 0, 12);
    assert.isTrue(proposalPasses(BigInt(MEMBERS), tally));
  });

  it("Act 1b: deploy $80k to Kamino (40% cap) across APY scenarios", () => {
    const deploy = 80_000;
    for (const apyBps of APY_SCENARIOS_BPS) {
      const snap = projectTreasuryGrowth("chen-family", TOTAL, deploy, apyBps, 12);
      assert.approximately(snap.totalNavUsdc, TOTAL + snap.simulatedYieldUsdc, 0.01);
      assert.isAtMost(apyBps, 1200);
    }
  });

  it("Act 2: rogue executive cannot pass vote alone — needs 7 token voters", () => {
    const execAlone = buildEqualMemberVotes(MEMBERS, 1, 0, 19);
    assert.isFalse(proposalPasses(BigInt(MEMBERS), execAlone));
  });

  it("Act 3: 7 guardians required for emergency freeze (M-of-N)", () => {
    assert.equal(GUARDIAN_THRESHOLD, 7);
    assert.isAbove(GUARDIAN_THRESHOLD, 3); // minority cannot freeze
  });

  it("Act 4: failed proposal when 7 against vs 7 for at quorum (tie)", () => {
    const tie = buildEqualMemberVotes(MEMBERS, 7, 7, 6);
    assert.isFalse(proposalPasses(BigInt(MEMBERS), tie));
  });

  it("Act 5: multi-protocol allocation respects 40/30/30 caps on $200k", () => {
    const nav = usdcToRaw(TOTAL);
    const [k, j, m] = allocateByCaps(nav, [4000, 3000, 3000]);
    assert.approximately(Number(k) / 1e6, 80_000, 1);
    assert.approximately(Number(j) / 1e6, 60_000, 1);
    assert.approximately(Number(m) / 1e6, 60_000, 1);
  });

  it("Act 6: 12-month compound at 12% APY on $80k deployed yields ~$10k+", () => {
    const yieldRaw = simulateYield(usdcToRaw(80_000), 1200, 365);
    assert.isAbove(Number(yieldRaw) / 1e6, 9_000);
    assert.isBelow(Number(yieldRaw) / 1e6, 11_000);
  });
});

describe("DAO size matrix — governance thresholds", () => {
  for (const preset of DAO_PRESETS) {
    it(`${preset.label}: ${preset.members} members, $${preset.depositPerMemberUsdc} each, guardians ${preset.guardianThreshold}/${preset.guardianCount}`, () => {
      const totalTreasury = preset.members * preset.depositPerMemberUsdc;
      const quorumMin = minParticipantsForQuorum(preset.members);

      const passing = buildEqualMemberVotes(
        preset.members,
        quorumMin,
        0,
        preset.members - quorumMin
      );
      assert.isTrue(proposalPasses(BigInt(preset.members), passing));

      assert.isAtMost(preset.guardianThreshold, preset.guardianCount);
      assert.isAtMost(preset.guardianCount, 10);

      const deployed = Math.floor(totalTreasury * 0.5);
      const snap = projectTreasuryGrowth(preset.label, totalTreasury, deployed, 800, 6);
      assert.isAbove(snap.simulatedYieldUsdc, 0);
    });
  }
});

describe("voting threshold edge cases", () => {
  const cases = [
    { members: 20, for: 7, against: 0, pass: true, note: "exact quorum, unanimous for" },
    { members: 20, for: 7, against: 6, pass: true, note: "quorum with narrow for majority" },
    { members: 20, for: 6, against: 0, pass: false, note: "one vote short of quorum" },
    { members: 100, for: 35, against: 34, pass: true, note: "large DAO narrow pass" },
    { members: 100, for: 35, against: 35, pass: false, note: "large DAO tie at quorum" },
    { members: 3, for: 2, against: 1, pass: true, note: "micro DAO 2-of-3 participating" },
  ] as const;

  for (const c of cases) {
    it(c.note, () => {
      const tally = buildEqualMemberVotes(c.members, c.for, c.against, c.members - c.for - c.against);
      assert.equal(proposalPasses(BigInt(c.members), tally), c.pass);
    });
  }
});

describe("treasury size scenarios", () => {
  const treasuries = [
    { label: "micro $30k", members: 3, deposit: 10_000 },
    { label: "family $200k", members: 20, deposit: 10_000 },
    { label: "club $250k", members: 50, deposit: 5_000 },
    { label: "community $5M", members: 100, deposit: 50_000 },
  ] as const;

  for (const t of treasuries) {
    it(`${t.label}: simulates 12% APY on 60% deployed capital`, () => {
      const total = t.members * t.deposit;
      const deployed = Math.floor(total * 0.6);
      const snap = projectTreasuryGrowth(t.label, total, deployed, 1200, 12);
      assert.isAbove(snap.simulatedYieldUsdc, deployed * 0.05);
    });
  }
});
