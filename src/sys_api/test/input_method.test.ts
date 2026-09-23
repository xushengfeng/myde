import { execSync } from "node:child_process";
import { dbusIO } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ImComposeState, inputMethod } from "../input_method";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

// 连接真实 fcitx5 做冒烟测试：只测合成，不提交文字（避免影响系统输入法）。
// 无法连接时仅提示，不报错。
const SESSION_BUS = (process.env.DBUS_SESSION_BUS_ADDRESS ?? "").replace("unix:path=", "") || "/run/user/1000/bus";
// 合成用输入法（唯一名称），可用 MYDE_TEST_IM 覆盖
const TEST_IM = process.env.MYDE_TEST_IM || "rime";
// 自然码双拼输入：nihk = ni + hao →「你好」
const TEST_INPUT = process.env.MYDE_TEST_INPUT || "nihk";

function newSocket() {
    const socket = new mus.USocket();
    socket.connect(SESSION_BUS);
    return socket;
}

describe("input_method", () => {
    let im: inputMethod;
    let connected = false;
    let prevIM = "";

    beforeAll(async () => {
        try {
            const io = new dbusIO({ socket: newSocket() });
            await io.connect();
            im = new inputMethod(io);
            connected = await im.init();
        } catch (e) {
            console.warn("[input_method 测试] 无法连接会话总线/fcitx5:", e);
        }
        if (connected) {
            try {
                prevIM = execSync("fcitx5-remote -n").toString().trim();
                console.log(`[input_method 测试] 当前输入法: ${prevIM || "(无)"}`);
            } catch (e) {
                console.warn("[input_method 测试] fcitx5-remote 不可用:", e);
            }
        } else {
            console.warn(
                "[input_method 测试] 未检测到 fcitx5（org.freedesktop.portal.Fcitx / org.fcitx.Fcitx5），跳过合成测试",
            );
        }
    });

    afterAll(async () => {
        if (connected && prevIM) {
            try {
                execSync(`fcitx5-remote -s ${prevIM}`);
                console.log(`[input_method 测试] 已恢复输入法: ${prevIM}`);
            } catch {
                // 忽略
            }
        }
    });

    it("列出与切换输入法", async () => {
        if (!connected) return; // 已在前置提示

        // 列出全部可用输入法
        const all = await im.listInputMethods();
        console.log(`[input_method 测试] 可用输入法共 ${all.length} 个`);
        const names = all.map((e) => e.uniqueName);
        expect(names).toContain(TEST_IM);
        expect(names).toContain("keyboard-us");

        // 当前组详情（切换菜单用的列表：第一个是键盘布局）
        const group = await im.getGroupInfo();
        console.log(
            `[input_method 测试] 组 "${group.name}" 默认输入法: ${group.defaultInputMethod}, 成员: [${group.inputMethods.map((e) => e.uniqueName).join(", ")}]`,
        );
        expect(group.inputMethods.length).toBeGreaterThan(1);
        const layoutIM = group.inputMethods[0].uniqueName;
        expect(group.inputMethods.some((e) => e.uniqueName === TEST_IM)).toBe(true);

        // 自建上下文聚焦后切换（作用于最近聚焦的上下文）
        const ctx = await im.createContext("myde-test-switch");
        await ctx.focus();
        try {
            // 切到键盘布局 = 停用合成
            await im.setCurrentIM(layoutIM);
            await new Promise((r) => setTimeout(r, 300));
            expect((await im.getCurrentIM()).uniqueName).toBe(layoutIM);
            expect(await im.getState()).toBe(1); // 未激活

            // 切到合成输入法 = 激活
            await im.setCurrentIM(TEST_IM);
            await new Promise((r) => setTimeout(r, 300));
            expect((await im.getCurrentIM()).uniqueName).toBe(TEST_IM);
            expect(await im.getState()).toBe(2); // 激活
        } finally {
            // 恢复现场
            await im.setCurrentIM(prevIM || TEST_IM);
            await ctx.destroy();
        }
    });

    it("合成字母（不提交）", async () => {
        if (!connected) return; // 已在前置提示
        const ctx = await im.createContext("myde-test");
        await ctx.focus();

        // 上下文获得焦点后切换到可合成的输入法（只影响本上下文状态，测完恢复）
        try {
            execSync("fcitx5-remote -o");
            execSync(`fcitx5-remote -s ${TEST_IM}`);
            await new Promise((r2) => setTimeout(r2, 300));
            console.log(
                "[input_method 测试] 切换后:",
                execSync("fcitx5-remote -n").toString().trim(),
                "state:",
                execSync("fcitx5-remote").toString().trim(),
            );
        } catch (e) {
            console.warn("[input_method 测试] fcitx5-remote 切换输入法失败:", e);
        }

        // 订阅事件
        const updates: ImComposeState[] = [];
        const commits: string[] = [];
        const offUpdate = ctx.on("update", (state) => updates.push(state));
        const offCommit = ctx.on("commit", (text) => commits.push(text));

        const r = await ctx.type(TEST_INPUT);
        console.log(`[input_method 测试] 输入 "${TEST_INPUT}" 合成结果:`, JSON.stringify(r));
        console.log(`[input_method 测试] 事件: ${updates.length} 次 update, ${commits.length} 次 commit`);

        // 仅合成，不提交
        expect(r.committed).toBe("");
        expect(commits).toEqual([]);
        // 应有合成内容（预编辑或候选）
        expect(r.preedit.length + r.candidates.length).toBeGreaterThan(0);
        // 事件：合成过程应推送过 update
        expect(updates.length).toBeGreaterThan(0);
        const last = updates[updates.length - 1];
        expect(last.preedit.length + last.candidates.length).toBeGreaterThan(0);

        offUpdate();
        offCommit();

        // 丢弃合成，不留下影响
        await ctx.reset();
        expect(ctx.getState().preedit).toBe("");
        expect(ctx.getState().candidates).toEqual([]);
        await ctx.destroy();
    });
});
