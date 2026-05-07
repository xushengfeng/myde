const { exec } = require("node:child_process") as typeof import("child_process");

export function setPowerState(state: "suspend" | "hibernate" | "shutdown" | "restart") {
    const targetState = (() => {
        switch (state) {
            case "suspend":
                return "suspend";
            case "hibernate":
                return "hibernate";
            case "shutdown":
                return "poweroff";
            case "restart":
                return "reboot";
        }
    })();

    exec(`systemctl ${targetState}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing power command: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`Power command stderr: ${stderr}`);
            return;
        }
        console.log(`Power command stdout: ${stdout}`);
    });
}
