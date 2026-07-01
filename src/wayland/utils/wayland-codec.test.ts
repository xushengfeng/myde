import { describe, it, expect } from "vitest";
import { WaylandDecoder } from "./wayland-decoder";
import { WaylandEncoder } from "./wayland-encoder";
import type { WaylandObjectId } from "./wayland-binary";

function codecTest(write: (e: WaylandEncoder) => void, read: (d: WaylandDecoder) => void) {
    const encoder = new WaylandEncoder();
    encoder.writeHeader(1 as WaylandObjectId, 0);
    write(encoder);
    const { data, fds } = encoder.finalizeMessage();
    const decoder = new WaylandDecoder(data, fds);
    decoder.readHeader();
    read(decoder);
}

describe("Wayland codec", () => {
    describe("int", () => {
        it("positive", () => {
            codecTest(
                (e) => e.writeInt(12345),
                (d) => expect(d.readInt()).toBe(12345),
            );
        });

        it("negative", () => {
            codecTest(
                (e) => e.writeInt(-999),
                (d) => expect(d.readInt()).toBe(-999),
            );
        });

        it("zero", () => {
            codecTest(
                (e) => e.writeInt(0),
                (d) => expect(d.readInt()).toBe(0),
            );
        });

        it("max/min 32-bit", () => {
            codecTest(
                (e) => {
                    e.writeInt(2147483647);
                    e.writeInt(-2147483648);
                },
                (d) => {
                    expect(d.readInt()).toBe(2147483647);
                    expect(d.readInt()).toBe(-2147483648);
                },
            );
        });
    });

    describe("uint", () => {
        it("normal", () => {
            codecTest(
                (e) => e.writeUint(42),
                (d) => expect(d.readUint()).toBe(42),
            );
        });

        it("zero", () => {
            codecTest(
                (e) => e.writeUint(0),
                (d) => expect(d.readUint()).toBe(0),
            );
        });

        it("max 32-bit", () => {
            codecTest(
                (e) => e.writeUint(4294967295),
                (d) => expect(d.readUint()).toBe(4294967295),
            );
        });
    });

    describe("fixed", () => {
        it("integer value", () => {
            codecTest(
                (e) => e.writeFixed(5),
                (d) => expect(d.readFixed()).toBe(5),
            );
        });

        it("fractional value", () => {
            codecTest(
                (e) => e.writeFixed(3.14),
                (d) => {
                    const val = d.readFixed();
                    expect(Math.abs(val - 3.14)).toBeLessThan(0.001);
                },
            );
        });

        it("negative", () => {
            codecTest(
                (e) => e.writeFixed(-2.5),
                (d) => expect(d.readFixed()).toBe(-2.5),
            );
        });

        it("zero", () => {
            codecTest(
                (e) => e.writeFixed(0),
                (d) => expect(d.readFixed()).toBe(0),
            );
        });
    });

    describe("string", () => {
        it("normal", () => {
            codecTest(
                (e) => e.writeString("hello"),
                (d) => expect(d.readString()).toBe("hello"),
            );
        });

        it("empty string", () => {
            codecTest(
                (e) => e.writeString(""),
                (d) => expect(d.readString()).toBe(""),
            );
        });

        it("unicode", () => {
            codecTest(
                (e) => e.writeString("你好世界"),
                (d) => expect(d.readString()).toBe("你好世界"),
            );
        });

        it("non-aligned length", () => {
            codecTest(
                (e) => e.writeString("abc"),
                (d) => expect(d.readString()).toBe("abc"),
            );
        });

        it("already aligned length", () => {
            codecTest(
                (e) => e.writeString("abcd"),
                (d) => expect(d.readString()).toBe("abcd"),
            );
        });
    });

    describe("object", () => {
        it("normal", () => {
            codecTest(
                (e) => e.writeObject(42),
                (d) => expect(d.readObject()).toBe(42),
            );
        });

        it("zero", () => {
            codecTest(
                (e) => e.writeObject(0),
                (d) => expect(d.readObject()).toBe(0),
            );
        });
    });

    describe("new_id", () => {
        it("normal", () => {
            codecTest(
                (e) => e.writeNewId(100 as WaylandObjectId),
                (d) => expect(d.readNewId()).toBe(100),
            );
        });
    });

    describe("array", () => {
        it("empty", () => {
            codecTest(
                (e) => e.writeArray(new Uint8Array(0)),
                (d) => expect(new Uint8Array(d.readArray())).toEqual(new Uint8Array(0)),
            );
        });

        it("4-byte aligned", () => {
            const input = new Uint8Array([1, 2, 3, 4]);
            codecTest(
                (e) => e.writeArray(input),
                (d) => expect(new Uint8Array(d.readArray())).toEqual(input),
            );
        });

        it("non-aligned (5 bytes)", () => {
            const input = new Uint8Array([10, 20, 30, 40, 50]);
            codecTest(
                (e) => e.writeArray(input),
                (d) => expect(new Uint8Array(d.readArray())).toEqual(input),
            );
        });

        it("1 byte", () => {
            const input = new Uint8Array([0xff]);
            codecTest(
                (e) => e.writeArray(input),
                (d) => expect(new Uint8Array(d.readArray())).toEqual(input),
            );
        });

        it("7 bytes", () => {
            const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
            codecTest(
                (e) => e.writeArray(input),
                (d) => expect(new Uint8Array(d.readArray())).toEqual(input),
            );
        });

        it("large (256 bytes)", () => {
            const input = new Uint8Array(256);
            for (let i = 0; i < 256; i++) input[i] = i & 0xff;
            codecTest(
                (e) => e.writeArray(input),
                (d) => expect(new Uint8Array(d.readArray())).toEqual(input),
            );
        });
    });

    describe("fd", () => {
        it("reads fd from list", () => {
            const encoder = new WaylandEncoder();
            encoder.writeHeader(1 as WaylandObjectId, 0);
            encoder.addFileDescriptor(7);
            encoder.addFileDescriptor(8);
            const { data, fds } = encoder.finalizeMessage();
            const decoder = new WaylandDecoder(data, fds);
            decoder.readHeader();
            expect(decoder.readFileDescriptor()).toBe(7);
            expect(decoder.readFileDescriptor()).toBe(8);
        });

        it("returns null when no fds", () => {
            codecTest(
                () => {},
                (d) => expect(d.readFileDescriptor()).toBeNull(),
            );
        });
    });

    describe("mixed types", () => {
        it("int + uint + string", () => {
            codecTest(
                (e) => {
                    e.writeInt(-1);
                    e.writeUint(99);
                    e.writeString("test");
                },
                (d) => {
                    expect(d.readInt()).toBe(-1);
                    expect(d.readUint()).toBe(99);
                    expect(d.readString()).toBe("test");
                },
            );
        });

        it("all scalar types", () => {
            codecTest(
                (e) => {
                    e.writeInt(1);
                    e.writeUint(2);
                    e.writeFixed(3.5);
                    e.writeString("hello");
                    e.writeObject(5);
                    e.writeNewId(6 as WaylandObjectId);
                },
                (d) => {
                    expect(d.readInt()).toBe(1);
                    expect(d.readUint()).toBe(2);
                    expect(d.readFixed()).toBe(3.5);
                    expect(d.readString()).toBe("hello");
                    expect(d.readObject()).toBe(5);
                    expect(d.readNewId()).toBe(6);
                },
            );
        });

        it("array between scalars", () => {
            codecTest(
                (e) => {
                    e.writeInt(10);
                    e.writeArray(new Uint8Array([1, 2, 3]));
                    e.writeString("end");
                },
                (d) => {
                    expect(d.readInt()).toBe(10);
                    expect(new Uint8Array(d.readArray())).toEqual(new Uint8Array([1, 2, 3]));
                    expect(d.readString()).toBe("end");
                },
            );
        });

        it("string + array + uint", () => {
            codecTest(
                (e) => {
                    e.writeString("abc");
                    e.writeArray(new Uint8Array([9, 8]));
                    e.writeUint(77);
                },
                (d) => {
                    expect(d.readString()).toBe("abc");
                    expect(new Uint8Array(d.readArray())).toEqual(new Uint8Array([9, 8]));
                    expect(d.readUint()).toBe(77);
                },
            );
        });

        it("repeated same type", () => {
            codecTest(
                (e) => {
                    e.writeInt(1);
                    e.writeInt(2);
                    e.writeInt(3);
                },
                (d) => {
                    expect(d.readInt()).toBe(1);
                    expect(d.readInt()).toBe(2);
                    expect(d.readInt()).toBe(3);
                },
            );
        });

        it("fixed precision boundary", () => {
            codecTest(
                (e) => {
                    e.writeFixed(0.0001);
                    e.writeFixed(1000.999);
                },
                (d) => {
                    expect(Math.abs(d.readFixed() - 0.0001)).toBeLessThan(0.001);
                    expect(Math.abs(d.readFixed() - 1000.999)).toBeLessThan(0.001);
                },
            );
        });
    });
});
