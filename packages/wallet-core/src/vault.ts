// ═══════════════════════════════════════════════════════════════════════
//  @kaizen/wallet-core — Vault
//
//  AES-256-GCM + PBKDF2-SHA256 (600k iterations). Stores the mnemonic
//  encrypted at rest. Only the Secure Wallet Service opens the vault,
//  and only for the duration of one signing operation.
//
//  The passphrase lives in an environment variable owned by the
//  backend service (KAIZEN_VAULT_PASSPHRASE). It is NEVER available to
//  the LLM, the dashboard, or the agent runtime code.
// ═══════════════════════════════════════════════════════════════════════

import { webcrypto } from "node:crypto";

const KDF_ITERATIONS = 600_000;
const KDF_HASH = "SHA-256";
const KEY_LEN_BITS = 256;
const SALT_LEN = 32;
const IV_LEN = 12;
const VERSION = 1;

export interface VaultBlob {
  v: number;                 // version
  kdf: "pbkdf2-sha256";
  iters: number;
  salt: string;              // hex
  iv: string;                // hex
  ct: string;                // hex ciphertext + auth tag
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(buf: ArrayBufferLike | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(str: string): Uint8Array {
  const clean = str.startsWith("0x") ? str.slice(2) : str;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await webcrypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: KDF_HASH },
    material,
    { name: "AES-GCM", length: KEY_LEN_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a plaintext string (the mnemonic) into a self-contained blob. */
export async function seal(plaintext: string, passphrase: string): Promise<VaultBlob> {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return {
    v: VERSION,
    kdf: "pbkdf2-sha256",
    iters: KDF_ITERATIONS,
    salt: hex(salt),
    iv: hex(iv),
    ct: hex(ct),
  };
}

/** Reverse of seal(). Throws if passphrase is wrong or blob is tampered. */
export async function open(blob: VaultBlob, passphrase: string): Promise<string> {
  if (blob.v !== VERSION) throw new Error(`Unsupported vault version ${blob.v}`);
  if (blob.kdf !== "pbkdf2-sha256") throw new Error(`Unsupported KDF ${blob.kdf}`);
  const key = await deriveKey(passphrase, unhex(blob.salt));
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(blob.iv) },
    key,
    unhex(blob.ct),
  );
  return dec.decode(pt);
}
