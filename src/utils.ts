import * as lowlevel from "olmdb/lowlevel";

/**
 * Assert function for runtime checks with TypeScript assertion support.
 * @param cond - Condition to check.
 * @param message - Optional error message.
 * @throws {Error} If condition is false.
 */
export function assert(cond: any, message?: string): asserts cond {
    if (!cond) {
        throw new Error(message || "Assertion failed");
    }
}

export function toBuffer(data: Uint8Array): ArrayBufferLike {
    const b = data.buffer;
    return b.byteLength === data.byteLength ? b : b.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

export function hashBytes(data: Uint8Array): number {
    let a = 0x811C9DC5, b = 0x811C9DC5;
    for (const ch of data) {
        a = Math.imul(a ^ ch, 0x517CC1B7) >>> 0;
        b = Math.imul(b ^ ch, 0x27220A95) >>> 0;
    }
    return a + ((b & 0x1FFFFF) * 0x100000000);
}

export function hashFunction(fn: Function): number {
    return hashBytes(new TextEncoder().encode(fn.toString().replace(/\s\s+/g, ' ').trim()));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function dbGet(txnId: number, key: Uint8Array): Uint8Array | undefined {
    const result = lowlevel.get(txnId, toBuffer(key));
    return result ? new Uint8Array(result) : undefined;
}

export function dbPut(txnId: number, key: Uint8Array, value: Uint8Array): void {
    lowlevel.put(txnId, toBuffer(key), toBuffer(value));
}

export function dbDel(txnId: number, key: Uint8Array): void {
    lowlevel.del(txnId, toBuffer(key));
}

/**
 * Regular expression for parsing error messages with paths.
 */
export const ERROR_AT = /^(.*) at ([a-zA-Z0-9_.]+)$/;

/**
 * Add a path segment to an exception for better error reporting.
 * @param error - The (Database)Error to modify.
 * @param path - The path segment to add (string or number).
 * @returns The modified DatabaseError.
 */
export function addErrorPath<T>(error: T, path: string | number): T {
    if (error instanceof Error) {
        const m = error.message.match(ERROR_AT);
        error.message = m ? `${m[1]} at ${path}.${m[2]}` : `${error.message} at ${path}`;
    }
    return error;
}

// Get log level from environment variable
// 0: no logging (default), 1: model-level logs, 2: add update logs, 3: add read logs
export const logLevel = parseInt(process.env.EDINBURGH_LOG_LEVEL || "0") || 0;

/** @internal Symbol used to access the underlying model from a proxy */
export declare const TARGET_SYMBOL: unique symbol;

