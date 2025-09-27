// @ts-check
const fs = require("node:fs");
const path = require("node:path");

const arch = (process.env.npm_config_arch || process.env.M_ARCH || process.arch) === "arm64" ? "arm64" : "x64";

const platform = process.platform;
const platformMap = { linux: "linux", win32: "win", darwin: "mac" };
/**
 * @type {"linux"|"win"|"mac"}
 */
const platform2 = platformMap[platform];

const beforePack = async () => {};

/**
 * @type import("electron-builder").Configuration
 */
const build = {
    appId: "com.view.app",
    executableName: "view",
    directories: {
        output: "build",
    },
    icon: "./assets/logo",
    electronDownload: {
        mirror: "https://npmmirror.com/mirrors/electron/",
    },
    npmRebuild: false,
    fileAssociations: [
        {
            ext: "html",
            mimeType: "text/html",
        },
    ],
    asar: false,
    artifactName: `\${productName}-\${version}-\${platform}-${arch}.\${ext}`,
    // beforePack: beforePack,
    linux: {
        category: "Utility",
        target: [
            { target: "tar.gz", arch },
            { target: "deb", arch },
            { target: "rpm", arch },
            { target: "AppImage", arch },
        ],
        files: [
            "!assets/logo/icon.icns",
            "!assets/logo/icon.ico",
            "!node_modules/onnxruntime-node/bin/napi-v3/win32",
            "!node_modules/onnxruntime-node/bin/napi-v3/darwin",
        ],
    },
    mac: {
        files: [
            "!lib/gtk-open-with",
            "!lib/kde-open-with",
            "!assets/logo/1024x1024.png",
            "!assets/logo/512x512.png",
            "!assets/logo/icon.ico",
            "!node_modules/onnxruntime-node/bin/napi-v3/win32",
            "!node_modules/onnxruntime-node/bin/napi-v3/linux",
        ],
        target: [
            {
                target: "dmg",
                arch: arch,
            },
            {
                target: "zip",
                arch: arch,
            },
        ],
    },
    dmg: {
        writeUpdateInfo: false,
    },
    win: {
        icon: "./assets/logo/icon.ico",
        target: [
            {
                target: "nsis",
                arch: arch,
            },
            {
                target: "zip",
                arch: arch,
            },
        ],
        files: [
            "!lib/gtk-open-with",
            "!lib/kde-open-with",
            "!assets/logo/icon.icns",
            "!assets/logo/1024x1024.png",
            "!assets/logo/512x512.png",
            "!node_modules/onnxruntime-node/bin/napi-v3/linux",
            "!node_modules/onnxruntime-node/bin/napi-v3/darwin",
        ],
    },
    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        differentialPackage: false,
    },
    afterPack: async (c) => {},
};

/** @type {string[]|undefined} */
// @ts-ignore
const files = build[platform2]?.files;

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
    "node_modules/**/*.flow",
    "node_modules/**/*.md",
    "node_modules/**/**esm**",
    "node_modules/**/*.es*",
];
const ignoreModule = [];
for (const i of ignoreModule) {
    ignoreDir.push(`node_modules/${i}`);
}
for (let i of ignoreDir) {
    i = `!${i}`;
    files?.push(i);
}

module.exports = build;

/**
 * @type {Record<string,Record<string,string[]>>}
 */
const release = {
    win32: { gh: ["exe", "zip"], arch: ["x64", "arm64"] },
    linux: { gh: ["AppImage", "deb", "rpm", "tar.gz"], arch: ["x64", "arm64"] },
    darwin: { gh: ["dmg", "zip"], arch: ["x64", "arm64"] },
};

/**
 *
 * @param {string} url
 */
function getUrl(url) {
    const version = require("./package.json").version;
    let t = "| | Windows | macOS | Linux|\n| --- | --- | --- | --- |\n";
    for (const arch of ["x64", "arm64"]) {
        t += `|${arch}| `;
        for (const p of ["win32", "darwin", "linux"]) {
            if (!release[p].arch.includes(arch)) continue;
            t += `${(release[p].gh || []).map((i) => `[${i}](${url.replaceAll("$v", version).replace("$arch", arch).replace("$p", p).replace("$h", i)})`).join(" ")}|`;
        }
        t += "\n";
    }
    return t;
}

console.log(
    "⚡镜像下载：\n",
    getUrl("https://mirror.ghproxy.com/https://github.com/xushengfeng/view/releases/download/$v/view-$v-$p-$arch.$h"),
);
