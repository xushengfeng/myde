import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const chPath = path.resolve(__dirname, "input-event-codes.h");
const outputTypesPath = path.resolve(__dirname, "../../src/renderer/input_codes/types.ts");

const codeMap = new Map<string, number>();

for (const i of fs.readFileSync(chPath, "utf-8").split("\n")) {
    const match = i.match(/^#define\s+([A-Z_]+)\s+(\(.+\)|\S+)/);
    if (match) {
        if (match[2].match(/^[A-Z]/)) {
            const value = codeMap.get(match[2]);
            if (value !== undefined) {
                codeMap.set(match[1], value);
            } else {
                throw `跳过 ${match[1]}，因为其值 ${match[2]} 未找到`;
            }
        } else if (match[2].startsWith("(")) {
            const match2 = match[2].match(/\((.+)\s*\+\s*(\d+)\)/);
            if (match2) {
                const base = codeMap.get(match2[1].trim());
                if (base !== undefined) {
                    codeMap.set(match[1], base + parseInt(match2[2], 10));
                } else {
                    throw `跳过 ${match[1]}，因为其基值 ${match2[1]} 未找到`;
                }
            }
        } else {
            codeMap.set(match[1], parseInt(match[2]));
        }
        const v = codeMap.get(match[1]);
        console.log(match[1], v);

        if (v === undefined || Number.isNaN(v)) {
            codeMap.delete(match[1]);
            throw `跳过 ${match[1]}，因为其值 ${match[2]} 无法解析`;
        }
    }
}

const TypeLines: string[] = [];
TypeLines.push("// 自动生成，勿手动编辑");
TypeLines.push("");
TypeLines.push("export enum InputEventCodes {");
for (const [k, v] of codeMap) {
    TypeLines.push(`    ${k} = ${v},`);
}
TypeLines.push("}");

fs.writeFileSync(outputTypesPath, TypeLines.join("\n") + "\n", "utf-8");
console.log(`已自动生成事件类型枚举和参数类型: ${outputTypesPath}`);
