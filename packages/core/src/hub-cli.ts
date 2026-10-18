import { mkdir } from "node:fs/promises";
import { startHub } from "./relay-node.ts";

const directory = process.argv[2];
const portArg = process.argv[3];
const membersArg = process.argv[4];
const bytesArg = process.argv[5];
if (directory === undefined || portArg === undefined || !/^\d+$/.test(portArg)) {
  process.stderr.write("Usage: pnpm hub -- <directory> <port> [maxMembers] [maxBlobBytes]\n");
  process.exit(1);
}
const port = Number(portArg);
const limits = readLimits(membersArg, bytesArg);
if (!Number.isInteger(port) || port < 0 || port > 65535 || limits === "invalid") {
  process.stderr.write("Usage: pnpm hub -- <directory> <port> [maxMembers] [maxBlobBytes]\n");
  process.exit(1);
}

await mkdir(directory, { recursive: true });
const hub = await startHub(directory, limits === undefined ? { port } : { port, limits });
process.stdout.write(`listening 127.0.0.1 ${hub.port}\n`);
void hub;

function readLimits(
  membersArg: string | undefined,
  bytesArg: string | undefined,
): { maxMembers: number; maxBlobBytes: number } | undefined | "invalid" {
  if (membersArg === undefined && bytesArg === undefined) return undefined;
  if (membersArg === undefined || bytesArg === undefined) return "invalid";
  if (!/^\d+$/.test(membersArg) || !/^\d+$/.test(bytesArg)) return "invalid";
  const maxMembers = Number(membersArg);
  const maxBlobBytes = Number(bytesArg);
  if (!Number.isSafeInteger(maxMembers) || maxMembers <= 0) return "invalid";
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes <= 0) return "invalid";
  return { maxMembers, maxBlobBytes };
}
