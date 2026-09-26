const { execSync } = require("node:child_process") as typeof import("node:child_process");

import { EventEmitter } from "../event-emitter/event-emitter";

export interface AudioDevice {
    id: number;
    name: string;
    type: "sink" | "source" | "device";
    isDefault: boolean;
    volume?: number;
    isMuted?: boolean;
    description?: string;
}

export interface AudioStream {
    id: number;
    name: string;
    pid?: number;
    type: "input" | "output";
    applicationName?: string;
    mediaClass?: string;
    volume?: number;
    isMuted?: boolean;
}

export class volumeControl {
    ev = new EventEmitter<{
        deviceAdd: [device: AudioDevice];
        deviceRemove: [deviceId: number];
        deviceVolumeChange: [deviceId: number, volume: number];
        deviceMuteChange: [deviceId: number, muted: boolean];
        streamAdd: [stream: AudioStream];
        streamRemove: [streamId: number];
        streamVolumeChange: [streamId: number, volume: number];
        streamMuteChange: [streamId: number, muted: boolean];
    }>();

    private devices = new Map<number, AudioDevice>();
    private streams = new Map<number, AudioStream>();
    private pollInterval: number = 1000;
    private timer?: ReturnType<typeof setInterval>;

    async init() {
        await this.refreshDevices();
        await this.refreshStreams();
        this.startPolling();
    }

    private startPolling() {
        this.timer = setInterval(async () => {
            await this.poll();
        }, this.pollInterval);
    }

    private async poll() {
        try {
            const oldDeviceIds = new Set(this.devices.keys());
            const oldStreamIds = new Set(this.streams.keys());

            await this.refreshDevices();
            await this.refreshStreams();

            // Check for new/removed devices
            for (const [id] of this.devices) {
                if (!oldDeviceIds.has(id)) {
                    const device = this.devices.get(id);
                    if (device) {
                        this.ev.emit("deviceAdd", device);
                    }
                }
            }

            for (const id of oldDeviceIds) {
                if (!this.devices.has(id)) {
                    this.ev.emit("deviceRemove", id);
                }
            }

            // Check for new/removed streams
            for (const [id] of this.streams) {
                if (!oldStreamIds.has(id)) {
                    const stream = this.streams.get(id);
                    if (stream) {
                        this.ev.emit("streamAdd", stream);
                    }
                }
            }

            for (const id of oldStreamIds) {
                if (!this.streams.has(id)) {
                    this.ev.emit("streamRemove", id);
                }
            }
        } catch (_error) {
            // Ignore errors
        }
    }

    private async refreshDevices() {
        try {
            const output = execSync("wpctl status", { encoding: "utf-8" });
            this.parseDevices(output);
        } catch (_error) {
            // Ignore errors
        }
    }

    private async refreshStreams() {
        try {
            const output = execSync("wpctl status", { encoding: "utf-8" });
            this.parseStreams(output);
        } catch (_error) {
            // Ignore errors
        }
    }

