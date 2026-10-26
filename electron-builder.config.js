// @ts-check

const fs = require("node:fs");
const path = require("node:path");

const requestedArch =
    process.env.npm_config_arch ||
    process.env.M_ARCH ||
    (process.argv.includes("--arm64") ? "arm64" : process.argv.includes("--x64") ? "x64" : process.arch);
const arch = requestedArch === "arm64" ? "arm64" : "x64";
const nativeArch = process.arch === "arm64" ? "arm64" : "x64";

// myde-wrap 编译产物（`npm run build:myde-wrap` 或 CI 生成），存在才打进安装包
const mydeWrapBin = path.join(__dirname, "resources", "myde-wrap");

/**
 * @type import("electron-builder").Configuration
 */
const build = {
    appId: "com.myde.app",
    executableName: "myde",
    directories: {
        output: "build",
    },
    icon: "./assets/logo",
    electronDownload: {
        mirror: "https://npmmirror.com/mirrors/electron/",
    },
    npmRebuild: false,
    asar: false,
    artifactName: `\${productName}-\${version}-\${platform}-${arch}.\${ext}`,
    linux: {
        category: "Utility",
        target: [
            { target: "tar.gz", arch },
            { target: "deb", arch },
            { target: "rpm", arch },
        ],
        files: [],
    },
    afterPack: async (_c) => {},
};

if (fs.existsSync(mydeWrapBin)) {
    // myde-wrap 是当前主机的可执行文件；跨架构打包时不能直接塞进安装包
    if (arch === nativeArch || process.env.MYDE_WRAP_ALLOW_CROSS === "1") {
        // 打包到可执行文件同级目录：安装后 `myde-wrap myde` 即可运行
        build.extraFiles = [{ from: "resources/myde-wrap", to: "myde-wrap" }];
    } else {
        console.warn(
            `[electron-builder] 跳过 myde-wrap：当前文件是 ${nativeArch}，目标架构是 ${arch}。请在 ${arch} 主机上重新编译。`,
        );
    }
}

/** @type {string[]|undefined} */
// @ts-expect-error
const files = build.linux?.files;

const ignoreDir = [
    ".*",
    "tsconfig*",
    "*.md",
    "*.js",
    "*.yaml",
    "**/*.map",
    "**/*.ts",
    "src",
    "docs",
    "test",
    // myde-wrap 编译产物由 extraFiles 单独打包，不放进 app 目录
    "resources",
    "node_modules/**/*.flow",
    "node_modules/**/*.md",
    "node_modules/**/**esm**",
    "node_modules/**/*.es*",
];

for (let i of ignoreDir) {
    i = `!${i}`;
    files?.push(i);
}

module.exports = build;
