// Integration-style tests for the staking global-parity mirror
// (runStakingMirror / deliverEvmShare / nextMirrorNonce in stakingMirror.ts),
// driven through the REAL code paths — web3.js Connection (including the
// confirmSolanaTransactionRobust fallback), viem wallet pipeline, supabase-js
// — against hermetic local mock servers (see testMockServers.ts).
//
// Covered (audit workstreams 2+3):
//   • tick orchestration: disabled short-circuit, fail-fast on partial EVM
//     config BEFORE any funds move, below-threshold sync-poke path;
//   • full distribution happy path: stake-weight split, Solana
//     transfer+sync atomicity, and the complete EVM leg
//     (custody transfer → bridgeIn(901, nonce) → approve → notifyReward)
//     verified by decoding the actual signed transactions;
//   • mirror-nonce derivation against a real (in-memory PostgREST) table:
//     partitioned per destination chain, counts only reward_topup rows,
//     failed attempts burn their nonce;
//   • custody-succeeded-but-audit-insert-failed reconciliation: the tick
//     aborts LOUDLY with the custody tx in the error, and no wNAVE is minted
//     (an unbacked mint can never happen silently);
//   • EVM-leg failure: the audit row is marked 'failed' with the sanitized
//     error, the tick reports (not throws) the leg error, and the burned
//     nonce is never reused.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { createClient } from '@supabase/supabase-js';
import { decodeFunctionData, keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  evmBaseHandlers,
  evmCallHandler,
  makeEvmRpcState,
  solanaBaseHandlers,
  startJsonRpcMock,
  startSupabaseMock,
  type SolanaRpcState,
} from './testMockServers.js';

// ─── Fixture identities ───────────────────────────────────────────────────────

const relayerKeypair = Keypair.generate();
const collectorAccount = Keypair.generate().publicKey;
const stakingProgramId = Keypair.generate().publicKey;
const bridgeProgramId = Keypair.generate().publicKey;
const evmMinterKey = generatePrivateKey();
const evmMinterAddress = privateKeyToAccount(evmMinterKey).address;
const stakingAddress = '0x59a661F1C909cA13ba3E9114bFdD81E5a10EAB78';
const lockboxAddress = '0xdC2c4f3a61AeA908Da5768b63eF9BFF74D13ACf0';
const wrappedNaveAddress = '0x8412cba812593CC8f9Fb510Cd983f79EA2D5fc50';

// ─── Mutable chain state the mock handlers read ───────────────────────────────

const chainState = {
  collectorBalance: 0n,
  solanaTotalStaked: 0n,
  evmTotalStaked: 0n,
};

// ─── Mock servers (must be live before the module under test is imported) ─────

const solanaState: SolanaRpcState = { sentTransactions: [], sentRawTransactions: [] };
const solanaRpc = await startJsonRpcMock({
  ...solanaBaseHandlers(solanaState),
  getTokenAccountBalance: () => ({
    context: { slot: 100 },
    value: {
      amount: chainState.collectorBalance.toString(),
      decimals: 6,
      uiAmount: Number(chainState.collectorBalance) / 1e6,
      uiAmountString: String(Number(chainState.collectorBalance) / 1e6),
    },
  }),
  getAccountInfo: () => ({
    context: { slot: 100 },
    value: {
      data: [syntheticPool(chainState.solanaTotalStaked).toString('base64'), 'base64'],
      executable: false,
      lamports: 2_500_000,
      owner: stakingProgramId.toBase58(),
      rentEpoch: 0,
      space: 299,
    },
  }),
});

const evmState = makeEvmRpcState('0xaa36a7', lockboxAddress); // Sepolia 11155111; wNAVE.minter() = lockbox
const evmRpc = await startJsonRpcMock({
  ...evmBaseHandlers(evmState, (raw) => keccak256(raw)),
  // `minter()` is answered from evmState; every other view the mirror reads
  // (NaveStaking.totalStaked / rewardRate / periodFinish / rewardsDuration)
  // returns the same uint256 fixture.
  eth_call: evmCallHandler(evmState, () => `0x${chainState.evmTotalStaked.toString(16).padStart(64, '0')}`),
});

const supabase = await startSupabaseMock({
  bridge_stake_events: { rows: [], unique: 'source_tx' },
});

