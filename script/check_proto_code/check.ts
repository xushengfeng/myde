/**
 * 静态核对 wayland 协议实现与生成物 `protocols/protocols.json` 的差距。
 *
 * 不做 AST，只在源码里查引号文本：
 *  - 请求：`requests: { "接口.请求"(…) / "接口.请求": (…) }` 里的键
 *  - 事件：`ctx.send/sendNow(id, "接口.事件", …)`、host 侧
 *    `sendMessageImm/sendMessageX(id, "接口.事件", …)` 的第二个实参
 *
 * 三类结果：
 *  - 未实现的请求：协议有、代码没有 handler（析构请求单列，host 会自动删对象）
 *  - 未发送的事件：协议有、代码里没有任何发送点（多为可选事件，只提示）
 *  - 代码里不存在的键：写了但协议里没有，基本是拼写错误（视为错误）
 *
 * 用法：npx tsx script/check_proto_code/check.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WaylandProtocol } from "../../src/wayland/utils/wayland-binary";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

/** 参与扫描的目录：协议模块 + host（host 也直接发事件） */
const scanDirs = ["src/wayland/protocols", "src/wayland/host"];
/** 生成物与测试不算实现 */
const skipFiles = new Set(["wayland-types.ts", "index.ts"]);
const skipSuffix = [".test.ts", ".d.ts"];

// ───────────────────────── 1. 协议侧期望 ─────────────────────────

const protocols = JSON.parse(
    fs.readFileSync(path.join(root, "src/wayland/protocols/protocols.json"), "utf8"),
) as Record<string, WaylandProtocol[]>;

/** 全部请求 → 期望有 handler（值为接口名） */
const expectRequests = new Map<string, string>();
/** 析构请求子集 → host 自动 deleteObj，无 handler 只提示 */
const destructorKeys = new Set<string>();
/** 事件 → 期望至少有一个发送点 */
const expectEvents = new Map<string, string>();

for (const ps of Object.values(protocols)) {
    for (const p of ps) {
        if (p.version === 0) continue;
        for (const r of p.request ?? []) {
            const key = `${p.name}.${r.name}`;
            expectRequests.set(key, p.name);
            if (r.isDestructor || r.name === "destroy") destructorKeys.add(key);
        }
        for (const e of p.event ?? []) {
            expectEvents.set(`${p.name}.${e.name}`, p.name);
        }
    }
}

// ───────────────────────── 2. 代码侧扫描 ─────────────────────────

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
            walk(full, out);
        } else if (name.endsWith(".ts") && !skipFiles.has(name) && !skipSuffix.some((s) => name.endsWith(s))) {
            out.push(full);
        }
    }
    return out;
}

/** 去掉注释，避免注释里的 `"a.b"` 被当成实现；块注释按原行数补回换行，保证行号不错位 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `"a.b"` 后面紧跟 `:`（属性）或 `(`（方法简写）→ 请求 handler 键；排除 `case "a.b":` */
const REQUEST_KEY_RE = /(?<!case )"([a-z][\w]*)\.([a-z][\w]*)"\s*[:(]/g;
/** `ctx.send/sendNow(目标, "a.b"` / `sendMessageImm(目标, "a.b"` → 事件发送点 */
const SEND_RE =
    /(?:ctx\.send(?:Now)?|sendMessageImm|sendMessageX|sendMessage)\s*\(\s*[^,()]*,\s*"([a-z][\w]*\.[a-z][\w]*)"/g;

const protoDir = path.join(root, "src/wayland/protocols");
const files = scanDirs.flatMap((d) => walk(path.join(root, d)));
/** 键 → 出现位置（file:line） */
const foundRequests = new Map<string, string[]>();
const foundEvents = new Map<string, string[]>();

function rel(file: string) {
    return path.relative(root, file);
}

function record(map: Map<string, string[]>, key: string, file: string, line: number) {
    const at = `${rel(file)}:${line}`;
    const list = map.get(key);
    if (list) list.push(at);
    else map.set(key, [at]);
}

for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    // 请求 handler 只可能出现在协议模块里（defineModule），host 的桌面命令键不算
    if (file.startsWith(protoDir)) {
        for (const m of src.matchAll(REQUEST_KEY_RE)) {
            const line = src.slice(0, m.index).split("\n").length;
            record(foundRequests, `${m[1]}.${m[2]}`, file, line);
        }
    }
    for (const m of src.matchAll(SEND_RE)) {
        const line = src.slice(0, m.index).split("\n").length;
        record(foundEvents, m[1], file, line);
    }
}

// ───────────────────────── 3. 对比 ─────────────────────────

const missingAll = [...expectRequests.keys()].filter((k) => !foundRequests.has(k));
const missingEvents = [...expectEvents.keys()].filter((k) => !foundEvents.has(k));
const ghostRequests = [...foundRequests.keys()].filter((k) => !expectRequests.has(k));
const ghostEvents = [...foundEvents.keys()].filter((k) => !expectEvents.has(k));

/** 一个 handler 键被多个文件声明 —— defineModule 装配期会静默覆盖 */
const duplicated = [...foundRequests.entries()].filter(([, locs]) => locs.length > 1);

function byInterface(keys: string[]): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const k of keys) {
        const i = k.slice(0, k.indexOf("."));
        const list = m.get(i);
        if (list) list.push(k.slice(i.length + 1));
        else m.set(i, [k.slice(i.length + 1)]);
    }
    return m;
}

console.log(
    `扫描 ${files.length} 个文件；协议请求 ${expectRequests.size}（析构 ${destructorKeys.size}），事件 ${expectEvents.size}`,
);

const missingDeps = missingAll.filter((k) => destructorKeys.has(k));
const missingReal = missingAll.filter((k) => !destructorKeys.has(k));

console.log(`\n未实现的请求（${missingReal.length}）:`);
for (const [iface, reqs] of byInterface(missingReal)) console.log(`  ${iface}: ${reqs.join(", ")}`);
if (missingDeps.length) {
    console.log(`\n未实现的析构请求（${missingDeps.length}，host 自动删对象，仅提示）:`);
    for (const [iface, reqs] of byInterface(missingDeps)) console.log(`  ${iface}: ${reqs.join(", ")}`);
}

console.log(`\n未发送的事件（${missingEvents.length}）:`);
for (const [iface, evs] of byInterface(missingEvents)) console.log(`  ${iface}: ${evs.join(", ")}`);

if (ghostRequests.length || ghostEvents.length) {
    console.log(`\n代码里不存在的键（协议里查不到，多半是拼写错误）:`);
    for (const k of ghostRequests) console.log(`  request ${k}  ← ${foundRequests.get(k)?.join(", ")}`);
    for (const k of ghostEvents) console.log(`  event   ${k}  ← ${foundEvents.get(k)?.join(", ")}`);
}

if (duplicated.length) {
    console.log(`\n重复声明的请求键（后声明的会覆盖前一个）:`);
    for (const [k, locs] of duplicated) console.log(`  ${k}  ← ${locs.join(", ")}`);
}

const errors = ghostRequests.length + ghostEvents.length + duplicated.length;
console.log(
    `\n${errors === 0 ? "无错误" : `${errors} 处错误`}；未实现 ${missingReal.length} 请求 / ${missingEvents.length} 事件`,
);
process.exitCode = errors === 0 ? 0 : 1;
