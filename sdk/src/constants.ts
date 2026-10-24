import { PublicKey } from "@solana/web3.js";

export const ACCUMULATOR_PROGRAM_ID = new PublicKey("BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y");

export const XDEX_PROGRAM_ID = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
export const X1_STAKE_POOL_PROGRAM_ID = new PublicKey("XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** X1 mainnet addresses the two launch markets use (verified on-chain 2026-10-23). */
export const MAINNET = {
  rpc: "https://rpc.mainnet.x1.xyz",
  /** Protocol fee treasury (a Ledger). Fees can only be paid to token accounts it owns. */
  treasury: new PublicKey("DyKtYX7jpkp7VLmwoGVTup1PXYYJBoeuv3XEG1Jpe1GV"),
  /** Leaked key (old id.json). Must never hold any Accumulator role. */
  compromised: new PublicKey("DtZz8J1VHtVkAUBvKsh5oibb3wVeqn3B3EHR3unXnRkh"),
  /** pXNT: X1 Foundation stake pool token (classic SPL Token, 9 decimals). */
  pxntMint: new PublicKey("pXNTyoqQsskHdZ7Q1rnP25FEyHHjissbs7n6RRN2nP5"),
  stakePool: new PublicKey("X1SPaMUM1A8E1vKL8XQAB5rxKarJbqtWFFSNFs8f7Av"),
  /** USDC.x: bridged USDC (Token-2022, 6 decimals, metadata extensions only). */
  usdcxMint: new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"),
  /** Ripper Pool: a community stake pool on the same X1 stake pool program; rXNT is its token
   *  (Token-2022, 9 decimals, metadata extensions only). https://github.com/BlackBeard085/ripper-pool */
  ripper: {
    stakePool: new PublicKey("R1PP3RkqTJniWgzJgeymd4rFpdpXcmjywVomMpd8eAY"),
    rxntMint: new PublicKey("7jP6rm8zEd2kLgt1vRTzmA11MmbhypHRdU1VyZPripp"),
  },
  /** XDEX XNT/USDC.x pool — token 0 = XNT, token 1 = USDC.x. */
  xdexXntUsdc: {
    pool: new PublicKey("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR"),
    observation: new PublicKey("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ"),
    vault0: new PublicKey("8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb"),
    vault1: new PublicKey("7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg"),
  },
} as const;

/** X1 testnet: same stake pool and pXNT as mainnet, but XDEX runs its own program and USDC differs. */
export const TESTNET = {
  rpc: "https://rpc.testnet.x1.xyz",
  xdexProgram: new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf"),
  pxntMint: MAINNET.pxntMint,
  stakePool: MAINNET.stakePool,
  /** Testnet USDC (Token-2022, 9 decimals, metadata extensions only). */
  usdcMint: new PublicKey("4dr9zMDzp4TY3ikZmsqF2ikSkmtWiCwWYJ9xJx1h2KsU"),
  /** XDEX XNT/USDC pool on testnet: token 0 = XNT, token 1 = USDC. */
  xdexXntUsdc: {
    pool: new PublicKey("ENWQ8z4eF9LesH1Xye81mpMfh9pMptPaVojPJ52rgAb5"),
    observation: new PublicKey("BKPGM6ThsF3SfD7m9rXhZzdQq3S72F96gKRdVRyBd8jf"),
    vault0: new PublicKey("642hmxRAQNu4agWLRTFxkX62dsJtXxtpKWK8hnmXoA2R"),
    vault1: new PublicKey("GaA3Qeiz5go7XbFiK2wZfFU3Pz3iM6kMEPsxo7mbWjEA"),
  },
  /**
   * Percolator's test USDC (classic SPL Token, 6 decimals like USDC.x). Mintable by
   * percolator-vault/keys/x1-faucet.json, so drills can fund lenders; its XNT pool is
   * kept active by percolator's swap bots.
   */
  testUsdcMint: new PublicKey("7jpUVrakCqTm68aatnDHYe7qhSF7Zq39PWoSKM1u2Aaw"),
  xdexXntTestUsdc: {
    pool: new PublicKey("8SgXc12aVMuUToajCGjSUhPCLvyag8SHjGWdpnHQYPpC"),
    observation: new PublicKey("6z2m3yDFj6MAf6gNSUct2MYBJC6Gf9nczUsCB1qTGeSv"),
    vault0: new PublicKey("4Ts1XZRtadYpAjDE2tqonRQAP44pykv7qwf6Vt5Vob3N"),
    vault1: new PublicKey("GQKr9PP1LJJWhFhU8ACbDeoZ3oYuSA3LxUupQkRFDXYr"),
  },
} as const;

/** Account data layouts the program reads (mirrors programs/accumulator/src/oracle.rs). */
export const LAYOUT = {
  stakePool: { accountType: 1, poolMint: 163, totalLamports: 259, poolTokenSupply: 267, lastUpdateEpoch: 275 },
  xdexPool: {
    len: 637,
    vault0: 72,
    vault1: 104,
    mint0: 168,
    mint1: 200,
    observation: 296,
    protocolFees0: 341,
    protocolFees1: 349,
    fundFees0: 357,
    fundFees1: 365,
  },
  xdexObservation: { len: 4075, initialized: 8, index: 9, pool: 11, observations: 43, entryLen: 40, count: 100 },
  tokenAccount: { mint: 0, owner: 32, amount: 64 },
} as const;
