import { it } from "vitest";
import { dbusIO } from "myde-dbus";
import { polkit } from "../polkit";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function out(...args: unknown[]) {
    process.stdout.write(`\n[diag] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}

it("pkexec flow through our agent", async () => {
    const socket = new mus.USocket();
    socket.connect("/var/run/dbus/system_bus_socket");
    const io = new dbusIO({ socket });
    const agent = new polkit(io);
    agent.on("auth-request", (req) => {
        out("auth-request", req.actionId, JSON.stringify(req.message), JSON.stringify(req.identities), JSON.stringify(req.details));
        setTimeout(() => req.cancel(), 500);
    });
    agent.on("auth-prompt", (req, prompt, echo) => out("auth-prompt", JSON.stringify(prompt), echo));
    agent.on("auth-info", (_req, m) => out("auth-info", m));
    agent.on("auth-error", (_req, m) => out("auth-error", m));
    agent.on("auth-end", (_req, r) => out("auth-end", r));
    await agent.init();
    out("agent pid", process.pid);

    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn("pkexec", ["true"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.kill();
        }, 8000);
        child.on("exit", (c) => {
            clearTimeout(timer);
            resolve(c);
        });
    });
    out("pkexec", { code, stdout: stdout.trim(), stderr: stderr.trim() });
    agent.destroy();
    await new Promise((r) => setTimeout(r, 300));
}, 60000);
