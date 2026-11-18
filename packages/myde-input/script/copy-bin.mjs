import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "rust", "target", "release", "myde-input-reader");
const targetDir = join(root, "bin");
const target = join(targetDir, `myde-input-reader-${process.platform}-${process.arch}`);
// 先复制到临时文件再原子替换：正在运行的旧二进制不会再让覆盖失败（ETXTBSY）
const temp = `${target}.tmp`;

mkdirSync(targetDir, { recursive: true });
try {
  copyFileSync(source, temp);
  renameSync(temp, target);
} finally {
  rmSync(temp, { force: true });
}

console.log(`myde-input: ${source} -> ${target}`);
