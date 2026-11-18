import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "target", "release", "libmyde_drm.so");
const targetDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, join(targetDir, "index.node"));

console.log(`myde-drm: ${source} -> ${join(targetDir, "index.node")}`);
