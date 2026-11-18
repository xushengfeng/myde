import { buildChoiceResults, parseChoice } from "./choices";
import { PortalRequestBase } from "./portal_request";
import type { AccessRequest, PortalAcceptResult, PortalChoice } from "./types";
import { optionValue, variant, type WireDict } from "./wire";

export interface ParsedAccessOptions {
    modal: boolean;
    denyLabel: string;
    grantLabel: string;
    icon: string;
    choices: PortalChoice[];
}

/**
 * 前端的权限对话框选项。桌面可以自己记住“总是允许”，
 * 所以这里只把一次性的允许/拒绝交给桌面。
 */
export function parseAccessOptions(options: WireDict | undefined): ParsedAccessOptions {
    const dict = Array.isArray(options) ? options : [];
    const rawChoices = optionValue(dict, "choices", "a(ssa(ss)s)") ?? [];
    return {
        modal: optionValue(dict, "modal", "b") ?? true,
        denyLabel: optionValue(dict, "deny_label", "s") ?? "",
        grantLabel: optionValue(dict, "grant_label", "s") ?? "",
        icon: optionValue(dict, "icon", "s") ?? "",
        choices: rawChoices.map(parseChoice).filter((choice) => choice.id.length > 0),
    };
}

/**
 * 前端（xdg-desktop-portal）需要问用户“允许/拒绝”时发来的请求。
 * 截图 portal 只有在配置了 Access 后端时才会被前端提供，即使默认策略是全部允许。
 */
export class AccessRequestImpl extends PortalRequestBase implements AccessRequest {
    readonly title: string;
    readonly subtitle: string;
    readonly body: string;
    readonly denyLabel: string;
    readonly grantLabel: string;
    readonly icon: string;
    readonly choices: PortalChoice[];

    constructor(op: {
        id: string;
        appId: string;
        parentWindow: string;
        title: string;
        subtitle: string;
        body: string;
        options: ParsedAccessOptions;
    }) {
        super({
            id: op.id,
            appId: op.appId,
            parentWindow: op.parentWindow,
            modal: op.options.modal,
        });
        this.title = op.title;
        this.subtitle = op.subtitle;
        this.body = op.body;
        this.denyLabel = op.options.denyLabel;
        this.grantLabel = op.options.grantLabel;
        this.icon = op.options.icon;
        this.choices = op.options.choices;
    }

    /** 用户允许：response=0 */
    async accept(selected?: Record<string, string>): Promise<PortalAcceptResult> {
        if (this.isClosed) return { ok: false, error: "请求已结束" };
        const results: WireDict = [];
        if (this.choices.length > 0) {
            results.push(["choices", variant("a(ss)", [buildChoiceResults(this.choices, selected)])]);
        }
        this.finish(0, results);
        return { ok: true };
    }

    /** 用户拒绝：response=1 */
    async deny(): Promise<void> {
        this.finish(1, []);
    }
}
