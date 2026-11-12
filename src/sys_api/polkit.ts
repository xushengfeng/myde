import { type DBusType, dbusClient, type dbusIO, dbusMessage, dbusVariant, MessageType } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

const fs = require("node:fs") as typeof import("node:fs");
const net = require("node:net") as typeof import("node:net");
const childProcess = require("node:child_process") as typeof import("node:child_process");

const AUTHORITY_BUS = "org.freedesktop.PolicyKit1";
const AUTHORITY_PATH = "/org/freedesktop/PolicyKit1/Authority";
const AUTHORITY_IFACE = "org.freedesktop.PolicyKit1.Authority";
const AGENT_IFACE = "org.freedesktop.PolicyKit1.AuthenticationAgent";
const DEFAULT_AGENT_PATH = "/org/myde/PolicyKit1/AuthenticationAgent";

const LOGIN_BUS = "org.freedesktop.login1";
const LOGIN_MANAGER_PATH = "/org/freedesktop/login1";
const LOGIN_MANAGER_IFACE = "org.freedesktop.login1.Manager";
const LOGIN_SESSION_IFACE = "org.freedesktop.login1.Session";
const LOGIN_USER_IFACE = "org.freedesktop.login1.User";

const DEFAULT_HELPER_SOCKET = "/run/polkit/agent-helper.socket";
const HELPER_CANDIDATES = [
    "/run/wrappers/bin/polkit-agent-helper-1",
    "/run/wrappers/bin/.polkit-agent-helper-1-wrapped",
    "/usr/lib/polkit-1/polkit-agent-helper-1",
    "/usr/libexec/polkit-1/polkit-agent-helper-1",
    "/usr/lib64/polkit-1/polkit-agent-helper-1",
    "/usr/lib/policykit-1/polkit-agent-helper-1",
    "/usr/libexec/policykit-1/polkit-agent-helper-1",
];

const ERROR_FAILED = "org.freedesktop.PolicyKit1.Error.Failed";

type WireVariant = { signature: string; value: unknown[] };
type WireDict = [string, WireVariant][];
type DetailEntry = [string, string];

export interface PolkitIdentity {
    /** 身份类型，如 "unix-user" / "unix-group" */
    kind: string;
    /** 原始身份字符串，如 "unix-user:1000" */
    id: string;
    /** 显示名；unix-user 为用户名，其它类型为原始身份 */
    name: string;
    uid?: number;
    gid?: number;
}

export interface PolkitAuthRequest {
    /** 进程内唯一的请求编号；从 1 开始递增，不是 polkit cookie */
    readonly id: number;
    readonly actionId: string;
    readonly message: string;
    readonly iconName: string;
    readonly details: Readonly<Record<string, string>>;
    readonly identities: readonly PolkitIdentity[];
    /** 从 details 里提取的命令行 */
    readonly command: string;
    readonly vendor: string;
    readonly vendorUrl: string;
    /** 当前选中的身份 */
    readonly selectedIdentity: PolkitIdentity;
    /** PAM 的最新提示文本 */
    readonly prompt: string;
    /** PAM 提示是否回显（例如用户名输入） */
    readonly echo: boolean;
    readonly info: string;
    readonly error: string;

    /** 把用户输入的密码交给 PAM；echo 为 false 时是密码，true 时是普通输入 */
    submitPassword(value: string): void;
    /** 取消这次认证 */
    cancel(): void;
    /** 切换认证身份，返回是否找到该身份 */
    selectIdentity(identityId: string): boolean;
}

export interface PolkitAuthResult {
    success: boolean;
    cancelled: boolean;
}

export type PolkitEvents = {
    "auth-request": [request: PolkitAuthRequest];
    "auth-prompt": [request: PolkitAuthRequest, prompt: string, echo: boolean];
    "auth-info": [request: PolkitAuthRequest, message: string];
    "auth-error": [request: PolkitAuthRequest, message: string];
    "auth-identity-changed": [request: PolkitAuthRequest, identity: PolkitIdentity];
    "auth-end": [request: PolkitAuthRequest, result: PolkitAuthResult];
};

