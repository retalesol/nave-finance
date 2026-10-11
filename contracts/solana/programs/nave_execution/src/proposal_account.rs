//! Read a governance `Proposal` from either layout that exists on devnet.
//!
//! `token_mint` was appended at the end of `nave_governance::state::Proposal`.
//! The governance program deployed on 2026-07-26 still allocates 1272 bytes and
//! does not write that field. The execution program built against the current
//! struct expects 1304 bytes, so `Account<Proposal>` returns
//! `AccountDidNotDeserialize` for every proposal that program creates.
//! A missing tail is the default pubkey, which is what wallet-governed
//! proposals store.

use std::ops::Deref;

use anchor_lang::prelude::*;
use nave_governance::state::Proposal;

/// On-chain size of a `Proposal` account before `token_mint` was appended
/// (8-byte discriminator plus the body through `finalized_at`).
const PROPOSAL_LEN_BEFORE_TOKEN_MINT: usize = 1272;

const _: () = assert!(Proposal::LEN == PROPOSAL_LEN_BEFORE_TOKEN_MINT + 32);

#[derive(Clone)]
pub struct ReadableProposal(pub Proposal);

impl AccountDeserialize for ReadableProposal {
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        let data = *buf;
        if data.len() < Proposal::DISCRIMINATOR.len() || &data[..8] != Proposal::DISCRIMINATOR {
            return Err(ErrorCode::AccountDiscriminatorMismatch.into());
        }
        if data.len() >= Proposal::LEN {
            return Proposal::try_deserialize(buf).map(Self);
        }
        if data.len() != PROPOSAL_LEN_BEFORE_TOKEN_MINT {
            return Err(ErrorCode::AccountDidNotDeserialize.into());
        }
        let mut padded = vec![0u8; Proposal::LEN];
        padded[..PROPOSAL_LEN_BEFORE_TOKEN_MINT].copy_from_slice(data);
        let mut slice: &[u8] = &padded;
        Proposal::try_deserialize(&mut slice).map(Self)
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        Self::try_deserialize(buf)
    }
}

impl AccountSerialize for ReadableProposal {}

impl Owner for ReadableProposal {
    fn owner() -> Pubkey {
        nave_governance::ID
    }
}

impl Deref for ReadableProposal {
    type Target = Proposal;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
