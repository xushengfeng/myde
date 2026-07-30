import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DBusTestEnv } from "./dbus-env";

describe("DBusTestEnv", () => {
  let env: DBusTestEnv;

  beforeAll(async () => {
    env = new DBusTestEnv({ enablePcap: false });
    await env.start();
  });

  afterAll(async () => {
    await env.stop();
  });

  it("should create a running dbus-daemon", async () => {
    expect(env.socketPath).toBeDefined();
    expect(env.busAddress).toContain("unix:path=");
  });

  it("should provide dbusEnv for child processes", () => {
    const dbusEnv = env.dbusEnv;
    expect(dbusEnv.DBUS_SESSION_BUS_ADDRESS).toBe(env.busAddress);
  });

  it("should create dbus connection", async () => {
    const conn = await env.createConnection();
    expect(conn).toBeDefined();
  });

  it("should spawn child process with dbus env", async () => {
    const child = env.spawn("dbus-send", [
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.ListNames",
    ]);

    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      child.stdout?.on("data", (data) => (stdout += data.toString()));
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
      child.on("error", reject);
    });

    expect(output).toContain("org.freedesktop.DBus");
  });
});
