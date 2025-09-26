import { DataPack } from "../src/datapack.js";
import { expect, test, describe } from "vitest";

describe('constructor', () => {
    test('should create empty packs', () => {
        const pack = new DataPack();
        expect(pack._buffer).toBeInstanceOf(Uint8Array);
        expect(pack.readPos).toBe(0);
        expect(pack.writePos).toBe(0);
    });

    test('should create buffer with specified size', () => {
        const pack = new DataPack(100);
        expect(pack._buffer.length).toBe(100);
    });

    test('should initialize with provided buffer', () => {
        const data = new Uint8Array([1, 2, 3, 4]);
        const pack = new DataPack(data);
        expect(pack._buffer).toBe(data);
        expect(pack.writePos).toBe(4);
    });
});

describe('basic write/read operations', () => {
    test('should write and read numbers', () => {
        const pack = new DataPack();
        pack.write(42);
        pack.write(-123);
        pack.write(3.14);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(result.read()).toBe(42);
        expect(result.read()).toBe(-123);
        expect(result.read()).toBe(3.14);
    });

    test('should write and read strings', () => {
        const pack = new DataPack();
        pack.write("Hello");
        pack.write("World");
        pack.write("");
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(result.read()).toBe("Hello");
        expect(result.read()).toBe("World");
        expect(result.read()).toBe("");
    });

    test('should write and read booleans', () => {
        const pack = new DataPack();
        pack.write(true);
        pack.write(false);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(result.read()).toBe(true);
        expect(result.read()).toBe(false);
    });

    test('should write and read null and undefined', () => {
        const pack = new DataPack();
        pack.write(null);
        pack.write(undefined);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(result.read()).toBe(null);
        expect(result.read()).toBe(undefined);
    });

    test('should write and read Uint8Arrays', () => {
        const pack = new DataPack();
        const data1 = new Uint8Array([1, 2, 3]);
        const data2 = new Uint8Array([4, 5, 6, 7]);
        
        pack.write(data1);
        pack.write(data2);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        const read1 = result.read();
        const read2 = result.read();
        
        expect(read1).toBeInstanceOf(Uint8Array);
        expect(read2).toBeInstanceOf(Uint8Array);
        expect(Array.from(read1)).toEqual([1, 2, 3]);
        expect(Array.from(read2)).toEqual([4, 5, 6, 7]);
    });
});

describe('complex data types', () => {
    test('should write and read arrays', () => {
        const pack = new DataPack();
        const arr = [1, "hello", true, null];
        
        pack.write(arr);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        const readArr = result.read();
        
        expect(readArr).toEqual(arr);
    });

    test('should write and read objects', () => {
        const pack = new DataPack();
        const obj = { name: "test", value: 42, active: true };
        
        pack.write(obj);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        const readObj = result.read();
        
        expect(readObj).toEqual(obj);
    });

    test('should write and read Maps', () => {
        const pack = new DataPack();
        const map = new Map<string, any>([["key1", "value1"], ["key2", 42]]);
        
        pack.write(map);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        const readMap = result.read();
        
        expect(readMap).toBeInstanceOf(Map);
        expect(readMap.get("key1")).toBe("value1");
        expect(readMap.get("key2")).toBe(42);
    });

    test('should write and read Sets', () => {
        const pack = new DataPack();
        const set = new Set([1, "hello", true]);
        
        pack.write(set);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        const readSet = result.read();
        
        expect(readSet).toBeInstanceOf(Set);
        expect(readSet.has(1)).toBe(true);
        expect(readSet.has("hello")).toBe(true);
        expect(readSet.has(true)).toBe(true);
        expect(readSet.size).toBe(3);
    });

    test('should write and read Date objects', () => {
        const pack = new DataPack();
        const date = new Date("2024-01-01T12:13:14Z");
        pack.write(date);
        
        const readDate = pack.read();
        expect(readDate).toBeInstanceOf(Date);
        expect(readDate.toISOString()).toBe(date.toISOString());
    });
});

describe('identifier operations', () => {
    test('should write and read identifiers', () => {
        const pack = new DataPack();
        const id = "abc12345"; // 8 characters
        
        pack.writeIdentifier(id);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(result.read()).toBe(id);
    });

    test('should validate identifier length', () => {
        const pack = new DataPack();
        
        expect(() => pack.writeIdentifier("short")).toThrow();
        expect(() => pack.writeIdentifier("toolongstring")).toThrow();
    });

    test('should validate identifier characters', () => {
        const pack = new DataPack();
        
        expect(() => pack.writeIdentifier("invalid@")).toThrow();
        expect(() => pack.writeIdentifier("bad!char")).toThrow();
    });
});

describe('typed read methods', () => {
    test('should use typed read methods', () => {
        const pack = new DataPack();
        pack.write(42);
        pack.write("hello");
        pack.write(true);
        pack.write(new Uint8Array([1, 2, 3]));
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        
        expect(result.readNumber()).toBe(42);
        expect(result.readString()).toBe("hello");
        expect(result.readBoolean()).toBe(true);
        expect(Array.from(result.readUint8Array())).toEqual([1, 2, 3]);
    });

    test('should throw errors for wrong types', () => {
        const pack = new DataPack();
        pack.write("not a number");
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(() => result.readNumber()).toThrow('Expected number');
    });

    test('should validate positive integers', () => {
        const pack = new DataPack();
        pack.write(42);
        pack.write(-5);
        pack.write(3.14);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        
        expect(result.readPositiveInt()).toBe(42);
        expect(() => result.readPositiveInt()).toThrow('Expected positive integer');
        result.readNumber(); // Skip the float
        
        // Test with limit
        const pack2 = new DataPack();
        pack2.write(50);
        const result2 = new DataPack(pack2._buffer.slice(0, pack2.writePos));
        expect(() => result2.readPositiveInt(10)).toThrow('Expected positive integer < 10');
    });
});

