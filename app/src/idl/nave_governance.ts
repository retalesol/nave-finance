/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/nave_governance.json`.
 */
export type NaveGovernance = {
  "address": "CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M",
  "metadata": {
    "name": "naveGovernance",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Nave Finance governance program"
  },
  "instructions": [
    {
      "name": "cancelProposal",
      "discriminator": [
        106,
        74,
        128,
        146,
        19,
        65,
        39,
        23
      ],
      "accounts": [
        {
          "name": "proposer",
          "signer": true
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "proposal",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "castVoteWallet",
      "discriminator": [
        13,
        252,
        37,
        252,
        184,
        166,
        21,
        237
      ],
      "accounts": [
        {
          "name": "voter",
          "writable": true,
          "signer": true
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "guardianConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  97,
                  114,
                  100,
                  105,
                  97,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
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
          "name": "proposal",
          "writable": true
        },
        {
          "name": "voteRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  116,
                  101,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "proposal"
              },
              {
                "kind": "account",
                "path": "voter"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "choice",
          "type": "u8"
        }
      ]
    },
    {
      "name": "createProposal",
      "discriminator": [
        132,
        116,
        68,
        174,
        216,
        160,
        198,
        22
      ],
      "accounts": [
        {
          "name": "proposer",
          "writable": true,
          "signer": true
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "daoRegistry",
          "writable": true,
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "dao_registry.next_proposal_index",
                "account": "daoRegistry"
              }
            ]
          }
        },
        {
          "name": "daoTokenMint"
        },
        {
          "name": "tokenRegistry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
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
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "governanceProgram",
          "address": "CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M"
        },
        {
          "name": "instructions",
          "docs": [
            "for CPI caller verification."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "createProposalParams"
            }
          }
        }
      ]
    },
    {
      "name": "executePermissionProposal",
      "docs": [
        "Execute a passed `Permission` proposal: replace guardian wallets +",
        "threshold. CPIs into `nave_core::apply_guardian_config_from_governance`,",
        "which decodes `(threshold, wallets)` from this proposal's bound payload",
        "and latches `GuardianConfig.bootstrapped`. Marks the proposal `Executed`",
        "immediately after the CPI so it cannot be replayed."
      ],
      "discriminator": [
        195,
        31,
        18,
        46,
        207,
        243,
        85,
        27
      ],
      "accounts": [
        {
          "name": "executor",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "guardianConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  97,
                  114,
                  100,
                  105,
                  97,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "proposal.proposal_index",
                "account": "proposal"
              }
            ]
          }
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        }
      ],
      "args": []
    },
    {
      "name": "executeSwitchVotingSystem",
      "docs": [
        "Execute a passed `SwitchVotingSystem` proposal (SOL-C2). CPIs into",
        "`nave_core::switch_voting_system`, which itself decodes the target",
        "governance configuration straight from this proposal's payload",
        "(verified via `nave_core`'s instructions-sysvar CPI-caller check) —",
        "mirrors `execute_treasury_transfer_*` above. Marks the proposal",
        "`Executed` immediately after the CPI so it can never be replayed."
      ],
      "discriminator": [
        32,
        167,
        250,
        171,
        193,
        12,
        36,
        206
      ],
      "accounts": [
        {
          "name": "executor",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "daoRegistry",
          "writable": true,
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
          "name": "guardianConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  97,
                  114,
                  100,
                  105,
                  97,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
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
          "name": "tokenRegistry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "proposal.proposal_index",
                "account": "proposal"
              }
            ]
          }
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        }
      ],
      "args": []
    },
    {
      "name": "executeTreasuryTransferNativeSol",
      "docs": [
        "Execute a passed native-SOL transfer proposal (payload mint = 32 zero bytes)."
      ],
      "discriminator": [
        57,
        18,
        0,
        108,
        98,
        23,
        116,
        45
      ],
      "accounts": [
        {
          "name": "executor",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "proposal.proposal_index",
                "account": "proposal"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "writable": true,
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
          "docs": [
            "Passed through to nave_core so it can invalidate last_revalued_at after",
            "the transfer, forcing a fresh revaluation before the next deploy."
          ],
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
          "name": "recipient",
          "writable": true
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "executeTreasuryTransferNft",
      "docs": [
        "Execute a passed NFT transfer proposal (registered `NftVaultRecord` mint)."
      ],
      "discriminator": [
        31,
        12,
        38,
        220,
        178,
        105,
        122,
        241
      ],
      "accounts": [
        {
          "name": "executor",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "proposal.proposal_index",
                "account": "proposal"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "writable": true,
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
          "name": "mint"
        },
        {
          "name": "nftRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  102,
                  116,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
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
          "name": "nftVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  102,
                  116,
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
          "name": "recipient"
        },
        {
          "name": "recipientToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
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
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "executeTreasuryTransferSpl",
      "docs": [
        "Execute a passed SPL transfer proposal (registered treasury asset mint)."
      ],
      "discriminator": [
        217,
        207,
        143,
        55,
        13,
        174,
        21,
        235
      ],
      "accounts": [
        {
          "name": "executor",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "proposal.proposal_index",
                "account": "proposal"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "writable": true,
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
          "name": "mint"
        },
        {
          "name": "assetConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
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
          "name": "treasuryAsset",
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
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
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
          "name": "treasuryVault",
          "docs": [
            "Passed through to nave_core so it can invalidate last_revalued_at after",
            "the transfer, forcing a fresh revaluation before the next deploy."
          ],
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
          "name": "assetVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
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
          "name": "recipient"
        },
        {
          "name": "recipientToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
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
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "finalizeProposal",
      "discriminator": [
        23,
        68,
        51,
        167,
        109,
        173,
        187,
        164
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
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
          "name": "guardianConfig",
          "docs": [
            "Used for early-finalization eligible-voter calculation in wallet-governance",
            "DAOs (where snapshot_supply == 0). For token governance, this account is",
            "still required but guardian_config.wallet_count is not used."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  97,
                  114,
                  100,
                  105,
                  97,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
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
          "name": "proposal",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "lockTokensAndVote",
      "discriminator": [
        244,
        255,
        209,
        86,
        167,
        106,
        153,
        186
      ],
      "accounts": [
        {
          "name": "voter",
          "writable": true,
          "signer": true
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "proposal",
          "writable": true
        },
        {
          "name": "daoTokenMint",
          "docs": [
            "Must be the governance mint snapshotted on the proposal at creation —",
            "a caller-supplied arbitrary mint could otherwise buy unbounded weight."
          ]
        },
        {
          "name": "voterTokenAccount",
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "writable": true
        },
        {
          "name": "voteEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  116,
                  101,
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
                "path": "proposal"
              },
              {
                "kind": "account",
                "path": "voter"
              }
            ]
          }
        },
        {
          "name": "voteRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  116,
                  101,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "proposal"
              },
              {
                "kind": "account",
                "path": "voter"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "choice",
          "type": "u8"
        }
      ]
    },
    {
      "name": "markMoonlightProposalExecuted",
      "docs": [
        "Mark a `MoonlightRequest`/`MoonlightDistribution` proposal `Executed` so",
        "it can never be replayed. Unlike `Transfer`/`TokenMint` proposals — whose",
        "SOLE entry point is a `nave_governance` instruction that flips",
        "`status = Executed` itself right after the CPI — moonlighting's entry",
        "point is `nave_core`'s own instructions (`record_moonlight_request`,",
        "`execute_moonlight_distribution`), which only ever READ this proposal's",
        "raw account bytes and have no way to mutate a `nave_governance`-owned",
        "account directly. Without this, the exact same `Passed` proposal pair",
        "could be fed into those handlers again after a `restore_dao` cycle,",
        "re-triggering moonlighting without a fresh vote (P6-3 in",
        "`docs/AUDIT_FINDINGS.md`). Callable ONLY as a CPI from `nave_core`",
        "(verified via the instructions-sysvar top-level-caller check, the same",
        "pattern `nave_core::verify_governance_caller` uses in the other",
        "direction) — `nave_core`'s moonlight handlers call this immediately",
        "after validating each proposal, before advancing the lifecycle."
      ],
      "discriminator": [
        197,
        174,
        240,
        144,
        29,
        209,
        125,
        219
      ],
      "accounts": [
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
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
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "proposal.proposal_index",
                "account": "proposal"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "mintAdditionalTokens",
      "discriminator": [
        145,
        232,
        211,
        225,
        5,
        19,
        26,
        15
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "tokenRegistry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
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
          "name": "proposal",
          "docs": [
            "The passed TokenMint proposal authorizing this mint. REQUIRED for every",
            "post-genesis mint (audit M11) so a founder cannot mint outside a ratified",
            "governance vote. It is omitted ONLY for the one-time genesis supply mint",
            "(when the mint currently has zero supply and no governance exists yet).",
            "Boxed to keep the large Proposal payload off the BPF stack."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "genesisRecord",
          "docs": [
            "SEC-M3: persistent per-(dao, mint) genesis latch. `init_if_needed` so the",
            "first-ever mint for a token creates it; once `minted` is set, the ungated",
            "genesis path can never re-open (even after a burn-to-zero)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  103,
                  101,
                  110,
                  101,
                  115,
                  105,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "daoRegistry"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "instructions",
          "docs": [
            "CPI so it can verify nave_governance is the top-level caller."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "naveCoreProgram",
          "docs": [
            "mint authority belongs to nave_core)."
          ],
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
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
      "name": "releaseVoteEscrow",
      "discriminator": [
        228,
        119,
        63,
        32,
        239,
        52,
        149,
        34
      ],
      "accounts": [
        {
          "name": "voter",
          "signer": true
        },
        {
          "name": "globalConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "proposal"
        },
        {
          "name": "voteEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  116,
                  101,
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
                "path": "proposal"
              },
              {
                "kind": "account",
                "path": "voter"
              }
            ]
          }
        },
        {
          "name": "escrowTokenAccount",
          "writable": true
        },
        {
          "name": "voterTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "assetConfig",
      "discriminator": [
        57,
        112,
        247,
        166,
        247,
        64,
        140,
        23
      ]
    },
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
      "name": "guardianConfig",
      "discriminator": [
        253,
        92,
        160,
        221,
        64,
        253,
        141,
        121
      ]
    },
    {
      "name": "naveGlobalConfig",
      "discriminator": [
        20,
        11,
        3,
        106,
        198,
        98,
        48,
        105
      ]
    },
    {
      "name": "nftVaultRecord",
      "discriminator": [
        132,
        134,
        124,
        200,
        161,
        241,
        187,
        64
      ]
    },
    {
      "name": "proposal",
      "discriminator": [
        26,
        94,
        189,
        187,
        116,
        136,
        53,
        33
      ]
    },
    {
      "name": "tokenGenesisRecord",
      "discriminator": [
        251,
        170,
        163,
        70,
        103,
        87,
        248,
        15
      ]
    },
    {
      "name": "tokenRegistry",
      "discriminator": [
        227,
        255,
        152,
        118,
        84,
        200,
        145,
        120
      ]
    },
    {
      "name": "treasuryAsset",
      "discriminator": [
        255,
        23,
        38,
        43,
        200,
        65,
        202,
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
    },
    {
      "name": "voteEscrow",
      "discriminator": [
        242,
        251,
        110,
        92,
        198,
        238,
        144,
        106
      ]
    },
    {
      "name": "voteRecord",
      "discriminator": [
        112,
        9,
        123,
        165,
        234,
        9,
        157,
        167
      ]
    }
  ],
  "events": [
    {
      "name": "additionalTokensMinted",
      "discriminator": [
        166,
        188,
        237,
        101,
        180,
        61,
        10,
        249
      ]
    },
    {
      "name": "daoTokenMinted",
      "discriminator": [
        195,
        25,
        172,
        172,
        59,
        87,
        93,
        152
      ]
    },
    {
      "name": "executionRequestQueued",
      "discriminator": [
        192,
        237,
        127,
        162,
        96,
        180,
        102,
        120
      ]
    },
    {
      "name": "proposalCancelled",
      "discriminator": [
        253,
        59,
        104,
        46,
        129,
        78,
        9,
        14
      ]
    },
    {
      "name": "proposalCreated",
      "discriminator": [
        186,
        8,
        160,
        108,
        81,
        13,
        51,
        206
      ]
    },
    {
      "name": "proposalFinalized",
      "discriminator": [
        159,
        104,
        210,
        220,
        86,
        209,
        61,
        51
      ]
    },
    {
      "name": "tokenAuthorityRevoked",
      "discriminator": [
        54,
        58,
        122,
        43,
        92,
        111,
        225,
        6
      ]
    },
    {
      "name": "tokenMetadataUpdated",
      "discriminator": [
        61,
        64,
        22,
        85,
        194,
        80,
        154,
        40
      ]
    },
    {
      "name": "voteCast",
      "discriminator": [
        39,
        53,
        195,
        104,
        188,
        17,
        225,
        213
      ]
    },
    {
      "name": "voteEscrowLocked",
      "discriminator": [
        180,
        17,
        68,
        241,
        96,
        143,
        2,
        204
      ]
    },
    {
      "name": "voteEscrowReleased",
      "discriminator": [
        127,
        71,
        222,
        51,
        86,
        206,
        115,
        110
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "globalPaused",
      "msg": "Global protocol is paused"
    },
    {
      "code": 6001,
      "name": "daoFrozen",
      "msg": "DAO is frozen"
    },
    {
      "code": 6002,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6003,
      "name": "daoOwnershipMismatch",
      "msg": "DAO ownership mismatch"
    },
    {
      "code": 6004,
      "name": "maxProposalsReached",
      "msg": "Max proposals reached"
    },
    {
      "code": 6005,
      "name": "invalidProposalType",
      "msg": "Invalid proposal type"
    },
    {
      "code": 6006,
      "name": "invalidProposalStatus",
      "msg": "Invalid proposal status"
    },
    {
      "code": 6007,
      "name": "invalidVoteChoice",
      "msg": "Invalid vote choice"
    },
    {
      "code": 6008,
      "name": "proposalNotActive",
      "msg": "Proposal not active"
    },
    {
      "code": 6009,
      "name": "proposalAlreadyFinalized",
      "msg": "Proposal already finalized"
    },
    {
      "code": 6010,
      "name": "votingPeriodEnded",
      "msg": "Voting period ended"
    },
    {
      "code": 6011,
      "name": "votingPeriodNotEnded",
      "msg": "Voting period not ended"
    },
    {
      "code": 6012,
      "name": "alreadyVoted",
      "msg": "Already voted"
    },
    {
      "code": 6013,
      "name": "guardianRequired",
      "msg": "Guardian membership required for wallet voting"
    },
    {
      "code": 6014,
      "name": "tokenNotInRegistry",
      "msg": "Token not in registry"
    },
    {
      "code": 6015,
      "name": "tokenRegistryFull",
      "msg": "Token registry full"
    },
    {
      "code": 6016,
      "name": "authorityAlreadyRevoked",
      "msg": "Token authority already revoked"
    },
    {
      "code": 6017,
      "name": "escrowNotLocked",
      "msg": "Escrow not locked"
    },
    {
      "code": 6018,
      "name": "escrowStillLocked",
      "msg": "Escrow still locked"
    },
    {
      "code": 6019,
      "name": "invalidTitleLength",
      "msg": "Invalid title length"
    },
    {
      "code": 6020,
      "name": "invalidDescriptionLength",
      "msg": "Invalid description length"
    },
    {
      "code": 6021,
      "name": "invalidPayloadLength",
      "msg": "Invalid payload length"
    },
    {
      "code": 6022,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6023,
      "name": "insufficientEscrowBalance",
      "msg": "Insufficient escrow balance"
    },
    {
      "code": 6024,
      "name": "quorumNotMet",
      "msg": "Quorum not met"
    },
    {
      "code": 6025,
      "name": "tokenMintNotRegistered",
      "msg": "Token mint not registered"
    },
    {
      "code": 6026,
      "name": "wrongGovernanceMode",
      "msg": "Wrong governance mode for this voting method"
    },
    {
      "code": 6027,
      "name": "proposalTypeNotImplemented",
      "msg": "Proposal type has no execution path and cannot be created"
    },
    {
      "code": 6028,
      "name": "payloadMismatch",
      "msg": "Mint/destination/amount does not match the proposal payload"
    },
    {
      "code": 6029,
      "name": "invalidVotingPeriod",
      "msg": "Voting period out of allowed bounds"
    },
    {
      "code": 6030,
      "name": "votingMintMismatch",
      "msg": "Token mint does not match the proposal's governance voting mint"
    }
  ],
  "types": [
    {
      "name": "additionalTokensMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "mint",
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
      "name": "assetConfig",
      "docs": [
        "Per-(dao, mint) configuration for a treasury-eligible asset. Governs how the",
        "asset is valued in USD on-chain (Pyth feed + decimals) and how the agent",
        "pipeline is allowed to route it (asset_kind). Distinct from `TokenRegistry`,",
        "which tracks tokens the DAO itself *issues* rather than *holds*."
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
              "SPL mint of the held asset."
            ],
            "type": "pubkey"
          },
          {
            "name": "decimals",
            "docs": [
              "Mint decimals (cached for valuation math)."
            ],
            "type": "u8"
          },
          {
            "name": "pythFeedId",
            "docs": [
              "Pyth price-feed id (32-byte feed id, NOT a price account address). Used",
              "with `get_price_no_older_than` to value the asset in USD. May be all",
              "zeroes for stablecoins valued at a hard $1."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "isStablecoin",
            "docs": [
              "Whether the asset is a USD-pegged stablecoin valued at exactly $1."
            ],
            "type": "bool"
          },
          {
            "name": "assetKind",
            "docs": [
              "`AssetKind` discriminant for protocol routing."
            ],
            "type": "u8"
          },
          {
            "name": "enabled",
            "docs": [
              "Whether the asset is currently enabled for deposits/deployment."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "createProposalParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "title",
            "type": "string"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "payload",
            "type": "bytes"
          },
          {
            "name": "proposalType",
            "type": "u8"
          },
          {
            "name": "votingPeriodSeconds",
            "type": "i64"
          }
        ]
      }
    },
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
      "name": "daoTokenMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "executionRequestQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "payloadHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "guardianConfig",
      "docs": [
        "Guardian multisig configuration for a DAO."
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
            "name": "threshold",
            "docs": [
              "Required signatures for guardian actions."
            ],
            "type": "u8"
          },
          {
            "name": "walletCount",
            "docs": [
              "Active guardian wallet count."
            ],
            "type": "u8"
          },
          {
            "name": "wallets",
            "docs": [
              "Fixed-size guardian wallet list."
            ],
            "type": {
              "array": [
                "pubkey",
                10
              ]
            }
          },
          {
            "name": "bootstrapped",
            "docs": [
              "False until the founder completes the ActivationHub one-shot guardian",
              "edit (or the first Permission proposal executes). After true, only a",
              "passed `ProposalType::Permission` governance path may change the set.",
              "Appended at the END of the layout to preserve byte offsets for",
              "off-chain decoders; legacy accounts omit this byte until resized."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "naveGlobalConfig",
      "docs": [
        "Global protocol configuration singleton."
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
            "name": "authority",
            "docs": [
              "Protocol admin authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "docs": [
              "Treasury receiving formation fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Whether all protocol activity is paused."
            ],
            "type": "bool"
          },
          {
            "name": "formationFeeLamports",
            "docs": [
              "Lamports required to initialize a DAO."
            ],
            "type": "u64"
          },
          {
            "name": "daoCount",
            "docs": [
              "Monotonic DAO identifier counter."
            ],
            "type": "u64"
          },
          {
            "name": "naveMint",
            "docs": [
              "Canonical NAVE SPL mint accepted for the DAO creation stake on this",
              "cluster (mainnet real mint / devnet replica). Occupies the 32 bytes that",
              "were previously `reserved`, so the account byte layout is unchanged;",
              "legacy configs read this as the zero pubkey (\"unset\"), in which case the",
              "stake instruction accepts any mint until `set_nave_mint` pins it."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "nftVaultRecord",
      "docs": [
        "Per-(dao, nft_mint) custody record for a treasury-held NFT.",
        "",
        "NFTs are held in a dedicated `nft_vault` token account owned by the DAO's",
        "`vault_authority` PDA. Unlike fungible `TreasuryAsset`s, NFTs are NOT priced",
        "(no Pyth feed) and do NOT count against the fungible asset cap — they are",
        "custodied at $0 NAV and leave only through a passed governance Transfer",
        "proposal (`execute_governance_transfer_nft`)."
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
              "NFT mint (decimals 0, supply 1)."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "docs": [
              "The `nft_vault` holding token account (owned by vault_authority)."
            ],
            "type": "pubkey"
          },
          {
            "name": "transferred",
            "docs": [
              "True once the NFT has been transferred out via governance. A transferred",
              "record is retained for audit but blocks a second governance transfer."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "proposal",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "proposalIndex",
            "type": "u64"
          },
          {
            "name": "proposer",
            "type": "pubkey"
          },
          {
            "name": "proposalType",
            "type": "u8"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "title",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "titleLen",
            "type": "u8"
          },
          {
            "name": "description",
            "type": {
              "array": [
                "u8",
                512
              ]
            }
          },
          {
            "name": "descriptionLen",
            "type": "u16"
          },
          {
            "name": "payload",
            "type": {
              "array": [
                "u8",
                512
              ]
            }
          },
          {
            "name": "payloadLen",
            "type": "u16"
          },
          {
            "name": "payloadHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "snapshotSlot",
            "type": "u64"
          },
          {
            "name": "snapshotSupply",
            "type": "u64"
          },
          {
            "name": "votesFor",
            "type": "u64"
          },
          {
            "name": "votesAgainst",
            "type": "u64"
          },
          {
            "name": "votesAbstain",
            "type": "u64"
          },
          {
            "name": "votingEnd",
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "finalizedAt",
            "type": "i64"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Governance token mint this proposal is voted with. Snapshotted from",
              "`dao_registry.voting_token` at creation for token-weighted DAOs and",
              "enforced by `lock_tokens_and_vote` (`dao_token_mint` MUST equal this),",
              "so a voter cannot supply an arbitrary attacker-minted token to buy",
              "unbounded voting weight. `Pubkey::default()` for wallet-governed DAOs",
              "(which never lock tokens). Appended at the END of the layout so the",
              "byte offsets consumed by `nave_core::GovernanceProposalLayout` and",
              "off-chain decoders are preserved."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "proposalCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposal",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "proposalCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "proposalIndex",
            "type": "u64"
          },
          {
            "name": "proposalType",
            "type": "u8"
          },
          {
            "name": "snapshotSlot",
            "type": "u64"
          },
          {
            "name": "snapshotSupply",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "proposalFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "votesFor",
            "type": "u64"
          },
          {
            "name": "votesAgainst",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenAuthorityRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "tokenGenesisRecord",
      "docs": [
        "SEC-M3: persistent per-(dao, mint) record that the one-time ungated",
        "\"genesis\" supply mint has been consumed. `mint_additional_tokens` previously",
        "re-derived `is_genesis = mint.supply == 0` on every call, so a founder",
        "controlling 100% of supply could burn it all to zero and repeat the ungated",
        "genesis mint indefinitely. Once ANY mint (genesis or a passed-proposal mint)",
        "runs for a token, `minted` is latched true here and every subsequent mint —",
        "regardless of the mint's current supply — must go through the passed",
        "`TokenMint` proposal path."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "minted",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "tokenMetadataUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "tokenRegistry",
      "docs": [
        "DAO token registry (max 3 tokens)."
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
            "name": "tokenCount",
            "docs": [
              "Active token count."
            ],
            "type": "u8"
          },
          {
            "name": "tokens",
            "docs": [
              "Fixed-size token slots."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "tokenSlot"
                  }
                },
                3
              ]
            }
          }
        ]
      }
    },
    {
      "name": "tokenSlot",
      "docs": [
        "Token slot within a DAO token registry."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "docs": [
              "SPL token mint."
            ],
            "type": "pubkey"
          },
          {
            "name": "authorityRevoked",
            "docs": [
              "Whether mint authority has been revoked."
            ],
            "type": "bool"
          },
          {
            "name": "decimals",
            "docs": [
              "Token decimals."
            ],
            "type": "u8"
          },
          {
            "name": "name",
            "docs": [
              "Fixed-size token name."
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
            "name": "symbol",
            "docs": [
              "Fixed-size token symbol."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "symbolLen",
            "docs": [
              "Active symbol length."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "treasuryAsset",
      "docs": [
        "Per-(dao, mint) treasury accounting record. Each held asset has its own",
        "holding token account (the `asset_vault` PDA owned by `vault_authority`) and",
        "tracks principal in that asset's base units. Portfolio-level USD aggregates",
        "live on `TreasuryVault`; this record holds the raw token figures that the",
        "`revalue_treasury` instruction prices into USD."
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
              "SPL mint of the held asset."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "docs": [
              "The `asset_vault` holding token account (owned by vault_authority)."
            ],
            "type": "pubkey"
          },
          {
            "name": "deposited",
            "docs": [
              "Cumulative deposits in base units."
            ],
            "type": "u64"
          },
          {
            "name": "deployedCapital",
            "docs": [
              "Capital currently deployed to strategies in base units (sum across",
              "protocols for this mint)."
            ],
            "type": "u64"
          },
          {
            "name": "lastValuedUsd",
            "docs": [
              "USD micro-units value of this asset (idle + deployed) at the last",
              "`revalue_treasury`. Diagnostic / reconciliation aid."
            ],
            "type": "u64"
          },
          {
            "name": "lastValuedAt",
            "docs": [
              "Timestamp of the last valuation."
            ],
            "type": "i64"
          },
          {
            "name": "lastManagementFeeAt",
            "docs": [
              "Accounting anchor for the discrete annual management fee, floored to a",
              "midnight-UTC boundary. The fee becomes due when",
              "`now >= last_management_fee_at + SECONDS_PER_YEAR`; on collection this is",
              "advanced to `floor_to_utc_midnight(now)`. Seeded at asset registration so",
              "the first period is anchored to (the UTC midnight of) registration time.",
              "Per-asset (not vault-level) so each asset's annual cycle is independent."
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
    },
    {
      "name": "voteCast",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "voter",
            "type": "pubkey"
          },
          {
            "name": "choice",
            "type": "u8"
          },
          {
            "name": "method",
            "type": "u8"
          },
          {
            "name": "weight",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "voteEscrow",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "voter",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "escrowTokenAccount",
            "type": "pubkey"
          },
          {
            "name": "lockedAmount",
            "type": "u64"
          },
          {
            "name": "released",
            "type": "bool"
          },
          {
            "name": "lockedAt",
            "type": "i64"
          },
          {
            "name": "releasedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "voteEscrowLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "voter",
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
      "name": "voteEscrowReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "voter",
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
      "name": "voteRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "voter",
            "type": "pubkey"
          },
          {
            "name": "choice",
            "type": "u8"
          },
          {
            "name": "method",
            "type": "u8"
          },
          {
            "name": "weight",
            "type": "u64"
          },
          {
            "name": "votedAt",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
