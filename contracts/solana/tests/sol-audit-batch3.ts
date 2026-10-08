/**
 * Batch 3 — Solana Medium audit remediation coverage.
 *
 * SEC-M2: the DAO creation stake now enforces a meaningful on-chain NAVE floor
 *         (>= 1.0 NAVE) instead of accepting a single base unit.
 * SEC-M3: the ungated "genesis" token mint can be taken at most once per token;
 *         a burn-to-zero can no longer re-open it (persistent latch).
 * SEC-M4: record_bootstrap_usage rejects a direct (non-CPI) founder call.
 * FN-H4:  a proposal whose voting window closes without quorum can be finalized
 *         to Failed (terminal) so locked vote escrows can be released.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  burn,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { NaveTestHarness, VOTE_FOR } from "./helpers/nave-harness";

describe("Batch 3 — Solana medium audit fixes", () => {
  describe("SEC-M2: on-chain DAO creation stake floor", () => {
    it("rejects a stake below the on-chain NAVE minimum and accepts one at/above it", async () => {
      const harness = new NaveTestHarness();
      await harness.ensureGlobalConfig();
      const naveMint = await createMint(
        harness.provider.connection,
        harness.founder,
        harness.founder.publicKey,
        null,
        6
      );
      const ata = await getOrCreateAssociatedTokenAccount(
        harness.provider.connection,
        harness.founder,
        naveMint,
        harness.founder.publicKey
      );
      const { mintTo } = await import("@solana/spl-token");
      await mintTo(
        harness.provider.connection,
        harness.founder,
        naveMint,
        ata.address,
        harness.founder,
        100_000_000n
      );

      const dao = await harness.createDao({
        name: "sec-m2-stake",
        memberCount: 1,
        depositPerMemberUsdc: 100,
        guardianCount: 1,
        guardianThreshold: 1,
      });
      const daoStakeLock = PublicKey.findProgramAddressSync(
        [Buffer.from("dao_stake_lock"), dao.daoRegistry.toBuffer()],
        harness.core.programId
      )[0];
      const stakeEscrow = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_escrow"), dao.daoRegistry.toBuffer()],
        harness.core.programId
      )[0];

      const stakeArgs = (amount: bigint) =>
        harness.core.methods
          .stakeDaoCreation(new anchor.BN(amount.toString()), new anchor.BN(10_000_000))
          .accounts({
            founder: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            naveMint,
            founderNaveAccount: ata.address,
            daoStakeLock,
            stakeEscrow,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          });

      // 999_999 base units < 1.0 NAVE floor (1_000_000) -> rejected.
      await harness.expectError(() => stakeArgs(999_999n).rpc(), "StakeAmountTooLow");

      // Exactly the floor succeeds.
      await stakeArgs(1_000_000n).rpc();
      const lock = await harness.core.account.daoStakeLock.fetch(daoStakeLock);
      assert.equal(lock.lockedAmount.toString(), "1000000");
    });
  });

  describe("SEC-M3: one-time genesis mint latch", () => {
    it("allows a single genesis mint and rejects a re-genesis after burn-to-zero", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sec-m3-genesis",
        memberCount: 1,
        depositPerMemberUsdc: 100,
        guardianCount: 1,
        guardianThreshold: 1,
      });

      // A governance token whose mint authority is the DAO registry PDA, so
      // nave_governance can mint it.
      const govMint = await createMint(
        harness.provider.connection,
        harness.founder,
        dao.daoRegistry, // mint authority = DAO PDA
        null,
        6
      );
      const founderAta = await getOrCreateAssociatedTokenAccount(
        harness.provider.connection,
        harness.founder,
        govMint,
        harness.founder.publicKey
      );

      const tokenRegistry = dao.tokenRegistry;
      const protocolFeeVault = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_fee_vault")],
        harness.core.programId
      )[0];

      // Register the token (initial_supply 0 -> no mint at registration).
      await harness.core.methods
        .registerDaoToken("GovTok", "GOV", 6, false, new anchor.BN(0))
        .accounts({
          authority: harness.founder.publicKey,
          globalConfig: harness.globalConfig,
          daoRegistry: dao.daoRegistry,
          tokenRegistry,
          vaultAuthority: dao.vaultAuthority,
          treasuryVault: dao.treasuryVault,
          destination: founderAta.address,
          protocolFeeVault,
          mint: govMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const genesisRecord = PublicKey.findProgramAddressSync(
        [Buffer.from("token_genesis"), dao.daoRegistry.toBuffer(), govMint.toBuffer()],
        harness.governance.programId
      )[0];

      const mintCall = () =>
        harness.governance.methods
          .mintAdditionalTokens(new anchor.BN(5_000_000))
          .accounts({
            authority: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            tokenRegistry,
            proposal: null,
            genesisRecord,
            mint: govMint,
            destination: founderAta.address,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            naveCoreProgram: harness.core.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          });

      // First mint: supply == 0 and latch unset -> genesis path allowed.
      await mintCall().rpc();
      let supply = (await getMint(harness.provider.connection, govMint)).supply;
      assert.equal(supply.toString(), "5000000", "genesis mint credited supply");
      const rec = await harness.governance.account.tokenGenesisRecord.fetch(genesisRecord);
      assert.isTrue(rec.minted, "genesis latch set after first mint");

      // Founder burns their entire balance back to zero supply.
      await burn(
        harness.provider.connection,
        harness.founder,
        founderAta.address,
        govMint,
        harness.founder,
        5_000_000n
      );
      supply = (await getMint(harness.provider.connection, govMint)).supply;
      assert.equal(supply.toString(), "0", "supply burned back to zero");

      // Re-genesis attempt (still no proposal): latch blocks the ungated path,
      // so it now falls through to the proposal requirement and fails.
      await harness.expectError(() => mintCall().rpc(), "Unauthorized");

      // The PDA-signed mint primitive in nave_core is CPI-only from
      // nave_governance: a direct top-level call must be rejected.
      await harness.expectError(
        () =>
          harness.core.methods
            .mintDaoToken(new anchor.BN(1))
            .accounts({
              instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
              globalConfig: harness.globalConfig,
              daoRegistry: dao.daoRegistry,
              tokenRegistry,
              mint: govMint,
              destination: founderAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc(),
        "Unauthorized"
      );
    });
  });

  describe("SEC-M4: record_bootstrap_usage is CPI-only", () => {
    it("rejects a direct (non-CPI) founder call to record_bootstrap_usage", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sec-m4-bootstrap",
        memberCount: 1,
        depositPerMemberUsdc: 100,
        guardianCount: 1,
        guardianThreshold: 1,
      });

      await harness.expectError(
        () =>
          harness.core.methods
            .recordBootstrapUsage()
            .accounts({
              founder: harness.founder.publicKey,
              daoRegistry: dao.daoRegistry,
              executionProgram: harness.execution.programId,
              instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .rpc(),
        "Unauthorized"
      );

      const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.isFalse(registry.bootstrapUsed, "bootstrap latch must remain unset");
    });
  });

  describe("FN-H4: no-quorum proposals resolve to Failed", () => {
    it("finalizes a closed no-quorum proposal to Failed and releases the vote escrow", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "fn-h4-noquorum",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 1,
        guardianThreshold: 1,
      });

      const { proposal } = await harness.createStrategyProposal(
        dao,
        "no-quorum",
        harness.strategyPayload(harness.kamino.programId, 100n, dao.vaultMint),
        3
      );

      // A single tiny FOR lock — far below the 35% quorum of snapshot supply.
      const member = dao.members[0];
      await harness.lockTokensAndVote(dao, proposal, member, 1n, VOTE_FOR);

      // Pre-fix, finalize reverted QuorumNotMet forever; now it resolves Failed.
      await harness.finalizeProposal(dao, proposal);
      const p = await harness.governance.account.proposal.fetch(proposal);
      assert.equal(p.status, 2, "closed no-quorum proposal must be Failed");

      // The locked escrow can now be released (only requires status != Active).
      const beforeAta = await getAccount(
        harness.provider.connection,
        dao.memberTokenAccounts.get(member.publicKey.toBase58())!
      );
      await harness.releaseVoteEscrows(dao, proposal, [member]);
      const afterAta = await getAccount(
        harness.provider.connection,
        dao.memberTokenAccounts.get(member.publicKey.toBase58())!
      );
      assert.equal(
        (afterAta.amount - beforeAta.amount).toString(),
        "1",
        "released escrow returned the locked token"
      );
    });
  });
});
