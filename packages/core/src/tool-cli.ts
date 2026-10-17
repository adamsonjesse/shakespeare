import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { hexToBytes } from "@noble/hashes/utils.js";
import { publicKeyOf } from "./invite.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlExecutor, SqlValue } from "./storage.ts";
import { callTool, ToolError, toolFailureMessage, type ToolContext } from "./tools.ts";

/**
 * CLI for the same club tools the loopback server calls.
 * The private key is read from SHAKESPEARE_PRIVATE_KEY and is never printed.
 */

export async function executeToolCli(options: {
  readonly databasePath: string;
  readonly tool: string;
  readonly args: unknown;
  readonly privateKeyHex: string;
  readonly now?: () => string;
}): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(options.privateKeyHex)) throw new ToolError("forbidden");
  const privateKey = hexToBytes(options.privateKeyHex);
  const author = { publicKey: publicKeyOf(privateKey), privateKey };
  const db = new DatabaseSync(options.databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const executor = openExecutor(db);
    const now = options.now ?? (() => new Date().toISOString());
    await migrate(executor, MIGRATIONS, { now: now() });
    const context: ToolContext = { db: executor, author, now };
    return await callTool(context, options.tool, options.args);
  } finally {
    db.close();
  }
}

function openExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []) {
      db.prepare(sql).run(...params);
    },
    async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
      return db.prepare(sql).all(...params) as Row[];
    },
  };
}

function runningAsCli(): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href || entry.endsWith("/src/tool-cli.ts");
}

if (runningAsCli()) {
  const databasePath = process.argv[2];
  const tool = process.argv[3];
  const json = process.argv[4] ?? "{}";
  const privateKeyHex = process.env.SHAKESPEARE_PRIVATE_KEY ?? "";
  if (databasePath === undefined || tool === undefined) {
    process.stderr.write("Usage: pnpm tools -- <database> <tool> <json>\n");
    process.exit(1);
  }
  let args: unknown;
  try {
    args = JSON.parse(json) as unknown;
  } catch {
    process.stderr.write("The tool rejected that request.\n");
    process.exit(1);
  }
  try {
    const result = await executeToolCli({ databasePath, tool, args, privateKeyHex });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${toolFailureMessage(error)}\n`);
    process.exit(1);
  }
}
