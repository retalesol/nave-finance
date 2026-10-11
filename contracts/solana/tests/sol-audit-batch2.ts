/**
 * Batch 2 — Solana High audit remediation coverage.
 *
 * SOL-H1: a founder can no longer neutralize an in-flight guardian M-of-N
 *         safety action by swapping guardians mid-accumulation; the action's
 *         signer set is snapshotted at open and enforced from the snapshot.
 * SOL-H2: `nullify_agent` is now a guardian M-of-N action, so a single
 *         (compromised) Executive can no longer unilaterally freeze the DAO.
 * SEC-H4: `jupiter_swap` rejects any forwarded route account that is a
 *         vault_authority-owned token account other than the bound source /
 *         destination.
 * SOL-H3 (partial): `jupiter_deposit` refuses to deploy below the configured
 *         agent operating threshold (NAV-freshness gate shares the same code
 *         path). Full pipeline routing is flagged as residual in the PR.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import { NaveTestHarness, VOTE_FOR } from "./helpers/nave-harness";

const JUPITER_SWAP_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

describe("Batch 2 — Solana high audit fixes", () => {
  describe("SOL-H1: guardian action signer set is snapshotted at open", () => {
    it("a mid-accumulation guardian-config swap cannot neutralize an in-flight freeze", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-h1-snapshot",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 2,
        guardianThreshold: 2,
      });

      const nonce = 1;
      // Guardian 0 opens the freeze (1 of 2 signatures — not yet executed).
      await harness.guardianEmergencyFreeze(dao, nonce, [dao.guardians[0]]);
      let registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.isFalse(registry.frozen, "one signature must not freeze a 2-of-2 DAO");

      // Founder swaps in an entirely new guardian set, trying to strand the
      // in-flight action.
      const newGuardians = [Keypair.generate(), Keypair.generate()];
      await harness.core.methods
        .updateGuardianConfig(newGuardians.map((g) => g.publicKey), 2)
        .accounts({
          authority: harness.founder.publicKey,
          globalConfig: harness.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
        })
        .rpc();

      // A brand-new guardian (not in the action's snapshot) cannot push the
      // in-flight action forward.
      await harness.airdrop(newGuardians[0].publicKey, 0.05);
      await harness.expectError(
        () => harness.guardianEmergencyFreeze(dao, nonce, [newGuardians[0]]),
        "GuardianNotFound"
      );

      // The ORIGINAL second guardian — removed from the live config but present
      // in the action snapshot — completes the freeze. Pre-fix this reverted
      // (live-config re-check), permanently neutralizing the action.
      await harness.guardianEmergencyFreeze(dao, nonce, [dao.guardians[1]]);
      registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.isTrue(registry.frozen, "original snapshot guardian must still complete the freeze");
    });
  });

  describe("SOL-H2: nullify_agent is guardian M-of-N gated", () => {
    it("rejects a single Executive-agent nullify and requires guardian threshold", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-h2-nullify",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 2,
        guardianThreshold: 2,
      });
      await harness.enableAgents(dao);

      // The Executive agent (agents[0]) is not a guardian, so it can no longer
      // nullify an agent / freeze the DAO on its own signature.
      await harness.airdrop(dao.agents[0].publicKey, 0.05);
      const nonce = 7;
      const guardianAction = harness.guardianActionPda(dao, 5, [Buffer.from([1])], nonce);
      await harness.expectError(
        () =>
          harness.core.methods
            .nullifyAgent(1, new anchor.BN(nonce))
            .accounts({
              guardian: dao.agents[0].publicKey,
              globalConfig: harness.globalConfig,
              daoRegistry: dao.daoRegistry,
              guardianConfig: dao.guardianConfig,
              guardianAction,
              agentSet: dao.agentSet,
              systemProgram: SystemProgram.programId,
            })
            .signers([dao.agents[0]])
            .rpc(),
        "GuardianNotFound"
      );

      let registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.isFalse(registry.frozen, "rogue Executive must not have frozen the DAO");

      // One guardian (below the 2-of-2 threshold) records a signature but does
      // not execute.
      await harness.guardianNullifyAgent(dao, 1, nonce, [dao.guardians[0]]);
      registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.isFalse(registry.frozen, "one guardian signature must not nullify/freeze");

      // The threshold guardian completes it: agent nullified + DAO frozen.
      await harness.guardianNullifyAgent(dao, 1, nonce, [dao.guardians[1]]);
      registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.isTrue(registry.frozen, "guardian M-of-N nullify must freeze the DAO");
      const agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
      assert.isTrue(agentSet.agents[1].nullified, "Financial agent slot must be nullified");
    });
  });

  describe("SEC-H4: jupiter_swap route-account containment", () => {
    it("rejects a route that references a foreign vault-owned token account", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sec-h4-route",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 1,
        guardianThreshold: 1,
      });
      await harness.enableAgents(dao);

      // Swap destination asset.
      const mintOut = await createMint(
        harness.provider.connection,
        harness.founder,
        harness.founder.publicKey,
        null,
        6
      );
      // A THIRD registered asset whose vault_authority-owned asset_vault will be
      // smuggled into the route accounts.
      const foreignMint = await createMint(
        harness.provider.connection,
        harness.founder,
        harness.founder.publicKey,
        null,
        6
      );

      for (const m of [mintOut, foreignMint]) {
        await harness.core.methods
          .registerAsset(new Array(32).fill(0), true, 0)
          .accounts({
            authority: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            mint: m,
            vaultAuthority: dao.vaultAuthority,
            treasuryVault: dao.treasuryVault,
            assetConfig: harness.assetConfigPda(dao.daoRegistry, m),
            treasuryAsset: harness.treasuryAssetPda(dao.daoRegistry, m),
            assetVault: harness.assetVaultPda(dao.daoRegistry, m),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
      }

      const foreignAssetVault = harness.assetVaultPda(dao.daoRegistry, foreignMint);
      const operational = dao.agents[3];

      const jupiterSwapAccounts = {
        operationalAgent: operational.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        constitution: dao.constitution,
        vaultAuthority: dao.vaultAuthority,
        treasuryVault: dao.treasuryVault,
        mintIn: dao.vaultMint,
        mintOut,
        assetConfigIn: harness.assetConfigPda(dao.daoRegistry, dao.vaultMint),
        assetConfigOut: harness.assetConfigPda(dao.daoRegistry, mintOut),
        treasuryAssetIn: harness.treasuryAssetPda(dao.daoRegistry, dao.vaultMint),
        treasuryAssetOut: harness.treasuryAssetPda(dao.daoRegistry, mintOut),
        sourceTokenAccount: harness.assetVaultPda(dao.daoRegistry, dao.vaultMint),
        destinationTokenAccount: harness.assetVaultPda(dao.daoRegistry, mintOut),
        jupiterProgram: JUPITER_SWAP_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any;

      const expectedOut = new anchor.BN(1_000_000);
      const compliantMinOut = new anchor.BN(995_000); // within the 150 bps default cap
      const amountIn = new anchor.BN(1_000); // tiny; well under the size cap

      await harness.expectError(
        () =>
          harness.core.methods
            .jupiterSwap(amountIn, compliantMinOut, expectedOut, Buffer.alloc(0))
            .accounts(jupiterSwapAccounts)
            .remainingAccounts([
              { pubkey: foreignAssetVault, isWritable: true, isSigner: false },
            ])
            .signers([operational])
            .rpc(),
        "RouteAccountNotAllowed"
      );
    });
  });

  describe("SOL-H3 (partial): jupiter_deposit deploy gate", () => {
    it("refuses to deploy when treasury NAV is below the agent operating threshold", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-h3-gate",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 1,
        guardianThreshold: 1,
      });
      await harness.enableAgents(dao);

      // Raise the agent operating threshold far above the DAO's NAV so the
      // deploy gate must reject (fresh NAV, but under threshold).
      await harness.core.methods
        .updateConstitution(
          [
            {
              protocolId: "kamino",
              programId: harness.kamino.programId,
              maxAllocationBps: 4000,
              approved: true,
            },
          ],
          null,
          new anchor.BN("1000000000000") // $1,000,000 threshold (micro-USD)
        )
        .accounts({
          authority: harness.founder.publicKey,
          globalConfig: harness.globalConfig,
          daoRegistry: dao.daoRegistry,
          constitution: dao.constitution,
        })
        .rpc();

      // Provision the Jupiter strategy position (founder-gated).
      await harness.core.methods
        .initStrategyPosition("jupiter")
        .accounts({
          authority: harness.founder.publicKey,
          globalConfig: harness.globalConfig,
          daoRegistry: dao.daoRegistry,
          mint: dao.vaultMint,
          strategyPosition: harness.strategyPositionPda(dao.daoRegistry, "jupiter", dao.vaultMint),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await harness.initStrategyEscrow(dao, "jupiter");

      const fTokenMint = await createMint(
        harness.provider.connection,
        harness.founder,
        harness.founder.publicKey,
        null,
        6
      );
      const operational = dao.agents[3];
      await harness.airdrop(operational.publicKey, 0.1);

      const dummy = () => Keypair.generate().publicKey;
      await harness.expectError(
        () =>
          harness.core.methods
            .jupiterDeposit(new anchor.BN(1))
            .accounts({
              authority: operational.publicKey,
              globalConfig: harness.globalConfig,
              daoRegistry: dao.daoRegistry,
              agentSet: dao.agentSet,
              constitution: dao.constitution,
              treasuryVault: dao.treasuryVault,
              mint: dao.vaultMint,
              fTokenMint,
              vaultAuthority: dao.vaultAuthority,
              strategyPosition: harness.strategyPositionPda(dao.daoRegistry, "jupiter", dao.vaultMint),
              depositorTokenAccount: getAssociatedTokenAddressSync(dao.vaultMint, dao.vaultAuthority, true),
              recipientTokenAccount: getAssociatedTokenAddressSync(fTokenMint, dao.vaultAuthority, true),
              jupiterLendingProgram: dummy(),
              lendingAdmin: dummy(),
              lending: dummy(),
              supplyTokenReservesLiquidity: dummy(),
              lendingSupplyPositionOnLiquidity: dummy(),
              rateModel: dummy(),
              vault: dummy(),
              liquidity: dummy(),
              liquidityProgram: dummy(),
              rewardsRateModel: dummy(),
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([operational])
            .rpc(),
        "AgentThresholdNotMet"
      );
    });
  });
});
