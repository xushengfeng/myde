import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DBusType, dbusClient, dbusServer, dbusVariant } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { polkit } from "../polkit";
import { DBusTestEnv } from "./utils/dbus_env/dbus-env";

const AUTHORITY_BUS = "org.freedesktop.PolicyKit1";
const AUTHORITY_PATH = "/org/freedesktop/PolicyKit1/Authority";
const AUTHORITY_IFACE = "org.freedesktop.PolicyKit1.Authority";
const AGENT_IFACE = "org.freedesktop.PolicyKit1.AuthenticationAgent";
const AGENT_BUS = "org.myde.PolicyKit1.test";
const AGENT_PATH = "/org/myde/PolicyKit1/AuthenticationAgent/test";

interface Registration {
    subject: unknown;
    locale: string;
    objectPath: string;
}

describe("polkit", () => {
    let env: DBusTestEnv;
    let agent: polkit;
    let helperDir: string;
    let registered: Registration | undefined;
    let unregistered = false;
    let firstRequestId = 0;

    beforeAll(async () => {
        env = new DBusTestEnv();
        await env.start();

        const authorityIo = await env.createConnection();
        const authority = new dbusServer(authorityIo, AUTHORITY_BUS);
        await authority.init();
        authority.addObject(AUTHORITY_PATH, AUTHORITY_IFACE, {
            RegisterAuthenticationAgent: (subject: unknown, locale: string, objectPath: string) => {
                registered = { subject, locale, objectPath };
            },
            UnregisterAuthenticationAgent: () => {
                unregistered = true;
            },
        });

        helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-polkit-helper-"));
        const helperPath = path.join(helperDir, "fake-polkit-helper.sh");
        fs.writeFileSync(
            helperPath,
            [
                "#!/bin/sh",
                "read cookie",
                "printf 'PAM_PROMPT_ECHO_OFF Password: \\n'",
                "read password",
                'if [ "$password" = "secret" ]; then',
                "  printf 'PAM_TEXT_INFO Authenticated\\n'",
                "  printf 'SUCCESS\\n'",
                "else",
                "  printf 'FAILURE\\n'",
                "fi",
                "",
            ].join("\n"),
        );
        fs.chmodSync(helperPath, 0o755);

        const agentIo = await env.createConnection();
        agent = new polkit(agentIo, {
            busName: AGENT_BUS,
            objectPath: AGENT_PATH,
            sessionId: "test-session",
            locale: "C",
            helperPath,
            helperSocketPath: path.join(helperDir, "missing.socket"),
            requireSetuidHelper: false,
        });
        await agent.init();
    });

    afterAll(async () => {
        await agent?.destroy();
        expect(unregistered).toBe(true);
        fs.rmSync(helperDir, { recursive: true, force: true });
        await env.stop();
    });

    it("注册到 polkitd 并完成密码认证", { timeout: 20000 }, async () => {
        expect(registered?.locale).toBe("C");
        expect(registered?.objectPath).toBe(AGENT_PATH);
        expect(registered?.subject).toEqual([
            "unix-session",
            [["session-id", { signature: "s", value: ["test-session"] }]],
        ]);

        const client = await env.createConnection();
        const service = await new dbusClient({ io: client }).getService(AGENT_BUS);
        const object = await service.getObject(AGENT_PATH);
        const iface = await object.getInterface(AGENT_IFACE);

        const requestPromise = agent.waitFor("auth-request");
        const promptPromise = agent.waitFor("auth-prompt");
        const endPromise = agent.waitFor("auth-end");

        const identities = [
            ["unix-user", [["uid", dbusVariant<"u">("u", process.getuid?.() ?? 1000)]]],
        ] as unknown as DBusType<"a(sa{sv})">;
        const details: [string, string][] = [
            ["command_line", "/usr/bin/test --flag"],
            ["polkit.vendor", "MyDE"],
        ];
        const done = iface
            .call(
                "BeginAuthentication",
                "sssa{ss}sa(sa{sv})",
                "org.myde.test.action",
                "Authentication required to run /usr/bin/test",
                "dialog-password",
                details,
                "cookie-1",
                identities,
            )
            .await();

        const [request] = await requestPromise;
        firstRequestId = request.id;
        expect(request.id).toBe(1);
        expect(request.actionId).toBe("org.myde.test.action");
        expect(request.iconName).toBe("dialog-password");
        expect(request.command).toBe("/usr/bin/test --flag");
        expect(request.vendor).toBe("MyDE");
        expect(request.identities).toHaveLength(1);
        expect(request.identities[0].kind).toBe("unix-user");
        expect(request.identities[0].uid).toBe(process.getuid?.() ?? 1000);
        expect(request.selectedIdentity.id).toBe(`unix-user:${process.getuid?.() ?? 1000}`);

        const [promptRequest, prompt, echo] = await promptPromise;
        expect(promptRequest).toBe(request);
        expect(prompt).toBe("Password: ");
        expect(echo).toBe(false);

        request.submitPassword("secret");
        await done;

        const [endedRequest, result] = await endPromise;
        expect(endedRequest).toBe(request);
        expect(result).toEqual({ success: true, cancelled: false });
        expect(request.info).toBe("Authenticated");
    });

    it("取消认证", { timeout: 20000 }, async () => {
        const client = await env.createConnection();
        const service = await new dbusClient({ io: client }).getService(AGENT_BUS);
        const object = await service.getObject(AGENT_PATH);
        const iface = await object.getInterface(AGENT_IFACE);

        const requestPromise = agent.waitFor("auth-request");
        const endPromise = agent.waitFor("auth-end");
        const identities = [
            ["unix-user", [["uid", dbusVariant<"u">("u", process.getuid?.() ?? 1000)]]],
        ] as unknown as DBusType<"a(sa{sv})">;

        const done = iface
            .call(
                "BeginAuthentication",
                "sssa{ss}sa(sa{sv})",
                "org.myde.test.cancel",
                "Cancel test",
                "",
                [],
                "cookie-2",
                identities,
            )
            .await();

        const [request] = await requestPromise;
        expect(request.id).not.toBe(firstRequestId);
        request.cancel();
        await done;

        const [endedRequest, result] = await endPromise;
        expect(endedRequest).toBe(request);
        expect(result).toEqual({ success: false, cancelled: true });
    });
});
