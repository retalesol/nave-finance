# Ethereum

Chain id `1` (Mainnet). Explorer: https://etherscan.io

This folder is the EVM deployment record for Ethereum: address manifests (`*.json`) and Foundry broadcast logs (`broadcast/`).

Shared Solidity, tests, and deploy scripts live in [`contracts/evm`](../../evm). Files in `contracts/evm/deployments` and `contracts/evm/broadcast` are symlinks back to this folder so Forge and the cutover scripts keep a single project root.

Do not put private keys, mnemonics, or keyed RPC URLs in this folder. RPC endpoints belong in environment variables.
