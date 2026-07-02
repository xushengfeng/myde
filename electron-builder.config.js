// @ts-check

const arch = (process.env.npm_config_arch || process.env.M_ARCH || process.arch) === "arm64" ? "arm64" : "x64";

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
    afterPack: async (c) => {},
};

/** @type {string[]|undefined} */
// @ts-ignore
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
