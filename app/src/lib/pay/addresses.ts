/**
 * Per-invoice payment addresses.
 *
 * Solana vaults are derived even when the invoice instructions are not
 * deployed yet: seeds are ["invoice_vault", dao registry, invoice id].
 * The SPL address is the vault's associated token account, and only when a
 * USDC mint is configured.
 *
 * An EVM forwarder is NavePaymentRouter.predictAddress. It is computed only
 * when that chain has a router address. With no router, nothing here invents
 * a forwarder. The customer is shown the treasury's canonical address and the
 * invoice reference instead.
 */

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { concat, encodeAbiParameters, getCreate2Address, isAddress, keccak256, type Hex } from 'viem';
import { FORWARDER_CREATION_CODE } from './forwarderCreation';

export const EVM_NATIVE_ASSET = '0x0000000000000000000000000000000000000000';
export const SOLANA_NATIVE_ASSET = 'native';

export type InvoiceAddressKind = 'solana_vault' | 'solana_ata' | 'evm_forwarder';

export interface InvoiceAddressDraft {
  chain: string;
  chain_id: number | null;
  asset: string;
  kind: InvoiceAddressKind;
  address: string;
  dao_onchain_address: string;
}

export interface TreasuryReceiveRow {
  chain: string;
  chain_id: number | null;
  address: string;
  dao_onchain_address: string;
}

function invoiceIdBytes(invoiceIdHex: string): Buffer {
  const hex = invoiceIdHex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('invoice id must be 32 bytes');
  return Buffer.from(hex, 'hex');
}

export function solanaInvoiceVaultPda(programId: PublicKey, dao: PublicKey, invoiceIdHex: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('invoice_vault'), dao.toBuffer(), invoiceIdBytes(invoiceIdHex)],
    programId,
  )[0];
}

export function solanaInvoiceAta(vault: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, vault, true);
}

/** CREATE2 forwarder. Returns null when the router or treasury is not an address. */
export function predictForwarder(
  router: string | null | undefined,
  treasury: string,
  invoiceIdHex: string,
  asset: string,
): string | null {
  if (!router || !isAddress(router) || !isAddress(treasury) || !isAddress(asset)) return null;
  const hex = invoiceIdHex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const invoiceId = `0x${hex}` as Hex;
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
    [treasury as Hex, invoiceId, asset as Hex],
  );
  return getCreate2Address({
    from: router as Hex,
    salt: keccak256(args),
    bytecode: concat([FORWARDER_CREATION_CODE as Hex, args]),
  });
}

function validMint(value: string | null | undefined): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

export function buildInvoiceAddresses(input: {
  invoiceIdHex: string;
  wallets: TreasuryReceiveRow[];
  solanaProgramId: PublicKey;
  solanaUsdcMint?: string | null;
  routers?: Record<string, string | undefined>;
  evmUsdc?: Record<string, string | undefined>;
}): InvoiceAddressDraft[] {
  const routers = input.routers ?? {};
  const evmUsdc = input.evmUsdc ?? {};
  const rows: InvoiceAddressDraft[] = [];
  const usdcMint = validMint(input.solanaUsdcMint);

  for (const wallet of input.wallets) {
    if (wallet.chain === 'solana') {
      let dao: PublicKey;
      try {
        dao = new PublicKey(wallet.dao_onchain_address);
      } catch {
        continue;
      }
      const vault = solanaInvoiceVaultPda(input.solanaProgramId, dao, input.invoiceIdHex);
      rows.push({
        chain: 'solana',
        chain_id: null,
        asset: SOLANA_NATIVE_ASSET,
        kind: 'solana_vault',
        address: vault.toBase58(),
        dao_onchain_address: wallet.dao_onchain_address,
      });
      if (usdcMint) {
        rows.push({
          chain: 'solana',
          chain_id: null,
          asset: usdcMint.toBase58(),
          kind: 'solana_ata',
          address: solanaInvoiceAta(vault, usdcMint).toBase58(),
          dao_onchain_address: wallet.dao_onchain_address,
        });
      }
      continue;
    }

    if (wallet.chain_id == null) continue;
    const router = routers[String(wallet.chain_id)];
    const treasury = wallet.dao_onchain_address;
    const native = predictForwarder(router, treasury, input.invoiceIdHex, EVM_NATIVE_ASSET);
    if (!native) continue;
    rows.push({
      chain: wallet.chain,
      chain_id: wallet.chain_id,
      asset: EVM_NATIVE_ASSET,
      kind: 'evm_forwarder',
      address: native,
      dao_onchain_address: treasury,
    });
    const usdc = evmUsdc[String(wallet.chain_id)];
    if (usdc && isAddress(usdc)) {
      const token = predictForwarder(router, treasury, input.invoiceIdHex, usdc);
      if (token) {
        rows.push({
          chain: wallet.chain,
          chain_id: wallet.chain_id,
          asset: usdc,
          kind: 'evm_forwarder',
          address: token,
          dao_onchain_address: treasury,
        });
      }
    }
  }

  return rows;
}

export interface PayableChoice {
  address: string | null;
  unique: boolean;
  asset: string | null;
}

/**
 * Unique address when one is stored for the chain. Otherwise the canonical
 * treasury address. The reference code is shown beside that address; it is
 * not concatenated into it.
 */
export function choosePayable(
  chain: string,
  unique: { chain: string; address: string; asset: string }[],
  canonical: string | null,
): PayableChoice {
  const onChain = unique.filter((row) => row.chain === chain && row.address);
  const native = onChain.find((row) => row.asset === SOLANA_NATIVE_ASSET || row.asset.toLowerCase() === EVM_NATIVE_ASSET);
  const picked = native ?? onChain[0];
  if (picked) return { address: picked.address, unique: true, asset: picked.asset };
  return { address: canonical, unique: false, asset: null };
}
