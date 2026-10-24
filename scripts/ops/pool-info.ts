// Prints the X1 stake pool's rate, fees and estimated staking APY on both networks.
import { Connection } from "@solana/web3.js";
import { estimateStakingApy, fetchStakePool } from "../../sdk/src";
(async () => {
  for (const [n, url] of [["testnet", "https://rpc.testnet.x1.xyz"], ["mainnet", "https://rpc.mainnet.x1.xyz"]]) {
    const c = new Connection(url, "confirmed");
    const p = await fetchStakePool(c);
    console.log(n, { rate: Number(p.totalLamports) / Number(p.supply), lastEpochRate: p.lastEpochRate, dep: p.solDepositFee, wd: p.solWithdrawalFee, reserve: p.reserve.toBase58(), apy: await estimateStakingApy(c) });
  }
})();
