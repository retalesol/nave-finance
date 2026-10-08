/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/nave_kamino_adapter.json`.
 */
export type NaveKaminoAdapter = {
  "address": "B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD",
  "metadata": {
    "name": "naveKaminoAdapter",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Nave Finance Kamino strategy adapter"
  },
  "instructions": [
    {
      "name": "depositToKamino",
      "discriminator": [
        107,
        90,
        118,
        214,
        59,
        19,
        144,
        80
      ],
      "accounts": [
        {
          "name": "executionAuthority"
        },
        {
          "name": "daoRegistry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  97,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "dao_registry.founder",
                "account": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "dao_registry.dao_id",
                "account": "daoRegistry"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "mint",
          "docs": [
            "Asset mint deployed; keys the per-(protocol, mint) escrow + position."
          ]
        },
        {
          "name": "strategyEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "const",
                "value": [
                  107,
                  97,
                  109,
                  105,
                  110,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "strategyPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "const",
                "value": [
                  107,
                  97,
                  109,
                  105,
                  110,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "payer"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawFromKamino",
      "discriminator": [
        177,
        144,
        191,
        109,
        204,
        151,
        38,
        176
      ],
      "accounts": [
        {
          "name": "executionAuthority"
        },
        {
          "name": "daoRegistry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  97,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "dao_registry.founder",
                "account": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "dao_registry.dao_id",
                "account": "daoRegistry"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "mint",
          "docs": [
            "Asset mint withdrawn; keys the per-(protocol, mint) escrow + position."
          ]
        },
        {
          "name": "strategyEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "const",
                "value": [
                  107,
                  97,
                  109,
                  105,
                  110,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "strategyPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "const",
                "value": [
                  107,
                  97,
                  109,
                  105,
                  110,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                107,
                246,
                146,
                40,
                40,
                177,
                194,
                61,
                12,
                178,
                136,
                4,
                131,
                48,
                167,
                128,
                141,
                194,
                153,
                75,
                63,
                152,
                103,
                108,
                220,
                227,
                19,
                24,
                42,
                89,
                69,
                196
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "daoRegistry",
      "discriminator": [
        182,
        39,
        16,
        182,
        109,
        194,
        206,
        16
      ]
    },
    {
      "name": "strategyPosition",
      "discriminator": [
        39,
        177,
        202,
        35,
        88,
        177,
        104,
        129
      ]
    },
    {
      "name": "treasuryVault",
      "discriminator": [
        86,
        102,
        19,
        109,
        56,
        58,
        144,
        81
      ]
    },
    {
      "name": "vaultAuthority",
      "discriminator": [
        132,
        34,
        187,
        202,
        202,
        195,
        211,
        53
      ]
    }
  ],
  "events": [
    {
      "name": "kaminoDepositEvent",
      "discriminator": [
        56,
        219,
        241,
        139,
        238,
        243,
        64,
        152
      ]
    },
    {
      "name": "kaminoWithdrawEvent",
      "discriminator": [
        228,
        7,
        132,
        112,
        184,
        123,
        46,
        61
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorizedCaller",
      "msg": "Unauthorized caller"
    },
    {
      "code": 6001,
      "name": "protocolNotApproved",
      "msg": "Protocol not approved"
    },
    {
      "code": 6002,
      "name": "invalidAmount",
      "msg": "Invalid amount"
    },
    {
      "code": 6003,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6004,
      "name": "insufficientBalance",
      "msg": "Insufficient balance"
    },
    {
      "code": 6005,
      "name": "invalidVaultAccount",
      "msg": "Invalid vault token account"
    },
    {
      "code": 6006,
      "name": "invalidEscrowAccount",
      "msg": "Invalid strategy escrow account"
    }
  ],
  "types": [
    {
      "name": "daoRegistry",
      "docs": [
        "Per-DAO registry and lifecycle state."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "daoId",
            "docs": [
              "Monotonic DAO identifier."
            ],
            "type": "u64"
          },
          {
            "name": "founder",
            "docs": [
              "DAO founder authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "name",
            "docs": [
              "Fixed-size DAO name bytes."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nameLen",
            "docs": [
              "Active name length."
            ],
            "type": "u8"
          },
          {
            "name": "privacyMode",
            "docs": [
              "Privacy mode (see PrivacyMode enum)."
            ],
            "type": "u8"
          },
          {
            "name": "frozen",
            "docs": [
              "Emergency freeze flag."
            ],
            "type": "bool"
          },
          {
            "name": "agentsEnabled",
            "docs": [
              "Whether agent approvals are enabled."
            ],
            "type": "bool"
          },
          {
            "name": "proposalCount",
            "docs": [
              "Active proposal counter (governance-linked). Incremented on creation and",
              "DECREMENTED by `archive_proposals`; used only for the",
              "`MAX_PROPOSALS_PER_DAO` active-limit enforcement, never as a PDA seed."
            ],
            "type": "u64"
          },
          {
            "name": "archivedProposals",
            "docs": [
              "Cumulative archived proposals."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp of creation."
            ],
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Unix timestamp of last update."
            ],
            "type": "i64"
          },
          {
            "name": "quorumBps",
            "docs": [
              "Minimum participation for proposal passage (basis points of snapshot supply)."
            ],
            "type": "u16"
          },
          {
            "name": "governanceType",
            "docs": [
              "Active governance/voting model (see GovernanceType enum: 0 = Wallet, 1 = Token)."
            ],
            "type": "u8"
          },
          {
            "name": "votingToken",
            "docs": [
              "Designated voting token mint when governance_type == Token (default when none)."
            ],
            "type": "pubkey"
          },
          {
            "name": "nextProposalIndex",
            "docs": [
              "Monotonic proposal index. Only ever INCREMENTS (on proposal creation);",
              "`archive_proposals` never touches it. Used as the per-proposal PDA seed",
              "(`PROPOSAL_SEED`) and `proposal_index` so an archived slot's index can",
              "never be reused — which previously caused a PDA `init` collision because",
              "the seed was derived from the decremented `proposal_count`."
            ],
            "type": "u64"
          },
          {
            "name": "bootstrapUsed",
            "docs": [
              "One-time founder bootstrap latch. `false` at creation; flipped to `true`",
              "the first time the founder creates a bootstrap execution request (which",
              "snapshots `review_window = 0` for immediate execution). Once set it can",
              "never be reset, so the zero-review-window path is available exactly once",
              "per DAO. Mutated only by `record_bootstrap_usage` (CPI from",
              "`nave_execution`). Appended at the END of the layout to preserve the byte",
              "offsets consumed by off-chain decoders / IDL clients."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "kaminoDepositEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "kaminoWithdrawEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "strategyPosition",
      "docs": [
        "On-chain strategy position tracking per (protocol, asset mint). A DAO can",
        "hold positions in the same protocol for different mints, and the same mint",
        "across different protocols, so positions are keyed by both."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "dao",
            "docs": [
              "Owning DAO registry key."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "Asset mint this position deploys (matches the funding `TreasuryAsset`)."
            ],
            "type": "pubkey"
          },
          {
            "name": "positionTokenAccount",
            "docs": [
              "Receipt-token account holding protocol receipt tokens (cTokens / poolSOL)",
              "for this position; `Pubkey::default()` when the position is escrow-only."
            ],
            "type": "pubkey"
          },
          {
            "name": "extMarket",
            "docs": [
              "Approved external venue/market for this position (Kamino lending market,",
              "or Jito SPL stake pool). Bound at init; every protocol CPI must target it.",
              "`Pubkey::default()` until a real on-chain integration is configured."
            ],
            "type": "pubkey"
          },
          {
            "name": "extReserve",
            "docs": [
              "Approved external reserve/pool account (Kamino reserve, or Jito stake pool",
              "— same as `ext_market` for venues without a separate reserve). Bound at",
              "init; prevents an agent from misrouting escrow into an arbitrary reserve."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolId",
            "docs": [
              "Fixed-size protocol identifier."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "protocolIdLen",
            "docs": [
              "Active protocol id length."
            ],
            "type": "u8"
          },
          {
            "name": "depositedAmount",
            "docs": [
              "Deposited principal amount (in `mint` base units)."
            ],
            "type": "u64"
          },
          {
            "name": "currentValue",
            "docs": [
              "Current marked value (in `mint` base units)."
            ],
            "type": "u64"
          },
          {
            "name": "lastUpdated",
            "docs": [
              "Last update timestamp."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "treasuryVault",
      "docs": [
        "Portfolio-level treasury accounting. With the multi-asset redesign the",
        "USD-denominated aggregates (`current_nav`, `high_water_mark`,",
        "`deployed_capital`, `total_deposited`, `total_withdrawn`) are stored in",
        "micro-USD (`USD_SCALE` = 1e6) and recomputed by `revalue_treasury` from each",
        "per-mint `TreasuryAsset` priced via Pyth. The legacy single-mint",
        "`vault_token_account` is retained only for migration of pre-multi-asset DAOs",
        "and is otherwise unused once `asset_count > 0`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "dao",
            "docs": [
              "Owning DAO registry key."
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultTokenAccount",
            "docs": [
              "Legacy single-mint vault token account (migration only)."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalDeposited",
            "docs": [
              "Cumulative deposits in micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "totalWithdrawn",
            "docs": [
              "Cumulative withdrawals in micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "currentNav",
            "docs": [
              "Current portfolio net asset value in micro-USD (idle + deployed)."
            ],
            "type": "u64"
          },
          {
            "name": "highWaterMark",
            "docs": [
              "High-water mark for performance fees, in micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "lastManagementFeeAt",
            "docs": [
              "Last management fee collection timestamp."
            ],
            "type": "i64"
          },
          {
            "name": "lastPerformanceFeeAt",
            "docs": [
              "Last performance fee collection timestamp."
            ],
            "type": "i64"
          },
          {
            "name": "deployedCapital",
            "docs": [
              "Capital currently deployed to strategy positions, in micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "assetCount",
            "docs": [
              "Number of registered treasury assets (`TreasuryAsset` records)."
            ],
            "type": "u8"
          },
          {
            "name": "lastRevaluedAt",
            "docs": [
              "Unix timestamp of the last `revalue_treasury`. `0` means NAV has never",
              "been computed. Executable strategy deploys hard-block when this is `0`",
              "or older than the configured staleness window, so the USD-denominated",
              "allocation / deployment / reserve caps are always enforced against a",
              "fresh NAV rather than a stale snapshot."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultAuthority",
      "docs": [
        "Vault authority PDA used as CPI signer for treasury operations."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "dao",
            "docs": [
              "Owning DAO registry key."
            ],
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
