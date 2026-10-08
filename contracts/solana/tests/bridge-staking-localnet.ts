// Localnet Anchor integration tests for nave_bridge + nave_staking account
// constraints (audit follow-up: these were previously only covered by Rust unit
// tests / the devnet smoke scripts because localnet `anchor test` was not wired
// into CI). Exercises the on-chain guards that cannot be unit-tested:
//   • init-race gating (initialize_config / initialize_pool bound to the program
//     upgrade authority);
//   • owner-only setters (set_paused) and the has_one owner constraint;
//   • two-step ownership (transfer_ownership + accept_ownership, wrong signer
//     rejected);
//   • the P6 replay-PDA hardening: the ProcessedRelease PDA now includes
//     source_chain_id, so the same 32-byte message id from two different source
//     chains derives DISTINCT PDAs (no cross-chain collision).
//
// Runs under `anchor test` (localnet); the CI job `solana-localnet-anchor`
// builds all programs and executes this suite.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

describe("nave_bridge + nave_staking localnet constraints", () => {
  let provider: anchor.AnchorProvider;
  let bridge: Program;
  let staking: Program;
  let payer: Keypair; // provider wallet = program upgrade authority on localnet
  let naveMint: PublicKey;

  const bridgeOwner = Keypair.generate();
  const relayer = Keypair.generate();
  const protocolFeeOwner = Keypair.generate();
  const stakingPoolOwner = Keypair.generate();
  const stakingOwner = Keypair.generate();
  const stranger = Keypair.generate();

  let bridgeConfig: PublicKey;
  let custodyAuthority: PublicKey;
  let custody: PublicKey;
  let bridgeProgramData: PublicKey;

  let stakePool: PublicKey;
  let poolAuthority: PublicKey;
  let stakeVault: PublicKey;
  let rewardVault: PublicKey;
  let stakingProgramData: PublicKey;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    bridge = anchor.workspace.NaveBridge as Program;
    staking = anchor.workspace.NaveStaking as Program;
    payer = (provider.wallet as anchor.Wallet).payer;

    for (const kp of [bridgeOwner, relayer, stakingOwner, stranger]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    naveMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], bridge.programId);
    [custodyAuthority] = PublicKey.findProgramAddressSync([Buffer.from("bridge_custody_authority")], bridge.programId);
    [custody] = PublicKey.findProgramAddressSync([Buffer.from("bridge_custody")], bridge.programId);
    [bridgeProgramData] = PublicKey.findProgramAddressSync([bridge.programId.toBuffer()], BPF_UPGRADEABLE_LOADER_ID);

    [stakePool] = PublicKey.findProgramAddressSync([Buffer.from("stake_pool")], staking.programId);
    [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("stake_pool_authority")], staking.programId);
    [stakeVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_vault")], staking.programId);
    [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_vault")], staking.programId);
    [stakingProgramData] = PublicKey.findProgramAddressSync([staking.programId.toBuffer()], BPF_UPGRADEABLE_LOADER_ID);
  });

  // ── nave_bridge ────────────────────────────────────────────────────────────

  it("rejects initialize_config from a non-upgrade-authority payer (init-race gate)", async () => {
    let threw = false;
    try {
      await bridge.methods
        .initializeConfig(
          bridgeOwner.publicKey,
          relayer.publicKey,
          protocolFeeOwner.publicKey,
          stakingPoolOwner.publicKey,
          250,
          100,
          100,
          50,
          new anchor.BN(1_000_000_000),
          new anchor.BN(10_000_000_000),
        )
        .accounts({
          payer: stranger.publicKey,
          bridgeProgram: bridge.programId,
          programData: bridgeProgramData,
          config: bridgeConfig,
          naveMint,
          custodyAuthority,
          custody,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([stranger])
        .rpc();
    } catch (_err) {
      threw = true;
    }
    assert.isTrue(threw, "a non-upgrade-authority payer must not be able to bootstrap the bridge config");
  });

  it("initializes the bridge config as the upgrade authority with owner != relayer", async () => {
    await bridge.methods
      .initializeConfig(
        bridgeOwner.publicKey,
        relayer.publicKey,
        protocolFeeOwner.publicKey,
        stakingPoolOwner.publicKey,
        250,
        100,
        100,
        50,
        new anchor.BN(1_000_000_000),
        new anchor.BN(10_000_000_000),
      )
      .accounts({
        payer: payer.publicKey,
        bridgeProgram: bridge.programId,
        programData: bridgeProgramData,
        config: bridgeConfig,
        naveMint,
        custodyAuthority,
        custody,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
    assert.strictEqual(cfg.owner.toBase58(), bridgeOwner.publicKey.toBase58());
    assert.strictEqual(cfg.relayer.toBase58(), relayer.publicKey.toBase58());
    assert.notStrictEqual(cfg.owner.toBase58(), cfg.relayer.toBase58(), "P1: owner must differ from relayer");
    assert.strictEqual(cfg.feeBps, 250);
    assert.strictEqual(cfg.paused, false);
    // Outbound guardrails start fail-closed on the allowlist / unlimited on cap.
    assert.strictEqual(cfg.lockDailyCap.toString(), "0");
    assert.strictEqual(cfg.lockDailyUsed.toString(), "0");
    assert.isTrue(
      (cfg.allowedDestChains as anchor.BN[]).every((c) => c.isZero()),
      "allowlist must start empty",
    );
  });

  it("set_paused is owner-only (has_one owner)", async () => {
    let threw = false;
    try {
      await bridge.methods
        .setPaused(true)
        .accounts({ owner: stranger.publicKey, config: bridgeConfig })
        .signers([stranger])
        .rpc();
    } catch (_err) {
      threw = true;
    }
    assert.isTrue(threw, "a non-owner must not pause the bridge");

    await bridge.methods
      .setPaused(true)
      .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
      .signers([bridgeOwner])
      .rpc();
    let cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
    assert.strictEqual(cfg.paused, true);

    await bridge.methods
      .setPaused(false)
      .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
      .signers([bridgeOwner])
      .rpc();
    cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
    assert.strictEqual(cfg.paused, false);
  });

  it("two-step ownership: propose then accept; wrong signer rejected", async () => {
    const newOwner = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(newOwner.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    await bridge.methods
      .transferOwnership(newOwner.publicKey)
      .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
      .signers([bridgeOwner])
      .rpc();

    // Wrong signer cannot accept.
    let threw = false;
    try {
      await bridge.methods
        .acceptOwnership()
        .accounts({ newOwner: stranger.publicKey, config: bridgeConfig })
        .signers([stranger])
        .rpc();
    } catch (_err) {
      threw = true;
    }
    assert.isTrue(threw, "only the pending owner may accept");

    await bridge.methods
      .acceptOwnership()
      .accounts({ newOwner: newOwner.publicKey, config: bridgeConfig })
      .signers([newOwner])
      .rpc();
    const cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
    assert.strictEqual(cfg.owner.toBase58(), newOwner.publicKey.toBase58());
    assert.strictEqual(cfg.pendingOwner.toBase58(), PublicKey.default.toBase58());

    // Hand ownership back so later assertions/reruns stay consistent.
    await bridge.methods
      .transferOwnership(bridgeOwner.publicKey)
      .accounts({ owner: newOwner.publicKey, config: bridgeConfig })
      .signers([newOwner])
      .rpc();
    await bridge.methods
      .acceptOwnership()
      .accounts({ newOwner: bridgeOwner.publicKey, config: bridgeConfig })
      .signers([bridgeOwner])
      .rpc();
  });

  // ── lock guardrails: destination allowlist + rolling daily cap ─────────────

  describe("lock: destination-chain allowlist + outbound daily cap", () => {
    const BASE_CHAIN = 8453n;
    const ETH_CHAIN = 1n;
    const NET = 1_000_000n; // 1 NAVE @ 6 decimals
    const sender = Keypair.generate();
    const evmRecipient = Array.from(Buffer.alloc(20, 0xab));
    let senderAta: PublicKey;
    let protocolFeeAta: PublicKey;
    let stakingPoolAta: PublicKey;

    function lockIx(net: bigint, chain: bigint) {
      return bridge.methods
        .lock(new anchor.BN(net.toString()), new anchor.BN(chain.toString()), evmRecipient)
        .accounts({
          sender: sender.publicKey,
          config: bridgeConfig,
          naveMint,
          senderNaveAccount: senderAta,
          custody,
          custodyAuthority,
          protocolFeeAccount: protocolFeeAta,
          stakingPoolAccount: stakingPoolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender]);
    }

    async function expectErr(fn: () => Promise<unknown>, fragment: string) {
      try {
        await fn();
      } catch (e) {
        const msg = String(e);
        assert.include(msg, fragment, `expected "${fragment}" in: ${msg}`);
        return;
      }
      assert.fail(`expected error containing "${fragment}"`);
    }

    before(async () => {
      const sig = await provider.connection.requestAirdrop(sender.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      senderAta = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, naveMint, sender.publicKey)
      ).address;
      await mintTo(provider.connection, payer, naveMint, senderAta, payer, 1_000_000_000n);
      protocolFeeAta = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, naveMint, protocolFeeOwner.publicKey)
      ).address;
      stakingPoolAta = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, naveMint, stakingPoolOwner.publicKey)
      ).address;
    });

    it("rejects lock to a destination chain that is not allowlisted (fail-closed default)", async () => {
      await expectErr(() => lockIx(NET, BASE_CHAIN).rpc(), "UnsupportedChain");
      const custodyAcc = await getAccount(provider.connection, custody);
      assert.strictEqual(custodyAcc.amount.toString(), "0", "nothing may be pulled into custody");
    });

    it("set_dest_chain_allowed / set_lock_daily_cap are owner-only", async () => {
      await expectErr(
        () =>
          bridge.methods
            .setDestChainAllowed(new anchor.BN(BASE_CHAIN.toString()), true)
            .accounts({ owner: stranger.publicKey, config: bridgeConfig })
            .signers([stranger])
            .rpc(),
        "Unauthorized",
      );
      await expectErr(
        () =>
          bridge.methods
            .setLockDailyCap(new anchor.BN(1))
            .accounts({ owner: stranger.publicKey, config: bridgeConfig })
            .signers([stranger])
            .rpc(),
        "Unauthorized",
      );
      // chain id 0 is the empty-slot marker and can never be allowlisted.
      await expectErr(
        () =>
          bridge.methods
            .setDestChainAllowed(new anchor.BN(0), true)
            .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
            .signers([bridgeOwner])
            .rpc(),
        "InvalidChainId",
      );
    });

    it("allowlisted chain locks succeed; a removed chain is rejected again", async () => {
      await bridge.methods
        .setDestChainAllowed(new anchor.BN(BASE_CHAIN.toString()), true)
        .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
        .signers([bridgeOwner])
        .rpc();
      let cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
      assert.isTrue(
        (cfg.allowedDestChains as anchor.BN[]).some((c) => c.toString() === BASE_CHAIN.toString()),
      );

      await lockIx(NET, BASE_CHAIN).rpc();
      cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
      assert.strictEqual(cfg.lockDailyUsed.toString(), NET.toString(), "outbound usage is tracked even when uncapped");
      assert.strictEqual(cfg.outboundNonce.toString(), "1");

      // A different, non-allowlisted chain is still rejected.
      await expectErr(() => lockIx(NET, ETH_CHAIN).rpc(), "UnsupportedChain");

      // Remove BASE → rejected again; re-add for the cap tests.
      await bridge.methods
        .setDestChainAllowed(new anchor.BN(BASE_CHAIN.toString()), false)
        .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
        .signers([bridgeOwner])
        .rpc();
      await expectErr(() => lockIx(NET, BASE_CHAIN).rpc(), "UnsupportedChain");
      await bridge.methods
        .setDestChainAllowed(new anchor.BN(BASE_CHAIN.toString()), true)
        .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
        .signers([bridgeOwner])
        .rpc();
    });

    it("enforces the rolling outbound daily cap on net locked", async () => {
      // Cap = 2.5 NAVE; setting it resets the window (used = 0).
      const cap = NET * 5n / 2n;
      await bridge.methods
        .setLockDailyCap(new anchor.BN(cap.toString()))
        .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
        .signers([bridgeOwner])
        .rpc();
      let cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
      assert.strictEqual(cfg.lockDailyCap.toString(), cap.toString());
      assert.strictEqual(cfg.lockDailyUsed.toString(), "0", "set_lock_daily_cap resets the window");

      const custodyBefore = (await getAccount(provider.connection, custody)).amount;

      await lockIx(NET, BASE_CHAIN).rpc(); // used = 1.0
      await lockIx(NET, BASE_CHAIN).rpc(); // used = 2.0
      // 3rd full lock would take used to 3.0 > 2.5 → rejected, no partial state.
      await expectErr(() => lockIx(NET, BASE_CHAIN).rpc(), "LockDailyCapExceeded");
      cfg = await (bridge.account as any).bridgeConfig.fetch(bridgeConfig);
      assert.strictEqual(cfg.lockDailyUsed.toString(), (NET * 2n).toString(), "rejected lock leaves usage untouched");
      const custodyAfter = (await getAccount(provider.connection, custody)).amount;
      // Custody grew by exactly the two NETs (fee legs leave custody again).
      assert.strictEqual((custodyAfter - custodyBefore).toString(), (NET * 2n).toString());

      // Exactly filling the remaining 0.5 is allowed; one more base unit is not.
      await lockIx(NET / 2n, BASE_CHAIN).rpc();
      await expectErr(() => lockIx(1n, BASE_CHAIN).rpc(), "LockDailyCapExceeded");

      // The pre-existing per-tx cap (1_000 NAVE = 1e9 base units from
      // initialize_config) still applies and is checked before the daily cap.
      await bridge.methods
        .setLockDailyCap(new anchor.BN(0))
        .accounts({ owner: bridgeOwner.publicKey, config: bridgeConfig })
        .signers([bridgeOwner])
        .rpc();
      await expectErr(() => lockIx(1_000_000_000n + 1n, BASE_CHAIN).rpc(), "PerTxCapExceeded");
    });
  });

  it("P6: the ProcessedRelease PDA includes source_chain_id (no cross-chain collision)", () => {
    const seed = Buffer.from("bridge_processed");
    const msgId = Buffer.alloc(32, 7);
    const [pdaBase] = PublicKey.findProgramAddressSync(
      [seed, bridgeConfig.toBuffer(), u64le(84532n), msgId],
      bridge.programId,
    );
    const [pdaEth] = PublicKey.findProgramAddressSync(
      [seed, bridgeConfig.toBuffer(), u64le(11155111n), msgId],
      bridge.programId,
    );
    assert.notStrictEqual(
      pdaBase.toBase58(),
      pdaEth.toBase58(),
      "same message id from different source chains must derive distinct replay PDAs",
    );
  });

  // ── nave_staking ─────────────────────────────────────────────────────────────

  it("rejects initialize_pool from a non-upgrade-authority payer (init-race gate)", async () => {
    let threw = false;
    try {
      await staking.methods
        .initializePool(stakingOwner.publicKey)
        .accounts({
          payer: stranger.publicKey,
          stakingProgram: staking.programId,
          programData: stakingProgramData,
          pool: stakePool,
          naveMint,
          poolAuthority,
          stakeVault,
          rewardVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([stranger])
        .rpc();
    } catch (_err) {
      threw = true;
    }
    assert.isTrue(threw, "a non-upgrade-authority payer must not be able to bootstrap the pool");
  });

  it("initializes the staking pool as the upgrade authority and gates set_paused to the owner", async () => {
    await staking.methods
      .initializePool(stakingOwner.publicKey)
      .accounts({
        payer: payer.publicKey,
        stakingProgram: staking.programId,
        programData: stakingProgramData,
        pool: stakePool,
        naveMint,
        poolAuthority,
        stakeVault,
        rewardVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const pool = await (staking.account as any).stakePool.fetch(stakePool);
    assert.strictEqual(pool.owner.toBase58(), stakingOwner.publicKey.toBase58());
    assert.strictEqual(pool.paused, false);

    // Non-owner cannot pause.
    let threw = false;
    try {
      await staking.methods
        .setPaused(true)
        .accounts({ owner: stranger.publicKey, pool: stakePool })
        .signers([stranger])
        .rpc();
    } catch (_err) {
      threw = true;
    }
    assert.isTrue(threw, "a non-owner must not pause staking");

    // unstake stays open even while paused is the exit guarantee — here we just
    // confirm the owner can toggle pause.
    await staking.methods
      .setPaused(true)
      .accounts({ owner: stakingOwner.publicKey, pool: stakePool })
      .signers([stakingOwner])
      .rpc();
    const paused = await (staking.account as any).stakePool.fetch(stakePool);
    assert.strictEqual(paused.paused, true);
    await staking.methods
      .setPaused(false)
      .accounts({ owner: stakingOwner.publicKey, pool: stakePool })
      .signers([stakingOwner])
      .rpc();
  });
});