export interface polkitOptions {
    /** 认证 agent 对象的 D-Bus path */
    objectPath?: string;
    /** 测试或特殊环境下直接指定 logind session id */
    sessionId?: string;
    /** 传给 polkitd 的 locale */
    locale?: string;
    /** 直接指定 polkit-agent-helper-1 路径；默认自动探测 */
    helperPath?: string;
    /** polkit-agent-helper socket；默认 /run/polkit/agent-helper.socket */
    helperSocketPath?: string;
    /** 自行指定的 helper 是否必须带 setuid 位，默认 true */
    requireSetuidHelper?: boolean;
    /** 可选：在总线上申请这个 name。polkitd 用的是连接的唯一名，正常不需要 */
    busName?: string;
}

interface PolkitRequestActions {
    submitPassword(request: PolkitAuthRequestImpl, value: string): void;
    cancel(request: PolkitAuthRequestImpl): void;
    selectIdentity(request: PolkitAuthRequestImpl, identityId: string): boolean;
}

class PolkitAuthRequestImpl implements PolkitAuthRequest {
    readonly id: number;
    readonly actionId: string;
    readonly message: string;
    readonly iconName: string;
    readonly details: Readonly<Record<string, string>>;
    readonly identities: readonly PolkitIdentity[];
    readonly command: string;
    readonly vendor: string;
    readonly vendorUrl: string;

    private readonly actions: PolkitRequestActions;
    private selectedIndex: number;
    private promptText = "";
    private echoPrompt = false;
    private infoText = "";
    private errorText = "";

    constructor(
        op: {
            id: number;
            actionId: string;
            message: string;
            iconName: string;
            details: Record<string, string>;
            identities: PolkitIdentity[];
            command: string;
            vendor: string;
            vendorUrl: string;
            selectedIndex: number;
        },
        actions: PolkitRequestActions,
    ) {
        this.id = op.id;
        this.actionId = op.actionId;
        this.message = op.message;
        this.iconName = op.iconName;
        this.details = op.details;
        this.identities = op.identities;
        this.command = op.command;
        this.vendor = op.vendor;
        this.vendorUrl = op.vendorUrl;
        this.selectedIndex = op.selectedIndex;
        this.actions = actions;
    }

    get selectedIdentity(): PolkitIdentity {
        return this.identities[this.selectedIndex] ?? this.identities[0];
    }

    get prompt(): string {
        return this.promptText;
    }

    get echo(): boolean {
        return this.echoPrompt;
    }

    get info(): string {
        return this.infoText;
    }

    get error(): string {
        return this.errorText;
    }

    submitPassword(value: string): void {
        this.actions.submitPassword(this, value);
    }

    cancel(): void {
        this.actions.cancel(this);
    }

    selectIdentity(identityId: string): boolean {
        return this.actions.selectIdentity(this, identityId);
    }

    setSelectedIndex(index: number): void {
        this.selectedIndex = index;
    }

    setPrompt(prompt: string, echo: boolean): void {
        this.promptText = prompt;
        this.echoPrompt = echo;
    }

    setInfo(info: string): void {
        this.infoText = info;
    }

    setError(error: string): void {
        this.errorText = error;
    }

    clearMessages(): void {
        this.infoText = "";
        this.errorText = "";
        this.promptText = "";
        this.echoPrompt = false;
    }
}

interface Helper {
    kind: "socket" | "fork";
    gotPrompt: boolean;
    buffer: string;
    write(data: string): void;
    close(): void;
}

interface ActiveAuth {
    request: PolkitAuthRequestImpl;
    cookie: string;
    selectedIndex: number;
    helper?: Helper;
    triedFork: boolean;
    finished: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
}

function polkitError(message: string) {
    const error = new Error(message);
    error.name = ERROR_FAILED;
    return error;
}

function variantValue(dict: WireDict, key: string): unknown {
    const entry = dict.find(([k]) => k === key);
    if (!entry) return undefined;
    return entry[1].value[0];
}

function usernameForUid(uid: number): string {
    if (uid === process.getuid?.() && process.env.USER) return process.env.USER;
    try {
        for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
            const fields = line.split(":");
            if (fields.length >= 3 && Number(fields[2]) === uid && fields[0]) return fields[0];
        }
    } catch {
        // 没有 /etc/passwd 时退回 uid 字符串
    }
    return String(uid);
}

