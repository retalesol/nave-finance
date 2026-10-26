use anchor_lang::prelude::*;

/// Program-owned payment address for one invoice.
///
/// Seeds: `["invoice_vault", dao_registry, invoice_id]`. There is no hot key.
/// Native SOL is the lamport balance above rent. SPL is held in the associated
/// token account of this PDA, one mint at a time, and settled separately.
#[account]
pub struct InvoiceVault {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Invoice id supplied by the books product. Opaque 32 bytes.
    pub invoice_id: [u8; 32],
}

impl InvoiceVault {
    pub const LEN: usize = 8 + 1 + 32 + 32;
}
