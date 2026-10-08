import { supabase, setSupabaseWalletAddress } from './supabaseClient';
import { normalizeDaoOnchainAddressForQuery } from './chain/daoOnchainAddress';

const BUCKET = 'dao-logos';

/**
 * Upload a (square-cropped) logo image blob to the public `dao-logos` bucket
 * and return its public URL.
 *
 * The object key is namespaced as `{daoAddress}/{keyHint}-{timestamp}-{rand}`
 * so the storage RLS policy can bind an upload/overwrite to the SPECIFIC DAO
 * being written, not just "any DAO founder" — the folder-name-embedded
 * address is what a tightened policy checks against `dao_registry` (see the
 * `dao-logos founder upload`/`update` policies). Before this, any founder of
 * ANY DAO could overwrite ANY other DAO's logo, since the path carried no
 * DAO identity for the policy to scope against.
 *
 * `founderWallet` is the connected founder wallet. The `dao-logos` policy
 * fails closed unless the request carries the founder in the
 * `x-wallet-address` header, so we set it on the shared client before the
 * upload (the client injects it via its global fetch wrapper).
 */
export async function uploadDaoLogo(
  blob: Blob,
  keyHint: string,
  founderWallet: string,
  daoAddress: string,
): Promise<string> {
  // Supply the header the fail-closed `dao-logos` policy expects.
  setSupabaseWalletAddress(founderWallet);
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const safeHint = keyHint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'logo';
  // Normalize the same way the RLS policy's dao_registry lookup does (EVM 0x
  // addresses are lowercased; Solana base58 is left as-is) so the folder name
  // matches dao_registry.dao_onchain_address exactly.
  const safeDaoFolder = normalizeDaoOnchainAddressForQuery(daoAddress).replace(/[^a-zA-Z0-9]+/g, '');
  const path = `${safeDaoFolder}/${safeHint}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg',
    upsert: false,
    cacheControl: '31536000',
  });
  if (error) {
    throw new Error(`Logo upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
