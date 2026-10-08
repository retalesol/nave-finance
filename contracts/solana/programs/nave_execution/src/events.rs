use anchor_lang::prelude::*;

#[event]
pub struct ExecutionRequestCreated {
    pub dao: Pubkey,
    pub request: Pubkey,
    pub request_index: u64,
    pub protocol_program: Pubkey,
}

/// Emitted when the FIRST (founder-gated, one-time) bootstrap execution request
/// is created for a DAO. The request snapshots a zero review window for
/// immediate execution. Lets off-chain indexers / the orchestrator detect the
/// bootstrap request and fast-track its agent pipeline.
#[event]
pub struct BootstrapExecutionRequestCreated {
    pub dao: Pubkey,
    pub request: Pubkey,
    pub request_index: u64,
    pub protocol_program: Pubkey,
    pub founder: Pubkey,
}

#[event]
pub struct ExecutiveApprovedEvent {
    pub request: Pubkey,
    pub approver: Pubkey,
}

#[event]
pub struct FinancialApprovedEvent {
    pub request: Pubkey,
    pub approver: Pubkey,
    pub tx_payload_hash: [u8; 32],
}

#[event]
pub struct OversightApprovedEvent {
    pub request: Pubkey,
    pub approver: Pubkey,
}

#[event]
pub struct AgentApprovalEvent {
    pub dao: Pubkey,
    pub agent_role: u8,
    pub execution_request: Pubkey,
    pub reasoning_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct OperationalHaltEvent {
    pub dao: Pubkey,
    pub execution_request: Pubkey,
    pub reason_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct OperationalClearEvent {
    pub request: Pubkey,
    pub agent: Pubkey,
}

#[event]
pub struct StrategyExecutedEvent {
    pub request: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DirectStrategyExecutedEvent {
    pub request: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StrategyWithdrawnEvent {
    pub request: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ExecutionExpiredEvent {
    pub dao: Pubkey,
    pub execution_request: Pubkey,
    pub timestamp: i64,
}
