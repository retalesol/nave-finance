import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

import { NaveTestHarness } from "./helpers/nave-harness";

/**
 * Phase 3 (DAO creation NAVE stake escrow) + Phase 5 (moonlighting lifecycle)
 * focused tests. Creation is fee-free; the founder locks a recoverable
 * `$99`-of-NAVE stake into a per-DAO escrow, and the moonlight lifecycle is
 * bound to passed governance proposals.
 *
 * Run on localnet via `anchor test`. These exercise the new `stake_dao_creation`
 * and moonlight instructions added to nave_core.
 */
describe("dao stake + moonlighting", () => {
  let harness: NaveTestHarness;
  const DECIMALS = 6;
  const STAKE = 9_900_000n; // 9.9 NAVE @ 6 decimals ($99 at $10 devnet price)
  const PRICE_USD_MICRO = 10_000_000n; // $10

  let naveMint: PublicKey;
  let founderNaveAta: PublicKey;

  function stakeLockPda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dao_stake_lock"), daoRegistry.toBuffer()],
      harness.core.programId,
    )[0];
  }
  function stakeEscrowPda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("stake_escrow"), daoRegistry.toBuffer()],
      harness.core.programId,
    )[0];
  }
  function lifecyclePda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dao_lifecycle"), daoRegistry.toBuffer()],
      harness.core.programId,
    )[0];
  }

  before(async () => {
    harness = new NaveTestHarness();
    await harness.ensureGlobalConfig();
    // A dedicated NAVE replica mint (founder is mint authority for the test).
    naveMint = await createMint(
      harness.provider.connection,
      harness.founder,
      harness.founder.publicKey,
      null,
      DECIMALS,
    );
    const ata = await getOrCreateAssociatedTokenAccount(
      harness.provider.connection,
      harness.founder,
      naveMint,
      harness.founder.publicKey,
    );
    founderNaveAta = ata.address;
    await mintTo(
      harness.provider.connection,
      harness.founder,
      naveMint,
      founderNaveAta,
      harness.founder,
      1_000_000_000n, // 1000 NAVE
    );
  });

  it("locks the NAVE creation stake into escrow (fee-free creation)", async () => {
    const dao = await harness.createDao({
      name: "Stake DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1,
    });

    const daoStakeLock = stakeLockPda(dao.daoRegistry);
    const stakeEscrow = stakeEscrowPda(dao.daoRegistry);

    await harness.core.methods
      .stakeDaoCreation(new anchor.BN(STAKE.toString()), new anchor.BN(PRICE_USD_MICRO.toString()))
      .accounts({
        founder: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        naveMint,
        founderNaveAccount: founderNaveAta,
        daoStakeLock,
        stakeEscrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const lock = await harness.core.account.daoStakeLock.fetch(daoStakeLock);
    assert.equal(lock.lockedAmount.toString(), STAKE.toString());
    assert.equal(lock.status, 0, "stake status Locked");
    assert.isFalse(lock.unlockEligible);
    assert.equal(lock.naveMint.toBase58(), naveMint.toBase58());

    const escrow = await getAccount(harness.provider.connection, stakeEscrow);
    assert.equal(escrow.amount.toString(), STAKE.toString(), "escrow holds the stake");
  });

  it("rejects a zero-amount stake (StakeAmountTooLow)", async () => {
    const dao = await harness.createDao({
      name: "Zero Stake DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1,
    });

    await harness.expectError(
      () =>
        harness.core.methods
          .stakeDaoCreation(new anchor.BN(0), new anchor.BN(0))
          .accounts({
            founder: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            naveMint,
            founderNaveAccount: founderNaveAta,
            daoStakeLock: stakeLockPda(dao.daoRegistry),
            stakeEscrow: stakeEscrowPda(dao.daoRegistry),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc(),
      "StakeAmountTooLow",
    );
  });

  it("record_moonlight_request requires a passed MoonlightRequest proposal", async () => {
    const dao = await harness.createDao({
      name: "Moonlight DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1,
    });

    // Pass a bogus (non-governance) account as the request proposal: the handler
    // must reject it because it is not owned by nave_governance / not a passed
    // MoonlightRequest.
    const bogusProposal = Keypair.generate().publicKey;
    await harness.expectError(
      () =>
        harness.core.methods
          .recordMoonlightRequest()
          .accounts({
            founder: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            daoLifecycle: lifecyclePda(dao.daoRegistry),
            requestProposal: bogusProposal,
            governanceProgram: harness.governance.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "MoonlightProposalInvalid",
    );
  });
});