process.env.BRIDGE_SOLANA_RPC_URL = solanaRpc.url;
process.env.BRIDGE_SOLANA_RELAYER_AUTHORITY = bs58.encode(relayerKeypair.secretKey);
process.env.BRIDGE_SOLANA_STAKING_PROGRAM = stakingProgramId.toBase58();
process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM = bridgeProgramId.toBase58();
process.env.STAKING_MIRROR_MIN_RAW = '1000000';
process.env.SUPABASE_URL = supabase.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
// Enabled/collector/EVM config is deliberately NOT set yet — the first tests
// exercise the disabled and fail-fast paths, then fill these in.
delete process.env.STAKING_MIRROR_ENABLED;
delete process.env.BRIDGE_SOLANA_STAKING_COLLECTOR;
delete process.env.BRIDGE_EVM_STAKING_11155111;
delete process.env.BRIDGE_EVM_STAKING_84532;
delete process.env.BRIDGE_EVM_LOCKBOX_11155111;
delete process.env.BRIDGE_EVM_LOCKBOX_84532;
delete process.env.BRIDGE_EVM_WRAPPED_NAVE_11155111;
delete process.env.BRIDGE_EVM_WRAPPED_NAVE_84532;
delete process.env.EVM_SEPOLIA_RPC_URL;
delete process.env.BRIDGE_EVM_MINTER_PRIVATE_KEY;

const mirror = await import('./stakingMirror.js');
const { NAVE_BRIDGE_LOCKBOX_ABI } = await import('./bridgePrograms.js');

const stakePool = mirror.deriveStakePool(stakingProgramId);
const rewardVault = mirror.deriveRewardVault(stakingProgramId);

// Direct supabase-js client for nonce-derivation assertions (same mock DB).
const db = createClient(supabase.url, 'test-service-role-key');

after(async () => {
  await Promise.all([solanaRpc.close(), evmRpc.close(), supabase.close()]);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function u128leBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(value >> 64n, 8);
  return buf;
}

/** Synthetic 299-byte StakePool account with `totalStaked` at offset 202. */
function syntheticPool(totalStaked: bigint): Buffer {
  const buf = Buffer.alloc(mirror.STAKE_POOL_ACCOUNT_SIZE);
  buf.writeBigUInt64LE(totalStaked, 202);
  u128leBytes(0n).copy(buf, 210);
  buf.writeBigUInt64LE(0n, 226);
  buf.writeUInt8(0, 234);
  return buf;
}

interface DecodedSolanaIx {
  programId: string;
  dataHex: string;
  keys: string[];
}

/** Decode a captured base64 VersionedTransaction into per-instruction views. */
function decodeSolanaTx(rawB64: string): DecodedSolanaIx[] {
  const tx = VersionedTransaction.deserialize(Buffer.from(rawB64, 'base64'));
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex].toBase58(),
    dataHex: Buffer.from(ix.data).toString('hex'),
    keys: ix.accountKeyIndexes.map((i) => keys[i].toBase58()),
  }));
}

/** SPL Token `Transfer` instruction data: tag 3 + u64 LE amount. */
function splTransferData(amount: bigint): string {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(3, 0);
  buf.writeBigUInt64LE(amount, 1);
  return buf.toString('hex');
}

const SYNC_DISCRIMINATOR_HEX = '04db28a4159dbd58'; // sha256("global:sync")[0..8]

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

function fullMirrorEnv(): void {
  process.env.STAKING_MIRROR_ENABLED = 'true';
  process.env.BRIDGE_SOLANA_STAKING_COLLECTOR = collectorAccount.toBase58();
  process.env.BRIDGE_EVM_STAKING_11155111 = stakingAddress;
  process.env.BRIDGE_EVM_LOCKBOX_11155111 = lockboxAddress;
  process.env.BRIDGE_EVM_WRAPPED_NAVE_11155111 = wrappedNaveAddress;
  process.env.EVM_SEPOLIA_RPC_URL = evmRpc.url;
  process.env.BRIDGE_EVM_MINTER_PRIVATE_KEY = evmMinterKey;
}

// ─── Tick orchestration: gating + fail-fast config validation ─────────────────

test('tick is a silent no-op unless STAKING_MIRROR_ENABLED=true', async () => {
  const result = await mirror.runStakingMirror();
  assert.match(String(result.skipped), /disabled/);
  assert.equal(solanaState.sentTransactions.length, 0, 'nothing moves while disabled');
});

test('enabled without a collector account refuses to run', async () => {
  process.env.STAKING_MIRROR_ENABLED = 'true';
  await assert.rejects(mirror.runStakingMirror(), /BRIDGE_SOLANA_STAKING_COLLECTOR is not configured/);
});

