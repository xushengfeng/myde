import { dbusClient, type dbusInterface, type dbusIO, type dbusService } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

/** 合成状态快照 */
export interface ImComposeState {
    /** 预编辑（合成中）文本 */
    preedit: string;
    /** 预编辑光标（字符下标，-1 表示无） */
    preeditCursor: number;
    /** 辅助文本 */
    auxiliary: string;
    /** 候选词 */
    candidates: string[];
    /** 候选词标签（如 "1." "2."） */
    candidateLabels: string[];
    /** 高亮候选下标，-1 表示无 */
    candidateCursor: number;
    /** 候选布局（0=纵向等，来自 fcitx5 layoutHint） */
    candidateLayout: number;
    hasPrev: boolean;
    hasNext: boolean;
}

/** 单次按键/输入的结果 */
export interface ImKeyResult extends ImComposeState {
    /** 按键是否被输入法处理 */
    handled: boolean;
    /** 本次输入提交的文本（未提交为空串） */
    committed: string;
}

/** 当前输入法信息 */
export interface ImCurrentIM {
    name: string;
    uniqueName: string;
    language: string;
}

/** 合成会话事件 */
export type ImEvents = {
    /** 合成状态更新（预编辑/候选词等变化） */
    update: [ImComposeState];
    /** 提交文字 */
    commit: [string];
    /** 当前输入法变化 */
    im: [ImCurrentIM];
};

const emptyState = (): ImComposeState => ({
    preedit: "",
    preeditCursor: 0,
    auxiliary: "",
    candidates: [],
    candidateLabels: [],
    candidateCursor: -1,
    candidateLayout: 0,
    hasPrev: false,
    hasNext: false,
});

const FCITX_SERVICES = ["org.freedesktop.portal.Fcitx", "org.fcitx.Fcitx5"];
const INPUT_METHOD_PATH = "/org/freedesktop/portal/inputmethod";
const INPUT_METHOD_IFACE = "org.fcitx.Fcitx.InputMethod1";
const INPUT_CONTEXT_IFACE = "org.fcitx.Fcitx.InputContext1";

// 能力位图（fcitx5 CapabilityFlag）
const CAP_CLIENT_SIDE_UI = 1n << 0n;
const CAP_PREEDIT = 1n << 1n;
const CAP_FORMATTED_PREEDIT = 1n << 4n;
const CAP_CLIENT_SIDE_INPUT_PANEL = 1n << 39n;
// 注意不能全置 1——会带上 Disable(1<<40)/Password(1<<3) 位，
// fcitx5 将强制退化为键盘布局，不做任何合成
const CAP_DEFAULT = CAP_CLIENT_SIDE_UI | CAP_PREEDIT | CAP_FORMATTED_PREEDIT | CAP_CLIENT_SIDE_INPUT_PANEL;

/**
 * 输入法系统 API（fcitx5，原生 InputMethod1 / InputContext1 协议）
 *
 * 通过 dbus 连接 fcitx5，传入字母（按键），返回合成中的预编辑文本、候选词、提交文本。
 */
export class inputMethod {
    private client: dbusClient;
    private service: dbusService | undefined;

    constructor(dbus: dbusIO) {
        this.client = new dbusClient({ io: dbus });
    }

    /** 探测 fcitx5 是否可用 */
    async init(): Promise<boolean> {
        for (const name of FCITX_SERVICES) {
            try {
                const s = await this.client.getService(name);
                const infc = await (await s.getObject(INPUT_METHOD_PATH)).getInterface(INPUT_METHOD_IFACE);
                await infc.call("Version").as<"u">();
                this.service = s;
                return true;
            } catch {
                // 尝试下一个服务名
            }
        }
        return false;
    }

    /** 创建一个合成会话 */
    async createContext(program = "myde", capabilities: bigint = CAP_DEFAULT): Promise<inputMethodContext> {
        if (!this.service) {
            throw new Error("input_method: 未初始化或 fcitx5 不可用");
        }
        const im = await (await this.service.getObject(INPUT_METHOD_PATH)).getInterface(INPUT_METHOD_IFACE);
        const [path] = await im.call<"a(ss)">("CreateInputContext", "a(ss)", [["program", program]]).as<"oay">();
        const ctx = new inputMethodContext(this.service, path, capabilities);
        await ctx.init();
        return ctx;
    }
}

/** 一个合成会话（对应一个 fcitx5 InputContext1） */
export class inputMethodContext extends EventEmitter<ImEvents> {
    private service: dbusService;
    private path: string;
    private capabilities: bigint;
    private ic: dbusInterface | undefined;
    private state: ImComposeState = emptyState();
    /** 客户端预编辑（合成串，显示在输入框内） */
    private preeditClient = { text: "", cursor: 0 };
    /** 面板预编辑（候选窗顶部的合成串） */
    private preeditPanel = { text: "", cursor: 0 };
    private committedBuf = "";
    private unsubs: (() => void)[] = [];
    private currentIM: ImCurrentIM = { name: "", uniqueName: "", language: "" };

    constructor(service: dbusService, path: string, capabilities: bigint = CAP_DEFAULT) {
        super();
        this.service = service;
        this.path = path;
        this.capabilities = capabilities;
    }

