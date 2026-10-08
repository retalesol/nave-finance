import { assert } from "chai";
import {
  DAO_PRESETS,
  buildEqualMemberVotes,
  minParticipantsForQuorum,
  proposalPasses,
  meetsQuorum,
  requiredQuorumWeight,
  QUORUM_BPS,
} from "./helpers/governance-math";

describe("governance quorum math (35% participation, majority of quorum)", () => {
  it("calculates 35% quorum for varied community sizes", () => {
    assert.equal(minParticipantsForQuorum(3), 1);
    assert.equal(minParticipantsForQuorum(5), 1);
    assert.equal(minParticipantsForQuorum(20), 7);
    assert.equal(minParticipantsForQuorum(50), 17);
    assert.equal(minParticipantsForQuorum(100), 35);
  });

  it("passes when quorum met and for-votes exceed against-votes", () => {
    const supply = 20n;
    const tally = buildEqualMemberVotes(20, 8, 0, 12);
    assert.isTrue(meetsQuorum(supply, tally));
    assert.isTrue(proposalPasses(supply, tally));
  });

  it("fails when participation below 35% quorum", () => {
    const supply = 20n;
    const tally = buildEqualMemberVotes(20, 6, 0, 14);
    assert.isFalse(meetsQuorum(supply, tally));
    assert.isFalse(proposalPasses(supply, tally));
  });

  it("fails when quorum met but against votes win majority among participants", () => {
    const supply = 20n;
    const tally = buildEqualMemberVotes(20, 4, 8, 8);
    assert.isTrue(meetsQuorum(supply, tally));
    assert.isFalse(proposalPasses(supply, tally));
  });

  it("fails on tie among participating voters even with quorum", () => {
    const supply = 20n;
    const tally = buildEqualMemberVotes(20, 7, 7, 6);
    assert.isTrue(meetsQuorum(supply, tally));
    assert.isFalse(proposalPasses(supply, tally));
  });

  it("abstain votes do not count toward quorum participation", () => {
    const supply = 20n;
    const onlyAbstain = buildEqualMemberVotes(20, 0, 0, 20);
    assert.isFalse(meetsQuorum(supply, onlyAbstain));
    assert.equal(requiredQuorumWeight(supply, QUORUM_BPS), 7n);
  });

  describe("DAO preset matrix", () => {
    for (const preset of DAO_PRESETS) {
      it(`${preset.label}: needs ${minParticipantsForQuorum(preset.members)} of ${preset.members} voters`, () => {
        const min = minParticipantsForQuorum(preset.members);
        const passing = buildEqualMemberVotes(preset.members, min, 0, preset.members - min);
        assert.isTrue(proposalPasses(BigInt(preset.members), passing));

        const oneShort = buildEqualMemberVotes(preset.members, min - 1, 0, preset.members - min + 1);
        if (min > 1) {
          assert.isFalse(proposalPasses(BigInt(preset.members), oneShort));
        }
      });
    }
  });
});