describe('buffer management', () => {
    test('should manage buffer correctly', () => {
        const pack = new DataPack();
        
        // Write enough data to test buffer growth
        for (let i = 0; i < 100; i++) {
            pack.write(i);
        }
        
        expect(pack.writePos).toBeGreaterThan(0);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        for (let i = 0; i < 100; i++) {
            expect(result.read()).toBe(i);
        }
    });

    test('should handle toUint8Array', () => {
        const pack = new DataPack();
        pack.write("test");
        
        const buffer = pack.toUint8Array();
        expect(buffer).toBeInstanceOf(Uint8Array);
        expect(buffer.length).toBe(pack.writePos);
        
        // Test with custom range
        const partial = pack.toUint8Array(true, 0, 2);
        expect(partial.length).toBe(2);
    });

    test('should clone correctly', () => {
        const pack = new DataPack();
        pack.write("test");
        pack.write(42);
        
        const clone = pack.clone(true);
        expect(clone).not.toBe(pack);
        expect(clone._buffer).not.toBe(pack._buffer);
        
        expect(clone.read()).toBe("test");
        expect(clone.read()).toBe(42);
    });

    test('should increment buffer correctly', () => {
        const pack = new DataPack();
        pack.write(42); // This will write some pack
        
        const originalBuffer = pack.toUint8Array();
        const incremented = pack.increment();
        
        expect(incremented).toBe(pack);
        
        // Test edge case with all 255s
        const maxpack = new DataPack(new Uint8Array([255, 255]));
        maxpack.writePos = 2;
        const result = maxpack.increment();
        expect(result).toBeUndefined();
    });
});

describe('mixed data scenarios', () => {
    test('should handle complex nested data', () => {
        const pack = new DataPack();
        const complexData = {
            name: "test",
            values: [1, 2, 3],
            meta: {
                active: true,
                tags: new Set(["important", "test"])
            }
        };
        
        pack.write(complexData);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        const read = result.read();
        
        expect(read.name).toBe("test");
        expect(read.values).toEqual([1, 2, 3]);
        expect(read.meta.active).toBe(true);
        expect(read.meta.tags).toBeInstanceOf(Set);
        expect(read.meta.tags.has("important")).toBe(true);
    });

    test('should maintain data ordering', () => {
        const pack = new DataPack();
        const items = [
            42,
            "string",
            true,
            null,
            undefined,
            [1, 2, 3],
            { key: "value" }
        ];
        
        for (const item of items) {
            pack.write(item);
        }
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        
        expect(result.read()).toBe(42);
        expect(result.read()).toBe("string");
        expect(result.read()).toBe(true);
        expect(result.read()).toBe(null);
        expect(result.read()).toBe(undefined);
        expect(result.read()).toEqual([1, 2, 3]);
        expect(result.read()).toEqual({ key: "value" });
    });
});

describe('error handling', () => {
    test('should throw when reading past buffer', () => {
        const pack = new DataPack();
        pack.write(42);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        result.read(); // Read the number
        
        expect(() => result.read()).toThrow('Not enough data');
    });

    test('should handle unsupported data types', () => {
        const pack = new DataPack();
        class X {};
        const unsupported = new X();
        
        expect(() => pack.write(unsupported)).toThrow('Unsupported data type');
    });
});

describe('number encoding efficiency', () => {
    test('should efficiently encode small numbers', () => {
        const pack = new DataPack();
        
        // Small positive numbers (0-63) should be encoded in 1 byte
        pack.write(5);
        pack.write(63);
        expect(pack.writePos).toBe(2);
        
        pack.writePos = 0; // Reset

        // Negative integers are two pack
        pack.write(-5);
        expect(pack.writePos).toBe(2);
    });

    test('should handle large integers', () => {
        const pack = new DataPack();
        const largeNumbers = [
            1000,
            -1000,
            Math.pow(2, 20),
            -Math.pow(2, 20),
            Number.MAX_SAFE_INTEGER,
            Number.MIN_SAFE_INTEGER
        ];
        
        for (const num of largeNumbers) {
            pack.write(num);
        }
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        for (const expected of largeNumbers) {
            expect(result.read()).toBe(expected);
        }
    });

    test('should handle floating point numbers', () => {
        const pack = new DataPack();
        const floats = [3.14, -2.718, Math.PI, 123.456789, 0.000123456789];
        
        for (const f of floats) {
            pack.write(f);
        }
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        for (const expected of floats) {
            expect(result.read()).toBe(expected);
        }
    });

    test('should handle special numeric values', () => {
        const pack = new DataPack();
        pack.write(Number.POSITIVE_INFINITY);
        pack.write(Number.NEGATIVE_INFINITY);
        pack.write(NaN);
        
        const result = new DataPack(pack._buffer.slice(0, pack.writePos));
        expect(result.read()).toBe(Number.POSITIVE_INFINITY);
        expect(result.read()).toBe(Number.NEGATIVE_INFINITY);
        expect(Number.isNaN(result.read())).toBe(true);
    });
});
