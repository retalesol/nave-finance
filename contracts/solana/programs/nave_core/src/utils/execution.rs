use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

/// Seed for the nave_execution program's CPI authority PDA.
pub const EXECUTION_AUTHORITY_SEED: &[u8] = b"execution_authority";

/// Verify the execution authority PDA and that the call is authorized.
pub fn verify_execution_authority(
    execution_authority: &AccountInfo,
    dao: &Pubkey,
    execution_program_id: &Pubkey,
    instructions_sysvar: Option<&AccountInfo>,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[EXECUTION_AUTHORITY_SEED, dao.as_ref()],
        execution_program_id,
    );
    require!(
        execution_authority.key() == expected,
        crate::errors::NaveError::Unauthorized
    );
    if execution_authority.is_signer {
        return Ok(());
    }
    // During CPI the instructions sysvar index still refers to the outer instruction
    // (e.g. nave_execution::execute_strategy), not the inner adapter call.
    if let Some(ix_sysvar) = instructions_sysvar {
        let idx = load_current_index_checked(ix_sysvar)?;
        let current = load_instruction_at_checked(idx as usize, ix_sysvar)?;
        if current.program_id == *execution_program_id {
            return Ok(());
        }
    }
    err!(crate::errors::NaveError::Unauthorized)
}

/// Ensure this nave_core instruction is executing as a CPI child of
/// `nave_governance` (same pattern as [`verify_execution_authority`] for
/// `nave_execution`).
pub fn verify_governance_caller(
    governance_program_id: &Pubkey,
    instructions_sysvar: &AccountInfo,
) -> Result<()> {
    let idx = load_current_index_checked(instructions_sysvar)?;
    let current = load_instruction_at_checked(idx as usize, instructions_sysvar)?;
    require!(
        current.program_id == *governance_program_id,
        crate::errors::NaveError::Unauthorized
    );
    Ok(())
}

/// SEC-M4: ensure this nave_core instruction is executing as a CPI child of
/// `nave_execution` (the top-level instruction belongs to nave_execution).
/// Mirrors [`verify_governance_caller`] in the opposite direction. Without this,
/// the `record_bootstrap_usage` "CPI-only" guarantee was only an
/// `address = nave_execution_program::ID` check on a *passed account* plus a
/// founder signer — so the founder could call `record_bootstrap_usage` directly
/// (top-level) and flip `bootstrap_used` outside the execution pipeline.
pub fn verify_execution_caller(
    execution_program_id: &Pubkey,
    instructions_sysvar: &AccountInfo,
) -> Result<()> {
    let idx = load_current_index_checked(instructions_sysvar)?;
    let current = load_instruction_at_checked(idx as usize, instructions_sysvar)?;
    require!(
        current.program_id == *execution_program_id,
        crate::errors::NaveError::Unauthorized
    );
    Ok(())
}
