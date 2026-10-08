import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { parseEther, parseUnits } from 'viem';
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import Fi from '../components/Fi';
import { CardSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTokenRegistry, type TokenInfo } from '../hooks/useTokenRegistry';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { buildRegisterDaoTokenEvm, buildRevokeTokenAuthorityEvm } from '../lib/evm/writers';
import { toast } from '../hooks/use-toast';
import { describeTransactionError } from '../lib/errorMessages';
import {
  buildRegisterDaoToken,
  buildRevokeTokenAuthority,
  buildUpdateTokenMetadata,
  buildMintAdditionalTokens,
  type TransactionBuildResult,
} from '../lib/transactionBuilders';
import { getVaultAuthorityPDA } from '../lib/pdaDerivation';
import { TOKEN_MINT_FEE_SOL, TOKEN_REVOKE_REWARD_SOL, TOKEN_MINT_FEE_ETH, TOKEN_REVOKE_REWARD_ETH } from '../lib/programConfig';
import { uploadDaoLogo } from '../lib/uploadLogo';
import { supabase, setSupabaseWalletAddress } from '../lib/supabaseClient';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { encodeEvmTokenMintPayload } from '../lib/constitutionPayload';

/* ── Holder count (top accounts) ─────────────────────────── */
function useHolderCount(mint: string | null): number | null {
  const { connection } = useConnection();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!mint || mint.length < 32) {
      setCount(null);
      return;
    }
    (async () => {
      try {
        const res = await connection.getTokenLargestAccounts(new PublicKey(mint));
        const nonZero = res.value.filter((a) => Number(a.amount) > 0).length;
        if (!cancelled) setCount(nonZero);
      } catch {
        if (!cancelled) setCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mint, connection]);
  return count;
}

function tokenMintFeeLabel(chainKind: 'solana' | 'evm'): string {
  return chainKind === 'evm' ? `${TOKEN_MINT_FEE_ETH} ETH` : `${TOKEN_MINT_FEE_SOL} SOL`;
}

function tokenRevokeRewardLabel(chainKind: 'solana' | 'evm'): string {
  return chainKind === 'evm' ? `${TOKEN_REVOKE_REWARD_ETH} ETH` : `${TOKEN_REVOKE_REWARD_SOL} SOL`;
}

