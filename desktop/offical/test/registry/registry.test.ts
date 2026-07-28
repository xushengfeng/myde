import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry";

describe("build var id", () => {
    it("build", () => {
        const r = new Registry<{ "a[].b[].c": number }>();
        expect(r.buildVarId("a[].b[].c", ["1", "2"])).toEqual("a.1.b.2.c");
    });
    it("build err", () => {
        const r = new Registry<{ "a[].b[].c": number }>();
        expect(r.buildVarId("a[].b[].c", ["1"])).toEqual("a[].b[].c");
    });
    it("build err2", () => {
        const r = new Registry<{ "a[].b[].c": number }>();
        expect(r.buildVarId("a[].b[].c", [])).toEqual("a[].b[].c");
    });
});
