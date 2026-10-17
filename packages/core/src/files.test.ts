import { createServer, type Server, type Socket } from "node:net";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { assertSharePath, buildManifest, downloadSelected } from "./files.ts";

function hash(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

describe("folder manifests", () => {
  it("rejects absolute paths and parent segments", () => {
    expect(() => assertSharePath("../secret")).toThrow(/not allowed/);
    expect(() => assertSharePath("/etc/passwd")).toThrow(/not allowed/);
    expect(() => assertSharePath("C:/Windows/note.txt")).toThrow(/not allowed/);
    expect(() => assertSharePath("notes/../../secret")).toThrow(/not allowed/);
    expect(() => assertSharePath("notes\\secret.txt")).toThrow(/not allowed/);
    expect(assertSharePath("notes/a.txt")).toBe("notes/a.txt");
  });

  it("builds a stable hash that does not depend on input order", () => {
    const first = utf8ToBytes("alpha");
    const second = utf8ToBytes("beta");
    const left = buildManifest(
      [
        { path: "b.txt", bytes: second },
        { path: "a.txt", bytes: first },
      ],
      "notes",
    );
    const right = buildManifest(
      [
        { path: "a.txt", bytes: first },
        { path: "b.txt", bytes: second },
      ],
      "notes",
    );
    expect(left).toEqual(right);
    expect(left.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(left.files[0]?.hash).toBe(hash(first));
    expect(left.folderHash).toBe(right.folderHash);
    expect(left.folderHash).not.toBe("");
  });
});

describe("selective download", () => {
  it("fetches only the selected file and rejects a flipped byte", async () => {
    const alpha = utf8ToBytes("alpha-bytes");
    const beta = utf8ToBytes("beta-bytes");
    const gamma = utf8ToBytes("gamma-bytes");
    const manifest = buildManifest(
      [
        { path: "a.txt", bytes: alpha },
        { path: "b.txt", bytes: beta },
        { path: "c.txt", bytes: gamma },
      ],
      "notes",
    );
    const library = new Map(manifest.files.map((file, index) => [file.hash, [alpha, beta, gamma][index] as Uint8Array]));
    const requested: string[] = [];
    const peer = await serveHashes(library);
    const blobs = new MemoryBlobs();
    const output = new MemoryOutput();
    try {
      await downloadSelected({
        manifest,
        paths: ["b.txt"],
        fetchHash: (fileHash) => peer.fetch(fileHash, requested),
        blobs,
        output,
      });
      expect(requested).toEqual([manifest.files.find((file) => file.path === "b.txt")?.hash]);
      expect(output.paths()).toEqual(["b.txt"]);
      expect(blobs.hashes()).toEqual([manifest.files.find((file) => file.path === "b.txt")?.hash]);
      expect(output.read("b.txt")).toEqual(beta);

      const flipped = new Map(library);
      const betaHash = manifest.files.find((file) => file.path === "b.txt")?.hash ?? "";
      flipped.set(betaHash, utf8ToBytes("corrupt"));
      const badPeer = await serveHashes(flipped);
      const second = new MemoryOutput();
      const secondBlobs = new MemoryBlobs();
      await expect(
        downloadSelected({
          manifest,
          paths: ["b.txt"],
          fetchHash: (fileHash) => badPeer.fetch(fileHash, []),
          blobs: secondBlobs,
          output: second,
        }),
      ).rejects.toThrow(/hash/);
      expect(second.paths()).toEqual([]);
      expect(secondBlobs.hashes()).toEqual([]);
    } finally {
      await peer.close();
    }
  });
});

class MemoryBlobs {
  private readonly files = new Map<string, Uint8Array>();

  async read(fileHash: string): Promise<Uint8Array | null> {
    const found = this.files.get(fileHash);
    return found ? new Uint8Array(found) : null;
  }

  async write(fileHash: string, bytes: Uint8Array): Promise<void> {
    this.files.set(fileHash, new Uint8Array(bytes));
  }

  async remove(fileHash: string): Promise<void> {
    this.files.delete(fileHash);
  }

  hashes(): string[] {
    return [...this.files.keys()];
  }
}

class MemoryOutput {
  private readonly files = new Map<string, Uint8Array>();

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(bytes));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  read(path: string): Uint8Array | undefined {
    const found = this.files.get(path);
    return found ? new Uint8Array(found) : undefined;
  }
}

function serveHashes(library: Map<string, Uint8Array>): Promise<{
  fetch: (fileHash: string, requested: string[]) => Promise<Uint8Array>;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    let announced = false;
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (announced) return;
      const end = pending.indexOf(0x0a);
      if (end < 0) return;
      announced = true;
      const fileHash = pending.subarray(0, end).toString("utf8").trim();
      const bytes = library.get(fileHash);
      if (!bytes) {
        socket.end("NO\n");
        return;
      }
      const header = Buffer.from(`OK ${bytes.length}\n`);
      socket.end(Buffer.concat([header, Buffer.from(bytes)]));
    });
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        async fetch(fileHash: string, requested: string[]) {
          requested.push(fileHash);
          const { connect } = await import("node:net");
          const socket = connect(address.port, "127.0.0.1");
          const chunks: Buffer[] = [];
          socket.write(`${fileHash}\n`);
          await new Promise<void>((done, reject) => {
            socket.on("data", (chunk) => chunks.push(chunk));
            socket.on("end", () => done());
            socket.on("error", reject);
          });
          const payload = Buffer.concat(chunks);
          const end = payload.indexOf(0x0a);
          const header = payload.subarray(0, end).toString("utf8");
          if (!header.startsWith("OK ")) throw new Error("missing blob");
          return new Uint8Array(payload.subarray(end + 1));
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