    private parseDevices(output: string) {
        const lines = output.split("\n");
        let inAudioSection = false;
        let currentSection = "";

        for (const line of lines) {
            // Check for Audio section header
            if (line.trim() === "Audio") {
                inAudioSection = true;
                continue;
            }

            // Exit at Video section
            if (inAudioSection && line.trim() === "Video") {
                break;
            }

            if (inAudioSection) {
                // Check for section headers
                if (line.includes("├─ Devices:") || line.includes("└─ Devices:")) {
                    currentSection = "devices";
                    continue;
                } else if (line.includes("├─ Sinks:") || line.includes("└─ Sinks:")) {
                    currentSection = "sinks";
                    continue;
                } else if (line.includes("├─ Sources:") || line.includes("└─ Sources:")) {
                    currentSection = "sources";
                    continue;
                } else if (line.includes("├─ Filters:") || line.includes("└─ Filters:")) {
                    currentSection = "filters";
                    continue;
                } else if (line.includes("├─ Streams:") || line.includes("└─ Streams:")) {
                    currentSection = "streams";
                    continue;
                }

                // Parse device lines
                if (
                    currentSection &&
                    (currentSection === "devices" || currentSection === "sinks" || currentSection === "sources")
                ) {
                    const match = line.match(/(\d+)\.\s+(.+?)(?:\s+\[.*?\])?\s*$/);
                    if (match) {
                        const id = parseInt(match[1], 10);
                        const name = match[2].trim();
                        const isDefault = line.includes("*");

                        let deviceType: "sink" | "source" | "device" = "device";
                        if (currentSection === "sinks") deviceType = "sink";
                        else if (currentSection === "sources") deviceType = "source";

                        // Get volume info from the line
                        let volume: number | undefined;
                        let isMuted = false;
                        const volMatch = line.match(/vol:\s+([\d.]+)/);
                        if (volMatch) {
                            volume = parseFloat(volMatch[1]);
                        }
                        if (line.includes("MUTED")) {
                            isMuted = true;
                        }

                        this.devices.set(id, {
                            id,
                            name,
                            type: deviceType,
                            isDefault,
                            volume,
                            isMuted,
                        });
                    }
                }
            }
        }
    }

    private parseStreams(output: string) {
        const lines = output.split("\n");
        let inStreamsSection = false;

        for (const line of lines) {
            // Check for Audio Streams section
            if (line.includes("└─ Streams:") || line.includes("├─ Streams:")) {
                inStreamsSection = true;
                continue;
            }

            // Exit at Video section or Settings section
            if (inStreamsSection && (line.trim() === "Video" || line.trim() === "Settings")) {
                break;
            }

            if (inStreamsSection) {
                // Main stream line: "        81. speech-dispatcher-dummy"
                const mainMatch = line.match(/^\s+(\d+)\.\s+(.+?)(?:\s{2,}|\t)/);
                if (mainMatch) {
                    const id = parseInt(mainMatch[1], 10);
                    const name = mainMatch[2].trim();

                    // Get detailed info via wpctl inspect
                    const streamInfo = this.getStreamInfo(id);

                    const stream: AudioStream = {
                        id,
                        name,
                        pid: streamInfo?.pid,
                        type: streamInfo?.type || "output",
                        applicationName: streamInfo?.applicationName || name,
                        mediaClass: streamInfo?.mediaClass,
                    };

                    this.streams.set(id, stream);
                }
            }
        }
    }

    private getStreamInfo(
        streamId: number,
    ): { pid?: number; type?: "input" | "output"; applicationName?: string; mediaClass?: string } | null {
        try {
            const output = execSync(`wpctl inspect ${streamId}`, { encoding: "utf-8" });

            let pid: number | undefined;
            let type: "input" | "output" = "output";
            let applicationName: string | undefined;
            let mediaClass: string | undefined;

            const lines = output.split("\n");
            for (const line of lines) {
                if (line.includes("application.process.id")) {
                    const match = line.match(/"(\d+)"/);
                    if (match) pid = parseInt(match[1], 10);
                }
                if (line.includes("application.name")) {
                    const match = line.match(/"(.+?)"/);
                    if (match) applicationName = match[1];
                }
                if (line.includes("media.class")) {
                    const match = line.match(/"(.+?)"/);
                    if (match) {
                        mediaClass = match[1];
                        if (mediaClass.includes("Input")) {
                            type = "input";
                        }
                    }
                }
            }

            return { pid, type, applicationName, mediaClass };
        } catch (_error) {
            return null;
        }
    }

    // Public API methods
    getDevices(): AudioDevice[] {
        return Array.from(this.devices.values());
    }

    getSinks(): AudioDevice[] {
        return Array.from(this.devices.values()).filter((d) => d.type === "sink");
    }

    getSources(): AudioDevice[] {
        return Array.from(this.devices.values()).filter((d) => d.type === "source");
    }

