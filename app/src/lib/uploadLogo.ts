import { founderMetadata, type DaoAccessMessageSigner } from './edgeFunctionClient';

/**
 * Upload a square-cropped logo through the founder-metadata function.
 * The founder signs the image hash; the function checks the on-chain founder
 * and stores the object with the service role. The anon key cannot write the
 * dao-logos bucket.
 */
export async function uploadDaoLogo(
  blob: Blob,
  _keyHint: string,
  founderWallet: string,
  daoAddress: string,
  signChallenge: DaoAccessMessageSigner,
  chain?: { chain?: string; chainId?: number | null },
): Promise<string> {
  const { data, error } = await founderMetadata({
    action: 'upload_logo',
    daoAddress,
    wallet: founderWallet,
    signChallenge,
    chain: chain?.chain,
    chainId: chain?.chainId,
    image: blob,
  });
  if (error || !data?.public_url) {
    throw new Error(error || 'Logo upload failed');
  }
  return data.public_url;
}
