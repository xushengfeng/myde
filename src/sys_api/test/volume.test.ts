import { describe, it, expect } from "vitest";
import { volumeControl } from "../volume";

describe("volumeControl", () => {
    it("init and get devices", async () => {
        const volume = new volumeControl();
        await volume.init();

        const devices = volume.getDevices();
        console.log("All devices:", devices);

        const sinks = volume.getSinks();
        console.log("Sinks (outputs):", sinks);

        const sources = volume.getSources();
        console.log("Sources (inputs):", sources);

        expect(devices).toBeDefined();
        expect(Array.isArray(devices)).toBe(true);
    });

    it("get streams", async () => {
        const volume = new volumeControl();
        await volume.init();

        const streams = volume.getStreams();
        console.log("Audio streams:", streams);

        expect(streams).toBeDefined();
        expect(Array.isArray(streams)).toBe(true);
    });

    it("get device volume", async () => {
        const volume = new volumeControl();
        await volume.init();

        const sinks = volume.getSinks();
        if (sinks.length > 0) {
            const sink = sinks[0];
            console.log(`Sink ${sink.id} (${sink.name}):`);

            const vol = volume.getDeviceVolume(sink.id);
            console.log(`  Volume: ${vol}`);

            const muted = volume.getDeviceMute(sink.id);
            console.log(`  Muted: ${muted}`);
        }
    });

    it("get stream volume", async () => {
        const volume = new volumeControl();
        await volume.init();

        const streams = volume.getStreams();
        if (streams.length > 0) {
            const stream = streams[0];
            console.log(`Stream ${stream.id} (${stream.applicationName}):`);

            const vol = volume.getStreamVolume(stream.id);
            console.log(`  Volume: ${vol}`);

            const muted = volume.getStreamMute(stream.id);
            console.log(`  Muted: ${muted}`);
        }
    });

    it("events", async () => {
        const volume = new volumeControl();
        
        const events: string[] = [];
        
        volume.ev.on("deviceAdd", (device) => {
            events.push(`deviceAdd: ${device.name}`);
            console.log(`[EVENT] Device added: ${device.name}`);
        });

        volume.ev.on("deviceRemove", (id) => {
            events.push(`deviceRemove: ${id}`);
            console.log(`[EVENT] Device removed: ${id}`);
        });

        volume.ev.on("streamAdd", (stream) => {
            events.push(`streamAdd: ${stream.name}`);
            console.log(`[EVENT] Stream added: ${stream.name} (PID: ${stream.pid})`);
        });

        volume.ev.on("streamRemove", (id) => {
            events.push(`streamRemove: ${id}`);
            console.log(`[EVENT] Stream removed: ${id}`);
        });

        await volume.init();
        
        // Wait a bit for potential events
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log("Events collected:", events);
        expect(volume).toBeDefined();
    });

    it("inspect stream info", async () => {
        const volume = new volumeControl();
        await volume.init();

        const streams = volume.getStreams();
        for (const stream of streams) {
            console.log(`Stream ${stream.id}:`);
            console.log(`  Name: ${stream.name}`);
            console.log(`  Application: ${stream.applicationName}`);
            console.log(`  PID: ${stream.pid}`);
            console.log(`  Type: ${stream.type}`);
            console.log(`  Media Class: ${stream.mediaClass}`);
        }
    });
});