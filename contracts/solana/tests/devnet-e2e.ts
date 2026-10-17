import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { NaveTestHarness, VOTE_FOR, pctOfTreasury } from "./helpers/nave-harness";

/**
 * Live devnet end-to-end lifecycle test.
 *
 * Runs create → deposit → strategy deploy → transfer proposal → governance
 * disbursement against programs deployed on devnet.
 *
 * Run via: npm run test:devnet:solana:smoke (from nave-contracts root)
 */
class DevnetHarness extends NaveTestHarness {
  async airdrop(key: PublicKey, sol = 0.05): Promise<void> {
    await this.provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.founder.publicKey,
          toPubkey: key,
          lamports: Math.floor(sol * LAMPORTS_PER_SOL),
        })
      )
    );
  }

  async airdropMany(keypairs: Keypair[], sol = 0.05): Promise<void> {
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    for (let i = 0; i < keypairs.length; i += 10) {
      const batch = keypairs.slice(i, i + 10);
      const tx = new Transaction();
      for (const kp of batch) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: this.founder.publicKey,
            toPubkey: kp.publicKey,
            lamports,
          })
        );
      }
      await this.provider.sendAndConfirm(tx);
    }
  }
}

function emitDevnetSummary(summary: Record<string, unknown>): void {
  const json = JSON.stringify(summary);
  console.log("DEVNET_E2E_SUMMARY=" + json);
  console.log("E2E_DAO_ADDRESS=" + summary.daoRegistry);
}

describe("devnet live E2E — full DAO lifecycle", () => {
  let harness: DevnetHarness;

  before(() => {
    harness = new DevnetHarness();
    console.log("Founder/deployer:", harness.founder.publicKey.toBase58());
    try {
      console.log("RPC host:", new URL(harness.provider.connection.rpcEndpoint).host);
    } catch {
      console.log("RPC host: configured");
    }
  });

  it("creates DAO, strategy deploy, and SPL transfer proposal", async function () {
    this.timeout(1_200_000);

    const dao = await harness.createDao({
      name: "devnet-e2e",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });
    console.log("DAO registry:", dao.daoRegistry.toBase58());

    await harness.enableAgents(dao);

    const vault = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    assert.equal(vault.currentNav.toString(), (30_000n * 1_000_000n).toString());

    const deployAmount = pctOfTreasury(dao.totalTreasuryRaw, 4000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Deploy 40% to Kamino",
      harness.strategyPayload(harness.kamino.programId, deployAmount, dao.vaultMint),
      60
    );

    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const p = await harness.governance.account.proposal.fetch(proposal);
    assert.equal(p.status, 1, "strategy proposal should be Passed");

    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      deployAmount,
      harness.kamino.programId
    );

    await harness.runAgentApprovals(dao, execReq, payloadHash);
    await harness.disableAgentsForDirectExecute(dao);
    await harness.executeStrategyDirect(dao, execReq, harness.kamino.programId, "kamino");
    await harness.enableAgents(dao);
    await harness.releaseVoteEscrows(dao, proposal, dao.members);

    const vaultAfter = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    assert.equal(vaultAfter.deployedCapital.toString(), deployAmount.toString());

    // Transfer proposal: disburse 0.1 USDC to a fresh recipient wallet.
    const grantee = Keypair.generate();
    await harness.airdrop(grantee.publicKey, 0.02);
    const grantRaw = 100_000n; // 0.1 USDC (6 decimals)
    const { proposal: tProposal } = await harness.createTransferProposal(
      dao,
      "Grant 0.1 USDC",
      grantee.publicKey,
      dao.vaultMint,
      grantRaw,
      60
    );
    await harness.lockQuorumVotes(dao, tProposal, VOTE_FOR);
    await harness.finalizeProposal(dao, tProposal);
    const tp = await harness.governance.account.proposal.fetch(tProposal);
    assert.equal(tp.status, 1, "transfer proposal should be Passed");

    const assetVaultBefore = await getAccount(
      harness.provider.connection,
      dao.assetVaultTokenAccount
    );
    await harness.executeTransferSpl(dao, tProposal, grantee.publicKey, dao.vaultMint);
    const granteeAta = getAssociatedTokenAddressSync(dao.vaultMint, grantee.publicKey);
    const granteeBal = await getAccount(harness.provider.connection, granteeAta);
    assert.equal(granteeBal.amount.toString(), grantRaw.toString());
    const assetVaultAfter = await getAccount(
      harness.provider.connection,
      dao.assetVaultTokenAccount
    );
    assert.equal(
      assetVaultBefore.amount - assetVaultAfter.amount,
      grantRaw,
      "treasury asset vault debited grant amount"
    );

    emitDevnetSummary({
      network: "solana-devnet",
      daoRegistry: dao.daoRegistry.toBase58(),
      treasuryVault: dao.treasuryVault.toBase58(),
      vaultMint: dao.vaultMint.toBase58(),
      strategyProposal: proposal.toBase58(),
      transferProposal: tProposal.toBase58(),
      grantee: grantee.publicKey.toBase58(),
      grantUsdcRaw: grantRaw.toString(),
      deployedCapital: deployAmount.toString(),
      multiAssetNote:
        "USDC treasury via deposit_to_asset; see revalue-multiasset-devnet.ts for wSOL+USDC NAV",
    });
  });
});
