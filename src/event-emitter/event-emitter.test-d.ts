import { describe, expectTypeOf, it } from "vitest";
import { EventEmitter } from "./event-emitter";

type MyEvents = {
    click: [x: number, y: number];
    message: [text: string];
    ready: [];
};

type MyRequestEvents = {
    query: { args: [sql: string]; result: any[] };
    getUser: { args: [id: number]; result: { name: string } };
};

describe("EventEmitter type tests", () => {
    it("on handler parameters are correctly inferred", () => {
        const emitter = new EventEmitter<MyEvents>();

        emitter.on("click", (x, y) => {
            expectTypeOf(x).toBeNumber();
            expectTypeOf(y).toBeNumber();
        });

        emitter.on("message", (text) => {
            expectTypeOf(text).toBeString();
        });

        emitter.on("ready", () => {});
    });

    it("once handler parameters are correctly inferred", () => {
        const emitter = new EventEmitter<MyEvents>();

        emitter.once("click", (x, y) => {
            expectTypeOf(x).toBeNumber();
            expectTypeOf(y).toBeNumber();
        });
    });

    it("emit requires correct arguments", () => {
        const emitter = new EventEmitter<MyEvents>();

        // @ts-expect-error - missing arguments
        emitter.emit("click");

        // @ts-expect-error - wrong argument types
        emitter.emit("click", "a", "b");

        emitter.emit("click", 10, 20);
        emitter.emit("message", "hello");
        emitter.emit("ready");
    });

    it("respond handler parameters and return type are correctly inferred", () => {
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        emitter.respond("query", (sql) => {
            expectTypeOf(sql).toBeString();
            return [];
        });

        emitter.respond("getUser", (id) => {
            expectTypeOf(id).toBeNumber();
            return { name: "Alice" };
        });
    });

    it("respond rejects wrong return type", () => {
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        // @ts-expect-error - wrong return type
        emitter.respond("query", (sql) => sql.length);

        // @ts-expect-error - wrong return type
        emitter.respond("getUser", (_id) => ({ name: 123 }));
    });

    it("request returns correct type", () => {
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        expectTypeOf(emitter.request("query", "SELECT 1")).toEqualTypeOf<Promise<any[][]>>();
        expectTypeOf(emitter.request("getUser", 1)).toEqualTypeOf<Promise<{ name: string }[]>>();
    });

    it("request cannot be used on regular events", () => {
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        // @ts-expect-error - 'click' is not a request event
        emitter.request("click", 1, 2);

        // @ts-expect-error - 'ready' is not a request event
        emitter.request("ready");
    });

    it("respond cannot be used on regular events", () => {
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        // @ts-expect-error - 'click' is not a request event
        emitter.respond("click", () => {});

        // @ts-expect-error - 'message' is not a request event
        emitter.respond("message", () => {});
    });

    it("event and request event names cannot be mixed", () => {
        const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

        // @ts-expect-error - 'query' is not a regular event
        emitter.on("query", () => {});

        // @ts-expect-error - 'getUser' is not a regular event
        emitter.emit("getUser", 1);

        // @ts-expect-error - 'click' is not a request event
        emitter.respond("click", () => 42);
    });

    it("second generic parameter is optional", () => {
        const emitter = new EventEmitter<{ update: [data: string] }>();

        emitter.on("update", (data) => {
            expectTypeOf(data).toBeString();
        });

        emitter.emit("update", "test");
    });

    it("cleanup functions have correct type", () => {
        const emitter = new EventEmitter<MyEvents>();

        expectTypeOf(emitter.on("click", () => {})).toBeFunction();
        expectTypeOf(emitter.once("click", () => {})).toBeFunction();
        expectTypeOf(emitter.respond("query", () => [])).toBeFunction();
    });

    it("waitFor returns correct promise type", () => {
        const emitter = new EventEmitter<MyEvents>();

        expectTypeOf(emitter.waitFor("click")).toEqualTypeOf<Promise<[number, number]>>();
        expectTypeOf(emitter.waitFor("message")).toEqualTypeOf<Promise<[string]>>();
        expectTypeOf(emitter.waitFor("ready")).toEqualTypeOf<Promise<[]>>();
    });

    it("event names are constrained", () => {
        const emitter = new EventEmitter<MyEvents>();

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.on("nonexistent", () => {});

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.emit("nonexistent");

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.off("nonexistent", () => {});

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.removeAllListeners("nonexistent");

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.listenerCount("nonexistent");

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.hasListeners("nonexistent");

        // @ts-expect-error - 'nonexistent' is not a valid event
        emitter.waitFor("nonexistent");
    });
});
