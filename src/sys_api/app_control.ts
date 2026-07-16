const os = require("node:os") as typeof import("node:os");
const child_process = require("node:child_process") as typeof import("node:child_process");

export type Item = {
    pid: number;
    ppid: number;
    /** memory usage in bytes */
    memoryUsage: number;
    name: string;
    children: Item[];
};

export async function getPidTree(pid = 0): Promise<Item> {
    const exec = (cmd: string): Promise<string> => {
        return new Promise((resolve, reject) => {
            child_process.exec(cmd, (error, stdout, _stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout);
                }
            });
        });
    };

    const psOutput = await exec("ps -e -o pid,ppid,rss,comm");
    const lines = psOutput.trim().split("\n").slice(1);

    const processes: { pid: number; ppid: number; memoryUsage: number; name: string }[] = [];
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
            const pidNum = parseInt(parts[0], 10);
            const ppidNum = parseInt(parts[1], 10);
            const memoryKB = parseInt(parts[2], 10);
            const name = parts.slice(3).join(" ");
            processes.push({
                pid: pidNum,
                ppid: ppidNum,
                memoryUsage: memoryKB * 1024,
                name,
            });
        }
    }

    const pidMap = new Map<number, { pid: number; ppid: number; memoryUsage: number; name: string }>();
    for (const proc of processes) {
        pidMap.set(proc.pid, proc);
    }

    const buildTree = (currentPid: number): Item => {
        const proc = pidMap.get(currentPid);
        if (!proc) {
            return {
                pid: currentPid,
                ppid: 0,
                memoryUsage: 0,
                name: "unknown",
                children: [],
            };
        }

        const children = processes.filter((p) => p.ppid === currentPid).map((p) => buildTree(p.pid));

        return {
            pid: proc.pid,
            ppid: proc.ppid,
            memoryUsage: proc.memoryUsage,
            name: proc.name,
            children,
        };
    };

    if (pid === 0) {
        const rootProcesses = processes.filter((p) => p.ppid === 0);
        const children = rootProcesses.map((p) => buildTree(p.pid));
        return {
            pid: 0,
            ppid: 0,
            memoryUsage: 0,
            name: "root",
            children,
        };
    } else {
        return buildTree(pid);
    }
}

export function getPid(pid: number) {
    return {
        getPidTree() {
            return getPidTree(pid);
        },
        setPriority(priority: number): void {
            try {
                os.setPriority(pid, priority);
            } catch (error) {
                console.error(`Failed to set priority for PID ${pid}:`, error);
            }
        },
        getPriority(): number | null {
            try {
                return os.getPriority(pid);
            } catch (error) {
                console.error(`Failed to get priority for PID ${pid}:`, error);
                return null;
            }
        },
        suspend() {
            process.kill(pid, "SIGSTOP");
        },
        resume() {
            process.kill(pid, "SIGCONT");
        },
        kill() {
            process.kill(pid, "SIGKILL");
        },
    };
}
