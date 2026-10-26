/**
 * Permissionless invoice settle crank.
 *
 * When NAVE_PAY_SOLANA_PROGRAM_ID and NAVE_PAY_ROUTERS are both unset, the tick
 * returns before any RPC, key, or database read. This file does not open
 * contracts/evm/.env.testnet.local or print a private key.
 */

import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getCreate2Address,
  http,
  isAddress,
  keccak256,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import { FORWARDER_CREATION_CODE } from './forwarderCreation.js';
import { arcTestnet, robinhood, robinhoodTestnet } from './evmChains.js';
import { rpcUrlFor } from './evmRelayer.js';
import {
  readInvoiceSettleConfig,
  selectSettleWork,
  type SettleCandidate,
} from './invoiceSettlePlan.js';
import { confirmSolanaTransactionRobust, parseSolanaKeypair } from './solanaTxUtils.js';

const BATCH_FETCH = 25;
const SOL_NATIVE_PUBKEY = '11111111111111111111111111111111';
const EVM_NATIVE_ASSET = '0x0000000000000000000000000000000000000000';

function predictForwarder(router: string, treasury: string, invoiceIdHex: string, asset: string): string | null {
  if (!isAddress(router) || !isAddress(treasury) || !isAddress(asset)) return null;
  const hex = invoiceIdHex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
    [treasury as Address, `0x${hex}` as Hex, asset as Address],
  );
  return getCreate2Address({
    from: router as Address,
    salt: keccak256(args),
    bytecode: concat([FORWARDER_CREATION_CODE as Hex, args]),
  });
}

const EVM_CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  11155111: sepolia,
  84532: baseSepolia,
  4663: robinhood,
  46630: robinhoodTestnet,
  5042002: arcTestnet,
};

const routerAbi = [{
  type: 'function',
  name: 'sweep',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'treasury', type: 'address' },
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'asset', type: 'address' },
  ],
  outputs: [{ name: 'amount', type: 'uint256' }],
}] as const;

const erc20BalanceAbi = [{
  type: 'function',
  name: 'balanceOf',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ type: 'uint256' }],
}] as const;

export interface InvoiceSettleResult {
  status: 'noop' | 'ok';
  reason?: 'config_absent';
  planned: number;
  settled: number;
  booked: number;
}

interface AddressRow {
  chain: string;
  chain_id: number | null;
  asset: string;
  kind: 'solana_vault' | 'solana_ata' | 'evm_forwarder';
  address: string;
  dao_onchain_address: string;
  invoice_id: string;
  pay_invoices: { invoice_id_hex: string; status: string } | { invoice_id_hex: string; status: string }[] | null;
}

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function service(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function solanaPayer(): Keypair | null {
  const raw = process.env.NAVE_OPS_WALLET_SECRET?.trim();
  if (!raw) return null;
  try {
    return parseSolanaKeypair(raw);
  } catch {
    console.error('[invoice-settle] Solana fee payer could not be parsed.');
    return null;
  }
}

function evmPayer() {
  const raw = (process.env.NAVE_EVM_OPS_PRIVATE_KEY || process.env.EVM_OPS_PRIVATE_KEY || '').trim();
  if (!raw) return null;
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('[invoice-settle] EVM fee payer is not a 32-byte hex key.');
    return null;
  }
  try {
    return privateKeyToAccount(hex);
  } catch {
    console.error('[invoice-settle] EVM fee payer could not be parsed.');
    return null;
  }
}

