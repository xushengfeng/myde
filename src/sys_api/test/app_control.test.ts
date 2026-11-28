import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
    getAffinity,
    getCpuTopology,
    getPid,
    getPidTree,
    getProcessDetail,
    getSystemSnapshot,
    setAffinity,
    watchSystem,
} from "../app_control";

function hasTaskset() {
    try {
        execFileSync("taskset", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

describe("app_control", () => {
    it("should get process tree for current process", async () => {
        const currentPid = process.pid;
        const tree = await getPidTree(currentPid);

        expect(tree).toBeDefined();
        expect(tree.pid).toBe(currentPid);
        expect(tree.ppid).toBeGreaterThan(0);
        expect(tree.memoryUsage).toBeGreaterThanOrEqual(0);
        expect(tree.name).toBeDefined();
        expect(Array.isArray(tree.children)).toBe(true);
    });

    it("should get process tree for all processes (pid 0)", async () => {
        const tree = await getPidTree(0);

        expect(tree).toBeDefined();
        expect(tree.pid).toBe(0);
        expect(tree.name).toBe("root");
        expect(Array.isArray(tree.children)).toBe(true);
        // Should have at least one child (init/systemd or kernel threads)
        expect(tree.children.length).toBeGreaterThan(0);
    });

    it("should get priority for current process", () => {
        const currentPid = process.pid;
        const pidInterface = getPid(currentPid);

        const priority = pidInterface.getPriority();
        expect(typeof priority).toBe("number");
    });

    it("should report a system snapshot", async () => {
        const snapshot = await getSystemSnapshot();

        expect(snapshot.time).toBeGreaterThan(0);
        expect(snapshot.memory.total).toBeGreaterThan(0);
        expect(snapshot.cpu.load).toHaveLength(3);
        expect(Array.isArray(snapshot.processes)).toBe(true);

        const current = snapshot.processes.find((item) => item.pid === process.pid);
        expect(current).toBeDefined();
        expect(current?.memory).toBeGreaterThan(0);
        expect(current?.threads).toBeGreaterThan(0);
    });

    it("should calculate CPU usage on the second sample", async () => {
        await getSystemSnapshot();
        const snapshot = await getSystemSnapshot();

        expect(snapshot.cpu.usage === null || typeof snapshot.cpu.usage === "number").toBe(true);
        expect(snapshot.cpu.perCpu.length).toBeGreaterThan(0);
        expect(snapshot.processes.every((process) => process.cpu === null || process.cpu >= 0)).toBe(true);
    });

    it("should report cpu topology", async () => {
        const topology = await getCpuTopology();

        expect(topology.model).toBeTypeOf("string");
        expect(topology.model.length).toBeGreaterThan(0);
        expect(topology.cores.length).toBeGreaterThan(0);
        const online = new Set(topology.cores.filter((core) => core.online).flatMap((core) => core.siblings));
        for (const cpu of [
            ...topology.performance,
            ...topology.efficiency,
            ...topology.lowPowerEfficiency,
            ...topology.unknown,
        ]) {
            expect(online.has(cpu)).toBe(true);
        }
    });

    it("should get process detail for current process", async () => {
        const detail = await getProcessDetail(process.pid);

        expect(detail).not.toBeNull();
        expect(detail?.pid).toBe(process.pid);
        expect(Array.isArray(detail?.cmdline)).toBe(true);
        expect(detail?.cmdline.length).toBeGreaterThan(0);
        expect(detail?.cgroup).toBeTypeOf("string");
        expect(detail?.affinity.length).toBeGreaterThan(0);
    });

    it("should reject an empty affinity list", async () => {
        await expect(setAffinity(process.pid, [])).rejects.toThrow("不能为空");
    });

    it.skipIf(!hasTaskset())("should read and write process affinity", async () => {
        const child = spawn("sleep", ["30"], { stdio: "ignore" });
        try {
            await new Promise((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
            });
            const pid = child.pid;
            expect(pid).toBeDefined();
            if (pid === undefined) return;

            const before = await getAffinity(pid);
            expect(before.length).toBeGreaterThan(0);
            const target = [before[0]];
            await setAffinity(pid, target);
            expect(await getAffinity(pid)).toEqual(target);
        } finally {
            child.kill("SIGKILL");
        }
    });

    it("should watch system snapshots", async () => {
        const controller = new AbortController();
        const snapshot = await new Promise<Awaited<ReturnType<typeof getSystemSnapshot>>>((resolve) => {
            watchSystem(
                (value) => {
                    controller.abort();
                    resolve(value);
                },
                { interval: 100, signal: controller.signal },
            );
        });

        expect(snapshot.processes.length).toBeGreaterThan(0);
    });
});
