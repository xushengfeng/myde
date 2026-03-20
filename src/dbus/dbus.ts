import type { USocket } from "@xushengfeng/usocket";
import { dbusMessage } from "./message";

export class dbusIO {
    private socket: USocket | null = null;
    constructor(op?: {
        socket: USocket;
    }) {
        if (op?.socket) {
            this.socket = op.socket;
        }
    }
    call(message: dbusMessage) {}
}
