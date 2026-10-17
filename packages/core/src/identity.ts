import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";

export { bytesToHex, hexToBytes };

export interface Identity {
  readonly publicKey: string;
  readonly privateKey: Uint8Array;
}

/** Stores private key bytes outside SQLite. Tests use an in-memory double. */
export interface KeyStore {
  save(publicKey: string, privateKey: Uint8Array): Promise<void>;
  load(publicKey: string): Promise<Uint8Array | null>;
}

/** Test double. The desktop app uses the OS keychain instead. */
export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, Uint8Array>();

  async save(publicKey: string, privateKey: Uint8Array): Promise<void> {
    this.keys.set(publicKey, copyBytes(privateKey));
  }

  async load(publicKey: string): Promise<Uint8Array | null> {
    const found = this.keys.get(publicKey);
    return found ? copyBytes(found) : null;
  }
}

export async function generateIdentity(store: KeyStore): Promise<Identity> {
  const generated = ed25519.keygen();
  const privateKey = copyBytes(generated.secretKey);
  generated.secretKey.fill(0);
  const publicKey = bytesToHex(generated.publicKey);
  await store.save(publicKey, privateKey);
  return { publicKey, privateKey: copyBytes(privateKey) };
}

export async function loadIdentity(store: KeyStore, publicKey: string): Promise<Identity> {
  const privateKey = await store.load(publicKey);
  if (!privateKey) {
    throw new Error("No identity is stored for that public key");
  }
  let derived = "";
  try {
    derived = bytesToHex(ed25519.getPublicKey(privateKey));
  } catch {
    throw new Error("The stored identity is unusable");
  }
  if (derived !== publicKey) {
    throw new Error("The stored identity does not match the requested public key");
  }
  return { publicKey, privateKey };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
