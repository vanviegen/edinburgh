import { DatabaseError } from "olmdb";

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

/**
 * Global log level for debugging output.
 * 0 = no logging, 1 = model-level logs, 2 = update logs, 3 = read logs.
 */
export let logLevel = 0;

/** @internal Symbol used to access the underlying model from a proxy */
export declare const TARGET_SYMBOL: unique symbol;

export const delayedInits = new Set<{_delayedInit: () => boolean}>();
let tryingDelayedInits = false;

export function tryDelayedInits() {
    if (tryingDelayedInits) return;
    tryingDelayedInits = true;
    let progress = true;
    while(progress) {
        progress = false;
        for(const target of delayedInits) {
            try {
                if (target._delayedInit()) {
                    delayedInits.delete(target);
                    progress = true;
                }
            } catch(e) {
                console.error("Error during delayed init:", e);
            }
        }
    }
    tryingDelayedInits = false;
}
