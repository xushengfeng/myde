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

    it("候选选择、翻页与提交", async () => {
        if (!connected) return; // 已在前置提示
        const ctx = await im.createContext("myde-test-commit");
        await ctx.focus();
        try {
            // 切到合成输入法
            execSync("fcitx5-remote -o");
            execSync(`fcitx5-remote -s ${TEST_IM}`);
            await new Promise((r2) => setTimeout(r2, 300));

            // 合成
            const r = await ctx.type(TEST_INPUT);
            expect(r.candidates.length).toBeGreaterThan(0);
            const first = r.candidates[0];

            // 翻页（下一页应有上一页可回，且候选/高亮状态更新）
            const page1 = await ctx.nextPage();
            console.log(
                `[input_method 测试] 下一页: cursor=${page1.candidateCursor} hasPrev=${page1.hasPrev} 候选=[${page1.candidates.join(",")}]`,
            );
            expect(page1.hasPrev).toBe(true);
            const page0 = await ctx.prevPage();
            expect(page0.candidates[0]).toBe(first);

            // 选词上屏（真实提交，测完无残留）
            const r2 = await ctx.selectCandidate(0);
            console.log(`[input_method 测试] 选词上屏: "${r2.committed}"`);
            expect(r2.committed).toBe(first);
            // 上屏后合成清空
            expect(ctx.getState().preedit).toBe("");
        } finally {
            await ctx.reset();
            await ctx.destroy();
        }
    });

    it("长句分段选词（部分词只锁定不提交）", async () => {
        if (!connected) return; // 已在前置提示
        const ctx = await im.createContext("myde-test-long");
        await ctx.focus();
        try {
            execSync("fcitx5-remote -o");
            execSync(`fcitx5-remote -s ${TEST_IM}`);
            await new Promise((r2) => setTimeout(r2, 300));

            // 多音节合成：自然码双拼 nihkma = ni hao ma
            const updates: ImComposeState[] = [];
            const commits: string[] = [];
            const offUpdate = ctx.on("update", (s) => updates.push(s));
            const offCommit = ctx.on("commit", (t) => commits.push(t));

            const r = await ctx.type("nihkma");
            expect(r.preedit.length).toBeGreaterThan(0);
            expect(r.candidates.length).toBeGreaterThan(0);

            // 选一个部分词（单字）：只锁定进 preedit，不提交
            const partial = await ctx.selectCandidate(2);
            expect(partial.committed).toBe("");
            expect(partial.preedit.length).toBeGreaterThan(0);
            expect(partial.preedit).not.toBe(r.preedit);
            // 剩余部分继续合成，候选更新为下一段
            expect(partial.candidates.length).toBeGreaterThan(0);

            // 关键：部分选词后候选列表更新会触发 update 事件（payload 为新候选）
            const changed = updates.filter((s) => s.candidates.join("\u0000") !== r.candidates.join("\u0000"));
            expect(changed.length).toBeGreaterThan(0);
            expect(changed[changed.length - 1].candidates.join("\u0000")).toBe(partial.candidates.join("\u0000"));
            // 此时不应有 commit 事件
            expect(commits).toEqual([]);

            // 整句完成后才一次上屏
            const done = await ctx.selectCandidate(0);
            console.log(
                `[input_method 测试] 分段选词上屏: "${done.committed}" (preedit=${r.preedit} → ${partial.preedit} → "${done.preedit}"), update 事件 ${updates.length} 次`,
            );
            expect(done.committed.length).toBeGreaterThan(0);
            expect(ctx.getState().preedit).toBe("");
            // 整句完成触发 commit 事件
            expect(commits.length).toBeGreaterThan(0);
            offUpdate();
            offCommit();
        } finally {
            await ctx.reset();
            await ctx.destroy();
        }
    });

    it("英文模式（键盘布局）按键全放行", async () => {
        if (!connected) return; // 已在前置提示
        const group = await im.getGroupInfo();
        const layoutIM = group.inputMethods[0].uniqueName; // 键盘布局（如 keyboard-us）
        const ctx = await im.createContext("myde-test-en");
        await ctx.focus();
        try {
            await im.setCurrentIM(layoutIM);
            await new Promise((r2) => setTimeout(r2, 300));
            // 字母、数字、标点全部放行：handled=false 且无 commit
            for (const ch of ["a", "1", "!"]) {
                const r = await ctx.keyEvent(ch.codePointAt(0) ?? 0);
                console.log(`[input_method 测试] 英文模式 "${ch}" → handled=${r.handled} committed="${r.committed}"`);
                expect(r.handled).toBe(false);
                expect(r.committed).toBe("");
            }
        } finally {
            await im.setCurrentIM(TEST_IM);
            await ctx.destroy();
        }
    });

    it("数字/标点的协议行为（放行 vs 输入法上屏）", async () => {
        if (!connected) return; // 已在前置提示
        const ctx = await im.createContext("myde-test-punct");
        await ctx.focus();
        try {
            execSync("fcitx5-remote -o");
            execSync(`fcitx5-remote -s ${TEST_IM}`);
            await new Promise((r2) => setTimeout(r2, 300));

            // 无合成 + 数字：输入法放行（handled=false、无 commit）→ 客户端自己插入字符
            const d = await ctx.keyEvent("1".codePointAt(0) ?? 0);
            expect(d.handled).toBe(false);
            expect(d.committed).toBe("");

            // 无合成 + 标点：输入法接管，转全角后主动上屏（走 commit 事件）
            const p = await ctx.keyEvent("!".codePointAt(0) ?? 0);
            expect(p.handled).toBe(true);
            expect(p.committed.length).toBeGreaterThan(0);
            console.log(`[input_method 测试] 无合成: 数字放行 handled=${d.handled}, 标点输入法上屏 "${p.committed}"`);

            // 合成中 + 标点：先上屏合成、再上屏标点（实测为一次 commit）
            const r = await ctx.type(TEST_INPUT);
            expect(r.preedit.length).toBeGreaterThan(0);
            const q = await ctx.keyEvent(".".codePointAt(0) ?? 0);
            expect(q.handled).toBe(true);
            expect(q.committed.length).toBeGreaterThan(0);
            expect(ctx.getState().preedit).toBe("");
            console.log(`[input_method 测试] 合成中敲标点: "${q.committed}"（合成+标点一起上屏）`);

            // 合成中 + 数字：消费为选词（1-9），不直接上屏数字
            await ctx.type(TEST_INPUT);
            const sel = await ctx.keyEvent("1".codePointAt(0) ?? 0);
            expect(sel.handled).toBe(true);
            expect(sel.committed).not.toBe("1");
            console.log(`[input_method 测试] 合成中敲数字: 消费为选词 → "${sel.committed}"`);
        } finally {
            await ctx.reset();
            await ctx.destroy();
        }
    });

    it("commit 提交当前合成（回车原文/空格上屏）", async () => {
        if (!connected) return; // 已在前置提示
        const ctx = await im.createContext("myde-test-commit2");
        await ctx.focus();
        try {
            execSync("fcitx5-remote -o");
            execSync(`fcitx5-remote -s ${TEST_IM}`);
            await new Promise((r2) => setTimeout(r2, 300));

            // 回车：上屏原文（双拼字母串）
            const r1 = await ctx.type(TEST_INPUT);
            expect(r1.preedit.length).toBeGreaterThan(0);
            const r2 = await ctx.commit();
            console.log(`[input_method 测试] 回车上屏: "${r2.committed}"`);
            expect(r2.committed).toBe(TEST_INPUT);
            expect(ctx.getState().preedit).toBe("");

            // 空格：上屏高亮/首选候选
            const r3 = await ctx.type(TEST_INPUT);
            const first = r3.candidates[0];
            const r4 = await ctx.commit(false);
            console.log(`[input_method 测试] 空格上屏: "${r4.committed}"`);
            expect(r4.committed).toBe(first);
            expect(ctx.getState().preedit).toBe("");
        } finally {
            await ctx.reset();
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
