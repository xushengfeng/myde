import { describe, expect, it } from "vitest";
import { getPidTree, getPid } from "../app_control";

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
});
