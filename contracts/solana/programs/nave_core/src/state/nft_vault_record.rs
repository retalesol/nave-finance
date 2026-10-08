use anchor_lang::prelude::*;

/// Per-(dao, nft_mint) custody record for a treasury-held NFT.
///
/// NFTs are held in a dedicated `nft_vault` token account owned by the DAO's
/// `vault_authority` PDA. Unlike fungible `TreasuryAsset`s, NFTs are NOT priced
/// (no Pyth feed) and do NOT count against the fungible asset cap — they are
/// custodied at $0 NAV and leave only through a passed governance Transfer
/// proposal (`execute_governance_transfer_nft`).
#[account]
pub struct NftVaultRecord {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// NFT mint (decimals 0, supply 1).
    pub mint: Pubkey,
    /// The `nft_vault` holding token account (owned by vault_authority).
    pub token_account: Pubkey,
    /// True once the NFT has been transferred out via governance. A transferred
    /// record is retained for audit but blocks a second governance transfer.
    pub transferred: bool,
}

impl NftVaultRecord {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 32 + 1;
}
