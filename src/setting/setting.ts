const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

type SettingJson<t extends Record<string, unknown>> = t & {
    version: string;
    namespace: { [namespace: string]: { [key: string]: unknown } };
};

export type { SettingJson };

export type settingTransform = (
    oldSetting: SettingJson<Record<string, unknown>>,
    versionA: string,
    versionB: string,
) => SettingJson<Record<string, unknown>>;

export class setting<mainSetting extends Record<string, unknown>> {
    private version: string;
    private filePath: string;
    private defaultSetting: mainSetting;
    private globalTransform: settingTransform;

    constructor(op: {
        version: string;
        filePath: string;
        transform: settingTransform;
        defaultSetting: mainSetting;
    }) {
        this.version = op.version;
        this.filePath = op.filePath;
        this.globalTransform = op.transform;
        this.defaultSetting = op.defaultSetting;

        this.ensureFileExists(op.filePath);

        if (op.filePath && fs.existsSync(op.filePath)) {
            const oldSetting = this.readJson(op.filePath);
            const newSetting = op.transform(oldSetting, oldSetting.version, op.version) as Record<string, unknown>;
            this.writeJson(op.filePath, { ...newSetting, version: op.version } as SettingJson<mainSetting>);
        }
    }

    init<moreSetting extends Record<string, unknown>>(op: {
        version: string;
        nameSpace?: string;
        defaultNsSetting: moreSetting;
        transform?: (oldSetting: Record<string, unknown>) => moreSetting;
    }) {
        const filePath = this.filePath;
        const namespace = op.nameSpace || "default";

        const data = this.readJson(filePath);
        let needWrite = false;

        // 处理命名空间
        if (!data.namespace) {
            data.namespace = {};
        }
        if (!data.namespace[namespace]) {
            data.namespace[namespace] = {};
            needWrite = true;
        }

        // 命名空间 transform
        if (op.transform) {
            const nsSetting = data.namespace[namespace];
            data.namespace[namespace] = op.transform(nsSetting);
            needWrite = true;
        }

        if (needWrite) {
            this.writeJson(filePath, data);
        }

        const readJson = this.readJson.bind(this);
        const writeJson = this.writeJson.bind(this);
        const globalTransform = this.globalTransform?.bind(this) ?? ((data) => data);
        type xSetting = mainSetting; // todo 根据版本选择历史类型
        const transformP2Main = (data: SettingJson<xSetting>): SettingJson<mainSetting> => {
            return globalTransform(data, op.version, this.version) as SettingJson<mainSetting>;
        };
        const transformMain2P = (data: SettingJson<mainSetting>): SettingJson<xSetting> => {
            return globalTransform(data, this.version, op.version) as SettingJson<xSetting>;
        };
        const defaultSetting = this.defaultSetting;

        return {
            get<K extends keyof xSetting>(key: K): xSetting[K] {
                if (key === "namespace") {
                    // @ts-expect-error
                    return undefined;
                }
                const data = readJson(filePath);
                const nData = transformMain2P(data);
                if (key in nData) {
                    return nData[key];
                }
                return defaultSetting[key];
            },
            set<K extends keyof xSetting>(key: K, value: xSetting[K]) {
                if (key === "namespace") return;
                if (key === "version") return;
                const data = readJson(filePath);
                const nData = transformMain2P(data);
                // @ts-expect-error
                nData[key] = value;
                const pData = transformP2Main(nData);
                writeJson(filePath, pData);
            },
            nget<K extends keyof moreSetting>(key: K): moreSetting[K] {
                const data = readJson(filePath);
                const namespaceObj = data.namespace;
                if (
                    namespaceObj &&
                    typeof namespaceObj === "object" &&
                    namespaceObj !== null &&
                    namespaceObj[namespace] &&
                    key in namespaceObj[namespace]
                ) {
                    return namespaceObj[namespace][key as string] as moreSetting[K];
                }
                return op.defaultNsSetting[key];
            },
            nset<K extends keyof moreSetting>(key: K, value: moreSetting[K]) {
                const data = readJson(filePath);
                if (!data.namespace) {
                    data.namespace = {};
                }
                if (typeof data.namespace === "object" && data.namespace !== null) {
                    if (!data.namespace[namespace]) {
                        data.namespace[namespace] = {};
                    }
                    data.namespace[namespace][key as string] = value;
                }
                writeJson(filePath, data);
            },
        };
    }

    private ensureFileExists(filePath: string): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(filePath)) {
            const defaultData = { version: this.version, namespace: {} } as SettingJson<mainSetting>;
            fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), "utf-8");
        }
    }

    private readJson(filePath: string): SettingJson<mainSetting> {
        const content = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(content) as SettingJson<mainSetting>;
    }

    private writeJson(filePath: string, data: SettingJson<mainSetting>): void {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    }
}
