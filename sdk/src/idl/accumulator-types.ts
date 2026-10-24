/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/accumulator.json`.
 */
export type Accumulator = {
  "address": "BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y",
  "metadata": {
    "name": "accumulator",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Accumulator — isolated lend/borrow markets on X1"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "accrueInterest",
      "discriminator": [
        47,
        40,
        115,
        198,
        91,
        12,
        222,
        49
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "applyParams",
      "discriminator": [
        188,
        203,
        86,
        124,
        178,
        34,
        133,
        116
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "applyTreasury",
      "discriminator": [
        226,
        18,
        133,
        106,
        27,
        32,
        83,
        204
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "borrow",
      "discriminator": [
        228,
        253,
        131,
        202,
        207,
        116,
        89,
        18
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "obligation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  108,
                  105,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "lendMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "lendTokenProgram"
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
      "name": "cancelParams",
      "discriminator": [
        100,
        172,
        113,
        60,
        25,
        68,
        80,
        172
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "closeObligation",
      "discriminator": [
        178,
        182,
        18,
        237,
        158,
        158,
        51,
        124
      ],
      "accounts": [
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "obligation"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "collectCollateralFees",
      "discriminator": [
        2,
        14,
        191,
        17,
        217,
        172,
        237,
        97
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "collateralMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "treasuryToken",
          "docs": [
            "Must belong to the configured treasury."
          ],
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "collectFees",
      "discriminator": [
        164,
        152,
        207,
        99,
        30,
        186,
        19,
        182
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "lendMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "treasuryToken",
          "docs": [
            "Must belong to the configured treasury."
          ],
          "writable": true
        },
        {
          "name": "lendTokenProgram"
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
      "name": "createMarket",
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "lendMint"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lendMint"
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ]
          }
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  113,
                  117,
                  105,
                  100,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "lendTokenProgram"
        },
        {
          "name": "collateralTokenProgram"
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
              "name": "marketParams"
            }
          }
        },
        {
          "name": "oracleKind",
          "type": {
            "defined": {
              "name": "oracleKind"
            }
          }
        },
        {
          "name": "collateralIsToken0",
          "type": "bool"
        }
      ]
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "lendMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userToken",
          "docs": [
            "User's lend-token account (source on deposit, destination on withdraw)."
          ],
          "writable": true
        },
        {
          "name": "userShares",
          "docs": [
            "User's share-token account."
          ],
          "writable": true
        },
        {
          "name": "lendTokenProgram"
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
      "name": "depositCollateral",
      "discriminator": [
        156,
        131,
        142,
        116,
        146,
        247,
        162,
        120
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "obligation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  108,
                  105,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "collateralMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userCollateral",
          "docs": [
            "Owner's collateral account (source on deposit, destination on withdraw)."
          ],
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
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
      "name": "initConfig",
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "timelockSeconds",
          "type": "i64"
        }
      ]
    },
    {
      "name": "liquidate",
      "discriminator": [
        223,
        179,
        226,
        125,
        48,
        46,
        39,
        74
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "liquidator",
          "signer": true
        },
        {
          "name": "lendMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidatorLend",
          "docs": [
            "Liquidator pays debt from here."
          ],
          "writable": true
        },
        {
          "name": "liquidatorCollateral",
          "docs": [
            "Liquidator receives collateral here."
          ],
          "writable": true
        },
        {
          "name": "lendTokenProgram"
        },
        {
          "name": "collateralTokenProgram"
        }
      ],
      "args": [
        {
          "name": "maxRepay",
          "type": "u64"
        },
        {
          "name": "minCollateralOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "migrateConfig",
      "discriminator": [
        92,
        131,
        58,
        105,
        210,
        154,
        224,
        193
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migrateMarket",
      "discriminator": [
        201,
        113,
        181,
        120,
        217,
        60,
        109,
        203
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openObligation",
      "discriminator": [
        3,
        19,
        90,
        233,
        47,
        113,
        28,
        155
      ],
      "accounts": [
        {
          "name": "market"
        },
        {
          "name": "obligation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  108,
                  105,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "proposeAdmin",
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "queueParams",
      "discriminator": [
        180,
        46,
        181,
        164,
        140,
        178,
        204,
        127
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "marketParams"
            }
          }
        }
      ]
    },
    {
      "name": "repay",
      "discriminator": [
        234,
        103,
        67,
        82,
        208,
        234,
        219,
        166
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "payer",
          "docs": [
            "Anyone may repay any position."
          ],
          "signer": true
        },
        {
          "name": "lendMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "lendTokenProgram"
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
      "name": "setBorrowPaused",
      "discriminator": [
        246,
        88,
        130,
        29,
        127,
        191,
        3,
        245
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setTreasury",
      "discriminator": [
        57,
        97,
        196,
        95,
        195,
        206,
        106,
        136
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "treasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "lendMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "liquidityVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userToken",
          "docs": [
            "User's lend-token account (source on deposit, destination on withdraw)."
          ],
          "writable": true
        },
        {
          "name": "userShares",
          "docs": [
            "User's share-token account."
          ],
          "writable": true
        },
        {
          "name": "lendTokenProgram"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawCollateral",
      "discriminator": [
        115,
        135,
        168,
        106,
        139,
        214,
        138,
        150
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "obligation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  108,
                  105,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "obligation"
          ]
        },
        {
          "name": "collateralMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userCollateral",
          "docs": [
            "Owner's collateral account (source on deposit, destination on withdraw)."
          ],
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
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
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "obligation",
      "discriminator": [
        168,
        206,
        141,
        106,
        88,
        76,
        172,
        167
      ]
    }
  ],
  "events": [
    {
      "name": "borrowPauseSet",
      "discriminator": [
        92,
        191,
        251,
        108,
        90,
        223,
        18,
        37
      ]
    },
    {
      "name": "borrowed",
      "discriminator": [
        225,
        182,
        241,
        78,
        34,
        145,
        253,
        230
      ]
    },
    {
      "name": "collateralDeposited",
      "discriminator": [
        244,
        62,
        77,
        11,
        135,
        112,
        61,
        96
      ]
    },
    {
      "name": "collateralFeesCollected",
      "discriminator": [
        173,
        205,
        49,
        27,
        47,
        34,
        227,
        168
      ]
    },
    {
      "name": "collateralWithdrawn",
      "discriminator": [
        51,
        224,
        133,
        106,
        74,
        173,
        72,
        82
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "feesCollected",
      "discriminator": [
        233,
        23,
        117,
        225,
        107,
        178,
        254,
        8
      ]
    },
    {
      "name": "liquidated",
      "discriminator": [
        231,
        57,
        55,
        75,
        0,
        170,
        246,
        68
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "paramsApplied",
      "discriminator": [
        79,
        221,
        60,
        141,
        244,
        69,
        47,
        209
      ]
    },
    {
      "name": "paramsQueued",
      "discriminator": [
        154,
        201,
        187,
        11,
        75,
        245,
        205,
        20
      ]
    },
    {
      "name": "repaid",
      "discriminator": [
        38,
        248,
        231,
        7,
        150,
        164,
        172,
        23
      ]
    },
    {
      "name": "treasuryQueued",
      "discriminator": [
        194,
        82,
        68,
        152,
        151,
        179,
        21,
        250
      ]
    },
    {
      "name": "treasurySet",
      "discriminator": [
        69,
        231,
        163,
        135,
        254,
        194,
        109,
        166
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6002,
      "name": "invalidParams",
      "msg": "Invalid market parameters"
    },
    {
      "code": 6003,
      "name": "timelockTooShort",
      "msg": "Timelock must be at least the protocol minimum"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "Signer is not the admin"
    },
    {
      "code": 6005,
      "name": "notPendingAdmin",
      "msg": "No pending admin, or signer is not the pending admin"
    },
    {
      "code": 6006,
      "name": "nothingQueued",
      "msg": "No parameter change is queued"
    },
    {
      "code": 6007,
      "name": "timelockNotElapsed",
      "msg": "Queued change is not yet executable"
    },
    {
      "code": 6008,
      "name": "borrowPaused",
      "msg": "Borrowing is paused on this market"
    },
    {
      "code": 6009,
      "name": "depositCapExceeded",
      "msg": "Deposit cap reached"
    },
    {
      "code": 6010,
      "name": "borrowCapExceeded",
      "msg": "Borrow cap reached"
    },
    {
      "code": 6011,
      "name": "accountBorrowCapExceeded",
      "msg": "Per-account borrow cap reached"
    },
    {
      "code": 6012,
      "name": "utilizationTooHigh",
      "msg": "Borrow would push utilization above the market maximum"
    },
    {
      "code": 6013,
      "name": "insufficientLiquidity",
      "msg": "Not enough liquidity in the market"
    },
    {
      "code": 6014,
      "name": "insufficientCollateral",
      "msg": "Not enough collateral"
    },
    {
      "code": 6015,
      "name": "borrowLimitExceeded",
      "msg": "Position would exceed the borrow limit"
    },
    {
      "code": 6016,
      "name": "positionHealthy",
      "msg": "Position is healthy and cannot be liquidated"
    },
    {
      "code": 6017,
      "name": "repayTooLarge",
      "msg": "Repay amount is above what may be liquidated"
    },
    {
      "code": 6018,
      "name": "obligationNotEmpty",
      "msg": "Position still has debt or collateral"
    },
    {
      "code": 6019,
      "name": "oracleAccountMismatch",
      "msg": "Oracle accounts do not match the market"
    },
    {
      "code": 6020,
      "name": "oracleWrongOwner",
      "msg": "Oracle account has the wrong owner"
    },
    {
      "code": 6021,
      "name": "oracleInvalidData",
      "msg": "Oracle account data is invalid"
    },
    {
      "code": 6022,
      "name": "oracleWindowTooShort",
      "msg": "Price history does not cover the required window"
    },
    {
      "code": 6023,
      "name": "oracleZeroPrice",
      "msg": "Oracle price is zero"
    },
    {
      "code": 6024,
      "name": "unsupportedOracle",
      "msg": "Unsupported oracle kind for these mints"
    },
    {
      "code": 6025,
      "name": "insufficientFees",
      "msg": "Not enough protocol fees"
    },
    {
      "code": 6026,
      "name": "unsupportedMint",
      "msg": "Token-2022 mints may only carry metadata extensions"
    },
    {
      "code": 6027,
      "name": "treasuryNotSet",
      "msg": "No treasury has been set"
    },
    {
      "code": 6028,
      "name": "notMigratable",
      "msg": "Account is not in the expected old layout"
    },
    {
      "code": 6029,
      "name": "stakePoolNotUpdated",
      "msg": "The stake pool hasn't updated for this epoch yet; try again shortly"
    }
  ],
  "types": [
    {
      "name": "borrowPauseSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "borrowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
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
      "name": "collateralDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
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
      "name": "collateralFeesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Liquidation fees, in collateral tokens."
            ],
            "type": "u64"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "collateralWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
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
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          },
          {
            "name": "timelockSeconds",
            "docs": [
              "Delay before queued risk changes can be applied. Fixed at init."
            ],
            "type": "i64"
          },
          {
            "name": "marketCount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "treasury",
            "docs": [
              "Owner of the token accounts protocol fees are paid to. Default = not set yet."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingTreasury",
            "docs": [
              "A treasury change waiting for the timelock. Default = none."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasuryEta",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "feesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Interest fees, in lend tokens."
            ],
            "type": "u64"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "liquidated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "liquidator",
            "type": "pubkey"
          },
          {
            "name": "repaid",
            "type": "u64"
          },
          {
            "name": "collateralSeized",
            "docs": [
              "Collateral taken from the position, including the protocol fee."
            ],
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "docs": [
              "Part of the seized collateral kept by the protocol."
            ],
            "type": "u64"
          },
          {
            "name": "badDebt",
            "type": "u64"
          },
          {
            "name": "priceWad",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "lendMint",
            "type": "pubkey"
          },
          {
            "name": "lendTokenProgram",
            "type": "pubkey"
          },
          {
            "name": "lendDecimals",
            "type": "u8"
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "collateralTokenProgram",
            "type": "pubkey"
          },
          {
            "name": "collateralDecimals",
            "type": "u8"
          },
          {
            "name": "liquidityVault",
            "type": "pubkey"
          },
          {
            "name": "collateralVault",
            "type": "pubkey"
          },
          {
            "name": "shareMint",
            "type": "pubkey"
          },
          {
            "name": "oracleKind",
            "type": {
              "defined": {
                "name": "oracleKind"
              }
            }
          },
          {
            "name": "oracleAccounts",
            "docs": [
              "Accounts the price is read from, in order. Unused slots are default."
            ],
            "type": {
              "array": [
                "pubkey",
                4
              ]
            }
          },
          {
            "name": "collateralIsToken0",
            "docs": [
              "XDEX only: true when the collateral is the pool's token 0."
            ],
            "type": "bool"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "marketParams"
              }
            }
          },
          {
            "name": "pendingParams",
            "type": {
              "defined": {
                "name": "marketParams"
              }
            }
          },
          {
            "name": "pendingEta",
            "type": "i64"
          },
          {
            "name": "hasPending",
            "type": "bool"
          },
          {
            "name": "borrowPaused",
            "type": "bool"
          },
          {
            "name": "cash",
            "docs": [
              "Lend tokens held in the liquidity vault (internal count; donations are ignored)."
            ],
            "type": "u64"
          },
          {
            "name": "totalBorrowScaled",
            "docs": [
              "Total debt in scaled units: debt = scaled * borrow_index / WAD."
            ],
            "type": "u128"
          },
          {
            "name": "borrowIndex",
            "type": "u128"
          },
          {
            "name": "protocolFees",
            "docs": [
              "Interest owed to the protocol, in lend raw units."
            ],
            "type": "u64"
          },
          {
            "name": "lastAccrualTs",
            "type": "i64"
          },
          {
            "name": "totalCollateral",
            "type": "u64"
          },
          {
            "name": "cumulativeBadDebt",
            "docs": [
              "Debt written off after liquidations ran out of collateral (lend raw units)."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "liquidityVaultBump",
            "type": "u8"
          },
          {
            "name": "collateralVaultBump",
            "type": "u8"
          },
          {
            "name": "shareMintBump",
            "type": "u8"
          },
          {
            "name": "protocolCollateralFees",
            "docs": [
              "Liquidation fees owed to the protocol, in collateral raw units. Held in the",
              "collateral vault on top of `total_collateral`."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "lendMint",
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "oracleKind",
            "type": {
              "defined": {
                "name": "oracleKind"
              }
            }
          },
          {
            "name": "priceWad",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "marketParams",
      "docs": [
        "Risk and rate settings for one market. All bps values are out of 10_000."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxLtvBps",
            "docs": [
              "Borrow limit: debt may not exceed this share of collateral value."
            ],
            "type": "u16"
          },
          {
            "name": "liquidationThresholdBps",
            "docs": [
              "Liquidation starts when debt exceeds this share of collateral value."
            ],
            "type": "u16"
          },
          {
            "name": "liquidationBonusBps",
            "docs": [
              "Extra collateral a liquidator receives, on top of the debt repaid."
            ],
            "type": "u16"
          },
          {
            "name": "closeFactorBps",
            "docs": [
              "Most of a position's debt one liquidation may repay."
            ],
            "type": "u16"
          },
          {
            "name": "reserveFactorBps",
            "docs": [
              "Share of interest kept as protocol fees."
            ],
            "type": "u16"
          },
          {
            "name": "optimalUtilizationBps",
            "docs": [
              "Utilization where the rate curve steepens."
            ],
            "type": "u16"
          },
          {
            "name": "maxUtilizationBps",
            "docs": [
              "Borrows may not push utilization above this."
            ],
            "type": "u16"
          },
          {
            "name": "baseRateBps",
            "docs": [
              "Annual rate at 0% utilization."
            ],
            "type": "u32"
          },
          {
            "name": "slope1Bps",
            "docs": [
              "Added annual rate from 0% to optimal utilization."
            ],
            "type": "u32"
          },
          {
            "name": "slope2Bps",
            "docs": [
              "Added annual rate from optimal to 100% utilization."
            ],
            "type": "u32"
          },
          {
            "name": "depositCap",
            "docs": [
              "Max total lender assets (lend token raw units)."
            ],
            "type": "u64"
          },
          {
            "name": "borrowCap",
            "docs": [
              "Max total borrows (lend token raw units)."
            ],
            "type": "u64"
          },
          {
            "name": "maxBorrowPerObligation",
            "docs": [
              "Max debt of one position (lend token raw units)."
            ],
            "type": "u64"
          },
          {
            "name": "dustDebt",
            "docs": [
              "Positions with debt at or under this may be liquidated in full."
            ],
            "type": "u64"
          },
          {
            "name": "twapWindowSecs",
            "docs": [
              "XDEX TWAP window in seconds (ignored for stake pool markets)."
            ],
            "type": "u32"
          },
          {
            "name": "liquidationFeeBps",
            "docs": [
              "Share of each liquidation bonus kept by the protocol (paid in collateral)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "obligation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "borrowScaled",
            "type": "u128"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "oracleKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "stakePool"
          },
          {
            "name": "xdexTwap"
          }
        ]
      }
    },
    {
      "name": "paramsApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "paramsQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "eta",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "repaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
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
      "name": "treasuryQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "eta",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "treasurySet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "treasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
