import { initDKH } from "dkh-ui";
import type { PolkitApi, PolkitAuthRequest, PolkitEvents } from "../../../../src/desktop-api";
import { EventEmitter } from "../../../../src/event-emitter/event-emitter";
import { createPolkitDialog } from "../../src/polkit_dialog";

initDKH({ pureStyle: true });

const statusEl = document.getElementById("status");
const scenarioEl = document.getElementById("scenario") as HTMLSelectElement | null;
const outcomeEl = document.getElementById("outcome") as HTMLSelectElement | null;
const openBtn = document.getElementById("open");

function setStatus(text: string) {
    if (statusEl) statusEl.textContent = `最近回调：${text}`;
}

/** 假 polkit agent：只实现对话框用到的事件和 ready */
const events = new EventEmitter<PolkitEvents>();
const fake = events as unknown as PolkitApi & { ready(): void };
fake.ready = () => setStatus("ready()");

const dialog = createPolkitDialog(fake);
dialog.el.addInto(document.body);

type SubmitOutcome = "retry" | "success" | "pending";
let submitMode: SubmitOutcome = "retry";
let current: PolkitAuthRequest | undefined;

function createRequest(scenario: string): PolkitAuthRequest {
    const long = scenario === "long";
    const identities = [{ kind: "unix-user", id: "unix-user:1000", name: "xsf" }];
    return {
        id: 1,
        actionId: "org.freedesktop.systemd1.manage-units",
        message: long
            ? "需要认证才能管理系统服务。这里用一段较长的文字检查换行排版，实际内容由应用提供。"
            : "需要认证才能管理系统服务。",
        iconName: "",
        details: {},
        identities,
        command: long
            ? "/usr/bin/systemctl restart foo.service --with-a-long-argument --and-another-long-argument"
            : "/usr/bin/systemctl restart foo.service",
        vendor: "systemd",
        vendorUrl: "",
        selectedIdentity: identities[0],
        prompt: "",
        echo: false,
        info: "",
        error: "",
        submitPassword(value) {
            setStatus(`submitPassword(${"*".repeat(value.length)})`);
            const request = current;
            if (!request) return;
            if (submitMode === "success") {
                setTimeout(() => {
                    current = undefined;
                    events.emit("auth-end", request, { success: true, cancelled: false });
                }, 600);
            } else if (submitMode === "retry") {
                setTimeout(() => {
                    events.emit("auth-error", request, "密码错误，请重试。");
                    events.emit("auth-prompt", request, "Password: ", false);
                }, 600);
            }
        },
        cancel() {
            setStatus("cancel()");
            const request = current;
            current = undefined;
            if (request) events.emit("auth-end", request, { success: false, cancelled: true });
        },
        selectIdentity: () => false,
    };
}

function open() {
    submitMode = (outcomeEl?.value as SubmitOutcome | undefined) ?? "retry";
    const scenario = scenarioEl?.value ?? "normal";
    current = createRequest(scenario);
    events.emit("auth-request", current);
    events.emit("auth-prompt", current, "Password: ", false);
    if (scenario === "info") {
        events.emit("auth-info", current, "正在以 xsf 身份认证");
    }
    setStatus(`auth-request → auth-prompt（${scenario}）`);
}

openBtn?.addEventListener("click", open);

/** 模拟键盘输入，用来直接截取提交后的状态 */
function autoSubmit(password = "hunter2") {
    const input = dialog.el.el.querySelector("[tabindex]");
    if (!(input instanceof HTMLElement)) return;
    input.focus();
    for (const key of password) input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

// 方便直接定位某个状态：?scenario=long&outcome=retry&submit=1
const params = new URLSearchParams(window.location.search);
const initialScenario = params.get("scenario");
if (initialScenario) {
    if (scenarioEl && [...scenarioEl.options].some((option) => option.value === initialScenario)) {
        scenarioEl.value = initialScenario;
    }
    const initialOutcome = params.get("outcome");
    if (outcomeEl && initialOutcome && [...outcomeEl.options].some((option) => option.value === initialOutcome)) {
        outcomeEl.value = initialOutcome;
    }
    setTimeout(open, 200);
    if (params.get("submit")) setTimeout(autoSubmit, 800);
}