function invoiceOf(row: AddressRow): { invoice_id_hex: string; status: string } | null {
  const value = row.pay_invoices;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

async function listCandidates(db: SupabaseClient): Promise<SettleCandidate[]> {
  const { data, error } = await db
    .from('pay_invoice_addresses')
    .select('chain, chain_id, asset, kind, address, dao_onchain_address, invoice_id, pay_invoices!inner(invoice_id_hex, status)')
    .limit(BATCH_FETCH);
  if (error) throw new Error(error.message);
  const out: SettleCandidate[] = [];
  for (const row of (data ?? []) as AddressRow[]) {
    const invoice = invoiceOf(row);
    if (!invoice || invoice.status === 'void') continue;
    out.push({
      chain: row.chain,
      chainId: row.chain_id,
      kind: row.kind,
      address: row.address,
      asset: row.asset,
      invoiceId: row.invoice_id,
      invoiceIdHex: invoice.invoice_id_hex,
      dao: row.dao_onchain_address,
      balance: 0n,
    });
  }
  return out;
}

async function observedBalance(row: SettleCandidate, solana: Connection | null): Promise<bigint> {
  if (row.kind === 'solana_vault') {
    if (!solana) return 0n;
    const info = await solana.getAccountInfo(new PublicKey(row.address));
    if (!info) return 0n;
    const rent = await solana.getMinimumBalanceForRentExemption(info.data.length);
    return BigInt(Math.max(0, info.lamports - rent));
  }
  if (row.kind === 'solana_ata') {
    if (!solana) return 0n;
    const info = await solana.getTokenAccountBalance(new PublicKey(row.address)).catch(() => null);
    return info ? BigInt(info.value.amount) : 0n;
  }
  if (row.chainId == null) return 0n;
  try {
    const client = createPublicClient({ chain: EVM_CHAINS[row.chainId], transport: http(rpcUrlFor(row.chainId)) });
    if (row.asset.toLowerCase() === EVM_NATIVE_ASSET) {
      return await client.getBalance({ address: row.address as Address });
    }
    return await client.readContract({
      address: row.asset as Address,
      abi: erc20BalanceAbi,
      functionName: 'balanceOf',
      args: [row.address as Address],
    });
  } catch (err) {
    console.error(`[invoice-settle] balance read skipped: ${err instanceof Error ? err.message : err}`);
    return 0n;
  }
}

function solanaSettleInstruction(programId: PublicKey, row: SettleCandidate): TransactionInstruction | null {
  const dao = new PublicKey(row.dao);
  const invoiceBytes = Buffer.from(row.invoiceIdHex, 'hex');
  if (invoiceBytes.length !== 32) return null;
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('invoice_vault'), dao.toBuffer(), invoiceBytes],
    programId,
  );
  if (row.kind === 'solana_vault') {
    if (vault.toBase58() !== row.address) return null;
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('vault_authority'), dao.toBuffer()], programId);
    const [treasuryVault] = PublicKey.findProgramAddressSync([Buffer.from('treasury_vault'), dao.toBuffer()], programId);
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: dao, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: true },
        { pubkey: treasuryVault, isSigner: false, isWritable: true },
        { pubkey: programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([anchorDiscriminator('settle_invoice'), invoiceBytes]),
    });
  }
  const mint = new PublicKey(row.asset);
  const ata = getAssociatedTokenAddressSync(mint, vault, true);
  if (ata.toBase58() !== row.address) return null;
  const [assetConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('asset_config'), dao.toBuffer(), mint.toBuffer()],
    programId,
  );
  const [treasuryAsset] = PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_asset'), dao.toBuffer(), mint.toBuffer()],
    programId,
  );
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: dao, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: assetConfig, isSigner: false, isWritable: false },
      { pubkey: treasuryAsset, isSigner: false, isWritable: true },
      { pubkey: PublicKey.default, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator('settle_invoice_spl'), invoiceBytes]),
  });
}

async function assetVaultAddress(connection: Connection, programId: PublicKey, dao: PublicKey, mint: PublicKey): Promise<PublicKey | null> {
  const [treasuryAsset] = PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_asset'), dao.toBuffer(), mint.toBuffer()],
    programId,
  );
  const info = await connection.getAccountInfo(treasuryAsset);
  if (!info || info.data.length < 73 + 32) return null;
  return new PublicKey(info.data.subarray(73, 73 + 32));
}

async function book(
  db: SupabaseClient,
  row: SettleCandidate,
  txHash: string,
  rawAmount: bigint,
): Promise<boolean> {
  const solanaNative = row.kind === 'solana_vault';
  const stable = row.kind === 'solana_ata' || (row.kind === 'evm_forwarder' && row.asset.toLowerCase() !== EVM_NATIVE_ASSET);
  const { error } = await db.rpc('pay_book_settlement', {
    p_chain: row.chain,
    p_tx_hash: txHash,
    p_invoice_id: row.invoiceId,
    p_asset: solanaNative ? SOL_NATIVE_PUBKEY : row.asset,
    p_raw_amount: rawAmount.toString(),
    p_decimals: solanaNative ? 9 : stable ? 6 : 18,
    p_stable: stable,
    p_symbol: solanaNative ? 'solana' : stable ? null : 'ethereum',
  });
  if (error) {
    console.error(`[invoice-settle] book failed for ${txHash}: ${error.message}`);
    return false;
  }
  return true;
}

