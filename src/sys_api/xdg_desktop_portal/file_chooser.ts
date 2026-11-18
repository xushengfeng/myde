const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path") as typeof import("node:path");

import { buildChoiceResults, parseChoice } from "./choices";
import { fromWireFilter, toWireFilter, type WireFilter } from "./filters";
import { PortalRequestBase } from "./portal_request";
import type {
    FileChooserMode,
    FileChooserRequest,
    FileChooserSelection,
    PortalAcceptResult,
    PortalChoice,
    PortalFilter,
} from "./types";
import { decodePathBytes, pathToUri } from "./uri";
import { optionValue, variant, type WireDict } from "./wire";

export interface ParsedFileChooserOptions {
    acceptLabel: string;
    modal: boolean;
    multiple: boolean;
    directory: boolean;
    filters: PortalFilter[];
    currentFilter?: PortalFilter;
    choices: PortalChoice[];
    currentFolder?: string;
    currentName: string;
    currentFile?: string;
    files: string[];
}

export function parseFileChooserOptions(options: WireDict | undefined): ParsedFileChooserOptions {
    const dict = Array.isArray(options) ? options : [];
    const rawFilters = optionValue(dict, "filters", "a(sa(us))") ?? [];
    const rawCurrentFilter = optionValue(dict, "current_filter", "(sa(us))");
    const rawChoices = optionValue(dict, "choices", "a(ssa(ss)s)") ?? [];
    const rawFiles = optionValue(dict, "files", "aay") ?? [];

    return {
        acceptLabel: optionValue(dict, "accept_label", "s") ?? "",
        modal: optionValue(dict, "modal", "b") ?? true,
        multiple: optionValue(dict, "multiple", "b") ?? false,
        directory: optionValue(dict, "directory", "b") ?? false,
        filters: rawFilters.map(fromWireFilter),
        currentFilter: rawCurrentFilter ? fromWireFilter(rawCurrentFilter) : undefined,
        choices: rawChoices.map(parseChoice).filter((c) => c.id.length > 0),
        currentFolder: decodePathBytes(optionValue(dict, "current_folder", "ay")),
        currentName: optionValue(dict, "current_name", "s") ?? "",
        currentFile: decodePathBytes(optionValue(dict, "current_file", "ay")),
        files: rawFiles.map((f) => decodePathBytes(f)).filter((f): f is string => f !== undefined),
    };
}

function ensureAbsolute(filePath: string): string {
    if (filePath.includes("\0")) throw new Error("路径包含 NUL");
    if (!path.isAbsolute(filePath)) throw new Error(`需要绝对路径: ${filePath}`);
    return path.normalize(filePath);
}

async function resolveOpenPath(filePath: string, directory: boolean): Promise<string> {
    const abs = ensureAbsolute(filePath);
    let real: string;
    try {
        real = await fsp.realpath(abs);
    } catch {
        throw new Error(`文件不存在: ${filePath}`);
    }
    const stats = await fsp.stat(real);
    if (directory && !stats.isDirectory()) throw new Error(`请选择文件夹: ${filePath}`);
    if (!directory && stats.isDirectory()) throw new Error(`请选择文件: ${filePath}`);
    return real;
}

async function resolveSavePath(filePath: string): Promise<string> {
    const abs = ensureAbsolute(filePath);
    if (abs.endsWith(path.sep)) throw new Error(`保存路径不能以 / 结尾: ${filePath}`);
    const name = path.basename(abs);
    if (!name || name === "." || name === "..") throw new Error(`文件名无效: ${filePath}`);

    const dir = path.dirname(abs);
    let realDir: string;
    try {
        realDir = await fsp.realpath(dir);
    } catch {
        throw new Error(`目录不存在: ${dir}`);
    }
    const dirStats = await fsp.stat(realDir);
    if (!dirStats.isDirectory()) throw new Error(`不是目录: ${dir}`);

    const target = path.join(realDir, name);
    const existing = await fsp.stat(target).catch(() => undefined);
    if (existing?.isDirectory()) throw new Error(`目标路径是目录: ${filePath}`);
    return target;
}

/**
 * 一个文件选择请求。portal 方法会 await `wait()`，桌面 UI 通过 accept/cancel/fail 结束。
 * 所有结束路径都幂等。
 */
export class FileChooserRequestImpl extends PortalRequestBase implements FileChooserRequest {
    readonly title: string;
    readonly mode: FileChooserMode;
    readonly acceptLabel: string;
    readonly multiple: boolean;
    readonly directory: boolean;
    readonly filters: PortalFilter[];
    readonly currentFilter?: PortalFilter;
    readonly choices: PortalChoice[];
    readonly currentFolder?: string;
    readonly currentName: string;
    readonly currentFile?: string;
    readonly files: string[];

    constructor(op: {
        id: string;
        appId: string;
        parentWindow: string;
        title: string;
        mode: FileChooserMode;
        options: ParsedFileChooserOptions;
    }) {
        super({
            id: op.id,
            appId: op.appId,
            parentWindow: op.parentWindow,
            modal: op.options.modal,
        });
        this.title = op.title;
        this.mode = op.mode;
        this.acceptLabel = op.options.acceptLabel;
        this.multiple = op.options.multiple;
        this.directory = op.options.directory;
        this.filters = op.options.filters;
        this.currentFilter = op.options.currentFilter;
        this.choices = op.options.choices;
        this.currentFolder = op.options.currentFolder;
        this.currentName = op.options.currentName;
        this.currentFile = op.options.currentFile;
        this.files = op.options.files;
    }

    async accept(selection: FileChooserSelection): Promise<PortalAcceptResult> {
        if (this.isClosed) return { ok: false, error: "请求已结束" };
        try {
            const results = await this.buildResults(selection);
            if (this.isClosed) return { ok: false, error: "请求已结束" };
            this.finish(0, results);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    private async buildResults(selection: FileChooserSelection): Promise<WireDict> {
        if (!Array.isArray(selection.paths) || selection.paths.length === 0) {
            throw new Error("没有选择文件");
        }
        const inputPaths = selection.paths;
        if (!this.multiple && inputPaths.length !== 1) {
            throw new Error("此请求只允许选择一个文件");
        }

        let paths: string[];
        if (this.mode === "open") {
            paths = [];
            for (const p of inputPaths) {
                paths.push(await resolveOpenPath(p, this.directory));
            }
        } else if (this.mode === "save") {
            if (inputPaths.length !== 1) throw new Error("保存请求只允许一个路径");
            paths = [await resolveSavePath(inputPaths[0])];
        } else {
            paths = [];
            for (const p of inputPaths) {
                paths.push(await resolveSavePath(p));
            }
            if (new Set(paths).size !== paths.length) throw new Error("保存路径重复");
        }

        const results: WireDict = [];
        results.push(["uris", variant("as", [paths.map(pathToUri)])]);

        if (this.choices.length > 0) {
            results.push(["choices", variant("a(ss)", [buildChoiceResults(this.choices, selection.choices)])]);
        }

        const filter = selection.currentFilter ?? this.currentFilter;
        if (filter) {
            results.push(["current_filter", variant("(sa(us))", [toWireFilter(filter)])]);
        }

        return results;
    }
}

export type { WireFilter };
