// Account metas after the yield-only fee change. Runtime writability comes from
// the IDL copies the app, signer, and edge functions load. Optional moonlight
// and restore accounts are null, which Anchor encodes as the nave_core program id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildCollectManagementFee,
  buildExecuteMoonlightDistribution,
  buildRestoreDao,
} from '../../src/lib/transactionBuilders';
import { NAVE_CORE_PROGRAM_ID, NAVE_EXECUTION_PROGRAM_ID } from '../../src/lib/programConfig';
import { getNavePrograms } from '../../src/lib/naveProgram';
import {
  getAgentSetPDA,
  getAssetConfigPDA,
  getAssetVaultPDA,
  getDaoStakeLockPDA,
  getExecutionAuthorityPDA,
  getExecutionRequestPDA,
  getFeeConfigPDA,
  getNaveGlobalConfigPDA,
  getStakeEscrowPDA,
  getStrategyEscrowForMintPDA,
  getStrategyPositionForMintPDA,
  getTreasuryAssetPDA,
  getTreasuryVaultPDA,
  getVaultAuthorityPDA,
} from '../../src/lib/pdaDerivation';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '../..');
const repoRoot = join(appRoot, '..');

type IdlAccount = { name: string; writable?: boolean; optional?: boolean; signer?: boolean };
type Idl = { instructions: { name: string; accounts: IdlAccount[] }[] };

function loadIdl(path: string): Idl {
  return JSON.parse(readFileSync(path, 'utf8')) as Idl;
}

function account(idl: Idl, ix: string, name: string): IdlAccount {
  const found = idl.instructions.find((i) => i.name === ix)?.accounts.find((a) => a.name === name);
  assert.ok(found, `${ix}.${name} missing`);
  return found;
}

const CORE_COPIES = [
  'app/src/idl/nave_core.json',
  'app/signer-service/idl/nave_core.json',
  'app/supabase/functions/_shared/idl/nave_core.json',
];
const EXEC_COPIES = [
  'app/src/idl/nave_execution.json',
  'app/signer-service/idl/nave_execution.json',
  'app/supabase/functions/_shared/idl/nave_execution.json',
];

test('loaded IDLs copy fee_config writability and optional moonlight/restore accounts', () => {
  const coreSrc = loadIdl(join(repoRoot, 'contracts/solana/idl/nave_core.json'));
  const execSrc = loadIdl(join(repoRoot, 'contracts/solana/idl/nave_execution.json'));
  const expectCore: Array<[string, string, boolean, boolean]> = [
    ['collect_management_fee', 'fee_config', true, false],
    ['record_strategy_withdrawal', 'fee_config', true, false],
    ['execute_moonlight_distribution', 'dao_stake_lock', true, true],
    ['execute_moonlight_distribution', 'stake_escrow', true, true],
    ['execute_moonlight_distribution', 'recipient_nave_account', true, true],
    ['restore_dao', 'dao_stake_lock', true, true],
    ['restore_dao', 'nave_mint', false, true],
    ['restore_dao', 'founder_nave_account', true, true],
    ['restore_dao', 'stake_escrow', true, true],
    ['restore_dao', 'token_program', false, false],
  ];
  for (const rel of CORE_COPIES) {
    const idl = loadIdl(join(repoRoot, rel));
    for (const [ix, name, writable, optional] of expectCore) {
      const copy = account(idl, ix, name);
      const src = account(coreSrc, ix, name);
      assert.equal(!!copy.writable, writable, `${rel} ${ix}.${name} writable`);
      assert.equal(!!copy.optional, optional, `${rel} ${ix}.${name} optional`);
      assert.equal(!!copy.writable, !!src.writable);
      assert.equal(!!copy.optional, !!src.optional);
    }
  }
  for (const rel of EXEC_COPIES) {
    const idl = loadIdl(join(repoRoot, rel));
    const copy = account(idl, 'withdraw_from_strategy', 'fee_config');
    const src = account(execSrc, 'withdraw_from_strategy', 'fee_config');
    assert.equal(!!copy.writable, true, `${rel} withdraw fee_config writable`);
    assert.equal(!!copy.optional, false);
    assert.equal(!!copy.writable, !!src.writable);
  }
});

function keyAt(ix: { keys: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] }, index: number) {
  const key = ix.keys[index];
  assert.ok(key, `missing account meta ${index}`);
  return key;
}

