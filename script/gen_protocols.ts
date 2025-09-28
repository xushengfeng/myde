import * as fs from "node:fs";
import * as path from "node:path";
import * as xml2js from "xml2js";
import { fileURLToPath } from "node:url";
import type { WaylandProtocol, WaylandArgType } from "../src/renderer/wayland/wayland-binary.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supportedProtocols: Array<{ name: string; interfaces: Array<{ name: string; version: number }> }> = [
    {
        name: "wayland",
        interfaces: [
            { name: "wl_display", version: 1 },
            { name: "wl_registry", version: 1 },
            { name: "wl_callback", version: 1 },
            { name: "wl_compositor", version: 6 },
            { name: "wl_shm_pool", version: 2 },
            { name: "wl_shm", version: 2 },
            { name: "wl_seat", version: 10 },
            { name: "wl_output", version: 4 },
        ],
    },
    {
        name: "xdg-shell",
        interfaces: [
            { name: "xdg_wm_base", version: 7 },
            { name: "xdg_surface", version: 7 },
            { name: "xdg_toplevel", version: 7 },
            { name: "xdg_popup", version: 7 },
            { name: "xdg_positioner", version: 7 },
        ],
    },
];

// 支持遍历 supportedProtocols，按 name 读取对应 xml 文件并处理
const xmlDir = path.resolve(__dirname, "xml");
const outputPath = path.resolve(__dirname, "../src/renderer/wayland/protocols.json");

// 先读取已有 JSON 内容
let allResults: Record<string, WaylandProtocol[]> = {};
if (fs.existsSync(outputPath)) {
    try {
        allResults = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    } catch (e) {
        allResults = {};
    }
}

supportedProtocols.forEach((proto) => {
    const xmlFile = path.join(xmlDir, `${proto.name}.xml`);
    if (!fs.existsSync(xmlFile)) {
        console.warn(`未找到协议文件: ${xmlFile}`);
        return;
    }
    const unOk: string[] = [];
    const overVersion: string[] = [];
    const xmlData = fs.readFileSync(xmlFile, "utf-8");
    xml2js.parseString(xmlData, (err, result) => {
        if (err) throw err;
        const protocol = result.protocol;
        const interfaces = protocol.interface || [];
        const filterList = proto.interfaces;
        const protocols: WaylandProtocol[] = [];
        interfaces.forEach((iface: any) => {
            const name = iface.$.name;
            const version = parseInt(iface.$.version || "1", 10);
            const match = filterList.find((i) => i.name === name);
            if (!match) {
                unOk.push(JSON.stringify({ name, version }));
                return;
            }
            if (match.version !== version) {
                overVersion.push(`${name} ${version} > ${match.version}`);
                // 保留原 protocols.json 中的内容
                const oldList = allResults[proto.name] || [];
                const old = oldList.find((item) => item.name === name);
                if (old) {
                    protocols.push(old);
                }
                return;
            }
            const request = (iface.request || []).map((req: any) => ({
                name: req.$.name,
                args: (req.arg || []).map((arg: any) => ({
                    name: arg.$.name,
                    type: arg.$.type as WaylandArgType,
                    interface: arg.$.interface,
                })),
            }));
            const event = (iface.event || []).map((evt: any) => ({
                name: evt.$.name,
                args: (evt.arg || []).map((arg: any) => ({
                    name: arg.$.name,
                    type: arg.$.type as WaylandArgType,
                    interface: arg.$.interface,
                })),
            }));
            const enums = (iface.enum || []).map((enm: any) => ({
                name: enm.$.name,
                enum: Object.fromEntries(
                    // biome-ignore lint/correctness/useParseIntRadix: 像0x开头的字符串需要parseInt自动识别为16进制
                    (enm.entry || []).map((entry: any) => [entry.$.name, parseInt(entry.$.value)]),
                ),
            }));
            protocols.push({ name, version, request, event, enum: enums });
        });
        allResults[proto.name] = protocols;

        if (unOk.length > 0) {
            console.warn(`协议 ${proto.name} 存在不支持的接口:\n\n`, unOk.join("\n"), "\n");
        }
        if (overVersion.length > 0) {
            console.warn(`协议 ${proto.name} 存在版本过高的接口:\n\n`, overVersion.join("\n"), "\n");
        }
    });
});
fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf-8");
console.log(`已生成协议文件: ${outputPath}`);
