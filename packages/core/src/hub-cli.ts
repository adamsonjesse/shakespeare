import { mkdir } from "node:fs/promises";
import { startHub } from "./relay-node.ts";

const directory = process.argv[2];
const portArg = process.argv[3];
if (directory === undefined || portArg === undefined || !/^\d+$/.test(portArg)) {
  process.stderr.write("Usage: pnpm hub -- <directory> <port>\n");
  process.exit(1);
}
const port = Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write("Usage: pnpm hub -- <directory> <port>\n");
  process.exit(1);
}

await mkdir(directory, { recursive: true });
const hub = await startHub(directory, { port });
process.stdout.write(`listening 127.0.0.1 ${hub.port}\n`);
void hub;