    getStreams(): AudioStream[] {
        return Array.from(this.streams.values());
    }

    getDevice(id: number): AudioDevice | undefined {
        return this.devices.get(id);
    }

    getStream(id: number): AudioStream | undefined {
        return this.streams.get(id);
    }

    getDeviceVolume(id: number): number | null {
        try {
            const output = execSync(`wpctl get-volume ${id}`, { encoding: "utf-8" });
            const match = output.match(/Volume:\s+([\d.]+)/);
            if (match) {
                const volume = parseFloat(match[1]);
                return volume;
            }
        } catch (_error) {
            // Ignore errors
        }
        return null;
    }

    setDeviceVolume(id: number, volume: number): boolean {
        try {
            // Clamp volume between 0 and 1.5 (150%)
            const clampedVolume = Math.max(0, Math.min(1.5, volume));
            execSync(`wpctl set-volume ${id} ${clampedVolume}`, { encoding: "utf-8" });

            // Update local cache
            const device = this.devices.get(id);
            if (device) {
                device.volume = clampedVolume;
            }

            return true;
        } catch (_error) {
            return false;
        }
    }

    getDeviceMute(id: number): boolean | null {
        try {
            const output = execSync(`wpctl get-volume ${id}`, { encoding: "utf-8" });
            const isMuted = output.includes("MUTED");
            return isMuted;
        } catch (_error) {
            return null;
        }
    }

    setDeviceMute(id: number, mute: boolean | "toggle"): boolean {
        try {
            const muteValue = mute === "toggle" ? "toggle" : mute ? "1" : "0";
            execSync(`wpctl set-mute ${id} ${muteValue}`, { encoding: "utf-8" });

            // Update local cache
            const device = this.devices.get(id);
            if (device) {
                device.isMuted = mute === "toggle" ? !device.isMuted : mute;
            }

            return true;
        } catch (_error) {
            return false;
        }
    }

    setDefaultDevice(id: number): boolean {
        try {
            execSync(`wpctl set-default ${id}`, { encoding: "utf-8" });

            // Update local cache
            for (const [deviceId, device] of this.devices) {
                device.isDefault = deviceId === id;
            }

            return true;
        } catch (_error) {
            return false;
        }
    }

    // Stream control methods
    getStreamVolume(streamId: number): number | null {
        try {
            const output = execSync(`wpctl get-volume ${streamId}`, { encoding: "utf-8" });
            const match = output.match(/Volume:\s+([\d.]+)/);
            if (match) {
                const volume = parseFloat(match[1]);
                return volume;
            }
        } catch (_error) {
            return null;
        }
        return null;
    }

    setStreamVolume(streamId: number, volume: number): boolean {
        try {
            const clampedVolume = Math.max(0, Math.min(1.5, volume));
            execSync(`wpctl set-volume ${streamId} ${clampedVolume}`, { encoding: "utf-8" });

            // Update local cache
            const stream = this.streams.get(streamId);
            if (stream) {
                stream.volume = clampedVolume;
            }

            return true;
        } catch (_error) {
            return false;
        }
    }

    getStreamMute(streamId: number): boolean | null {
        try {
            const output = execSync(`wpctl get-volume ${streamId}`, { encoding: "utf-8" });
            const isMuted = output.includes("MUTED");
            return isMuted;
        } catch (_error) {
            return null;
        }
    }

    setStreamMute(streamId: number, mute: boolean | "toggle"): boolean {
        try {
            const muteValue = mute === "toggle" ? "toggle" : mute ? "1" : "0";
            execSync(`wpctl set-mute ${streamId} ${muteValue}`, { encoding: "utf-8" });

            // Update local cache
            const stream = this.streams.get(streamId);
            if (stream) {
                stream.isMuted = mute === "toggle" ? !stream.isMuted : mute;
            }

            return true;
        } catch (_error) {
            return false;
        }
    }

    // Cleanup
    destroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}
