import { useEffect, useState, useCallback } from "react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

const STORAGE_KEY = "x1_wallet_pubkey";

function getProvider(): any {
  if (typeof window === "undefined") return null;
  return (window as any).backpack ?? (window as any).x1Wallet ?? null;
}

export interface X1Wallet {
  publicKey: PublicKey | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

export function useX1Wallet(): X1Wallet {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);

  const applyKey = (raw: any) => {
    const pk = new PublicKey(raw.toString());
    setPublicKey(pk);
    sessionStorage.setItem(STORAGE_KEY, pk.toBase58());
    return pk;
  };

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) throw new Error("X1 wallet extension not found (window.backpack / window.x1Wallet)");
    setConnecting(true);
    try {
      const resp = await provider.connect();
      applyKey(resp.publicKey);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    getProvider()?.disconnect?.();
    setPublicKey(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  // Auto-reconnect on page load
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const provider = getProvider();
    if (!provider) return;
    if (provider.isConnected && provider.publicKey) {
      applyKey(provider.publicKey);
    } else {
      // silently re-connect; ignore if user dismissed
      provider.connect().then((r: any) => applyKey(r.publicKey)).catch(() => {
        sessionStorage.removeItem(STORAGE_KEY);
      });
    }
  }, []);

  // Stay in sync when user switches accounts
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;
    const handler = (pk: any) => {
      if (pk) {
        applyKey(pk);
      } else {
        setPublicKey(null);
        sessionStorage.removeItem(STORAGE_KEY);
      }
    };
    provider.on?.("accountChanged", handler);
    return () => provider.off?.("accountChanged", handler);
  }, []);

  const signTransaction = useCallback(async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    const provider = getProvider();
    if (!provider) throw new Error("Wallet not connected");
    return provider.signTransaction(tx);
  }, []);

  const signAllTransactions = useCallback(async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
    const provider = getProvider();
    if (!provider) throw new Error("Wallet not connected");
    return provider.signAllTransactions(txs);
  }, []);

  const signMessage = useCallback(async (message: Uint8Array): Promise<Uint8Array> => {
    const provider = getProvider();
    if (!provider) throw new Error("Wallet not connected");
    const result = await provider.signMessage(message, "utf8");
    return result.signature ?? result;
  }, []);

  return {
    publicKey,
    connected: !!publicKey,
    connecting,
    connect,
    disconnect,
    signTransaction,
    signAllTransactions,
    signMessage,
  };
}