    async init() {
        const ic = await (await this.service.getObject(this.path)).getInterface(INPUT_CONTEXT_IFACE);
        this.ic = ic;

        this.unsubs.push(
            await ic.on<"s">("CommitString", (text) => {
                this.committedBuf += text;
                this.emit("commit", text);
            }),
        );
        this.unsubs.push(
            await ic.on<"a(si)i">("UpdateFormattedPreedit", (segments, cursor) => {
                this.preeditClient = { text: formatSegments(segments), cursor };
                this.syncPreedit();
                this.emitUpdate();
            }),
        );
        this.unsubs.push(
            // a(si)i preedit + 光标, a(si) aux上, a(si) aux下, a(ss) 候选(标签,文本), i 高亮, i 布局, b 有上页, b 有下页
            await ic.on<"a(si)ia(si)a(si)a(ss)iibb">(
                "UpdateClientSideUI",
                (preedit, cursor, auxUp, auxDown, candidates, candidateCursor, layout, hasPrev, hasNext) => {
                    this.preeditPanel = { text: formatSegments(preedit), cursor };
                    this.syncPreedit();
                    this.state.auxiliary = `${formatSegments(auxUp)}${formatSegments(auxDown)}`;
                    this.state.candidateLabels = candidates.map(([label]) => label);
                    this.state.candidates = candidates.map(([, text]) => text);
                    this.state.candidateCursor = candidateCursor;
                    this.state.candidateLayout = layout;
                    this.state.hasPrev = hasPrev;
                    this.state.hasNext = hasNext;
                    this.emitUpdate();
                },
            ),
        );
        this.unsubs.push(
            await ic.on<"sss">("CurrentIM", (name, uniqueName, language) => {
                this.currentIM = { name, uniqueName, language };
                this.emit("im", { ...this.currentIM });
            }),
        );

        await ic.call<"t">("SetCapability", "t", this.capabilities).await();
    }

    /** 合并两个预编辑来源：客户端预编辑优先，其次面板预编辑 */
    private syncPreedit() {
        const src = this.preeditClient.text ? this.preeditClient : this.preeditPanel;
        this.state.preedit = src.text;
        this.state.preeditCursor = src.cursor;
    }

    private emitUpdate() {
        this.emit("update", this.getState());
    }

    /** 会话可用的接口（销毁后调用抛错） */
    private iface(): dbusInterface {
        if (!this.ic) {
            throw new Error("input_method: 会话未初始化或已销毁");
        }
        return this.ic;
    }

    /** 获取上下文对象路径 */
    getPath() {
        return this.path;
    }

    /** 当前输入法信息 */
    getCurrentIM(): ImCurrentIM {
        return { ...this.currentIM };
    }

    /** 当前合成状态快照 */
    getState(): ImComposeState {
        return {
            ...this.state,
            candidates: [...this.state.candidates],
            candidateLabels: [...this.state.candidateLabels],
        };
    }

    /** 获得焦点（合成需要） */
    async focus() {
        await this.iface().call("FocusIn").await();
    }

    /** 失去焦点 */
    async blur() {
        await this.iface().call("FocusOut").await();
    }

    /** 传入单个按键（X keysym，如 0x61='a'、0xff08=BackSpace），返回合成结果 */
    async keyEvent(keyval: number, isRelease = false): Promise<ImKeyResult> {
        this.committedBuf = "";
        const [handled] = await this.iface()
            .call<"uuubu">("ProcessKeyEvent", "uuubu", keyval, 0, 0, isRelease, 0)
            .as<"b">();
        await new Promise((r) => setTimeout(r, 30));
        return { ...this.getState(), handled, committed: this.committedBuf };
    }

    /** 传入字母（字符串，逐字符发按键），返回合成结果 */
    async type(text: string): Promise<ImKeyResult> {
        this.committedBuf = "";
        let handled = false;
        for (const ch of text) {
            const keyval = ch.codePointAt(0) ?? 0;
            const [h] = await this.iface().call<"uuubu">("ProcessKeyEvent", "uuubu", keyval, 0, 0, false, 0).as<"b">();
            handled = h || handled;
            await this.iface()
                .call<"uuubu">("ProcessKeyEvent", "uuubu", keyval, 0, 0, true, 0)
                .as<"b">()
                .catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 30));
        return { ...this.getState(), handled, committed: this.committedBuf };
    }

    /** 选择候选词（页内下标），会提交文字 */
    async selectCandidate(index: number): Promise<ImKeyResult> {
        this.committedBuf = "";
        await this.iface().call<"i">("SelectCandidate", "i", index).await();
        await new Promise((r) => setTimeout(r, 30));
        return { ...this.getState(), handled: true, committed: this.committedBuf };
    }

    /** 候选翻页 */
    async nextPage() {
        await this.iface().call("NextPage").await();
    }

    async prevPage() {
        await this.iface().call("PrevPage").await();
    }

    /** 丢弃当前合成（不提交） */
    async reset() {
        await this.iface().call("Reset").await();
        this.state = emptyState();
        this.preeditClient = { text: "", cursor: 0 };
        this.preeditPanel = { text: "", cursor: 0 };
        this.committedBuf = "";
    }

    /** 销毁会话 */
    async destroy() {
        for (const un of this.unsubs) un();
        this.unsubs = [];
        await this.ic
            ?.call("DestroyIC")
            .await()
            .catch(() => {});
        this.ic = undefined;
        this.removeAllListeners("update");
        this.removeAllListeners("commit");
        this.removeAllListeners("im");
    }
}

/** a(si) 文本段 → 纯文本 */
function formatSegments(segments: [string, number][]): string {
    return segments.map(([text]) => text).join("");
}
