import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "./event-emitter";

describe("EventEmitter", () => {
    it("should call handler when event is emitted", () => {
        const emitter = new EventEmitter<{ test: [string, number] }>();
        const handler = vi.fn();

        emitter.on("test", handler);
        emitter.emit("test", "hello", 42);

        expect(handler).toHaveBeenCalledWith("hello", 42);
    });

    it("should return cleanup function from on", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler = vi.fn();

        const cleanup = emitter.on("test", handler);
        cleanup();

        emitter.emit("test");

        expect(handler).not.toHaveBeenCalled();
    });

    it("should remove handler with off", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler = vi.fn();

        emitter.on("test", handler);
        emitter.off("test", handler);

        emitter.emit("test");

        expect(handler).not.toHaveBeenCalled();
    });

    it("should support signal cleanup", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler = vi.fn();
        const controller = new AbortController();

        emitter.on("test", handler, { signal: controller.signal });

        controller.abort();
        emitter.emit("test");

        expect(handler).not.toHaveBeenCalled();
    });

    it("should not add handler if signal is already aborted", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler = vi.fn();
        const controller = new AbortController();

        controller.abort();
        emitter.on("test", handler, { signal: controller.signal });

        emitter.emit("test");

        expect(handler).not.toHaveBeenCalled();
    });

    it("should call handler only once with once", () => {
        const emitter = new EventEmitter<{ test: [string] }>();
        const handler = vi.fn();

        emitter.once("test", handler);

        emitter.emit("test", "first");
        emitter.emit("test", "second");

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith("first");
    });

    it("should return cleanup function from once", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler = vi.fn();

        const cleanup = emitter.once("test", handler);
        cleanup();

        emitter.emit("test");

        expect(handler).not.toHaveBeenCalled();
    });

    it("should remove all listeners for an event", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        emitter.on("test", handler1);
        emitter.once("test", handler2);

        emitter.removeAllListeners("test");

        emitter.emit("test");

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).not.toHaveBeenCalled();
    });

    it("should wait for event with waitFor", async () => {
        const emitter = new EventEmitter<{ test: [string] }>();

        setTimeout(() => {
            emitter.emit("test", "result");
        }, 10);

        const result = await emitter.waitFor("test");

        expect(result).toEqual(["result"]);
    });

    it("should abort waitFor with signal", async () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const controller = new AbortController();

        setTimeout(() => {
            controller.abort();
        }, 10);

        await expect(emitter.waitFor("test", { signal: controller.signal })).rejects.toThrow("Aborted");
    });

    it("should not wait if signal is already aborted", async () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const controller = new AbortController();

        controller.abort();

        await expect(emitter.waitFor("test", { signal: controller.signal })).rejects.toThrow("Aborted");
    });

    it("should return correct listener count", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        emitter.on("test", handler1);
        emitter.once("test", handler2);

        expect(emitter.listenerCount("test")).toBe(2);
    });

    it("should return true for hasListeners when listeners exist", () => {
        const emitter = new EventEmitter<{ test: [] }>();
        const handler = vi.fn();

        emitter.on("test", handler);

        expect(emitter.hasListeners("test")).toBe(true);
    });

    it("should return false for hasListeners when no listeners exist", () => {
        const emitter = new EventEmitter<{ test: [] }>();

        expect(emitter.hasListeners("test")).toBe(false);
    });

    it("should handle multiple events independently", () => {
        const emitter = new EventEmitter<{
            event1: [string];
            event2: [number];
        }>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        emitter.on("event1", handler1);
        emitter.on("event2", handler2);

        emitter.emit("event1", "test");
        emitter.emit("event2", 42);

        expect(handler1).toHaveBeenCalledWith("test");
        expect(handler2).toHaveBeenCalledWith(42);
    });

    it("should not interfere with different events", () => {
        const emitter = new EventEmitter<{
            event1: [];
            event2: [];
        }>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        emitter.on("event1", handler1);
        emitter.on("event2", handler2);

        emitter.removeAllListeners("event1");

        emitter.emit("event1");
        emitter.emit("event2");

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
    });

    it("should call multiple handlers in registration order", () => {
        const emitter = new EventEmitter<{ test: [number] }>();
        const callOrder: number[] = [];

        emitter.on("test", () => callOrder.push(1));
        emitter.on("test", () => callOrder.push(2));
        emitter.on("test", () => callOrder.push(3));

        emitter.emit("test", 0);

        expect(callOrder).toEqual([1, 2, 3]);
    });

    it("should call on and once handlers in registration order", () => {
        const emitter = new EventEmitter<{ test: [number] }>();
        const callOrder: number[] = [];

        emitter.on("test", () => callOrder.push(1));
        emitter.once("test", () => callOrder.push(2));
        emitter.on("test", () => callOrder.push(3));

        emitter.emit("test", 0);

        expect(callOrder).toEqual([1, 2, 3]);
    });
});

describe("EventEmitter request/respond", () => {
    it("should return result from responder", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [string]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        emitter.respond("query", (name: string) => name.length);

        const results = await emitter.request("query", "hello");

        expect(results).toEqual([5]);
    });

    it("should return results from multiple responders", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [number]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        emitter.respond("query", (n: number) => n * 2);
        emitter.respond("query", (n: number) => n * 3);

        const results = await emitter.request("query", 5);

        expect(results).toEqual([10, 15]);
    });

    it("should return empty array when no responders", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [string]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        const results = await emitter.request("query", "hello");

        expect(results).toEqual([]);
    });

    it("should cleanup responder with returned function", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [string]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        const cleanup = emitter.respond("query", (name: string) => name.length);
        cleanup();

        const results = await emitter.request("query", "hello");

        expect(results).toEqual([]);
    });

    it("should cleanup responder with signal", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [string]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();
        const controller = new AbortController();

        emitter.respond("query", (name: string) => name.length, { signal: controller.signal });
        controller.abort();

        const results = await emitter.request("query", "hello");

        expect(results).toEqual([]);
    });

    it("should not add responder if signal is already aborted", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [string]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();
        const controller = new AbortController();

        controller.abort();
        emitter.respond("query", (name: string) => name.length, { signal: controller.signal });

        const results = await emitter.request("query", "hello");

        expect(results).toEqual([]);
    });

    it("should reject on responder error", async () => {
        type MyEvents = Record<string, any[]>;
        type MyRequestEvents = {
            query: { args: [string]; result: number };
        };
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        emitter.respond("query", () => {
            throw new Error("test error");
        });

        await expect(emitter.request("query", "hello")).rejects.toThrow("test error");
    });
});
