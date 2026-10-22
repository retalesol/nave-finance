import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage } from 'wagmi';
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
import NaveModal from '../components/NaveModal';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTokenRegistry, type TokenInfo } from '../hooks/useTokenRegistry';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { fetchTokenRegistryEvm } from '../lib/evm/readers';
import { buildRegisterDaoTokenEvm, buildRevokeTokenAuthorityEvm, buildUpdateTokenMetadataEvm } from '../lib/evm/writers';
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
import { founderMetadata, solanaAccessSigner } from '../lib/edgeFunctionClient';
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

/* ── Token Row ───────────────────────────────────────────── */
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
  const [copied, setCopied] = useState(false);
  const holders = useHolderCount(token.mint);
  const revokeReward = tokenRevokeRewardLabel(chainKind);

  function copyMint(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(token.mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className="flex items-start gap-3.5 py-4 cursor-pointer group"
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0 border"
          style={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--border))' }}
        >
          {token.imageUri ? (
            <img src={token.imageUri} alt={token.symbol} className="w-full h-full object-cover" />
          ) : (
            <span className="nave-mono font-semibold" style={{ fontSize: '10px', color: 'hsl(var(--foreground))' }}>
              {token.symbol.slice(0, 3).toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="group-hover:text-brass transition-colors"
              style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
            >
              {token.name}
            </span>
            <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              ${token.symbol}
            </span>
            <span
              style={{
                fontSize: '11.5px',
                fontWeight: 600,
                color: token.isNaveManaged ? 'hsl(var(--success))' : 'hsl(var(--warning))',
              }}
            >
              · {token.isNaveManaged ? 'Nave Managed' : 'External'}
            </span>
          </div>
          <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '3px' }}>
            Supply {token.supply.toLocaleString()} · {token.decimals} decimals
            {holders !== null && ` · ${holders >= 20 ? '20+' : holders} holders`}
          </div>
        </div>
        <div className="flex items-center gap-3 ml-auto flex-shrink-0 pt-0.5">
          <span className="nave-mono hidden sm:inline" style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
            {token.mint.length > 20 ? `${token.mint.slice(0, 6)}…${token.mint.slice(-4)}` : token.mint}
          </span>
          <span style={{ color: 'hsl(var(--faint))', fontSize: '11px' }}>
            <Fi icon={expanded ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '11px' }} />
          </span>
        </div>
      </div>

      {expanded && (
        <div className="pb-4 pl-12 space-y-3" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
          {/* Key-value details */}
          <div>
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}>
              <span>Mint address</span>
              <span className="flex items-center gap-2">
                <code className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>
                  {token.mint.length > 20 ? `${token.mint.slice(0, 8)}…${token.mint.slice(-8)}` : token.mint}
                </code>
                <button
                  type="button"
                  onClick={copyMint}
                  className="hover:underline underline-offset-4"
                  style={{ fontSize: '12px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </span>
            </div>
            {token.createdAt ? (
              <div className="flex justify-between py-2" style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}>
                <span>Created</span>
                <span style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}>
                  {new Date(token.createdAt * 1000).toLocaleDateString()}
                </span>
              </div>
            ) : null}
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}>
              <span>Authorities</span>
              <span className="flex items-center gap-3 flex-wrap">
                {[
                  { label: 'Mint', revoked: token.mintAuthorityRevoked },
                  { label: 'Freeze', revoked: token.freezeAuthorityRevoked },
                  { label: 'Metadata', revoked: token.metadataAuthorityRevoked },
                ].map((a) => (
                  <span
                    key={a.label}
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: a.revoked ? 'hsl(var(--muted-foreground))' : 'hsl(var(--success))',
                    }}
                  >
                    {a.label}: {a.revoked ? 'Revoked' : 'Active'}
                  </span>
                ))}
              </span>
            </div>
          </div>

          {token.isNaveManaged ? (
            <div className="pt-1 flex items-center gap-2 flex-wrap">
              {!token.mintAuthorityRevoked && (
                <button
                  type="button"
                  onClick={() => onAction('mint', token)}
                  className="px-3.5 py-1.5 rounded-[9px] border font-semibold transition-colors"
                  style={{ fontSize: '12.5px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                >
                  Mint More
                </button>
              )}
              {!token.metadataAuthorityRevoked && (
                <button
                  type="button"
                  onClick={() => onAction('metadata', token)}
                  className="px-3.5 py-1.5 rounded-[9px] border font-semibold transition-colors"
                  style={{ fontSize: '12.5px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                >
                  Edit Metadata
                </button>
              )}
              <button
                type="button"
                onClick={() => onAction('revoke', token)}
                className="px-3.5 py-1.5 rounded-[9px] border font-semibold transition-colors"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: '#FFF9F8',
                  borderColor: '#E5A49E',
                  color: '#B42318',
                }}
              >
                Revoke Authority (+{revokeReward})
              </button>
            </div>
          ) : (
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
              This token is externally managed. Monitoring only — no management actions available.
            </p>
          )}
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
  const { signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const tx = useSendTransaction();
  const { chainKind, evmChainId, chainFamily } = useChain();
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
        if (out.status === 'success' || out.status === 'mock') {
          if (imageFile && evmAddress) {
            try {
              const reg = await fetchTokenRegistryEvm(evmChainId, daoAddress);
              const mintedAddr = reg?.tokens?.[0]?.mint;
              if (mintedAddr) {
                const { error: imageErr } = await founderMetadata({
                  action: 'set_token_image',
                  daoAddress,
                  wallet: evmAddress,
                  signChallenge: (m) => signMessageAsync({ message: m }),
                  chain: chainFamily,
                  chainId: evmChainId,
                  image: imageFile,
                  mint: mintedAddr,
                });
                if (imageErr) throw new Error(imageErr);
              }
            } catch { /* image upload is best-effort */ }
          }
          onDone();
          onClose();
        } else if (out.status === 'error') setErr(out.error || 'Token creation failed');
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
        if (imageFile && founder && signMessage) {
          try {
            const { error: imageErr } = await founderMetadata({
              action: 'set_token_image',
              daoAddress,
              wallet: founder.toBase58(),
              signChallenge: solanaAccessSigner(signMessage),
              chain: 'solana',
              image: imageFile,
              mint: mint.toBase58(),
            });
            if (imageErr) throw new Error(imageErr);
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

  return (
    <NaveModal open={true} onClose={onClose} title="Mint a token" maxWidth={480}>
      <div style={{ padding: '18px 22px 22px' }} className="space-y-4">
        <div
          className="rounded-[12px] border p-3.5"
          style={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--surface-2))', fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}
        >
          Minting a token costs <strong style={{ color: 'hsl(var(--foreground))' }}>{mintFeeLabel}</strong> from the treasury, with full mint/freeze/metadata authority held by the DAO. Revoking all authorities later returns <strong style={{ color: 'hsl(var(--foreground))' }}>{revokeRewardLabel}</strong> to the treasury.
        </div>

        {/* Token image */}
        <div>
          <label className="block mb-1.5" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Token image <span style={{ fontWeight: 400, color: 'hsl(var(--muted-foreground))' }}>(optional)</span>
          </label>
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer border"
              style={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--border))' }}
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
                className="flex items-center gap-1.5 px-3 py-2 rounded-[9px] border text-xs font-semibold"
                style={{ backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
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
          <div key={f.label}>
            <label className="block mb-1.5" style={{ fontSize: 12.5, fontWeight: 600 }}>{f.label}</label>
            <input
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              placeholder={f.ph}
              className="w-full px-3 py-2.5 rounded-[10px] border outline-none"
              style={{ fontSize: 14, fontFamily: f.mono ? 'var(--font-mono)' : 'var(--font-body)', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
          </div>
        ))}
        {err && <p style={{ fontSize: 12.5, color: 'hsl(var(--destructive))' }}>{err}</p>}
        <div className="flex items-center justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-[9px] border font-semibold" style={{ fontSize: 13, backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className="px-4 py-2 rounded-[9px] font-semibold" style={{ fontSize: 13, backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}>
            {busy ? 'Minting…' : `Mint token (${mintFeeLabel})`}
          </button>
        </div>
      </div>
    </NaveModal>
  );
}

/* ── Token action modals (replace window.prompt/confirm) ─────── */
function TokenModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <NaveModal open={true} onClose={onClose} title={title} maxWidth={460}>
      <div style={{ padding: '18px 22px 22px' }} className="space-y-4">
        {children}
      </div>
    </NaveModal>
  );
}

const tokenInputStyle: React.CSSProperties = {
  fontSize: 14,
  backgroundColor: '#ffffff',
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
      <div className="rounded-[12px] p-3.5 border" style={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--surface-2))' }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'hsl(var(--foreground))' }}>{token.name} <span style={{ color: 'hsl(var(--muted-foreground))' }}>({token.symbol})</span></div>
        <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
          Current supply: {token.supply.toLocaleString()} {token.symbol}
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
        Minting requires a governance <strong>TokenMint</strong> proposal. Once it passes, the founder executes the on-chain mint into the treasury. This increases total supply.
      </p>
      <div>
        <label className="block mb-1.5" style={{ fontSize: 12.5, fontWeight: 600 }}>Amount to mint ({token.symbol})</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100000"
          className="w-full px-3 py-2.5 rounded-[10px] border outline-none" style={{ ...tokenInputStyle, fontFamily: 'var(--font-mono)' }} />
      </div>
      <p style={{ fontSize: 12, color: 'hsl(var(--faint))', margin: 0 }}>Estimated mint fee: {mintFeeLabel} from the treasury.</p>
      {err && <p style={{ fontSize: 12.5, color: 'hsl(var(--destructive))' }}>{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
        <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-[9px] border font-semibold" style={{ fontSize: 13, backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>Cancel</button>
        <button
          type="button"
          onClick={() => {
            setErr(null);
            const n = Number(amount);
            if (!amount.trim() || !Number.isFinite(n) || n <= 0) { setErr('Enter a positive amount'); return; }
            if (onSubmit(amount.trim())) onClose();
          }}
          className="px-4 py-2 rounded-[9px] font-semibold" style={{ fontSize: 13, backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
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
      <div>
        <label className="block mb-1.5" style={{ fontSize: 12.5, fontWeight: 600 }}>Token name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name"
          className="w-full px-3 py-2.5 rounded-[10px] border outline-none" style={tokenInputStyle} />
      </div>
      <div>
        <label className="block mb-1.5" style={{ fontSize: 12.5, fontWeight: 600 }}>Symbol</label>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="SYMBOL" maxLength={8}
          className="w-full px-3 py-2.5 rounded-[10px] border outline-none" style={{ ...tokenInputStyle, fontFamily: 'var(--font-mono)' }} />
      </div>
      <p style={{ fontSize: 12, color: 'hsl(var(--faint))', lineHeight: 1.6, margin: 0 }}>
        Updates the on-chain Metaplex metadata. Symbol is upper-cased and capped at 8 characters.
      </p>
      {err && <p style={{ fontSize: 12.5, color: 'hsl(var(--destructive))' }}>{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
        <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-[9px] border font-semibold" style={{ fontSize: 13, backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>Cancel</button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setErr(null);
            if (!name.trim() || !symbol.trim()) { setErr('Name and symbol are required'); return; }
            setBusy(true);
            try { if (await onSubmit(name, symbol)) onClose(); }
            catch (e) { setErr(e instanceof Error ? e.message : 'Update failed'); }
            finally { setBusy(false); }
          }}
          className="px-4 py-2 rounded-[9px] font-semibold" style={{ fontSize: 13, backgroundColor: 'hsl(var(--foreground))', color: '#ffffff', opacity: busy ? 0.6 : 1 }}
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
      <div className="rounded-[12px] p-3.5 border" style={{ backgroundColor: '#FFF9F8', borderColor: '#F2C7C2' }}>
        <p style={{ fontSize: 13, color: '#B42318', lineHeight: 1.6, margin: 0 }}>
          This permanently and <strong>irreversibly</strong> revokes the <strong>Mint</strong> and <strong>Freeze</strong> authorities for {token.symbol}. After this, no more {token.symbol} can ever be minted or frozen.
        </p>
      </div>
      <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
        The revocation cost is paid by the protocol. After this transaction confirms, <strong>{revokeRewardLabel}</strong> will be credited to your treasury balance from the protocol rewards pool — revoking <em>adds</em> funds to the treasury, it does not cost it.
      </p>
      <div>
        <label className="block mb-1.5" style={{ fontSize: 12.5, fontWeight: 600 }}>Type <span style={{ fontFamily: 'var(--font-mono)' }}>{token.symbol}</span> to confirm</label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={token.symbol}
          className="w-full px-3 py-2.5 rounded-[10px] border outline-none" style={{ ...tokenInputStyle, fontFamily: 'var(--font-mono)' }} />
      </div>
      {err && <p style={{ fontSize: 12.5, color: 'hsl(var(--destructive))' }}>{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
        <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-[9px] border font-semibold" style={{ fontSize: 13, backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>Cancel</button>
        <button
          type="button"
          disabled={!matches || busy}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try { if (await onConfirm()) onClose(); }
            catch (e) { setErr(e instanceof Error ? e.message : 'Revoke failed'); }
            finally { setBusy(false); }
          }}
          className="px-4 py-2 rounded-[9px] font-semibold" style={{ fontSize: 13, backgroundColor: 'hsl(var(--destructive))', color: 'white', opacity: !matches || busy ? 0.5 : 1, cursor: !matches || busy ? 'not-allowed' : 'pointer' }}
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
  const [showCreate, setShowCreate] = useState(false);

  const canManage = !!daoAddress && (isMockMode || (chainKind === 'evm' ? !!evmAddress : !!publicKey));
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

  /** Build the governance mint proposal and route to /decisions. */
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
      navigate('/decisions', {
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
    navigate('/decisions', {
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

  /** Update token metadata (Solana or EVM). Returns true on success. */
  async function executeMetadata(token: TokenInfo, newName: string, newSymbol: string): Promise<boolean> {
    if (!daoAddress) return false;
    if (chainKind === 'evm') {
      if (!evmChainId) return false;
      const r = buildUpdateTokenMetadataEvm(
        evmChainId,
        daoAddress,
        token.mint,
        newName.trim(),
        newSymbol.trim().toUpperCase().slice(0, 11),
      );
      const out = await tx.sendEvm(r, { successLabel: 'Metadata updated' });
      if (out.status === 'success' || out.status === 'mock') { refetch(); return true; }
      return false;
    }
    if (!publicKey) return false;
    const r = await buildUpdateTokenMetadata(
      new PublicKey(daoAddress),
      publicKey,
      newName.trim(),
      newSymbol.trim().toUpperCase().slice(0, 8),
    );
    const out = await tx.send(r, { successLabel: 'Metadata updated' });
    if (out.status === 'success' || out.status === 'mock') { refetch(); return true; }
    return false;
  }

  return (
    <div className="animate-fade-in" data-onboarding-id="tokens-root">
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
      <div className="flex items-start justify-between gap-4 flex-wrap mb-7">
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>Tokens</div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: '34px',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
              color: 'hsl(var(--foreground))',
            }}
          >
            Treasury <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>tokens.</em>
          </h1>
          <p style={{ fontSize: '14.5px', color: 'hsl(var(--muted-foreground))', margin: 0, maxWidth: '520px' }}>
            Manage DAO tokens, authority permissions, and holder data · {tokenCount}/3 slots
          </p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          {canManage && !slotsFull && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold"
              style={{ fontSize: 13, backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
            >
              <Fi icon="plus" style={{ fontSize: 11 }} />
              Mint a Token
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="mt-4">
        {loading && (
          <div className="space-y-3">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={3} />
          </div>
        )}

        {!loading && !hasMintedToken && (
          <NaveEmptyState
            icon="coins"
            title="No tokens minted yet"
            description={`This treasury has no token. Use “Mint a Token” to create one — it costs ${mintFeeLabel} from the treasury and gives the DAO full mint, freeze, and metadata authority. Revoking those authorities later returns ${revokeRewardLabel}.`}
          />
        )}

        {!loading && tokens.length > 0 && (
          <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            {tokens.map((token) => (
              <TokenCard key={token.mint} token={token} chainKind={chainKind} onAction={handleTokenAction} />
            ))}
          </div>
        )}

        {!loading && tokenCount < 3 && hasMintedToken && (
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--faint))', marginTop: '16px' }}>
            {3 - tokenCount} token slot{3 - tokenCount > 1 ? 's' : ''} available — create a Token Mint proposal to use.
          </p>
        )}
      </div>
    </div>
  );
}