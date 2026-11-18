import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "target", "release", "libmyde_drm.so");
const targetDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
const target = join(targetDir, "index.node");
// 先复制到临时文件再原子替换：正在被 Electron 加载的旧原生模块不会再让覆盖失败（ETXTBSY）
const temp = `${target}.tmp`;

mkdirSync(targetDir, { recursive: true });
try {
    copyFileSync(source, temp);
    renameSync(temp, target);
} finally {
    rmSync(temp, { force: true });
}

console.log(`myde-drm: ${source} -> ${target}`);