test('partial EVM config fails fast BEFORE any funds move', async () => {
  process.env.STAKING_MIRROR_ENABLED = 'true';
  process.env.BRIDGE_SOLANA_STAKING_COLLECTOR = collectorAccount.toBase58();
  process.env.BRIDGE_EVM_STAKING_11155111 = stakingAddress;

  // Staking address configured, lockbox missing.
  await assert.rejects(mirror.runStakingMirror(), /BRIDGE_EVM_LOCKBOX_11155111 is required/);
  process.env.BRIDGE_EVM_LOCKBOX_11155111 = lockboxAddress;
  // Wrapped NAVE missing.
  await assert.rejects(mirror.runStakingMirror(), /BRIDGE_EVM_WRAPPED_NAVE_11155111 is required/);
  process.env.BRIDGE_EVM_WRAPPED_NAVE_11155111 = wrappedNaveAddress;
  // RPC missing.
  await assert.rejects(mirror.runStakingMirror(), /EVM_SEPOLIA_RPC_URL/);
  process.env.EVM_SEPOLIA_RPC_URL = evmRpc.url;
  // Minter key missing.
  await assert.rejects(mirror.runStakingMirror(), /BRIDGE_EVM_MINTER_PRIVATE_KEY is required/);

  assert.equal(solanaState.sentTransactions.length, 0, 'no Solana transaction was ever sent');
  assert.equal(evmState.sentRawTransactions.length, 0, 'no EVM transaction was ever sent');
});

// ─── Below-threshold: sync poke only ──────────────────────────────────────────

test('below the distribution threshold only a permissionless sync poke is sent', async () => {
  fullMirrorEnv();
  chainState.collectorBalance = 500_000n; // < 1_000_000 min

  const result = await mirror.runStakingMirror();

  assert.match(String(result.skipped), /below threshold \(500000 < 1000000\)/);
  assert.equal(result.collectorBalanceRaw, '500000');
  assert.ok(result.syncSignature, 'sync poke signature reported');
  assert.equal(solanaState.sentTransactions.length, 1);
  assert.equal(evmState.sentRawTransactions.length, 0, 'no EVM activity below threshold');

  const [ix] = decodeSolanaTx(solanaState.sentRawTransactions[0]);
  assert.equal(ix.programId, stakingProgramId.toBase58(), 'sync targets the staking program');
  assert.equal(ix.dataHex, SYNC_DISCRIMINATOR_HEX);
  assert.deepEqual(ix.keys, [stakePool.toBase58(), rewardVault.toBase58()]);
});

// ─── Full distribution happy path (deliverEvmShare end-to-end) ────────────────

