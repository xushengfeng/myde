import { addStyle, button, txt, view } from "dkh-ui";
import type { PolkitApi, PolkitAuthRequest, PolkitAuthResult } from "../../../src/desktop-api";
import { gRadius, gTextStyle, px, sSize, sSize2, ui, uPasswdInput } from "./ui";

// 密码输入框的默认焦点框是一圈黑边，改成浅蓝细环
addStyle({
    '[data-desktop-ui="polkit-dialog"] [tabindex]:focus': {
        outline: "2px solid #00aaff66",
        outlineOffset: "1px",
    },
});

/** PAM 提示转成输入框占位文本；标准密码提示不额外显示一行文字 */
function promptPlaceholder(prompt: string, echo: boolean): string {
    const label = prompt.trim().replace(/[:：]\s*$/, "");
    if (!label) return echo ? "请输入内容" : "请输入密码";
    if (/^(password|密码)$/i.test(label)) return "请输入密码";
    return label;
}

/**
 * polkit 认证对话框。
 *
 * 这里装好全部监听后才调用 `polkit.ready()`：helper 收到就绪信号前不注册认证
 * agent，免得把会话里的认证抢过来、桌面却没有对话框可以应答。
 */
export function createPolkitDialog(polkit: PolkitApi) {
    const el = view()
        .style({
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0, 0, 0, 0.18)",
            backdropFilter: "blur(6px)",
            zIndex: "25",
        })
        .data({ "desktop-ui": "polkit-dialog" });

    const titleEl = txt("需要认证").style({ ...gTextStyle.title, color: gTextStyle.color.primary });
    const messageEl = txt("").style({
        ...gTextStyle.body,
        color: gTextStyle.color.primary,
        wordBreak: "break-word",
    });
    const commandEl = txt("").style({
        ...gTextStyle.micro,
        fontFamily: gTextStyle.monoFamily,
        color: gTextStyle.color.secondary,
        userSelect: "text",
        wordBreak: "break-all",
    });
    const infoEl = txt("").style({
        ...gTextStyle.caption,
        color: gTextStyle.color.secondary,
        wordBreak: "break-word",
    });
    const errorEl = txt("").style({
        ...gTextStyle.caption,
        color: gTextStyle.color.error,
        wordBreak: "break-word",
    });

    // 对话框里的输入框是实心白，不再叠毛玻璃
    const inputEl = uPasswdInput();
    inputEl.el.style({
        width: "100%",
        height: px(sSize(1)),
        borderRadius: px(gRadius.item),
        padding: px(sSize2.paddingx),
        boxSizing: "border-box",
        background: "#fff",
    });
    inputEl.placeholder("请输入密码");

    const buttonBase = {
        flex: "1",
        height: px(sSize(1)),
        borderRadius: px(gRadius.item),
        border: "none",
        cursor: "pointer",
        fontSize: "13px",
    };
    const cancelBtn = button(txt("取消"))
        .style({ ...buttonBase, background: "#fff", color: gTextStyle.color.primary })
        .on("click", () => cancel());
    const submitBtn = button(txt("认证"))
        .style({ ...buttonBase, background: "#00aaff", color: gTextStyle.color.inverse })
        .on("click", () => submit());
    const buttons = view("x")
        .style({ gap: px(sSize2.padding) })
        .add([cancelBtn, submitBtn]);

    // L2 面板：文字和输入都在这一层上，避免只有 L1 玻璃而显得太透
    const panel = ui.barItem().style({
        padding: px(sSize2.padding + 4),
        display: "flex",
        flexDirection: "column",
        gap: px(sSize2.padding),
        boxSizing: "border-box",
    });
    panel.add([titleEl, messageEl, commandEl, inputEl.el, infoEl, errorEl, buttons]);

    // L1 玻璃外壳只负责 padding / gap / 圆角和阴影
    const card = ui.bar([panel]);
    card.el.style({
        width: px(sSize(8)),
        maxWidth: "calc(100vw - 32px)",
        boxSizing: "content-box",
        zoom: "var(--desktop-ui-scale, 1)",
    });
    el.add(card.el);

    let request: PolkitAuthRequest | undefined;
    /** 已经收到 PAM 的提示，可以提交输入；提交一次后等下一次提示 */
    let promptReady = false;
    let visible = false;

    function setSubmittable(enabled: boolean) {
        submitBtn.el.disabled = !enabled;
        submitBtn.style({ opacity: enabled ? "1" : "0.5", cursor: enabled ? "pointer" : "default" });
    }
    setSubmittable(false);

    function setInfo(text: string) {
        infoEl.sv(text);
        infoEl.style({ display: text ? "block" : "none" });
    }

    function setError(text: string) {
        errorEl.sv(text);
        errorEl.style({ display: text ? "block" : "none" });
    }

    function show(req: PolkitAuthRequest) {
        request = req;
        promptReady = false;
        messageEl.sv(req.message);
        messageEl.style({ display: req.message ? "block" : "none" });
        commandEl.sv(req.command);
        commandEl.style({ display: req.command ? "block" : "none" });
        setInfo("");
        setError("");
        inputEl.clear();
        inputEl.disable(true);
        inputEl.placeholder("等待认证…");
        setSubmittable(false);
        visible = true;
        el.style({ display: "flex" });
    }

    function close() {
        request = undefined;
        promptReady = false;
        setSubmittable(false);
        visible = false;
        inputEl.clear();
        el.style({ display: "none" });
    }

    function submit() {
        if (!request || !promptReady) return;
        const value = inputEl.el.gv;
        if (!value) return;
        promptReady = false;
        setSubmittable(false);
        setError("");
        inputEl.clear();
        inputEl.disable(true);
        inputEl.placeholder("认证中…");
        request.submitPassword(value);
    }

    function cancel() {
        const req = request;
        if (!req) return;
        close();
        req.cancel();
    }

    // uPasswdInput 自己处理字符和 Enter（Enter 会派发 change）
    inputEl.el.on("change", () => submit());
    // 点卡片外的空白也把焦点还给输入框
    el.on("click", () => {
        if (request) inputEl.focus();
    });
    // 输入框失焦时也要能用 Esc 取消；capture 阶段先于输入框自己的 keydown
    document.addEventListener(
        "keydown",
        (e) => {
            if (!visible || e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            cancel();
        },
        true,
    );

    polkit.on("auth-request", show);
    polkit.on("auth-prompt", (req, prompt, echo) => {
        if (req !== request) return;
        promptReady = true;
        setSubmittable(true);
        inputEl.disable(false);
        inputEl.placeholder(promptPlaceholder(prompt, echo));
        inputEl.focus();
    });
    polkit.on("auth-info", (req, message) => {
        if (req !== request) return;
        setInfo(message);
    });
    polkit.on("auth-error", (req, message) => {
        if (req !== request) return;
        setError(message);
    });
    polkit.on("auth-end", (req: PolkitAuthRequest, _result: PolkitAuthResult) => {
        if (req !== request) return;
        close();
    });

    polkit.ready();

    return {
        el,
        isOpen: () => visible,
        cancel,
    };
}