/* ── Token Card ──────────────────────────────────────────── */
function TokenCard({
  token,
  chainKind,
  onAction,
}: {
  token: TokenInfo;
  chainKind: 'solana' | 'evm';
  onAction: (action: string, token: TokenInfo) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const holders = useHolderCount(token.mint);
  const revokeReward = tokenRevokeRewardLabel(chainKind);

  return (
    <div
      className="rounded-xl border p-5 transition-all"
      style={{
        backgroundColor: 'hsl(var(--surface-0))',
        borderColor: 'hsl(var(--border))',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center overflow-hidden flex-shrink-0"
            style={{ backgroundColor: 'hsl(var(--surface-1))' }}
          >
            {token.imageUri ? (
              <img src={token.imageUri} alt={token.symbol} className="w-full h-full object-cover" />
            ) : (
              <Fi icon="coins" style={{ fontSize: '16px', color: 'hsl(var(--foreground))' }} />
            )}
          </div>
          <div>
            <div className="text-display font-semibold" style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }}>
              {token.name}
            </div>
            <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              ${token.symbol}
              {token.isNaveManaged && (
                <span
                  className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--muted-foreground))' }}
                >
                  Nave Managed
                </span>
              )}
              {!token.isNaveManaged && (
                <span
                  className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ backgroundColor: 'hsl(var(--warning-muted))', color: 'hsl(38 60% 35%)' }}
                >
                  External
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: 'hsl(var(--muted-foreground))' }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
        >
          <Fi icon={expanded ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '14px' }} />
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Supply', value: token.supply.toLocaleString() },
          { label: 'Decimals', value: token.decimals.toString() },
          { label: 'Holders', value: holders === null ? '—' : holders >= 20 ? '20+' : holders.toString() },
          { label: 'Created', value: token.createdAt ? new Date(token.createdAt * 1000).toLocaleDateString() : '—' },
        ].map((s) => (
          <div key={s.label} className="p-2.5 rounded-lg" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
            <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginBottom: '2px' }}>{s.label}</div>
            <div className="text-display font-semibold" style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Mint Address */}
      <div className="flex items-center gap-2 p-2.5 rounded-lg mb-4" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
        <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>Mint:</span>
        <code style={{ fontSize: '12px', color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono, monospace)' }}>
          {token.mint.length > 20 ? `${token.mint.slice(0, 8)}…${token.mint.slice(-8)}` : token.mint}
        </code>
        <button
          onClick={() => navigator.clipboard.writeText(token.mint)}
          className="ml-auto p-1 rounded transition-colors"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          <Fi icon="copy" style={{ fontSize: '11px' }} />
        </button>
      </div>

      {/* Authority Status */}
      <div className="flex flex-wrap gap-2 mb-4">
        {[
          { label: 'Mint Authority', revoked: token.mintAuthorityRevoked },
          { label: 'Freeze Authority', revoked: token.freezeAuthorityRevoked },
          { label: 'Metadata Authority', revoked: token.metadataAuthorityRevoked },
        ].map((a) => (
          <div
            key={a.label}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
            style={{
              backgroundColor: a.revoked ? 'hsl(var(--destructive-muted))' : 'hsl(var(--success-muted))',
              color: a.revoked ? 'hsl(var(--destructive))' : 'hsl(var(--success))',
            }}
          >
            <Fi icon={a.revoked ? 'lock' : 'unlock'} style={{ fontSize: '10px' }} />
            {a.label}: {a.revoked ? 'Revoked' : 'Active'}
          </div>
        ))}
      </div>

      {/* Expanded: Action Buttons (each creates a governance proposal) */}
      {expanded && token.isNaveManaged && (
        <div className="pt-4 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
          <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginBottom: '10px' }}>
            Token Management — revoking all authorities returns {revokeReward} to the treasury
          </div>
          <div className="flex flex-wrap gap-2">
            {!token.mintAuthorityRevoked && (
              <button
                onClick={() => onAction('mint', token)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors"
                style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                <Fi icon="plus" style={{ fontSize: '10px' }} />
                Mint More
              </button>
            )}
            {!token.metadataAuthorityRevoked && (
              <button
                onClick={() => onAction('metadata', token)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors"
                style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                <Fi icon="pen" style={{ fontSize: '10px' }} />
                Edit Metadata
              </button>
            )}
            <button
              onClick={() => onAction('revoke', token)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors"
              style={{
                borderColor: 'hsl(0 72% 80%)',
                color: 'hsl(var(--destructive))',
                backgroundColor: 'hsl(var(--destructive-muted))',
              }}
            >
              <Fi icon="ban" style={{ fontSize: '10px' }} />
              Revoke Authority (+{revokeReward})
            </button>
          </div>
        </div>
      )}

      {/* External token — monitoring only */}
      {expanded && !token.isNaveManaged && (
        <div className="pt-4 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
          <div
            className="flex items-center gap-2 p-3 rounded-lg"
            style={{ backgroundColor: 'hsl(var(--warning-muted))' }}
          >
            <Fi icon="info-circle" style={{ fontSize: '12px', color: 'hsl(38 60% 35%)' }} />
            <span style={{ fontSize: '12px', color: 'hsl(38 60% 35%)' }}>
              This token is externally managed. Monitoring only — no management actions available.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}


/* ── Create / mint token modal ───────────────────────────── */
interface CreateTokenModalProps {
  daoAddress: string;
  founder?: PublicKey;
  onClose: () => void;
  onDone: () => void;
}

function CreateTokenModal({ daoAddress, founder, onClose, onDone }: CreateTokenModalProps) {
  const { connection } = useConnection();
  const tx = useSendTransaction();
  const { chainKind, evmChainId } = useChain();
  const mintFeeLabel = tokenMintFeeLabel(chainKind);
  const revokeRewardLabel = tokenRevokeRewardLabel(chainKind);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('1000000');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setImageFile(file);
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setImagePreview(ev.target?.result as string);
      reader.readAsDataURL(file);
    } else {
      setImagePreview(null);
    }
  }

  async function submit() {
    if (!name.trim() || !symbol.trim()) {
      setErr('Name and symbol are required.');
      return;
    }
    // ── EVM: NaveTreasury.registerDaoToken deploys a NaveDaoToken + mints the
    // initial supply to the treasury in one founder-gated call. ──
    if (chainKind === 'evm') {
      if (!evmChainId) { setErr('Select an Ethereum or Base network.'); return; }
      setBusy(true);
      setErr(null);
      try {
        const evmDecimals = 18;
        const supplyNum = Number(supply);
        const initialSupply =
          Number.isFinite(supplyNum) && supplyNum > 0
            ? BigInt(Math.floor(supplyNum)) * (10n ** BigInt(evmDecimals))
            : 0n;
        // initialRecipient = the treasury (DAO) itself, mirroring the Solana vault.
        const feeWei = parseEther(String(TOKEN_MINT_FEE_ETH));
        const out = await tx.sendEvm(
          buildRegisterDaoTokenEvm(
            evmChainId,
            daoAddress,
            name.trim(),
            symbol.trim().toUpperCase().slice(0, 11),
            evmDecimals,
            initialSupply,
            daoAddress,
            feeWei,
          ),
          { successLabel: 'Token created' },
        );
        if (out.status === 'success' || out.status === 'mock') { onDone(); onClose(); }
        else if (out.status === 'error') setErr(out.error || 'Token creation failed');
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Token creation failed');
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (!founder) { setErr('Connect your Solana wallet first.'); return; }
      const daoPubkey = new PublicKey(daoAddress);
      const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
      const decimals = 6;

      // 1. Create the mint with the DAO PDA as mint + freeze authority.
      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;
      const rent = await getMinimumBalanceForRentExemptMint(connection);
      const vaultAta = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
      const createResult: TransactionBuildResult = {
        instruction: createInitializeMint2Instruction(mint, decimals, daoPubkey, daoPubkey),
        preInstructions: [
          SystemProgram.createAccount({
            fromPubkey: founder,
            newAccountPubkey: mint,
            space: MINT_SIZE,
            lamports: rent,
            programId: TOKEN_PROGRAM_ID,
          }),
        ],
        signers: [mintKeypair],
        programId: TOKEN_PROGRAM_ID,
      };

      // 2. Register the token (charges 0.5 SOL from the treasury) and create the
      //    treasury's ATA so the minted supply lands in the vault.
      const registerResult = await buildRegisterDaoToken(
        daoPubkey,
        founder,
        mint,
        vaultAta,
        name.trim(),
        symbol.trim().toUpperCase().slice(0, 8),
        decimals,
        true,
        0,
      );
      registerResult.preInstructions = [
        createAssociatedTokenAccountIdempotentInstruction(founder, vaultAta, vaultAuthority, mint),
      ];

      const groups = [[createResult, registerResult]];

      // 3. Optionally mint the initial supply to the treasury vault.
      //    This is the ONLY direct buildMintAdditionalTokens call in the UI — it is
      //    the token's genesis supply, minted once at creation before any governance
      //    exists (on-chain this is the supply==0 genesis path, which needs no
      //    proposal). Every POST-creation mint MUST go through a TokenMint
      //    governance proposal: mint_additional_tokens now binds the passed
      //    proposal account on-chain (audit M11), and the "Mint More" action routes
      //    to /governance where ratification (handleRatifyTokenMint) supplies it.
      const supplyNum = Number(supply);
      if (Number.isFinite(supplyNum) && supplyNum > 0) {
        const mintMore = await buildMintAdditionalTokens(
          daoPubkey,
          founder,
          mint,
          vaultAta,
          BigInt(Math.floor(supplyNum)) * BigInt(10 ** decimals),
        );
        groups.push([mintMore]);
      }

      const outcome = await tx.sendGrouped(groups, { successLabel: 'Token minted' });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        // 4. Upload and store the token image (non-blocking — failure doesn't roll back the token).
        if (imageFile) {
          try {
            // The new RLS policy on `dao_token_images` (and the `dao-logos`
            // bucket) fails closed unless the request carries the connected
            // founder wallet in `x-wallet-address`. Set it on the shared client
            // before both writes.
            setSupabaseWalletAddress(founder.toBase58());
            const imageUri = await uploadDaoLogo(imageFile, symbol.trim().toLowerCase() || 'token', founder.toBase58(), daoAddress);
            await supabase.from('dao_token_images').upsert(
              {
                dao_address: normalizeDaoOnchainAddressForQuery(daoAddress) || daoAddress,
                mint: mint.toBase58(),
                image_uri: imageUri,
              },
              { onConflict: 'dao_address,mint' },
            );
          } catch { /* image upload is best-effort */ }
        }
        onDone();
        onClose();
      } else {
        setErr(outcome.error || 'Token creation failed');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Token creation failed');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
      <div className="rounded-2xl overflow-hidden w-full" style={{ maxWidth: 460, backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}>
        <div className="px-5 py-3.5 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
          <span className="text-display font-semibold" style={{ fontSize: 15 }}>Mint a token</span>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div
            className="flex items-start gap-2 p-3 rounded-lg"
            style={{ backgroundColor: 'hsl(var(--accent-muted))', border: '1px solid hsl(var(--border-strong))' }}
          >
            <Fi icon="circle-info" style={{ fontSize: 13, color: 'hsl(var(--accent))', flexShrink: 0, marginTop: 2 }} />
            <p style={{ fontSize: 12, color: 'hsl(var(--accent-muted-foreground))', lineHeight: 1.6 }}>
              Minting a token costs <strong>{mintFeeLabel}</strong> from the treasury, with full mint/freeze/metadata authority held by the DAO. Revoking all authorities later returns <strong>{revokeRewardLabel}</strong> to the treasury.
            </p>
          </div>

          {/* Token image */}
          <div className="space-y-1.5">
            <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Token image <span style={{ fontWeight: 400, color: 'hsl(var(--muted-foreground))' }}>(optional)</span></label>
            <div className="flex items-center gap-3">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer border"
                style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
                onClick={() => fileInputRef.current?.click()}
              >
                {imagePreview ? (
                  <img src={imagePreview} alt="Token preview" className="w-full h-full object-cover" />
                ) : (
                  <Fi icon="image" style={{ fontSize: 18, color: 'hsl(var(--muted-foreground))' }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
                  style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                >
                  <Fi icon="upload" style={{ fontSize: 10 }} />
                  {imageFile ? 'Change image' : 'Upload image'}
                </button>
                {imageFile && (
                  <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', marginTop: 4 }}>{imageFile.name}</p>
                )}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleImageChange}
            />
          </div>

          {[
            { label: 'Token name', value: name, set: setName, ph: 'e.g. Builders Token', mono: false },
            { label: 'Symbol', value: symbol, set: setSymbol, ph: 'e.g. BUILD', mono: true },
            { label: 'Initial supply', value: supply, set: setSupply, ph: '1000000', mono: true },
          ].map((f) => (
            <div key={f.label} className="space-y-1.5">
              <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>{f.label}</label>
              <input
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                placeholder={f.ph}
                className="w-full px-3 py-2.5 rounded-lg border outline-none"
                style={{ fontSize: 13, fontFamily: f.mono ? 'var(--font-mono)' : 'var(--font-body)', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              />
            </div>
          ))}
          {err && <p style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>{err}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
            <button onClick={submit} disabled={busy} className="px-4 py-2 rounded-lg font-medium" style={{ fontSize: 13, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
              {busy ? 'Minting…' : `Mint token (${mintFeeLabel})`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Token action modals (replace window.prompt/confirm) ─────── */
function TokenModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
      <div className="rounded-2xl overflow-hidden w-full" style={{ maxWidth: 460, backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}>
        <div className="px-5 py-3.5 border-b flex items-center justify-between" style={{ borderColor: 'hsl(var(--border))' }}>
          <span className="text-display font-semibold" style={{ fontSize: 15 }}>{title}</span>
          <button onClick={onClose} style={{ color: 'hsl(var(--muted-foreground))' }}><Fi icon="xmark" style={{ fontSize: 14 }} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

const tokenInputStyle: React.CSSProperties = {
  fontSize: 13,
  backgroundColor: 'hsl(var(--surface-0))',
  borderColor: 'hsl(var(--border))',
  color: 'hsl(var(--foreground))',
};

function MintMoreModal({ token, mintFeeLabel, onSubmit, onClose }: {
  token: TokenInfo; mintFeeLabel: string; onSubmit: (amountStr: string) => boolean; onClose: () => void;
}) {
  const [amount, setAmount] = useState('100000');
  const [err, setErr] = useState<string | null>(null);
  return (
    <TokenModalShell title={`Mint more ${token.symbol}`} onClose={onClose}>
      <div className="rounded-lg p-3" style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}>
        <div style={{ fontSize: 12.5, color: 'hsl(var(--foreground))' }}>{token.name} <span style={{ color: 'hsl(var(--muted-foreground))' }}>({token.symbol})</span></div>
        <div style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
          Current supply: {token.supply.toLocaleString()} {token.symbol}
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
        Minting requires a governance <strong>TokenMint</strong> proposal. Once it passes, the founder executes the on-chain mint into the treasury. This increases total supply.
      </p>
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Amount to mint ({token.symbol})</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100000"
          className="w-full px-3 py-2.5 rounded-lg border outline-none" style={{ ...tokenInputStyle, fontFamily: 'var(--font-mono)' }} />
      </div>
      <p style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))' }}>Estimated mint fee: {mintFeeLabel} from the treasury.</p>
      {err && <p style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
        <button
          onClick={() => {
            setErr(null);
            const n = Number(amount);
            if (!amount.trim() || !Number.isFinite(n) || n <= 0) { setErr('Enter a positive amount'); return; }
            if (onSubmit(amount.trim())) onClose();
          }}
          className="px-4 py-2 rounded-lg font-medium" style={{ fontSize: 13, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
        >
          Create Mint Proposal
        </button>
      </div>
    </TokenModalShell>
  );
}

function EditMetadataModal({ token, onSubmit, onClose }: {
  token: TokenInfo; onSubmit: (name: string, symbol: string) => Promise<boolean>; onClose: () => void;
}) {
  const [name, setName] = useState(token.name);
  const [symbol, setSymbol] = useState(token.symbol);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <TokenModalShell title={`Edit ${token.symbol} metadata`} onClose={onClose}>
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Token name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name"
          className="w-full px-3 py-2.5 rounded-lg border outline-none" style={tokenInputStyle} />
      </div>
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Symbol</label>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="SYMBOL" maxLength={8}
          className="w-full px-3 py-2.5 rounded-lg border outline-none" style={{ ...tokenInputStyle, fontFamily: 'var(--font-mono)' }} />
      </div>
      <p style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
        Updates the on-chain Metaplex metadata. Symbol is upper-cased and capped at 8 characters.
      </p>
      {err && <p style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
        <button
          disabled={busy}
          onClick={async () => {
            setErr(null);
            if (!name.trim() || !symbol.trim()) { setErr('Name and symbol are required'); return; }
            setBusy(true);
            try { if (await onSubmit(name, symbol)) onClose(); }
            catch (e) { setErr(e instanceof Error ? e.message : 'Update failed'); }
            finally { setBusy(false); }
          }}
          className="px-4 py-2 rounded-lg font-medium" style={{ fontSize: 13, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Saving…' : 'Save metadata'}
        </button>
      </div>
    </TokenModalShell>
  );
}

function RevokeAuthorityModal({ token, revokeRewardLabel, onConfirm, onClose }: {
  token: TokenInfo; revokeRewardLabel: string; onConfirm: () => Promise<boolean>; onClose: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const matches = confirmText.trim().toUpperCase() === token.symbol.toUpperCase();
  return (
    <TokenModalShell title={`Revoke ${token.symbol} authorities`} onClose={onClose}>
      <div className="rounded-lg p-3 flex items-start gap-2" style={{ backgroundColor: 'hsl(var(--destructive-muted))', border: '1px solid hsl(var(--destructive) / 0.4)' }}>
        <Fi icon="triangle-exclamation" style={{ fontSize: 14, color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: 2 }} />
        <p style={{ fontSize: 12, color: 'hsl(var(--destructive))', lineHeight: 1.6 }}>
          This permanently and <strong>irreversibly</strong> revokes the <strong>Mint</strong> and <strong>Freeze</strong> authorities for {token.symbol}. After this, no more {token.symbol} can ever be minted or frozen.
        </p>
      </div>
      <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
        The revocation cost is paid by the protocol. After this transaction confirms, <strong>{revokeRewardLabel}</strong> will be credited to your treasury balance from the protocol rewards pool — revoking <em>adds</em> funds to the treasury, it does not cost it.
      </p>
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Type <span style={{ fontFamily: 'var(--font-mono)' }}>{token.symbol}</span> to confirm</label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={token.symbol}
          className="w-full px-3 py-2.5 rounded-lg border outline-none" style={{ ...tokenInputStyle, fontFamily: 'var(--font-mono)' }} />
      </div>
      {err && <p style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
        <button
          disabled={!matches || busy}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try { if (await onConfirm()) onClose(); }
            catch (e) { setErr(e instanceof Error ? e.message : 'Revoke failed'); }
            finally { setBusy(false); }
          }}
          className="px-4 py-2 rounded-lg font-medium" style={{ fontSize: 13, backgroundColor: 'hsl(var(--destructive))', color: 'white', opacity: !matches || busy ? 0.5 : 1, cursor: !matches || busy ? 'not-allowed' : 'pointer' }}
        >
          {busy ? 'Revoking…' : 'Revoke authorities'}
        </button>
      </div>
    </TokenModalShell>
  );
}

/* ── Tokens Page ──────────────────────────────────────────── */
export default function Tokens() {
  const navigate = useNavigate();
  const { daoAddress, isMockMode } = useDaoContext();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const { tokens, tokenCount, hasMintedToken, loading, refetch } = useTokenRegistry(daoAddress);
  const [activeTab, setActiveTab] = useState<'tokens' | 'holders'>('tokens');
  const [showCreate, setShowCreate] = useState(false);

  const canManage = !!daoAddress && !isMockMode && (chainKind === 'evm' ? !!evmAddress : !!publicKey);
  const slotsFull = tokenCount >= 3;
  const mintFeeLabel = tokenMintFeeLabel(chainKind);
  const revokeRewardLabel = tokenRevokeRewardLabel(chainKind);

  // Modal targets (replace the legacy window.prompt/confirm dialogs).
  const [mintToken, setMintToken] = useState<TokenInfo | null>(null);
  const [metadataToken, setMetadataToken] = useState<TokenInfo | null>(null);
  const [revokeToken, setRevokeToken] = useState<TokenInfo | null>(null);

  function handleTokenAction(action: string, token: TokenInfo) {
    if (!daoAddress) return;
    if (chainKind === 'evm' && !evmChainId) {
      toast({ variant: 'destructive', title: 'Wrong network', description: 'Select an Ethereum or Base network.' });
      return;
    }
    if (action === 'revoke') { setRevokeToken(token); return; }
    if (action === 'mint') { setMintToken(token); return; }
    if (action === 'metadata') {
      if (chainKind === 'evm') {
        toast({ variant: 'destructive', title: 'Not available', description: 'Token metadata edits are managed through governance on Ethereum or Base.' });
        return;
      }
      setMetadataToken(token);
      return;
    }
  }

  /** Revoke all token authorities (mint + freeze). Returns true on success. */
  async function executeRevoke(token: TokenInfo): Promise<boolean> {
    if (!daoAddress) return false;
    if (chainKind === 'evm') {
      if (!evmChainId) return false;
      const out = await tx.sendEvm(
        buildRevokeTokenAuthorityEvm(evmChainId, daoAddress, token.mint),
        { successLabel: 'Authorities revoked' },
      );
      if (out.status === 'success' || out.status === 'mock') { refetch(); return true; }
      if (out.status === 'error') {
        toast({
          variant: 'destructive',
          title: 'Revoke failed',
          description: describeTransactionError(out.error, { fallback: 'Revoke failed' }),
        });
      }
      return false;
    }
    if (!publicKey) return false;
    const r = await buildRevokeTokenAuthority(new PublicKey(daoAddress), publicKey, new PublicKey(token.mint));
    const out = await tx.send(r, { successLabel: 'Authorities revoked' });
    if (out.status === 'success') { refetch(); return true; }
    return false;
  }

  /** Build the governance mint proposal and route to /governance. */
  function executeMint(token: TokenInfo, amountStr: string): boolean {
    if (!daoAddress) return false;
    // ── EVM ──
    if (chainKind === 'evm') {
      let baseUnits: bigint;
      try { baseUnits = parseUnits(amountStr, token.decimals); }
      catch { toast({ variant: 'destructive', title: 'Invalid amount', description: 'Enter a valid token amount.' }); return false; }
      if (baseUnits <= 0n) { toast({ variant: 'destructive', title: 'Invalid amount', description: 'Enter a positive token amount.' }); return false; }
      const amount = Number(amountStr);
      const formattedAmount = Number.isFinite(amount) ? amount.toLocaleString() : amountStr;
      let payload: number[];
      try {
        payload = encodeEvmTokenMintPayload({
          mint: token.mint as `0x${string}`,
          to: daoAddress as `0x${string}`,
          amount: baseUnits,
        });
      } catch (err) {
        toast({ variant: 'destructive', title: 'Payload error', description: err instanceof Error ? err.message : 'Failed to encode EVM mint payload.' });
        return false;
      }
      navigate('/governance', {
        state: {
          proposeTokenMint: {
            title: `Token Mint — ${formattedAmount} ${token.symbol}`,
            description:
              `Propose minting ${formattedAmount} additional ${token.symbol} (${token.name}) into the EVM treasury.\n\n` +
              `• Token: ${token.symbol} (${token.mint.slice(0, 8)}…)\n` +
              `• Amount: ${formattedAmount} ${token.symbol} (${baseUnits.toString()} base units)\n` +
              `• Destination: treasury contract\n\n` +
              `If this proposal passes, the founder will execute the on-chain mint. ` +
              `This increases the total ${token.symbol} supply.`,
            payload,
          },
        },
      });
      return true;
    }
    // ── Solana ──
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ variant: 'destructive', title: 'Invalid amount', description: 'Enter a positive token amount.' });
      return false;
    }
    const daoPubkey = new PublicKey(daoAddress);
    const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
    const mintPubkey = new PublicKey(token.mint);
    const vaultAta = getAssociatedTokenAddressSync(mintPubkey, vaultAuthority, true);
    const baseUnits = BigInt(Math.floor(amount)) * BigInt(10 ** token.decimals);

    // Payload: [destination (32)] + [mint (32)] + [amount LE u64 (8)] = 72 bytes
    const payload = new Uint8Array(72);
    payload.set(vaultAta.toBytes(), 0);
    payload.set(mintPubkey.toBytes(), 32);
    const view = new DataView(payload.buffer);
    const lo = Number(baseUnits & BigInt(0xFFFFFFFF));
    const hi = Number((baseUnits >> BigInt(32)) & BigInt(0xFFFFFFFF));
    view.setUint32(64, lo, true);
    view.setUint32(68, hi, true);

    const formattedAmount = amount.toLocaleString();
    navigate('/governance', {
      state: {
        proposeTokenMint: {
          title: `Token Mint — ${formattedAmount} ${token.symbol}`,
          description:
            `Propose minting ${formattedAmount} additional ${token.symbol} (${token.name}) into the treasury vault.\n\n` +
            `• Token: ${token.symbol} (${token.mint.slice(0, 8)}…)\n` +
            `• Amount: ${formattedAmount} ${token.symbol} (${baseUnits.toString()} base units)\n` +
            `• Destination: treasury vault\n\n` +
            `If this proposal passes, the founder will execute the on-chain mint. ` +
            `This increases the total ${token.symbol} supply.`,
          payload: Array.from(payload),
        },
      },
    });
    return true;
  }

  /** Update token metadata (Solana). Returns true on success. */
  async function executeMetadata(token: TokenInfo, newName: string, newSymbol: string): Promise<boolean> {
    if (!publicKey || !daoAddress) return false;
    const r = await buildUpdateTokenMetadata(
      new PublicKey(daoAddress),
      publicKey,
      newName.trim(),
      newSymbol.trim().toUpperCase().slice(0, 8),
    );
    const out = await tx.send(r, { successLabel: 'Metadata updated' });
    if (out.status === 'success') { refetch(); return true; }
    return false;
  }

  return (
    <div className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 pb-8" data-onboarding-id="tokens-root">
      {showCreate && canManage && (
        <CreateTokenModal
          daoAddress={daoAddress!}
          founder={publicKey ?? undefined}
          onClose={() => setShowCreate(false)}
          onDone={refetch}
        />
      )}
      {mintToken && (
        <MintMoreModal
          token={mintToken}
          mintFeeLabel={mintFeeLabel}
          onSubmit={(amountStr) => executeMint(mintToken, amountStr)}
          onClose={() => setMintToken(null)}
        />
      )}
      {metadataToken && (
        <EditMetadataModal
          token={metadataToken}
          onSubmit={(name, symbol) => executeMetadata(metadataToken, name, symbol)}
          onClose={() => setMetadataToken(null)}
        />
      )}
      {revokeToken && (
        <RevokeAuthorityModal
          token={revokeToken}
          revokeRewardLabel={revokeRewardLabel}
          onConfirm={() => executeRevoke(revokeToken)}
          onClose={() => setRevokeToken(null)}
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-display font-semibold" style={{ fontSize: '20px', color: 'hsl(var(--foreground))' }}>
            Tokens
          </h1>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
            Manage DAO tokens, authority permissions, and holder data
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <div
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--muted-foreground))' }}
          >
            {tokenCount} / 3 slots used
          </div>
          {canManage && !slotsFull && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium"
              style={{ fontSize: 12.5, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
            >
              <Fi icon="plus" style={{ fontSize: 11 }} />
              Mint a Token
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
        {(['tokens', 'holders'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-all capitalize"
            style={{
              backgroundColor: activeTab === tab ? 'hsl(var(--surface-0))' : 'transparent',
              color: activeTab === tab ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
              boxShadow: activeTab === tab ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'tokens' && (
        <div className="space-y-4">
          {/* Loading state */}
          {loading && (
            <div className="space-y-3">
              <CardSkeleton lines={4} />
              <CardSkeleton lines={3} />
            </div>
          )}

          {/* Pre-mint state */}
          {!loading && !hasMintedToken && (
            <NaveEmptyState
              icon="coins"
              title="No tokens minted yet"
              description={`This treasury has no token. Use “Mint a Token” to create one — it costs ${mintFeeLabel} from the treasury and gives the DAO full mint, freeze, and metadata authority. Revoking those authorities later returns ${revokeRewardLabel}.`}
            />
          )}

          {/* Token cards */}
          {!loading &&
            tokens.map((token) => (
              <TokenCard key={token.mint} token={token} chainKind={chainKind} onAction={handleTokenAction} />
            ))}

          {/* Empty slot indicator */}
          {!loading && tokenCount < 3 && hasMintedToken && (
            <div
              className="p-5 rounded-xl border border-dashed text-center"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
            >
              <Fi icon="plus-circle" style={{ fontSize: '18px', marginBottom: '6px' }} />
              <p style={{ fontSize: '13px' }}>
                {3 - tokenCount} token slot{3 - tokenCount > 1 ? 's' : ''} available — create a Token Mint proposal to use
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'holders' && (
        <div className="space-y-4">
          {/* Holder annotations section */}
          <div
            className="rounded-xl border p-5"
            style={{
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--border))',
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-display font-semibold" style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }}>
                  Holder Annotations
                </div>
                <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                  Set data on holder wallets — becomes public only after holder approval
                </div>
              </div>
            </div>

            {/* Placeholder — no annotations yet */}
            <div
              className="p-6 rounded-lg text-center"
              style={{ backgroundColor: 'hsl(var(--surface-1))' }}
            >
              <Fi icon="user-tag" style={{ fontSize: '20px', color: 'hsl(var(--muted-foreground))', marginBottom: '8px' }} />
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
                No holder annotations yet. Annotations will appear here once set via governance.
              </p>
            </div>
          </div>

          {/* Info banner */}
          <div
            className="flex items-start gap-3 p-4 rounded-xl border"
            style={{
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--border))',
            }}
          >
            <Fi icon="info-circle" style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
              <strong style={{ color: 'hsl(var(--foreground))' }}>How holder annotations work:</strong>
              <br />
              The DAO can set annotation data on any holder wallet address through governance.
              The holder sees the pending data and must approve or deny it with a wallet signature.
              Only approved annotations become publicly visible. This protects holder privacy while
              allowing DAOs to assign roles, labels, or metadata to their token holders.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}