use anchor_lang::prelude::*;

#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct Unstaked {
    pub owner: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardClaimed {
    pub owner: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct LegacyPrincipalCredited {
    pub staker: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardsAccrued {
    pub new_rewards: u64,
    pub acc_reward_per_share: u128,
    pub total_staked: u64,
    pub timestamp: i64,
}
