import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const assets = join("apps", "desktop", "dist", "assets");
const bundles = readdirSync(assets).filter((name) => name.endsWith(".js"));
if (bundles.length === 0) {
  console.error("missing web bundle");
  process.exit(1);
}
const source = bundles.map((name) => readFileSync(join(assets, name), "utf8")).join("\n");
const markers = ["message-row", "download-file", "show-catch-up", "filter-ai", "10.0.2.2"];
for (const marker of markers) {
  if (!source.includes(marker)) {
    console.error(`missing ${marker}`);
    process.exit(1);
  }
}
