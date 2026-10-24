import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { AccumulatorClient, TESTNET_MARKETS } from "../../sdk/src";
import * as act from "../../app/src/actions";
(async () => {
  const conn = new Connection("https://rpc.testnet.x1.xyz", "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/accumulator-testnet-admin.json", "utf8"))));
  const accumulator = new AccumulatorClient(conn);
  const market = await accumulator.fetchMarket(TESTNET_MARKETS.xntPxnt.address);
  const tx: Transaction = await act.deposit({ conn, accumulator, user: admin.publicKey, market }, 5_000_000_000n);
  console.log("deposit 5 XNT:", await sendAndConfirmTransaction(conn, tx, [admin]));
})();
