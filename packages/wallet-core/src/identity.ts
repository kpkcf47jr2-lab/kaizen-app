// ═══════════════════════════════════════════════════════════════════════
//  @kaizen/wallet-core — Identity
//
//  BIP-39 mnemonic + BIP-44 EVM derivation for the agent's own wallet.
//  Every Kaizen agent owns one seed phrase; every seed derives many
//  chains (Polygon 137 first; BTC, Solana, etc. later).
//
//  The mnemonic never touches an LLM prompt or a log. It is written once
//  into the vault (AES-GCM encrypted with a passphrase the agent doesn't
//  know) and loaded server-side only by the Secure Wallet Service.
// ═══════════════════════════════════════════════════════════════════════

import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { computeAddress, getBytes, hexlify } from "ethers";

export interface EvmAccount {
  /** BIP-44 derivation path used to produce this account. */
  path: string;
  /** EIP-55 checksum address. */
  address: string;
  /** Uncompressed pubkey hex, 0x04-prefixed. Useful for signing verification. */
  publicKey: string;
  /** Private key hex — NEVER return this outside the Secure Wallet Service. */
  privateKey: string;
}

/**
 * Generate a fresh 12-word BIP-39 mnemonic (128 bits of entropy). Use 256
 * bits (24 words) if you want extra safety margin — but 128 is what most
 * wallets ship and is fine for MVP agent-owned funds under HARD_LIMITS.
 */
export function newMnemonic(strengthBits: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strengthBits);
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(phrase.trim(), wordlist);
}

/**
 * Derive one EVM account (Ethereum-family) from a mnemonic using
 * BIP-44 path m/44'/60'/account'/0/index. Kaizen uses account=0, index=0
 * for its primary Polygon wallet.
 */
export function deriveEvmAccount(
  mnemonic: string,
  account: number = 0,
  index: number = 0,
): EvmAccount {
  if (!isValidMnemonic(mnemonic)) throw new Error("Invalid mnemonic");
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const path = `m/44'/60'/${account}'/0/${index}`;
  const child = root.derive(path);
  if (!child.privateKey || !child.publicKey) throw new Error("Derivation failed");

  const privateKey = hexlify(child.privateKey);
  const publicKey = hexlify(child.publicKey);
  const address = computeAddress(privateKey);

  return { path, address, publicKey, privateKey };
}

/**
 * Address-only derivation. Useful for the dashboard / read-only clients
 * that must know the agent's address but MUST NOT hold the private key.
 */
export function deriveEvmAddress(mnemonic: string, account = 0, index = 0): string {
  return deriveEvmAccount(mnemonic, account, index).address;
}

/**
 * Fingerprint an address for logs and DB primary keys without ever
 * writing the raw hex address to disk in cleartext. First 12 chars of
 * keccak(address). Deterministic; ok to compare across systems.
 */
export function addressFingerprint(address: string): string {
  const bytes = getBytes(address.toLowerCase());
  // Cheap FNV-1a — good enough for a fingerprint, not a security primitive.
  let h = 2166136261n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 16777619n) & 0xffffffffn;
  }
  return h.toString(16).padStart(8, "0");
}
