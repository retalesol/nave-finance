import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { NaveTestHarness } from "./helpers/nave-harness";

/**
 * Verifies creation-time `register_dao_token`:
 *   - sets `dao_registry.voting_token` for token-governed DAOs
 *   - mints `initial_supply` into the treasury vault ATA
 */
describe("register_dao_token — creation mint + voting_token", () => {
  let harness: NaveTestHarness;

  before(async () => {
    harness = new NaveTestHarness();
    await harness.ensureGlobalConfig(0);
  });

  it("binds voting_token and mints initial supply into the vault", async function () {
    this.timeout(120_000);

    const { core } = harness;
    const founder = harness.founder.publicKey;
    const globalConfig = harness.globalConfig;

    const global = await core.account.naveGlobalConfig.fetch(globalConfig);
    const daoId = (global.daoCount as { toNumber: () => number }).toNumber();

    const [daoRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("dao"), founder.toBuffer(), Buffer.from(new anchor.BN(daoId).toArrayLike(Buffer, "le", 8))],
      core.programId,
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), daoRegistry.toBuffer()],
      core.programId,
    );
    const [treasuryVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_vault"), daoRegistry.toBuffer()],
      core.programId,
    );
    const [tokenRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_registry"), daoRegistry.toBuffer()],
      core.programId,
    );
    const [protocolFeeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_fee_vault")],
      core.programId,
    );
    const [agentSet] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_set"), daoRegistry.toBuffer()],
      core.programId,
    );
    const [feeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), daoRegistry.toBuffer()],
      core.programId,
    );
    const [guardianConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("guardian_config"), daoRegistry.toBuffer()],
      core.programId,
    );
    const [constitution] = PublicKey.findProgramAddressSync(
      [Buffer.from("constitution"), daoRegistry.toBuffer()],
      core.programId,
    );

    const mintKeypair = Keypair.generate();
    const vaultMint = mintKeypair.publicKey;
    const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);
    const decimals = 6;
    const initialSupply = 1_000_000n;

    const agents = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const params = {
      name: "token-mint-test",
      guardianWallets: [founder],
      guardianThreshold: 1,
      agentAuthorities: agents.map((a) => a.publicKey),
      managementFeeBps: 0,
      performanceFeeBps: 1500,
      frozenManagementFeeBps: 0,
      frozenPerformanceFeeBps: 1500,
      privacyMode: 0,
      feeRecipient: getAssociatedTokenAddressSync(vaultMint, founder, true),
      protocolRevenueWallet: founder,
      quorumBps: 3500,
      governanceType: 1,
    };

    await core.methods
      .initializeDao(params)
      .accounts({
        founder,
        globalConfig,
        protocolTreasury: founder,
        daoRegistry,
        vaultAuthority,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const rent = await getMinimumBalanceForRentExemptMint(harness.provider.connection);
    await harness.provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: founder,
          newAccountPubkey: vaultMint,
          space: MINT_SIZE,
          lamports: rent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(vaultMint, decimals, daoRegistry, daoRegistry),
        createAssociatedTokenAccountInstruction(founder, vaultTokenAccount, vaultAuthority, vaultMint),
      ),
      [harness.founder, mintKeypair],
    );

    await core.methods
      .initializeDaoExtensions(params)
      .accounts({
        founder,
        globalConfig,
        daoRegistry,
        treasuryVault,
        vaultAuthority,
        vaultTokenAccount,
        vaultMint,
        agentSet,
        feeConfig,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    await core.methods
      .initializeDaoGovernance(params)
      .accounts({
        founder,
        globalConfig,
        daoRegistry,
        guardianConfig,
        constitution,
        tokenRegistry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await core.methods
      .registerDaoToken("Test", "TST", decimals, false, new anchor.BN(initialSupply.toString()))
      .accounts({
        authority: founder,
        globalConfig,
        daoRegistry,
        tokenRegistry,
        vaultAuthority,
        treasuryVault,
        destination: vaultTokenAccount,
        protocolFeeVault,
        mint: vaultMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const dao = await core.account.daoRegistry.fetch(daoRegistry);
    assert.ok(dao.votingToken.equals(vaultMint), "voting_token should be set at registration");

    const vaultBal = (await getAccount(harness.provider.connection, vaultTokenAccount)).amount;
    assert.equal(vaultBal, initialSupply, "initial supply should land in treasury vault ATA");
  });
});
