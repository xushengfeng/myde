import { EventEmitter } from "../../src/event-emitter/event-emitter";
import type { AudioDevice, AudioStream, volumeControl } from "../../src/sys_api/volume";

/**
 * 提取类的公共成员（排除构造函数和private成员）
 */
type MockType<T> = Omit<T, "constructor">;

export class MockAudioDevice implements AudioDevice {
    id: number;
    name: string;
    type: "sink" | "source" | "device";
    isDefault: boolean;
    volume?: number;
    isMuted?: boolean;
    description?: string;

    constructor(
        id: number,
        name: string,
        type: "sink" | "source" | "device" = "device",
        isDefault = false,
        volume = 1.0,
        isMuted = false,
    ) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.isDefault = isDefault;
        this.volume = volume;
        this.isMuted = isMuted;
    }

    setId(id: number) {
        this.id = id;
    }

    setName(name: string) {
        this.name = name;
    }

    setType(type: "sink" | "source" | "device") {
        this.type = type;
    }

    setDefault(isDefault: boolean) {
        this.isDefault = isDefault;
    }

    setVolume(volume: number) {
        this.volume = volume;
    }

    setMuted(muted: boolean) {
        this.isMuted = muted;
    }

    setDescription(description: string) {
        this.description = description;
    }
}

export class MockAudioStream implements AudioStream {
    id: number;
    name: string;
    pid?: number;
    type: "input" | "output";
    applicationName?: string;
    mediaClass?: string;
    volume?: number;
    isMuted?: boolean;

    constructor(
        id: number,
        name: string,
        type: "input" | "output" = "output",
        pid?: number,
        applicationName?: string,
        volume = 1.0,
        isMuted = false,
    ) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.pid = pid;
        this.applicationName = applicationName;
        this.volume = volume;
        this.isMuted = isMuted;
    }

    setId(id: number) {
        this.id = id;
    }

    setName(name: string) {
        this.name = name;
    }

    setType(type: "input" | "output") {
        this.type = type;
    }

    setPid(pid: number) {
        this.pid = pid;
    }

    setApplicationName(name: string) {
        this.applicationName = name;
    }

    setMediaClass(mediaClass: string) {
        this.mediaClass = mediaClass;
    }

    setVolume(volume: number) {
        this.volume = volume;
    }

    setMuted(muted: boolean) {
        this.isMuted = muted;
    }
}

export class MockVolumeManager {
    private devices = new Map<number, MockAudioDevice>();
    private streams = new Map<number, MockAudioStream>();
    private emitter = new EventEmitter<{
        deviceAdd: [device: AudioDevice];
        deviceRemove: [deviceId: number];
        deviceVolumeChange: [deviceId: number, volume: number];
        deviceMuteChange: [deviceId: number, muted: boolean];
        streamAdd: [stream: AudioStream];
        streamRemove: [streamId: number];
        streamVolumeChange: [streamId: number, volume: number];
        streamMuteChange: [streamId: number, muted: boolean];
    }>();
    private log: (...args: unknown[]) => void;

    constructor(log: (...args: unknown[]) => void) {
        this.log = log;
    }

    addDevice(device: MockAudioDevice) {
        this.devices.set(device.id, device);
        this.emitter.emit("deviceAdd", device);
    }

    removeDevice(id: number) {
        this.devices.delete(id);
        this.emitter.emit("deviceRemove", id);
    }

    getDevice(id: number) {
        return this.devices.get(id);
    }

    getDevices() {
        return Array.from(this.devices.values());
    }

    addStream(stream: MockAudioStream) {
        this.streams.set(stream.id, stream);
        this.emitter.emit("streamAdd", stream);
    }

    removeStream(id: number) {
        this.streams.delete(id);
        this.emitter.emit("streamRemove", id);
    }

    getStream(id: number) {
        return this.streams.get(id);
    }

    getStreams() {
        return Array.from(this.streams.values());
    }

    createMock(): MockType<volumeControl> {
        const manager = this;
        return {
            ev: manager.emitter,

            async init() {
                manager.log("volume.init");
            },

            getDevices() {
                return manager.getDevices();
            },

            getSinks() {
                return manager.getDevices().filter((d) => d.type === "sink");
            },

            getSources() {
                return manager.getDevices().filter((d) => d.type === "source");
            },

            getStreams() {
                return manager.getStreams();
            },

            getDevice(id: number) {
                return manager.getDevice(id);
            },

            getStream(id: number) {
                return manager.getStream(id);
            },

            getDeviceVolume(id: number) {
                const device = manager.getDevice(id);
                return device?.volume ?? null;
            },

            setDeviceVolume(id: number, volume: number) {
                const device = manager.getDevice(id);
                if (device) {
                    device.setVolume(volume);
                    manager.emitter.emit("deviceVolumeChange", id, volume);
                    return true;
                }
                return false;
            },

            getDeviceMute(id: number) {
                const device = manager.getDevice(id);
                return device?.isMuted ?? null;
            },

            setDeviceMute(id: number, mute: boolean | "toggle") {
                const device = manager.getDevice(id);
                if (device) {
                    const newMuted = mute === "toggle" ? !device.isMuted : mute;
                    device.setMuted(newMuted);
                    manager.emitter.emit("deviceMuteChange", id, newMuted);
                    return true;
                }
                return false;
            },

            setDefaultDevice(id: number) {
                for (const [deviceId, device] of manager.devices) {
                    device.setDefault(deviceId === id);
                }
                return true;
            },

            getStreamVolume(streamId: number) {
                const stream = manager.getStream(streamId);
                return stream?.volume ?? null;
            },

            setStreamVolume(streamId: number, volume: number) {
                const stream = manager.getStream(streamId);
                if (stream) {
                    stream.setVolume(volume);
                    manager.emitter.emit("streamVolumeChange", streamId, volume);
                    return true;
                }
                return false;
            },

            getStreamMute(streamId: number) {
                const stream = manager.getStream(streamId);
                return stream?.isMuted ?? null;
            },

            setStreamMute(streamId: number, mute: boolean | "toggle") {
                const stream = manager.getStream(streamId);
                if (stream) {
                    const newMuted = mute === "toggle" ? !stream.isMuted : mute;
                    stream.setMuted(newMuted);
                    manager.emitter.emit("streamMuteChange", streamId, newMuted);
                    return true;
                }
                return false;
            },

            destroy() {
                manager.log("volume.destroy");
            },
        };
    }
}

function createMockVolume(log: (...args: any[]) => void): MockType<volumeControl> {
    const manager = new MockVolumeManager(log);
    return manager.createMock();
}

export { createMockVolume };