function parseIdentity([kind, dict]: [string, WireDict]): PolkitIdentity {
    const identity: PolkitIdentity = { kind, id: kind, name: kind };

    if (kind === "unix-user") {
        const uid = variantValue(dict, "uid");
        if (typeof uid === "number") {
            identity.uid = uid;
            identity.id = `unix-user:${uid}`;
            identity.name = usernameForUid(uid);
        }
    } else if (kind === "unix-group") {
        const gid = variantValue(dict, "gid");
        if (typeof gid === "number") {
            identity.gid = gid;
            identity.id = `unix-group:${gid}`;
            identity.name = String(gid);
        }
    }

    return identity;
}

function commandFromMessage(message: string): string {
    const marker = message.indexOf("to run ");
    if (marker < 0) return "";
    let start = marker + 7;
    const quote = message[start];
    if (quote !== "'" && quote !== "`") return "";
    start++;
    const end = message.indexOf(quote, start);
    if (end < 0) return "";
    return message.slice(start, end);
}

function parseDetails(details: DetailEntry[], message: string) {
    const map: Record<string, string> = {};
    for (const [key, value] of details) map[key] = value;

    const command = map.command_line || map.cmdline || map.command || commandFromMessage(message);

    return {
        details: map,
        command,
        vendor: map["polkit.vendor"] ?? "",
        vendorUrl: map["polkit.vendor_url"] ?? "",
    };
}