test('restore_dao encodes optional stake accounts as the nave_core program id', async () => {
  const dao = Keypair.generate().publicKey;
  const founder = Keypair.generate().publicKey;
  const built = await buildRestoreDao(dao, founder, null, 0, 0);
  assert.ok(built.instruction);
  const ix = built.instruction;
  assert.equal(ix.keys.length, 9);
  assert.equal(keyAt(ix, 0).pubkey.equals(founder), true);
  assert.equal(keyAt(ix, 0).isSigner, true);
  for (const index of [4, 5, 6, 7]) {
    const key = keyAt(ix, index);
    assert.equal(key.pubkey.equals(NAVE_CORE_PROGRAM_ID), true, `account ${index} is the program id`);
    assert.equal(key.isWritable, false, `program-id placeholder ${index} is not writable`);
    assert.equal(key.isSigner, false);
  }
  assert.equal(keyAt(ix, 8).pubkey.equals(TOKEN_PROGRAM_ID), true);
  assert.equal(ix.data.length, 24);
  assert.ok(ix.data.subarray(8).every((b) => b === 0), 'amount and price are encoded and ignored');
  const [stakeEscrow] = getStakeEscrowPDA(dao);
  assert.equal(ix.keys.some((k) => k.pubkey.equals(stakeEscrow)), false);
});

test('execute_moonlight_distribution passes null unless the stake is still Locked', async () => {
  const dao = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const naveMint = Keypair.generate().publicKey;
  const proposal = Keypair.generate().publicKey;

  const absent = await buildExecuteMoonlightDistribution(dao, authority, naveMint, recipient, proposal, {
    stakeLocked: false,
  });
  assert.ok(absent.instruction);
  assert.equal(absent.preInstructions, undefined);
  for (const index of [4, 5, 6]) {
    const key = keyAt(absent.instruction, index);
    assert.equal(key.pubkey.equals(NAVE_CORE_PROGRAM_ID), true);
    assert.equal(key.isWritable, false);
  }

  const locked = await buildExecuteMoonlightDistribution(dao, authority, naveMint, recipient, proposal, {
    stakeLocked: true,
  });
  assert.ok(locked.instruction);
  assert.equal(locked.preInstructions?.length, 1);
  const [daoStakeLock] = getDaoStakeLockPDA(dao);
  const [stakeEscrow] = getStakeEscrowPDA(dao);
  const recipientAta = getAssociatedTokenAddressSync(naveMint, recipient, false);
  const lockKey = keyAt(locked.instruction, 4);
  const escrowKey = keyAt(locked.instruction, 5);
  const ataKey = keyAt(locked.instruction, 6);
  assert.equal(lockKey.pubkey.equals(daoStakeLock), true);
  assert.equal(escrowKey.pubkey.equals(stakeEscrow), true);
  assert.equal(ataKey.pubkey.equals(recipientAta), true);
  assert.equal(lockKey.isWritable && escrowKey.isWritable && ataKey.isWritable, true);
});

test('collect_management_fee and withdraw_from_strategy mark fee_config writable', async () => {
  const dao = Keypair.generate().publicKey;
  const collector = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const revenue = Keypair.generate().publicKey;
  const collected = await buildCollectManagementFee(dao, collector, mint, revenue);
  assert.ok(collected.instruction);
  const [feeConfig] = getFeeConfigPDA(dao);
  const collectFee = keyAt(collected.instruction, 3);
  assert.equal(collectFee.pubkey.equals(feeConfig), true);
  assert.equal(collectFee.isWritable, true);

  const proposal = Keypair.generate().publicKey;
  const executor = Keypair.generate().publicKey;
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(dao);
  const [vaultAuthority] = getVaultAuthorityPDA(dao);
  const [treasuryVault] = getTreasuryVaultPDA(dao);
  const [assetConfig] = getAssetConfigPDA(dao, mint);
  const [treasuryAsset] = getTreasuryAssetPDA(dao, mint);
  const [vaultTokenAccount] = getAssetVaultPDA(dao, mint);
  const [executionAuthority] = getExecutionAuthorityPDA(dao);
  const [executionRequest] = getExecutionRequestPDA(proposal);
  const [strategyPosition] = getStrategyPositionForMintPDA(dao, 'kamino', mint);
  const [strategyEscrow] = getStrategyEscrowForMintPDA(dao, 'kamino', mint);
  const { execution } = getNavePrograms();
  const withdraw = await execution.methods
    .withdrawFromStrategy(new BN(1))
    .accountsPartial({
      executor,
      globalConfig,
      daoRegistry: dao,
      agentSet,
      vaultAuthority,
      treasuryVault,
      mint,
      assetConfig,
      treasuryAsset,
      priceUpdate: mint,
      vaultTokenAccount,
      executionAuthority,
      adapterProgram: Keypair.generate().publicKey,
      executionRequest,
      strategyEscrow,
      strategyPosition,
      feeConfig,
      revenueTokenAccount: revenue,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      naveCoreProgram: NAVE_CORE_PROGRAM_ID,
    })
    .instruction();
  assert.equal(withdraw.programId.equals(NAVE_EXECUTION_PROGRAM_ID), true);
  const withdrawFee = keyAt(withdraw, 16);
  assert.equal(withdrawFee.pubkey.equals(feeConfig), true);
  assert.equal(withdrawFee.isWritable, true);
  assert.equal(withdraw.keys.some((k) => k.pubkey.equals(feeConfig) && !k.isWritable), false);
});
