/**
 * Snapshots the real X1 mainnet accounts Accumulator reads, so tests can run the
 * program against live data. Read-only. Usage: npx ts-node scripts/fetch-fixtures.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { MAINNET, NATIVE_MINT } from "../sdk/src/constants";

const accounts: Record<string, PublicKey> = {
  stake_pool: MAINNET.stakePool,
  pxnt_mint: MAINNET.pxntMint,
  usdcx_mint: MAINNET.usdcxMint,
  native_mint: NATIVE_MINT,
  xdex_pool: MAINNET.xdexXntUsdc.pool,
  xdex_observation: MAINNET.xdexXntUsdc.observation,
  xdex_vault0: MAINNET.xdexXntUsdc.vault0,
  xdex_vault1: MAINNET.xdexXntUsdc.vault1,
  ripper_pool: MAINNET.ripper.stakePool,
  rxnt_mint: MAINNET.ripper.rxntMint,
};

(async () => {
  const conn = new Connection(process.env.RPC ?? MAINNET.rpc, "confirmed");
  const keys = Object.values(accounts);
  const slot = await conn.getSlot("confirmed");
  const infos = await conn.getMultipleAccountsInfo(keys, { minContextSlot: slot });
  const time = await conn.getBlockTime(slot);
  const out: any = { slot, unix_timestamp: time, accounts: {} };
  Object.keys(accounts).forEach((name, i) => {
    const a = infos[i];
    if (!a) throw new Error(`${name} missing`);
    out.accounts[name] = {
      pubkey: keys[i].toBase58(),
      owner: a.owner.toBase58(),
      lamports: a.lamports,
      data: Buffer.from(a.data).toString("base64"),
    };
  });
  const file = path.join(__dirname, "../tests-rs/fixtures/mainnet.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`saved ${Object.keys(accounts).length} accounts at slot ${slot} (${new Date(time! * 1000).toISOString()}) to ${file}`);
})();
