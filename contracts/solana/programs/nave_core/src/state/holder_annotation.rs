use anchor_lang::prelude::*;

use crate::constants::{AnnotationStatus, MAX_ANNOTATION_LEN};

/// Holder-submitted annotation awaiting guardian review.
#[account]
pub struct HolderAnnotation {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Token holder wallet.
    pub holder: Pubkey,
    /// Annotation status (see AnnotationStatus).
    pub status: u8,
    /// Fixed-size annotation text.
    pub annotation: [u8; MAX_ANNOTATION_LEN],
    /// Active annotation length.
    pub annotation_len: u16,
    /// Submission timestamp.
    pub submitted_at: i64,
    /// Review timestamp.
    pub reviewed_at: i64,
}

impl HolderAnnotation {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 1 + MAX_ANNOTATION_LEN + 2 + 8 + 8;

    pub fn set_annotation(&mut self, data: &[u8]) -> Result<()> {
        require!(
            !data.is_empty() && data.len() <= MAX_ANNOTATION_LEN,
            crate::errors::NaveError::InvalidAnnotationLength
        );
        self.annotation = [0u8; MAX_ANNOTATION_LEN];
        self.annotation[..data.len()].copy_from_slice(data);
        self.annotation_len = data.len() as u16;
        Ok(())
    }

    pub fn status_enum(&self) -> Result<AnnotationStatus> {
        AnnotationStatus::from_u8(self.status)
            .ok_or(error!(crate::errors::NaveError::InvalidAnnotationStatus))
    }
}
