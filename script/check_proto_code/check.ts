import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WaylandProtocol } from "../../src/renderer/wayland/wayland-binary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const protoCode = fs.readFileSync(path.join(__dirname, "../../src/renderer/view/view.ts"), "utf8");

const WaylandProtocolsx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/renderer/wayland/protocols.json"), "utf8"),
) as Record<string, WaylandProtocol[]>;

const all = new Set<string>();
const allProto = new Set<string>();
for (const ps of Object.values(WaylandProtocolsx)) {
    for (const p of ps) {
        const interfaceName = p.name;
        if (p.version === 0) continue;
        allProto.add(interfaceName);
        for (const r of p.request ?? []) {
            if (r.name === "destroy") continue;
            all.add(`${interfaceName}.${r.name}`);
        }
        for (const e of p.event ?? []) {
            all.add(`${interfaceName}.${e.name}`);
        }
    }
}
const req: string[] = [];
for (const m of protoCode.split("\n")) {
    if (m.includes("isOp")) {
        const op = m.match(/isOp\("(.+?)"/)?.[1];
        if (op) {
            req.push(op);
        }
    }
}
const event: string[] = [];
for (const m of protoCode.split("\n")) {
    const ev = m.match(/this\.sendMessage.*"(\w+\.\w+)/)?.[1];
    if (ev) {
        event.push(ev);
    }
}

for (const r of req) {
    all.delete(r);
}
for (const e of event) {
    all.delete(e);
}
console.log("Missing in code:", all);
for (const a of all) {
    const i = a.split(".")[0];
    allProto.delete(i);
}
console.log("全部完成", allProto);