test('full tick: stake-weighted split, Solana transfer+sync, and the complete EVM reward leg', async () => {
  fullMirrorEnv();
  chainState.collectorBalance = 10_000_000n;
  chainState.solanaTotalStaked = 60n;
  chainState.evmTotalStaked = 40n;
  const solanaTxsBefore = solanaState.sentRawTransactions.length;

  const result = await mirror.runStakingMirror();

  assert.equal(result.skipped, undefined);
  // 60/40 split of 10 NAVE.
  assert.ok(result.solana);
  assert.equal(result.solana!.shareRaw, '6000000');
  assert.equal(result.evm?.length, 1);
  const leg = result.evm![0];
  assert.equal(leg.chainId, 11155111);
  assert.equal(leg.shareRaw, '4000000');
  assert.equal(leg.error, undefined);
  assert.ok(leg.sourceTx, 'collector→custody transfer signature recorded');
  assert.ok(leg.notifyTx, 'notifyReward tx recorded');
  assert.equal(result.stakeEventsMirrored, 0);

  // Two Solana transactions: (1) solana leg = transfer(reward_vault, 6e6) +
  // sync in ONE atomic tx; (2) EVM leg custody funding = transfer(custody, 4e6).
  const solanaTxs = solanaState.sentRawTransactions.slice(solanaTxsBefore);
  assert.equal(solanaTxs.length, 2);
  const solanaLeg = decodeSolanaTx(solanaTxs[0]);
  assert.equal(solanaLeg.length, 2, 'transfer + sync land in the same transaction');
  assert.equal(solanaLeg[0].programId, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(solanaLeg[0].dataHex, splTransferData(6_000_000n));
  assert.deepEqual(solanaLeg[0].keys, [
    collectorAccount.toBase58(),
    rewardVault.toBase58(),
    relayerKeypair.publicKey.toBase58(),
  ]);
  assert.equal(solanaLeg[1].dataHex, SYNC_DISCRIMINATOR_HEX);

  const custodyLeg = decodeSolanaTx(solanaTxs[1]);
  assert.equal(custodyLeg.length, 1);
  assert.equal(custodyLeg[0].dataHex, splTransferData(4_000_000n));
  const { deriveCustody } = await import('./bridgePrograms.js');
  assert.deepEqual(custodyLeg[0].keys, [
    collectorAccount.toBase58(),
    deriveCustody(bridgeProgramId).toBase58(),
    relayerKeypair.publicKey.toBase58(),
  ]);

  // Three EVM transactions: bridgeIn → approve → notifyReward, all decoded
  // from the ACTUAL signed raw transactions the relayer broadcast.
  assert.equal(evmState.sentRawTransactions.length, 3);
  const [mintRaw, approveRaw, notifyRaw] = evmState.sentRawTransactions;

  const mintTx = parseTransaction(mintRaw);
  assert.equal(mintTx.to?.toLowerCase(), lockboxAddress.toLowerCase());
  const mintCall = decodeFunctionData({ abi: NAVE_BRIDGE_LOCKBOX_ABI, data: mintTx.data! });
  assert.equal(mintCall.functionName, 'bridgeIn');
  const [mintRecipient, mintAmount, srcChainId, srcNonce] = mintCall.args as readonly [string, bigint, bigint, bigint];
  assert.equal(mintRecipient.toLowerCase(), evmMinterAddress.toLowerCase(), 'wNAVE reward is minted to the relayer EOA');
  assert.equal(mintAmount, 4_000_000n);
  assert.equal(srcChainId, 901n, 'mirror mints use the dedicated srcChainId (bridge uses 900)');
  assert.equal(srcNonce, 1n, 'first mirror nonce for this chain is 1');

  const approveTx = parseTransaction(approveRaw);
  assert.equal(approveTx.to?.toLowerCase(), wrappedNaveAddress.toLowerCase());
  const approveCall = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approveTx.data! });
  assert.equal(approveCall.functionName, 'approve');
  assert.equal((approveCall.args[0] as string).toLowerCase(), stakingAddress.toLowerCase());
  assert.equal(approveCall.args[1], 4_000_000n);

  const notifyTx = parseTransaction(notifyRaw);
  assert.equal(notifyTx.to?.toLowerCase(), stakingAddress.toLowerCase());
  const notifyCall = decodeFunctionData({ abi: mirror.NAVE_STAKING_EVM_ABI, data: notifyTx.data! });
  assert.equal(notifyCall.functionName, 'notifyReward');
  assert.deepEqual(notifyCall.args, [4_000_000n]);

  // Audit rows: one completed Solana top-up, one completed EVM top-up whose
  // dest_tx is the final notifyReward hash and whose source_tx is the
  // collector→custody transfer signature (the reconciliation key).
  const rows = supabase.tables.bridge_stake_events.rows;
  const solanaRow = rows.find((r) => r.kind === 'reward_topup' && r.source_chain_id === null)!;
  assert.ok(solanaRow, 'Solana top-up audit row inserted');
  assert.equal(solanaRow.status, 'completed');
  assert.equal(solanaRow.amount_raw, '6000000');
  assert.equal(solanaRow.source_tx, result.solana!.signature);

  const evmRow = rows.find((r) => r.kind === 'reward_topup' && r.source_chain_id === 11155111)!;
  assert.ok(evmRow, 'EVM top-up audit row inserted');
  assert.equal(evmRow.status, 'completed');
  assert.equal(evmRow.amount_raw, '4000000');
  assert.equal(evmRow.source_tx, leg.sourceTx);
  assert.equal(evmRow.dest_tx, leg.notifyTx);
});

// ─── Mirror-nonce derivation against the (in-memory) audit table ──────────────

test('nextMirrorNonce counts only reward_topup rows for the destination chain', async () => {
  // One completed EVM top-up exists from the previous test → next nonce is 2.
  assert.equal(await mirror.nextMirrorNonce(db, 11155111), 2n);
  // A chain with no history starts at 1.
  assert.equal(await mirror.nextMirrorNonce(db, 84532), 1n);

  // Seed noise rows: a FAILED top-up for 84532 (failed attempts burn their
  // nonce), a stake event for 84532 (wrong kind — ignored), and a Solana-leg
  // top-up (source_chain_id null — ignored for every EVM chain).
  supabase.tables.bridge_stake_events.rows.push(
    { id: 'seed-1', kind: 'reward_topup', source_chain_id: 84532, source_tx: 'seed-failed-topup', status: 'failed' },
    { id: 'seed-2', kind: 'stake', source_chain_id: 84532, source_tx: 'seed-stake-event', status: 'completed' },
    { id: 'seed-3', kind: 'reward_topup', source_chain_id: null, source_tx: 'seed-solana-topup', status: 'completed' },
  );

  assert.equal(await mirror.nextMirrorNonce(db, 84532), 2n, 'failed top-ups still consume their nonce');
  assert.equal(await mirror.nextMirrorNonce(db, 11155111), 2n, 'other chains/kinds do not leak into the partition');
});