function isExecutable(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function isSetuidExecutable(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() && (stat.mode & 0o4000) !== 0 && (stat.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

/**
 * polkit 认证前端 agent。
 *
 * 在系统总线上向 polkitd 注册当前 logind session，收到认证请求后通过
 * `auth-request` 等事件交给桌面；桌面只管弹 UI 并调用 request 的方法，
 * PAM 交互由 polkit-agent-helper-1（或 socket 激活的 helper）完成。
 */
export class polkit extends EventEmitter<PolkitEvents> {
    private readonly io: dbusIO;
    private readonly client: dbusClient;
    private readonly objectPath: string;
    private readonly locale: string;
    private readonly helperSocketPath: string;
    private readonly options: polkitOptions;

    private sessionId = "";
    private nextRequestId = 1;
    private current?: ActiveAuth;
    private queue: ActiveAuth[] = [];
    private destroyed = false;
    private registered = false;
    private unwatch?: () => void | Promise<void>;

    private readonly messageHandler = (message: dbusMessage) => {
        this.handleMessage(message);
    };

    constructor(dbus: dbusIO, options: polkitOptions = {}) {
        super();
        this.io = dbus;
        this.client = new dbusClient({ io: dbus });
        this.options = options;
        this.objectPath = options.objectPath ?? DEFAULT_AGENT_PATH;
        this.locale = options.locale ?? process.env.LC_ALL ?? process.env.LANG ?? "";
        this.helperSocketPath = options.helperSocketPath ?? DEFAULT_HELPER_SOCKET;
    }

    async init(): Promise<void> {
        try {
            await this.io.connect();
            this.sessionId = this.options.sessionId || (await this.resolveSessionId());

            if (this.options.busName) {
                try {
                    const meta = await this.client.getMetaInterface();
                    await meta.RequestName(this.options.busName, 0);
                } catch (error) {
                    console.warn(`[polkit] 申请总线名 ${this.options.busName} 失败:`, error);
                }
            }

            this.io.addMessageHandler(this.messageHandler);

            try {
                const meta = await this.client.getMetaInterface();
                this.unwatch = await meta.onNameOwnerChanged((name, _oldOwner, newOwner) => {
                    if (name !== AUTHORITY_BUS || !newOwner) return;
                    void this.registerWithAuthority(true).catch((error) => {
                        console.warn("[polkit] polkitd 重启后重新注册失败:", error);
                    });
                });
            } catch (error) {
                console.warn("[polkit] 监听 polkitd 重启失败，重启后将无法收到认证请求:", error);
            }

            await this.registerWithAuthority();
        } catch (error) {
            await this.destroy().catch(() => undefined);
            throw error;
        }
    }

    async destroy(): Promise<void> {
        if (this.destroyed) return;
        this.destroyed = true;

        const pending = this.current ? [this.current, ...this.queue] : [...this.queue];
        this.current = undefined;
        this.queue = [];
        for (const auth of pending) this.finish(auth, false, true);

        if (typeof this.unwatch === "function") {
            try {
                await this.unwatch();
            } catch {
                // 总线可能已经断开
            }
            this.unwatch = undefined;
        }

        try {
            if (this.registered) await this.unregisterFromAuthority();
        } catch {
            // polkitd 可能已经退出
        }
        this.registered = false;

        this.io.removeMessageHandler(this.messageHandler);

        if (this.options.busName) {
            try {
                const meta = await this.client.getMetaInterface();
                await meta.ReleaseName(this.options.busName);
            } catch {
                // 总线可能已经断开
            }
        }
    }

    getRequest(): PolkitAuthRequest | undefined {
        return this.current?.request;
    }

    private async getAuthority() {
        const service = await this.client.getService(AUTHORITY_BUS);
        const object = await service.getObject(AUTHORITY_PATH);
        return object.getInterface(AUTHORITY_IFACE);
    }

    private subject(): DBusType<"(sa{sv})"> {
        return [
            "unix-session",
            [["session-id", dbusVariant<"s">("s", this.sessionId)]],
        ] as unknown as DBusType<"(sa{sv})">;
    }

    private async registerWithAuthority(allowAlreadyExists = false) {
        try {
            const authority = await this.getAuthority();
            await authority
                .call("RegisterAuthenticationAgent", "(sa{sv})ss", this.subject(), this.locale, this.objectPath)
                .await();
            this.registered = true;
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (allowAlreadyExists && (/already exists/i.test(text) || text.includes("AlreadyExists"))) {
                this.registered = true;
                return;
            }
            throw error;
        }
    }

    private async unregisterFromAuthority() {
        const authority = await this.getAuthority();
        await authority.call("UnregisterAuthenticationAgent", "(sa{sv})s", this.subject(), this.objectPath).await();
    }

    private async resolveSessionId(): Promise<string> {
        if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID;

        const uid = process.getuid?.() ?? 0;
        try {
            const manager = await this.getLoginManager();
            const [sessionPath] = await manager.call("GetSessionByPID", "u", process.pid).as<"o">();
            const session = await (await this.loginService()).getObject(sessionPath);
            const [id] = await (await session.getInterface(LOGIN_SESSION_IFACE)).get<"s">("Id");
            if (id) return id;
        } catch {
            // 继续尝试 User.Display
        }

        try {
            const manager = await this.getLoginManager();
            const [userPath] = await manager.call("GetUser", "u", uid).as<"o">();
            const user = await (await this.loginService()).getObject(userPath);
            const [id] = await (await user.getInterface(LOGIN_USER_IFACE)).get<"so">("Display");
            if (id) return id;
        } catch (error) {
            console.warn("[polkit] 无法从 logind 获取 session:", error);
        }

        throw new Error("无法确定当前 logind session，缺少 XDG_SESSION_ID 且 logind 查询失败");
    }

    private async loginService() {
        return this.client.getService(LOGIN_BUS);
    }

    private async getLoginManager() {
        const service = await this.loginService();
        const object = await service.getObject(LOGIN_MANAGER_PATH);
        return object.getInterface(LOGIN_MANAGER_IFACE);
    }

    private async isSessionLocked(): Promise<boolean> {
        try {
            const service = await this.loginService();
            const object = await service.getObject("/org/freedesktop/login1/session/auto");
            const [locked] = await (await object.getInterface(LOGIN_SESSION_IFACE)).get<"b">("LockedHint");
            return locked === true;
        } catch {
            return false;
        }
    }

    private handleMessage(message: dbusMessage) {
        if (message.getType() !== MessageType.MethodCall) return;
        if (message.getPath() !== this.objectPath) return;
        const iface = message.getInterface();
        if (iface && iface !== AGENT_IFACE && iface !== "org.freedesktop.DBus.Peer") return;

        const member = message.getMember();
        const sender = message.getSender();
        const serial = message.getSerial();
        if (!member || !sender) return;

        if (iface === "org.freedesktop.DBus.Peer" && member === "Ping") {
            void this.sendReturn(sender, serial);
            return;
        }

        if (member === "BeginAuthentication") {
            const [actionId, text, iconName, details, cookie, identities] = message.getBody() as [
                string,
                string,
                string,
                DetailEntry[],
                string,
                [string, WireDict][],
            ];
            void this.beginAuthentication(actionId, text, iconName, details, cookie, identities)
                .then(() => this.sendReturn(sender, serial))
                .catch((error) => this.sendError(sender, serial, error));
            return;
        }

        if (member === "CancelAuthentication") {
            const [cookie] = message.getBody() as [string];
            this.cancelByCookie(cookie);
            void this.sendReturn(sender, serial);
            return;
        }

        void this.sendError(sender, serial, new Error(`Method ${member} on path ${this.objectPath} doesn't exist`));
    }

    private async sendReturn(destination: string, replySerial: number) {
        const reply = new dbusMessage();
        reply.setType(MessageType.MethodReturn);
        reply.setReplySerial(replySerial);
        reply.setDestination(destination);
        try {
            await this.io.send(reply);
        } catch (error) {
            console.warn("[polkit] 发送认证结果失败:", error);
        }
    }

    private async sendError(destination: string, replySerial: number, error: unknown) {
        const name = error instanceof Error && error.name ? error.name : "org.freedesktop.DBus.Error.Failed";
        const text = error instanceof Error ? error.message : String(error);
        const reply = new dbusMessage();
        reply.setType(MessageType.Error);
        reply.setErrorName(name);
        reply.setReplySerial(replySerial);
        reply.setDestination(destination);
        reply.setSignature("s");
        reply.setBody([text]);
        try {
            await this.io.send(reply);
        } catch (sendError) {
            console.warn("[polkit] 发送认证错误失败:", sendError);
        }
    }

    private async beginAuthentication(
        actionId: string,
        message: string,
        iconName: string,
        details: DetailEntry[],
        cookie: string,
        identities: [string, WireDict][],
    ): Promise<void> {
        if (this.destroyed) throw polkitError("polkit agent 已销毁");
        if (identities.length === 0) throw polkitError("没有可用的认证身份");
        if (await this.isSessionLocked()) throw polkitError("Session is locked");

        const parsed = identities.map(parseIdentity);
        const currentUid = process.getuid?.() ?? 0;
        let selectedIndex = parsed.findIndex(
            (identity) => identity.kind === "unix-user" && identity.uid === currentUid,
        );
        if (selectedIndex < 0) selectedIndex = 0;

        const parsedDetails = parseDetails(details, message);

        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const reply = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        const request = new PolkitAuthRequestImpl(
            {
                id: this.nextRequestId++,
                actionId,
                message,
                iconName,
                details: parsedDetails.details,
                identities: parsed,
                command: parsedDetails.command,
                vendor: parsedDetails.vendor,
                vendorUrl: parsedDetails.vendorUrl,
                selectedIndex,
            },
            {
                submitPassword: (req, value) => this.submitPassword(req, value),
                cancel: (req) => this.cancelRequest(req),
                selectIdentity: (req, identityId) => this.selectIdentity(req, identityId),
            },
        );

        const auth: ActiveAuth = {
            request,
            cookie,
            selectedIndex,
            triedFork: false,
            finished: false,
            resolve,
            reject,
        };
        this.queue.push(auth);
        this.next();

        return reply;
    }

    private next() {
        if (this.destroyed || this.current) return;

        while (this.queue.length > 0 && !this.current) {
            const auth = this.queue.shift();
            if (!auth || auth.finished) continue;

            if (this.listenerCount("auth-request") === 0) {
                auth.finished = true;
                auth.reject(polkitError("desktop 没有注册 auth-request 监听"));
                continue;
            }

            this.current = auth;
            auth.request.setSelectedIndex(auth.selectedIndex);
            this.emit("auth-request", auth.request);

            // 监听器可能在同步处理里 cancel
            if (this.current !== auth) continue;

            const identity = auth.request.selectedIdentity;
            if (identity?.kind !== "unix-user") {
                this.finish(auth, false, false, "只支持 unix-user 身份认证");
                continue;
            }

            // 监听器可能已经在 auth-request 里 selectIdentity 启动了 helper
            if (!auth.helper) this.startHelper(auth);
            return;
        }
    }

    private findAuth(request: PolkitAuthRequestImpl): ActiveAuth | undefined {
        if (this.current?.request === request) return this.current;
        return this.queue.find((auth) => auth.request === request);
    }

    private submitPassword(request: PolkitAuthRequestImpl, value: string) {
        const auth = this.findAuth(request);
        if (!auth || auth.finished || auth !== this.current || !auth.helper) return;
        try {
            auth.helper.write(`${value}\n`);
        } catch (error) {
            console.warn("[polkit] 写入认证输入失败:", error);
        }
    }

    private cancelRequest(request: PolkitAuthRequestImpl) {
        const auth = this.findAuth(request);
        if (!auth) return;
        this.finish(auth, false, true);
    }

    private selectIdentity(request: PolkitAuthRequestImpl, identityId: string): boolean {
        const auth = this.findAuth(request);
        if (!auth || auth.finished) return false;

        const index = request.identities.findIndex((identity) => identity.id === identityId);
        if (index < 0) return false;
        if (index === auth.selectedIndex) return true;

        auth.selectedIndex = index;
        request.setSelectedIndex(index);
        this.emit("auth-identity-changed", request, request.selectedIdentity);

        if (auth === this.current) {
            this.killHelper(auth);
            request.clearMessages();
            this.startHelper(auth);
        }
        return true;
    }

    private cancelByCookie(cookie: string) {
        if (this.current?.cookie === cookie) {
            this.finish(this.current, false, true);
            return;
        }
        const queued = this.queue.find((auth) => auth.cookie === cookie);
        if (queued) this.finish(queued, false, true);
    }

    private finish(auth: ActiveAuth, success: boolean, cancelled: boolean, errorMessage?: string) {
        if (auth.finished) return;
        auth.finished = true;
        this.killHelper(auth);

        if (this.current === auth) {
            this.current = undefined;
        } else {
            const index = this.queue.indexOf(auth);
            if (index >= 0) this.queue.splice(index, 1);
        }

        if (success || cancelled) auth.resolve();
        else auth.reject(polkitError(errorMessage ?? "Authentication failed"));

        this.emit("auth-end", auth.request, { success, cancelled });
        this.next();
    }

    private helperSocketUsable(): boolean {
        try {
            fs.accessSync(this.helperSocketPath, fs.constants.W_OK);
            return fs.statSync(this.helperSocketPath).isSocket();
        } catch {
            return false;
        }
    }

    private findHelperPath(): string | undefined {
        if (this.options.helperPath) {
            if (!isExecutable(this.options.helperPath)) return undefined;
            if (this.options.requireSetuidHelper !== false && !isSetuidExecutable(this.options.helperPath))
                return undefined;
            return this.options.helperPath;
        }
        for (const candidate of HELPER_CANDIDATES) {
            if (isSetuidExecutable(candidate)) return candidate;
        }
        return undefined;
    }

    private startHelper(auth: ActiveAuth) {
        if (auth.finished || this.destroyed) return;

        this.killHelper(auth);

        const identity = auth.request.selectedIdentity;
        if (identity?.kind !== "unix-user") {
            this.finish(auth, false, false, "只支持 unix-user 身份认证");
            return;
        }

        if (!auth.triedFork && this.helperSocketUsable() && this.startSocketHelper(auth, identity.name)) return;

        auth.triedFork = true;
        const helperPath = this.findHelperPath();
        if (!helperPath) {
            this.finish(
                auth,
                false,
                false,
                `找不到可用的 polkit-agent-helper-1（socket ${this.helperSocketPath} 也不可用）`,
            );
            return;
        }
        this.startForkHelper(auth, helperPath, identity.name);
    }

    private startSocketHelper(auth: ActiveAuth, username: string): boolean {
        let socket: import("node:net").Socket;
        try {
            socket = net.createConnection({ path: this.helperSocketPath });
        } catch {
            return false;
        }

        const helper: Helper = {
            kind: "socket",
            gotPrompt: false,
            buffer: "",
            write: (data) => {
                if (!socket.destroyed) socket.write(data);
            },
            close: () => socket.destroy(),
        };
        auth.helper = helper;

        this.attachHelper(auth, helper, socket);
        try {
            socket.write(`${username}\n${auth.cookie}\n`);
        } catch {
            auth.helper = undefined;
            socket.destroy();
            return false;
        }
        return true;
    }

    private startForkHelper(auth: ActiveAuth, helperPath: string, username: string) {
        let child: import("node:child_process").ChildProcess;
        try {
            child = childProcess.spawn(helperPath, [username], { stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
            this.finish(auth, false, false, `启动 polkit-agent-helper-1 失败: ${String(error)}`);
            return;
        }

        const helper: Helper = {
            kind: "fork",
            gotPrompt: false,
            buffer: "",
            write: (data) => {
                if (child.stdin?.writable) child.stdin.write(data);
            },
            close: () => {
                try {
                    child.kill("SIGTERM");
                } catch {
                    // 进程可能已经退出
                }
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
            },
        };
        auth.helper = helper;

        child.stderr?.on("data", (data: Buffer) => {
            console.warn(`[polkit helper] ${data.toString().trim()}`);
        });
        child.stdin?.on("error", () => {
            // helper 提前退出时写入会 EPIPE，由 close 流程处理
        });
        child.on("error", (error) => {
            console.warn("[polkit] polkit-agent-helper-1 启动错误:", error);
            this.handleHelperGone(auth, helper);
        });
        child.on("close", () => this.handleHelperGone(auth, helper));

        if (child.stdout) this.attachHelper(auth, helper, child.stdout);
        try {
            child.stdin?.write(`${auth.cookie}\n`);
        } catch {
            this.handleHelperGone(auth, helper);
        }
    }

    private attachHelper(auth: ActiveAuth, helper: Helper, stream: NodeJS.ReadableStream) {
        const onData = (data: Buffer | string) => {
            if (auth.helper !== helper || auth.finished) return;
            helper.buffer += data.toString();
            this.consumeLines(auth, helper);
        };
        const onGone = () => {
            if (auth.helper !== helper || auth.finished) return;
            this.handleHelperGone(auth, helper);
        };

        stream.on("data", onData);
        stream.on("end", onGone);
        stream.on("close", onGone);
        stream.on("error", onGone);
    }

    private consumeLines(auth: ActiveAuth, helper: Helper) {
        for (;;) {
            const index = helper.buffer.indexOf("\n");
            if (index < 0) return;
            const line = helper.buffer.slice(0, index).replace(/\r$/, "");
            helper.buffer = helper.buffer.slice(index + 1);
            this.handleHelperLine(auth, helper, line);
            if (auth.finished || auth.helper !== helper) return;
        }
    }

    private handleHelperLine(auth: ActiveAuth, helper: Helper, line: string) {
        const prefix = (tag: string): string | undefined => {
            if (line === tag) return "";
            if (line.startsWith(`${tag} `)) return line.slice(tag.length + 1);
            return undefined;
        };

        const echoOff = prefix("PAM_PROMPT_ECHO_OFF");
        if (echoOff !== undefined) {
            helper.gotPrompt = true;
            auth.request.setPrompt(echoOff, false);
            this.emit("auth-prompt", auth.request, echoOff, false);
            return;
        }

        const echoOn = prefix("PAM_PROMPT_ECHO_ON");
        if (echoOn !== undefined) {
            helper.gotPrompt = true;
            auth.request.setPrompt(echoOn, true);
            this.emit("auth-prompt", auth.request, echoOn, true);
            return;
        }

        const error = prefix("PAM_ERROR_MSG");
        if (error !== undefined) {
            auth.request.setError(error);
            this.emit("auth-error", auth.request, error);
            return;
        }

        const info = prefix("PAM_TEXT_INFO");
        if (info !== undefined) {
            auth.request.setInfo(info);
            this.emit("auth-info", auth.request, info);
            return;
        }

        if (line === "SUCCESS") {
            this.finish(auth, true, false);
            return;
        }

        if (line === "FAILURE") {
            this.handleHelperFailure(auth, helper);
        }
    }

    private handleHelperFailure(auth: ActiveAuth, helper: Helper) {
        if (auth.finished) return;
        const hadPrompt = helper.gotPrompt;
        const wasSocket = helper.kind === "socket";

        this.killHelper(auth);

        if (hadPrompt) {
            auth.request.setError("Authentication failed");
            this.emit("auth-error", auth.request, "Authentication failed");
            this.startHelper(auth);
            return;
        }

        if (wasSocket && !auth.triedFork) {
            auth.triedFork = true;
            this.startHelper(auth);
            return;
        }

        // helper 还没提示就失败（账号锁定、PAM 配置损坏等），继续重开会无限弹窗
        this.finish(auth, false, true);
    }

    private handleHelperGone(auth: ActiveAuth, helper: Helper) {
        if (auth.finished || auth.helper !== helper) return;
        auth.helper = undefined;

        if (helper.kind === "socket" && !helper.gotPrompt && !auth.triedFork) {
            auth.triedFork = true;
            this.startHelper(auth);
            return;
        }

        if (!helper.gotPrompt) {
            this.finish(auth, false, true);
            return;
        }

        this.finish(auth, false, false, "Authentication failed");
    }

    private killHelper(auth: ActiveAuth) {
        const helper = auth.helper;
        auth.helper = undefined;
        if (!helper) return;
        try {
            helper.close();
        } catch {
            // 已经关闭
        }
    }
}
