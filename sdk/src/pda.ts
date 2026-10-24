import { PublicKey } from "@solana/web3.js";
import { ACCUMULATOR_PROGRAM_ID } from "./constants";

const seed = (s: string) => Buffer.from(s);

export function configPda(programId = ACCUMULATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed("config")], programId)[0];
}

export function marketPda(lendMint: PublicKey, collateralMint: PublicKey, programId = ACCUMULATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed("market"), lendMint.toBuffer(), collateralMint.toBuffer()], programId)[0];
}

export function liquidityVaultPda(market: PublicKey, programId = ACCUMULATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed("liquidity"), market.toBuffer()], programId)[0];
}

export function collateralVaultPda(market: PublicKey, programId = ACCUMULATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed("collateral"), market.toBuffer()], programId)[0];
}

export function shareMintPda(market: PublicKey, programId = ACCUMULATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed("shares"), market.toBuffer()], programId)[0];
}

export function obligationPda(market: PublicKey, owner: PublicKey, programId = ACCUMULATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed("obligation"), market.toBuffer(), owner.toBuffer()], programId)[0];
}