// ─── Custody-succeeded / audit-insert-failed reconciliation path ──────────────

test('audit-insert failure AFTER the custody transfer aborts loudly and never mints', async () => {
  fullMirrorEnv();
  chainState.collectorBalance = 2_000_000n;
  chainState.solanaTotalStaked = 0n; // all weight on the EVM chain → EVM-only leg
  chainState.evmTotalStaked = 40n;
  const solanaTxsBefore = solanaState.sentTransactions.length;
  const evmTxsBefore = evmState.sentRawTransactions.length;
  const rowsBefore = supabase.tables.bridge_stake_events.rows.length;

  supabase.failNextInsert(
    'bridge_stake_events',
    (row) => row.kind === 'reward_topup' && row.source_chain_id === 11155111,
  );

  await assert.rejects(mirror.runStakingMirror(), (err: Error) => {
    assert.match(err.message, /audit insert failed after custody transfer/);
    // The error must carry the custody-transfer signature so operators can
    // reconcile the NAVE that already reached custody.
    const custodySig = solanaState.sentTransactions[solanaState.sentTransactions.length - 1];
    assert.ok(err.message.includes(custodySig), 'error names the custody transfer signature');
    return true;
  });

  assert.equal(
    solanaState.sentTransactions.length,
    solanaTxsBefore + 1,
    'the collector→custody transfer DID happen (funds are in custody, reconciliation needed)',
  );
  assert.equal(
    evmState.sentRawTransactions.length,
    evmTxsBefore,
    'NO wNAVE was minted — an unbacked/unaudited mint can never happen',
  );
  assert.equal(supabase.tables.bridge_stake_events.rows.length, rowsBefore, 'no audit row was recorded');
  assert.equal(await mirror.nextMirrorNonce(db, 11155111), 2n, 'nonce not consumed (row never landed)');
});

// ─── EVM-leg failure: row marked failed, nonce burned, tick survives ──────────

test('a reverted bridgeIn marks the audit row failed, burns the nonce, and does not throw the tick', async () => {
  fullMirrorEnv();
  chainState.collectorBalance = 3_000_000n;
  chainState.solanaTotalStaked = 0n;
  chainState.evmTotalStaked = 40n;
  const evmTxsBefore = evmState.sentRawTransactions.length;

  evmState.revertNextTransaction = true; // the next EVM tx is the bridgeIn mint

  const result = await mirror.runStakingMirror();
  assert.equal(result.skipped, undefined, 'the tick itself completes');
  assert.equal(result.evm?.length, 1);
  const leg = result.evm![0];
  assert.match(String(leg.error), /bridgeIn reverted/);
  assert.ok(leg.sourceTx, 'custody transfer signature still reported for reconciliation');
  assert.equal(leg.notifyTx, undefined);

  // Only the (reverted) bridgeIn was broadcast — no approve, no notifyReward.
  assert.equal(evmState.sentRawTransactions.length, evmTxsBefore + 1);
  const failedMint = parseTransaction(evmState.sentRawTransactions[evmTxsBefore]);
  const failedCall = decodeFunctionData({ abi: NAVE_BRIDGE_LOCKBOX_ABI, data: failedMint.data! });
  assert.equal(failedCall.functionName, 'bridgeIn');
  assert.equal((failedCall.args as readonly unknown[])[3], 2n, 'this attempt consumed nonce 2');

  const row = supabase.tables.bridge_stake_events.rows.find((r) => r.source_tx === leg.sourceTx)!;
  assert.ok(row, 'audit row exists');
  assert.equal(row.status, 'failed');
  assert.match(String(row.error), /bridgeIn reverted/);

  // The failed attempt permanently consumed nonce 2 → the next is 3, so the
  // lockbox replay guard can never see a reused (901, nonce) pair.
  assert.equal(await mirror.nextMirrorNonce(db, 11155111), 3n);
});
