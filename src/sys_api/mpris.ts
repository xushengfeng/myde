import { type DBusTypes, dbusClient, type dbusInterface, type dbusIO } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

export type MprisEvents = {
    "new-player": [mprisPlayer];
    "remove-player": [name: string];
};

export type MprisPlayerEvents = {
    changed: [changedProperties: Record<string, unknown>];
    meta: [];
    status: [];
};

export class mpris extends EventEmitter<MprisEvents> {
    private io: dbusIO;
    private players = new Map<string, mprisPlayer>();
    private pendingPlayers = new Set<string>();
    private removedDuringInit = new Set<string>();

    constructor(dbus: dbusIO) {
        super();
        this.io = dbus;
    }

    async init() {
        await this.io.connect();
        const client = new dbusClient({ io: this.io });
        const infc = await client.getMetaInterface();
        await infc.onNameOwnerChanged((name, _oldOwner, newOwner) => {
            if (!name.startsWith("org.mpris.MediaPlayer2.")) return;
            if (newOwner) {
                if (this.players.has(name)) this.removePlayer(name);
                void this.emitNewPlayer(name);
            } else {
                this.removePlayer(name);
            }
        });
        void infc.ListNames().then(([names]) => {
            for (const name of names) {
                if (name.startsWith("org.mpris.MediaPlayer2.")) {
                    void this.emitNewPlayer(name);
                }
            }
        });
    }

    getPlayers() {
        return Array.from(this.players.values());
    }

    private async emitNewPlayer(name: string) {
        if (this.players.has(name) || this.pendingPlayers.has(name)) return;
        this.pendingPlayers.add(name);
        try {
            const player = new mprisPlayer(this.io);
            await player.init(name);
            if (this.removedDuringInit.delete(name)) {
                player.destroy();
                return;
            }
            this.players.set(name, player);
            this.emit("new-player", player);
        } finally {
            this.pendingPlayers.delete(name);
        }
    }

    private removePlayer(name: string) {
        if (this.pendingPlayers.has(name)) {
            this.removedDuringInit.add(name);
            return;
        }
        const player = this.players.get(name);
        if (!player) return;
        player.destroy();
        this.players.delete(name);
        this.emit("remove-player", name);
    }
}

export class mprisPlayer extends EventEmitter<MprisPlayerEvents> {
    private dbusClient: dbusClient;
    private root: dbusInterface | undefined;
    private player: dbusInterface | undefined;
    private name: string = "";
    private ready = false;
    private changedUnsub?: () => void;

    constructor(dbus: dbusIO) {
        super();
        this.dbusClient = new dbusClient({ io: dbus });
    }
    async init(name: string) {
        if (this.ready) return;
        this.name = name;
        const service = await this.dbusClient.getService(name);
        const c = await service.getObject("/org/mpris/MediaPlayer2");
        this.root = await c.getInterface("org.mpris.MediaPlayer2");
        this.player = await c.getInterface("org.mpris.MediaPlayer2.Player");
        this.changedUnsub = await this.getPlayer().propertiesChanged((changedProperties) => {
            this.emit("changed", changedProperties);
            if ("Metadata" in changedProperties) this.emit("meta");
            if ("PlaybackStatus" in changedProperties) this.emit("status");
        });
        this.ready = true;
    }
    destroy() {
        this.changedUnsub?.();
        this.changedUnsub = undefined;
        this.ready = false;
        this.root = undefined;
        this.player = undefined;
        this.removeAllListeners("changed");
        this.removeAllListeners("meta");
        this.removeAllListeners("status");
    }
    private getPlayer() {
        if (!this.player) throw new Error("init first");
        return this.player;
    }
    async identity() {
        return (await this.root?.get<"s">("Identity"))?.[0] ?? "";
    }
    getServerName() {
        return this.name;
    }
    play() {
        this.getPlayer().call("Play");
    }
    pause() {
        this.getPlayer().call("Pause");
    }
    stop() {
        this.getPlayer().call("Stop");
    }
    next() {
        this.getPlayer().call("Next");
    }
    previous() {
        this.getPlayer().call("Previous");
    }
    /** s */
    async getCurrentTime() {
        return Number((await this.getPlayer().get<"x">("Position"))[0] / BigInt(10e5));
    }
    setCurrentTime(s: number) {
        this.getPlayer().set("Position", [BigInt(s * 10e5)], "x");
    }
    async metadata() {
        const metadata = (await this.getPlayer().get<"a{sv}">("Metadata"))?.[0];
        const nMetadata: Record<string, any> = {};
        for (const [key, value] of metadata) {
            nMetadata[key] = value.value;
        }
        return nMetadata;
    }
    async duration() {
        const metadata = await this.metadata();
        if ("mpris:length" in metadata) {
            return Number((metadata["mpris:length"] as DBusTypes<"x">)[0]) / 10e5;
        } else {
            return Infinity;
        }
    }
    async paused() {
        const [status] = await this.getPlayer().get<"s">("PlaybackStatus");
        return status === "Paused" || status === "Stopped";
    }
    async title() {
        const metadata = await this.metadata();
        if ("xesam:title" in metadata) {
            return (metadata["xesam:title"] as DBusTypes<"s">)[0];
        } else {
            return "";
        }
    }
    async artist() {
        const metadata = await this.metadata();
        if ("xesam:artist" in metadata) {
            return (metadata["xesam:artist"] as DBusTypes<"as">)[0];
        } else {
            return [];
        }
    }
    async artCover() {
        const metadata = await this.metadata();
        if ("mpris:artUrl" in metadata) {
            return (metadata["mpris:artUrl"] as DBusTypes<"s">)[0];
        } else {
            return "";
        }
    }
    onMetaChange(callback: () => unknown) {
        return this.on("meta", callback);
    }
    onStatusChange(callback: () => unknown) {
        return this.on("status", callback);
    }
}
