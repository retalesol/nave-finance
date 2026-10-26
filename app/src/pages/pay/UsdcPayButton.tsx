import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { isEvmChainId, type EvmChainId } from '../../lib/chain/types';
import { Erc20Abi } from '../../lib/evm/contracts';
import { usdCentsToTokenUnits } from '../../lib/pay/billing';
import { payPrimary } from './payStyles';

/**
 * Sends USDC from the connected wallet. EVM pays the address directly.
 * Solana pays the USDC account of that wallet.
 */
export default function UsdcPayButton({
  label,
  disabled,
  evm,
  chainId,
  destination,
  solanaTokenAccount = false,
  token,
  cents,
  onSent,
  onError,
}: {
  label: string;
  disabled?: boolean;
  evm: boolean;
  chainId: number | null;
  destination: string;
  /** When set, Solana USDC is sent to this token account instead of the wallet's derived account. */
  solanaTokenAccount?: boolean;
  token: { address: string; decimals: number } | null;
  cents: number;
  onSent: (txHash: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { address, chainId: connectedChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { openConnectModal } = useConnectModal();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  return (
    <button
      type="button"
      style={payPrimary}
      disabled={disabled || !token || !destination}
      onClick={() => {
        void (async () => {
          try {
            if (!token) throw new Error('USDC is not listed on this network.');
            if (evm) {
              if (!address) {
                openConnectModal?.();
                throw new Error('Connect a wallet on this network, then pay again.');
              }
              if (chainId != null && connectedChainId !== chainId && isEvmChainId(chainId)) {
                await switchChainAsync({ chainId: chainId as EvmChainId });
              }
              const hash = await writeContractAsync({
                address: token.address as `0x${string}`,
                abi: Erc20Abi,
                functionName: 'transfer',
                args: [destination as `0x${string}`, usdCentsToTokenUnits(cents, token.decimals)],
              });
              await onSent(hash);
              return;
            }
            if (!publicKey || !sendTransaction) {
              setVisible(true);
              throw new Error('Connect a Solana wallet, then pay again.');
            }
            const mint = new PublicKey(token.address);
            const fromAta = await getAssociatedTokenAddress(mint, publicKey);
            const tx = new Transaction();
            let toAta: PublicKey;
            if (solanaTokenAccount) {
              toAta = new PublicKey(destination);
            } else {
              const owner = new PublicKey(destination);
              toAta = await getAssociatedTokenAddress(mint, owner, true);
              if (!(await connection.getAccountInfo(toAta))) {
                tx.add(createAssociatedTokenAccountInstruction(publicKey, toAta, owner, mint));
              }
            }
            tx.add(createTransferInstruction(
              fromAta,
              toAta,
              publicKey,
              usdCentsToTokenUnits(cents, token.decimals),
            ));
            await onSent(await sendTransaction(tx, connection));
          } catch (err) {
            onError(err instanceof Error ? err.message : 'Payment failed.');
          }
        })();
      }}
    >
      {label}
    </button>
  );
}