async function settleSolana(
  connection: Connection,
  programId: PublicKey,
  payer: Keypair,
  row: SettleCandidate,
): Promise<string | null> {
  const invoiceBytes = Buffer.from(row.invoiceIdHex, 'hex');
  if (invoiceBytes.length !== 32) return null;
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('invoice_vault'), new PublicKey(row.dao).toBuffer(), invoiceBytes],
    programId,
  );
  const vaultInfo = await connection.getAccountInfo(vault);
  if (!vaultInfo || !vaultInfo.owner.equals(programId)) return null;
  let ix = solanaSettleInstruction(programId, row);
  if (!ix) return null;
  if (row.kind === 'solana_ata') {
    const vault = await assetVaultAddress(connection, programId, new PublicKey(row.dao), new PublicKey(row.asset));
    if (!vault) return null;
    ix = new TransactionInstruction({
      programId: ix.programId,
      keys: ix.keys.map((key, index) => (index === 5 ? { ...key, pubkey: vault } : key)),
      data: ix.data,
    });
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await confirmSolanaTransactionRobust(connection, signature, blockhash, lastValidBlockHeight);
  return signature;
}

async function settleEvm(row: SettleCandidate, router: string): Promise<{ hash: string; amount: bigint } | null> {
  if (row.chainId == null || !EVM_CHAINS[row.chainId]) return null;
  const predicted = predictForwarder(router, row.dao, row.invoiceIdHex, row.asset);
  if (!predicted || predicted.toLowerCase() !== row.address.toLowerCase()) return null;
  const account = evmPayer();
  if (!account) return null;
  const chain = EVM_CHAINS[row.chainId];
  const transport = http(rpcUrlFor(row.chainId));
  const wallet = createWalletClient({ account, chain, transport });
  const hash = await wallet.writeContract({
    address: router as Address,
    abi: routerAbi,
    functionName: 'sweep',
    args: [row.dao as Address, `0x${row.invoiceIdHex}` as Hex, row.asset as Address],
  });
  const receipt = await createPublicClient({ chain, transport }).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') return null;
  return { hash, amount: row.balance };
}

export async function runInvoiceSettleLoop(): Promise<InvoiceSettleResult> {
  const config = readInvoiceSettleConfig(process.env);
  if (!config) return { status: 'noop', reason: 'config_absent', planned: 0, settled: 0, booked: 0 };

  const db = service();
  if (!db) {
    console.error('[invoice-settle] SUPABASE_URL or service role key is unset. Nothing was settled.');
    return { status: 'ok', planned: 0, settled: 0, booked: 0 };
  }

  const rows = await listCandidates(db);
  const solanaRpc = process.env.SOLANA_RPC_URL?.trim();
  const solana = config.solanaProgramId && solanaRpc ? new Connection(solanaRpc, 'confirmed') : null;
  const withBalance: SettleCandidate[] = [];
  for (const row of rows) {
    if (withBalance.length >= 25) break;
    const balance = await observedBalance(row, solana);
    if (balance > 0n) withBalance.push({ ...row, balance });
  }
  const work = selectSettleWork(config, withBalance);
  let settled = 0;
  let booked = 0;
  const payer = config.solanaProgramId ? solanaPayer() : null;
  const programId = config.solanaProgramId ? new PublicKey(config.solanaProgramId) : null;

  for (const row of work) {
    try {
      if (row.kind === 'evm_forwarder') {
        const router = config.routers[String(row.chainId)];
        const sent = await settleEvm(row, router);
        if (!sent) continue;
        settled += 1;
        if (await book(db, row, sent.hash, sent.amount)) booked += 1;
        continue;
      }
      if (!solana || !payer || !programId) continue;
      const before = row.balance;
      const signature = await settleSolana(solana, programId, payer, row);
      if (!signature) continue;
      const after = await observedBalance(row, solana);
      const moved = before > after ? before - after : before;
      if (moved <= 0n) continue;
      settled += 1;
      if (await book(db, row, signature, moved)) booked += 1;
    } catch (err) {
      console.error(`[invoice-settle] ${row.chain} ${row.invoiceId} skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { status: 'ok', planned: work.length, settled, booked };
}
