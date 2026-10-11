/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/nave_execution.json`.
 */
export type NaveExecution = {
  "address": "2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb",
  "metadata": {
    "name": "naveExecution",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Nave Finance execution program"
  },
  "instructions": [
    {
      "name": "createExecutionRequest",
      "discriminator": [
        78,
        158,
        203,
        32,
        231,
        122,
        140,
        188
      ],
      "accounts": [
        {
          "name": "creator",
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
          "name": "daoLifecycle",
          "docs": [
            "seeds; may be uninitialized (never moonlighted) — validated in handler."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  97,
                  111,
                  95,
                  108,
                  105,
                  102,
                  101,
                  99,
                  121,
                  99,
                  108,
                  101
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
          "name": "proposal"
        },
        {
          "name": "constitution",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  105,
                  116,
                  117,
                  116,
                  105,
                  111,
                  110
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
          "name": "executionRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  101,
                  99,
                  117,
                  116,
                  105,
                  111,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "proposal"
              }
            ]
          }
        },
        {
          "name": "naveCoreProgram",
          "docs": [
            "pinned to nave_core::ID. Required for `bootstrap = true`; pass for all",
            "calls (ignored when `bootstrap = false`)."
          ],
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "executionProgram",
          "docs": [
            "caller verification (mirrors the governance `record_proposal_creation`",
            "pattern). Address pinned to crate::ID."
          ],
          "address": "2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb"
        },
        {
          "name": "instructions",
          "docs": [
            "CPI so nave_core can verify (SEC-M4) that nave_execution is the top-level",
            "caller. Required for all calls; only consumed on the bootstrap path."
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
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "protocolProgram",
          "type": "pubkey"
        },
        {
          "name": "mint",
          "type": "pubkey"
        },
        {
          "name": "bootstrap",
          "type": "bool"
        }
      ]
    },
    {
      "name": "executeStrategy",
      "discriminator": [
        164,
        197,
        251,
        183,
        219,
        177,
        85,
        161
      ],
      "accounts": [
        {
          "name": "executor",
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
          "name": "daoLifecycle",
          "docs": [
            "seeds; may be uninitialized (never moonlighted) — validated in handler."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  97,
                  111,
                  95,
                  108,
                  105,
                  102,
                  101,
                  99,
                  121,
                  99,
                  108,
                  101
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
          "name": "constitution",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  105,
                  116,
                  117,
                  116,
                  105,
                  111,
                  110
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
          "name": "mint",
          "docs": [
            "Asset mint being deployed/withdrawn; keys the per-asset accounts."
          ]
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
          "name": "priceUpdate",
          "docs": [
            "verified in the handler. Ignored for stablecoins (pass any account)."
          ]
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "executionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  101,
                  99,
                  117,
                  116,
                  105,
                  111,
                  110,
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
            ]
          }
        },
        {
          "name": "adapterProgram"
        },
        {
          "name": "executionRequest",
          "writable": true
        },
        {
          "name": "strategyEscrow",
          "writable": true
        },
        {
          "name": "strategyPosition",
          "writable": true
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
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
        }
      ],
      "args": []
    },
    {
      "name": "executeStrategyDirect",
      "discriminator": [
        157,
        70,
        126,
        229,
        127,
        250,
        239,
        158
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "daoLifecycle",
          "docs": [
            "seeds; may be uninitialized (never moonlighted) — validated in handler."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  97,
                  111,
                  95,
                  108,
                  105,
                  102,
                  101,
                  99,
                  121,
                  99,
                  108,
                  101
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "constitution",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  105,
                  116,
                  117,
                  116,
                  105,
                  111,
                  110
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
          "name": "mint",
          "docs": [
            "Asset mint being deployed; keys the per-asset accounts."
          ]
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
          "name": "priceUpdate"
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "executionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  101,
                  99,
                  117,
                  116,
                  105,
                  111,
                  110,
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
            ]
          }
        },
        {
          "name": "adapterProgram"
        },
        {
          "name": "executionRequest",
          "writable": true
        },
        {
          "name": "strategyEscrow",
          "writable": true
        },
        {
          "name": "strategyPosition",
          "writable": true
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
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
        },
        {
          "name": "daoControl",
          "docs": [
            "guardian-locked). Owner checked by `DaoControl::is_guardian_locked`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  97,
                  111,
                  95,
                  99,
                  111,
                  110,
                  116,
                  114,
                  111,
                  108
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
        }
      ],
      "args": []
    },
    {
      "name": "executiveApprove",
      "discriminator": [
        67,
        228,
        138,
        187,
        180,
        35,
        7,
        77
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "executionRequest",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "reasoningHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "expireRequest",
      "docs": [
        "Transition an in-review request to Expired once its review window has",
        "elapsed without execution. Gated to the Operational agent (the monitoring",
        "role) so it cannot be used to grief a legitimately approved request."
      ],
      "discriminator": [
        219,
        189,
        105,
        97,
        227,
        47,
        124,
        23
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "executionRequest",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "financialApprove",
      "discriminator": [
        45,
        101,
        75,
        145,
        70,
        70,
        69,
        186
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "executionRequest",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "txPayloadHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "reasoningHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "operationalClear",
      "discriminator": [
        131,
        47,
        250,
        114,
        160,
        134,
        155,
        217
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "executionRequest",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "reasonHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "operationalHalt",
      "discriminator": [
        120,
        165,
        251,
        190,
        75,
        242,
        95,
        76
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "executionRequest",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "reasonHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "oversightApprove",
      "discriminator": [
        196,
        252,
        246,
        48,
        146,
        184,
        211,
        168
      ],
      "accounts": [
        {
          "name": "authority",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "executionRequest",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "txPayloadHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "reasoningHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "withdrawFromStrategy",
      "discriminator": [
        140,
        239,
        65,
        54,
        125,
        128,
        223,
        125
      ],
      "accounts": [
        {
          "name": "executor",
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
          "name": "agentSet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  115,
                  101,
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
          "name": "mint",
          "docs": [
            "Asset mint being deployed/withdrawn; keys the per-asset accounts."
          ]
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
          "name": "priceUpdate",
          "docs": [
            "verified in the handler. Ignored for stablecoins (pass any account)."
          ]
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "executionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  101,
                  99,
                  117,
                  116,
                  105,
                  111,
                  110,
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
            ]
          }
        },
        {
          "name": "adapterProgram"
        },
        {
          "name": "executionRequest",
          "writable": true
        },
        {
          "name": "strategyEscrow",
          "writable": true
        },
        {
          "name": "strategyPosition",
          "writable": true
        },
        {
          "name": "feeConfig",
          "docs": [
            "Fee configuration (nave_core) — forwarded to `record_strategy_withdrawal`",
            "so the 8.5% performance-fee skim can be taken on the realized yield."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
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
          "name": "revenueTokenAccount",
          "docs": [
            "Destination for the performance-fee skim: a token account owned by the",
            "configured protocol revenue wallet, for the withdrawn mint. Validated",
            "fully in nave_core; mint-checked here for early failure."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "naveCoreProgram",
          "address": "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB"
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
      "name": "agentSet",
      "discriminator": [
        64,
        143,
        27,
        120,
        116,
        66,
        19,
        37
      ]
    },
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
      "name": "executionRequest",
      "discriminator": [
        88,
        79,
        182,
        197,
        147,
        44,
        123,
        20
      ]
    },
    {
      "name": "feeConfig",
      "discriminator": [
        143,
        52,
        146,
        187,
        219,
        123,
        76,
        155
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
      "name": "treasuryConstitution",
      "discriminator": [
        170,
        252,
        208,
        183,
        251,
        143,
        245,
        80
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
      "name": "agentApprovalEvent",
      "discriminator": [
        1,
        192,
        171,
        255,
        70,
        231,
        78,
        99
      ]
    },
    {
      "name": "bootstrapExecutionRequestCreated",
      "discriminator": [
        128,
        212,
        41,
        126,
        108,
        171,
        66,
        96
      ]
    },
    {
      "name": "directStrategyExecutedEvent",
      "discriminator": [
        112,
        197,
        229,
        179,
        22,
        50,
        130,
        165
      ]
    },
    {
      "name": "executionExpiredEvent",
      "discriminator": [
        213,
        169,
        78,
        101,
        44,
        39,
        153,
        135
      ]
    },
    {
      "name": "executionRequestCreated",
      "discriminator": [
        15,
        254,
        21,
        255,
        72,
        250,
        154,
        181
      ]
    },
    {
      "name": "executiveApprovedEvent",
      "discriminator": [
        76,
        13,
        219,
        149,
        63,
        120,
        56,
        146
      ]
    },
    {
      "name": "financialApprovedEvent",
      "discriminator": [
        204,
        196,
        180,
        100,
        162,
        199,
        171,
        186
      ]
    },
    {
      "name": "operationalClearEvent",
      "discriminator": [
        226,
        9,
        188,
        168,
        39,
        6,
        82,
        153
      ]
    },
    {
      "name": "operationalHaltEvent",
      "discriminator": [
        141,
        147,
        32,
        220,
        14,
        64,
        202,
        198
      ]
    },
    {
      "name": "oversightApprovedEvent",
      "discriminator": [
        136,
        47,
        147,
        236,
        160,
        56,
        33,
        241
      ]
    },
    {
      "name": "strategyExecutedEvent",
      "discriminator": [
        84,
        225,
        104,
        36,
        107,
        101,
        186,
        217
      ]
    },
    {
      "name": "strategyWithdrawnEvent",
      "discriminator": [
        146,
        153,
        153,
        184,
        60,
        15,
        234,
        85
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
      "name": "agentsDisabled",
      "msg": "Agents are disabled"
    },
    {
      "code": 6003,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6004,
      "name": "invalidExecutionStatus",
      "msg": "Invalid execution status"
    },
    {
      "code": 6005,
      "name": "invalidStateTransition",
      "msg": "Invalid state transition"
    },
    {
      "code": 6006,
      "name": "payloadHashMismatch",
      "msg": "Payload hash mismatch"
    },
    {
      "code": 6007,
      "name": "reviewWindowActive",
      "msg": "Review window active"
    },
    {
      "code": 6008,
      "name": "protocolNotApproved",
      "msg": "Protocol not approved"
    },
    {
      "code": 6009,
      "name": "allocationLimitExceeded",
      "msg": "Allocation limit exceeded"
    },
    {
      "code": 6010,
      "name": "alreadyExecuted",
      "msg": "Already executed"
    },
    {
      "code": 6011,
      "name": "executionHalted",
      "msg": "Execution halted"
    },
    {
      "code": 6012,
      "name": "directExecutionNotAllowed",
      "msg": "Direct execution not allowed"
    },
    {
      "code": 6013,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6014,
      "name": "proposalNotPassed",
      "msg": "Proposal not passed"
    },
    {
      "code": 6015,
      "name": "proposalDaoMismatch",
      "msg": "Proposal DAO mismatch"
    },
    {
      "code": 6016,
      "name": "invalidProposalType",
      "msg": "Invalid proposal type"
    },
    {
      "code": 6017,
      "name": "insufficientVaultBalance",
      "msg": "Insufficient vault balance"
    },
    {
      "code": 6018,
      "name": "unsupportedAdapter",
      "msg": "Unsupported adapter program"
    },
    {
      "code": 6019,
      "name": "reasoningHashRequired",
      "msg": "Reasoning hash required"
    },
    {
      "code": 6020,
      "name": "escrowAccountMismatch",
      "msg": "Strategy escrow account does not match the canonical per-protocol PDA"
    },
    {
      "code": 6021,
      "name": "withdrawExceedsDeployed",
      "msg": "Withdrawal exceeds the amount deployed for this request"
    },
    {
      "code": 6022,
      "name": "deploymentCapExceeded",
      "msg": "Global deployment cap exceeded"
    },
    {
      "code": 6023,
      "name": "liquidityFloorBreached",
      "msg": "Liquidity floor breached"
    },
    {
      "code": 6024,
      "name": "invalidOracleAccount",
      "msg": "Pyth price update account is not owned by the receiver program"
    },
    {
      "code": 6025,
      "name": "staleOracle",
      "msg": "Pyth price is stale"
    },
    {
      "code": 6026,
      "name": "assetMintMismatch",
      "msg": "Asset mint does not match the execution request"
    },
    {
      "code": 6027,
      "name": "assetKindMismatch",
      "msg": "Asset kind is not compatible with the target protocol"
    },
    {
      "code": 6028,
      "name": "stablecoinReserveBreached",
      "msg": "Stablecoin reserve floor breached"
    },
    {
      "code": 6029,
      "name": "staleNav",
      "msg": "Treasury NAV is stale; a fresh revalue_treasury is required before deploying"
    },
    {
      "code": 6030,
      "name": "agentThresholdNotMet",
      "msg": "Treasury NAV is below the agent operating threshold"
    },
    {
      "code": 6031,
      "name": "daoMoonlighting",
      "msg": "DAO is moonlighting; new strategy deployments are blocked"
    }
  ],
  "types": [
    {
      "name": "agentApprovalEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "agentRole",
            "type": "u8"
          },
          {
            "name": "executionRequest",
            "type": "pubkey"
          },
          {
            "name": "reasoningHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentSet",
      "docs": [
        "Fixed four-role agent set for a DAO."
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
            "name": "agents",
            "docs": [
              "Exactly four agent roles."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "agentSlot"
                  }
                },
                4
              ]
            }
          },
          {
            "name": "agentsEnabled",
            "docs": [
              "Global agent enable flag."
            ],
            "type": "bool"
          },
          {
            "name": "pendingRotations",
            "docs": [
              "Pending rotations per agent role."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "pendingAgentRotation"
                  }
                },
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "agentSlot",
      "docs": [
        "Individual agent slot within a DAO agent set."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "role",
            "docs": [
              "Agent role discriminator."
            ],
            "type": "u8"
          },
          {
            "name": "authority",
            "docs": [
              "Agent authority pubkey."
            ],
            "type": "pubkey"
          },
          {
            "name": "active",
            "docs": [
              "Whether the agent is active."
            ],
            "type": "bool"
          },
          {
            "name": "nullified",
            "docs": [
              "Whether the agent has been nullified."
            ],
            "type": "bool"
          },
          {
            "name": "status",
            "docs": [
              "Operational status (0=Active, 1=Paused, 2=Revoked, 3=Rotating)."
            ],
            "type": "u8"
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
      "name": "bootstrapExecutionRequestCreated",
      "docs": [
        "Emitted when the FIRST (founder-gated, one-time) bootstrap execution request",
        "is created for a DAO. The request snapshots a zero review window for",
        "immediate execution. Lets off-chain indexers / the orchestrator detect the",
        "bootstrap request and fast-track its agent pipeline."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "requestIndex",
            "type": "u64"
          },
          {
            "name": "protocolProgram",
            "type": "pubkey"
          },
          {
            "name": "founder",
            "type": "pubkey"
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
      "name": "directStrategyExecutedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
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
      "name": "executionExpiredEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "executionRequest",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "executionRequest",
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
            "name": "requestIndex",
            "type": "u64"
          },
          {
            "name": "proposal",
            "type": "pubkey"
          },
          {
            "name": "protocolProgram",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "Asset mint this request deploys. Bound into the payload hash so the",
              "governance-approved proposal commits to (program, amount, mint)."
            ],
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "txPayloadHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "reviewEnd",
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "executiveReasoningHash",
            "docs": [
              "SHA-256 hash of the Executive agent's Claude reasoning JSON."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "financialReasoningHash",
            "docs": [
              "SHA-256 hash of the Financial agent's Claude reasoning JSON."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "oversightReasoningHash",
            "docs": [
              "SHA-256 hash of the Oversight agent's Claude reasoning JSON."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "operationalHaltReasonHash",
            "docs": [
              "SHA-256 hash of the Operational agent's halt reasoning JSON."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "withdrawnAmount",
            "docs": [
              "Cumulative amount already withdrawn from the strategy for this request.",
              "Caps repeatable withdrawals at `amount` so a fully-unwound position cannot",
              "be drained again. Appended at the end of the layout to preserve the byte",
              "offsets consumed by off-chain decoders. (NE-8)"
            ],
            "type": "u64"
          },
          {
            "name": "reviewWindow",
            "docs": [
              "Review window (seconds) snapshotted from the DAO constitution at request",
              "creation. Applied at the Oversight `InReview` transition to compute",
              "`review_end`. Snapshotting here freezes the human-oversight delay for the",
              "life of the request so a later constitution change cannot shorten it.",
              "Appended at the end of the layout to preserve existing byte offsets.",
              "For a bootstrap request this is snapshotted as `0`; the immediate",
              "(zero-delay) review window is driven by `bootstrap` below so the legacy",
              "`review_window == 0 -> 24h default` fallback is not triggered."
            ],
            "type": "i64"
          },
          {
            "name": "bootstrap",
            "docs": [
              "One-time founder bootstrap marker. When `true`, the Oversight transition",
              "uses a zero review window (immediate execution) instead of the",
              "snapshotted/legacy window. Set only by `create_execution_request` with",
              "`bootstrap = true`, which is founder-gated and consumes the DAO's",
              "one-time `dao_registry.bootstrap_used` latch via a nave_core CPI.",
              "Appended at the end of the layout to preserve existing byte offsets."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "executionRequestCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "requestIndex",
            "type": "u64"
          },
          {
            "name": "protocolProgram",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "executiveApprovedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "approver",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "feeConfig",
      "docs": [
        "Fee configuration with normal and frozen rates.",
        "",
        "Fee model (post-redesign):",
        "- Performance fee = `performance_fee_bps` (default 850 = 8.5%) of realized",
        "yield, skimmed on the strategy-withdrawal path straight into the",
        "`protocol_revenue_wallet`'s ATA for the withdrawn mint (it never touches",
        "the treasury balance). Replaces the old high-water-mark",
        "`collect_performance_fee` instruction, which was inert (Finding C).",
        "- Management fee = `management_fee_bps` (default 65 = 0.65%) of each",
        "registered treasury asset's idle balance, collected at most once per",
        "`SECONDS_PER_YEAR` and paid in-kind to the same",
        "`protocol_revenue_wallet` ATA for that mint."
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
            "name": "managementFeeBps",
            "docs": [
              "Management fee in basis points (default `DEFAULT_MANAGEMENT_FEE_BPS`, 65)."
            ],
            "type": "u16"
          },
          {
            "name": "performanceFeeBps",
            "docs": [
              "Performance fee in basis points (default `DEFAULT_PERFORMANCE_FEE_BPS`,",
              "850). Applied to realized yield on withdrawal."
            ],
            "type": "u16"
          },
          {
            "name": "frozenManagementFeeBps",
            "docs": [
              "Frozen-state management fee in basis points."
            ],
            "type": "u16"
          },
          {
            "name": "frozenPerformanceFeeBps",
            "docs": [
              "Frozen-state performance fee in basis points."
            ],
            "type": "u16"
          },
          {
            "name": "feeRecipient",
            "docs": [
              "LEGACY (pre-redesign): SPL token account that the old USD-denominated",
              "`collect_*_fee` paths paid into. Retained for account-layout stability;",
              "the new model pays to the `protocol_revenue_wallet`'s ATA per mint",
              "instead. No longer read by the fee instructions."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeAssetMint",
            "docs": [
              "LEGACY (pre-redesign): mint of the stablecoin USD-denominated fees were",
              "paid in. Retained for layout stability; unused by the in-kind fee model."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolRevenueWallet",
            "docs": [
              "Protocol revenue wallet (the SYSTEM/owner account, NOT a token account).",
              "Destination for BOTH the performance-fee skim and the annual management",
              "fee: each fee is paid to this wallet's associated token account for the",
              "relevant mint. Also funds off-chain agent-wallet replenishment (consumed",
              "by the off-chain worker). Must be set at DAO creation."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "financialApprovedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "approver",
            "type": "pubkey"
          },
          {
            "name": "txPayloadHash",
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
      "name": "operationalClearEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "reasonHash",
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
      "name": "operationalHaltEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dao",
            "type": "pubkey"
          },
          {
            "name": "executionRequest",
            "type": "pubkey"
          },
          {
            "name": "reasonHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "oversightApprovedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "approver",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pendingAgentRotation",
      "docs": [
        "Pending agent authority rotation awaiting timelock."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pendingAuthority",
            "docs": [
              "Proposed new authority pubkey."
            ],
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "docs": [
              "Unix timestamp when rotation becomes effective."
            ],
            "type": "i64"
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
      "name": "protocolEntry",
      "docs": [
        "Approved protocol entry within a DAO constitution."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "protocolId",
            "docs": [
              "Fixed-size protocol identifier bytes."
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
            "name": "programId",
            "docs": [
              "Target program id for CPI."
            ],
            "type": "pubkey"
          },
          {
            "name": "maxAllocationBps",
            "docs": [
              "Maximum allocation in basis points, with the venue risk tier packed into",
              "the two high bits. Read through `allocation_bps` / `risk_tier`."
            ],
            "type": "u16"
          },
          {
            "name": "approved",
            "docs": [
              "Whether the protocol is approved."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "strategyExecutedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
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
      "name": "strategyWithdrawnEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "request",
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
      "name": "treasuryConstitution",
      "docs": [
        "Treasury constitution defining approved DeFi protocols."
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
            "name": "protocolCount",
            "docs": [
              "Active protocol count."
            ],
            "type": "u8"
          },
          {
            "name": "protocols",
            "docs": [
              "Fixed-size protocol entries."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "protocolEntry"
                  }
                },
                10
              ]
            }
          },
          {
            "name": "confidenceThreshold",
            "docs": [
              "Minimum Claude reasoning confidence (0-100) an agent must report",
              "before the off-chain agent service will proceed with signing."
            ],
            "type": "u8"
          },
          {
            "name": "reviewWindowSecs",
            "docs": [
              "Mandatory on-chain review window (seconds) between Oversight approval",
              "(InReview) and `execute_strategy`. Governance-controlled per DAO so the",
              "human-oversight delay can be tuned (production default 24h); snapshotted",
              "onto each ExecutionRequest at creation so it cannot change mid-flight."
            ],
            "type": "i64"
          },
          {
            "name": "minStablecoinReserveBps",
            "docs": [
              "Continuous treasury policy: minimum portfolio share (bps) that must be",
              "held as stablecoin reserve at all times. `0` means unset (legacy",
              "accounts) and disables the floor. Enforced off-chain by the deterministic",
              "guardrails because the single-mint vault accounting cannot prove",
              "multi-asset composition on-chain yet (multi-asset treasury milestone).",
              "Appended at the end of the layout to preserve existing byte offsets."
            ],
            "type": "u16"
          },
          {
            "name": "maxTotalDeployedBps",
            "docs": [
              "Continuous treasury policy: maximum portfolio share (bps) that may be",
              "deployed across all approved strategies combined. `0` means unset and",
              "disables the explicit global cap (per-protocol caps still apply).",
              "Enforced on-chain at request creation and execution against vault NAV."
            ],
            "type": "u16"
          },
          {
            "name": "minLiquidityBps",
            "docs": [
              "Continuous treasury policy: minimum portfolio share (bps) that must",
              "remain immediately liquid (not deployed). `0` means unset and disables",
              "the floor. Enforced on-chain against vault NAV."
            ],
            "type": "u16"
          },
          {
            "name": "rebalanceFrequencySecs",
            "docs": [
              "Continuous treasury policy: rebalance cadence in seconds — how often the",
              "agents exit positions, realize profit, and re-establish allocations.",
              "`0` means unset (no cadence). Used by the off-chain policy loop to gate",
              "rebalance-due eligibility."
            ],
            "type": "i64"
          },
          {
            "name": "lastRebalanceAt",
            "docs": [
              "Unix timestamp of the last completed rebalance cycle. Maintained by the",
              "agent pipeline; combined with `rebalance_frequency_secs` to determine",
              "when the next rebalance is due. `0` until the first rebalance."
            ],
            "type": "i64"
          },
          {
            "name": "agentThresholdUsd",
            "docs": [
              "Minimum treasury NAV in micro-USD (USD_SCALE=1e6) required before agents",
              "may deploy/swap. Compared against treasury_vault.current_nav. 0 disables",
              "the gate."
            ],
            "type": "u64"
          },
          {
            "name": "maxSlippageBps",
            "docs": [
              "Maximum allowed slippage (bps) for `jupiter_swap`, enforced against the",
              "caller-supplied `expected_amount_out` in addition to the actual",
              "`min_amount_out` floor already checked against realized output. `0`",
              "means unset and disables this additional guardrail (the swap still",
              "enforces the caller-supplied `min_amount_out`, unchanged). Founder-set",
              "via `set_max_slippage_bps`. Appended at the end to preserve existing",
              "byte offsets."
            ],
            "type": "u16"
          },
          {
            "name": "maxSingleSwapBps",
            "docs": [
              "Maximum single `jupiter_swap` call size, in bps of the pre-swap balance",
              "of the asset being sold (`mint_in`). `jupiter_swap` is Operational-agent",
              "gated with no prior multi-agent-approval/review-window step (unlike",
              "deposits into Kamino/Jito/MarginFi, which can only move funds already",
              "escrowed via a governance-approved `execute_strategy`) — this is the",
              "on-chain backstop bounding how much of a single asset one Operational",
              "agent signature can move in one call. `0` means unset and disables the",
              "cap (existing DAOs are unaffected until the founder opts in via",
              "`set_max_single_swap_bps`). Appended at the end to preserve existing",
              "byte offsets."
            ],
            "type": "u16"
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
