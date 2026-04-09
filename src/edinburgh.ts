import * as lowlevel from "olmdb/lowlevel";
import { init as olmdbInit, DatabaseError } from "olmdb/lowlevel";
import { modelRegistry, txnStorage, currentTxn } from "./models.js";

let initNeeded = true;
export function scheduleInit() { initNeeded = true; }


// Re-export public API from models
export {
    Model,
    registerModel,
    field,
} from "./models.js";

import type { Transaction, Change, Model } from "./models.js";

// Re-export public API from types (only factory functions and instances)
export {
    // Pre-defined type instances
    string,
    orderedString,
    number,
    dateTime,
    boolean,
    identifier,
    undef,
    // Type factory functions
    opt,
    or,
    array,
    literal,
    link,
} from "./types.js";

// Re-export public API from indexes
export {
    index,
    primary,
    unique,
    dump,
} from "./indexes.js";

export { BaseIndex, UniqueIndex, PrimaryIndex, SecondaryIndex } from './indexes.js';

export { type Change } from './models.js';
export type { Transaction } from './models.js';
export { DatabaseError } from "olmdb/lowlevel";
export { runMigration } from './migrate.js';
export type { MigrationOptions, MigrationResult } from './migrate.js';

let olmdbReady = false;
let maxRetryCount = 6;

/**
 * Initialize the database with the specified directory path.
 * This function may be called multiple times with the same parameters. If it is not called before the first transact(),
 * the database will be automatically initialized with the default directory.
 * 
 * @example
 * ```typescript
 * init("./my-database");
 * ```
 */
export function init(dbDir: string): void {
    olmdbReady = true;
    olmdbInit(dbDir);
}

let pendingInit: Promise<void> | undefined;


const STALE_INSTANCE_DESCRIPTOR = {
    get() {
        throw new DatabaseError("The transaction for this model instance has ended", "STALE_INSTANCE");
    },
};

/**
* Executes a function within a database transaction context.
* 
* Loading models (also through links in other models) and changing models can only be done from
* within a transaction.
* 
* Transactions have a consistent view of the database, and changes made within a transaction are
* isolated from other transactions until they are committed. In case a commit clashes with changes
* made by another transaction, the transaction function will automatically be re-executed up to 6
* times.
* 
* @template T - The return type of the transaction function.
* @param fn - The function to execute within the transaction context. Receives a Transaction instance.
* @returns A promise that resolves with the function's return value.
* @throws {DatabaseError} With code "RACING_TRANSACTION" if the transaction fails after retries due to conflicts.
* @throws {DatabaseError} With code "TXN_LIMIT" if maximum number of transactions is reached.
* @throws {DatabaseError} With code "LMDB-{code}" for LMDB-specific errors.
* 
* @example
* ```typescript
* const paid = await E.transact(() => {
*   const user = User.pk.get("john_doe");
*   if (user.credits > 0) {
*     user.credits--;
*     return true;
*   }
*   return false;
* });
* ```
* ```typescript
* // Transaction with automatic retry on conflicts
* await E.transact(() => {
*   const counter = Counter.pk.get("global") || new Counter({id: "global", value: 0});
*   counter.value++;
* });
* ```
*/
export async function transact<T>(fn: () => T): Promise<T> {
    while (initNeeded || pendingInit) {
        // Make sure only one async task is doing the inits, the rest should wait for it
        if (pendingInit) {
            await pendingInit;
        } else {
            pendingInit = (async () => {
                if (!olmdbReady) olmdbInit('.edinburgh');
                olmdbReady = true;
                initNeeded = false;
                for (const model of Object.values(modelRegistry)) {
                    await model._delayedInit();
                }
            })();
            await pendingInit;
            pendingInit = undefined;
        }
    }

    // try {
        for (let retryCount = 0; retryCount < maxRetryCount; retryCount++) {
            const txnId = lowlevel.startTransaction();
            const txn: Transaction = { id: txnId, instances: new Set(), instancesByPk: new Map() };
            const onSaveItems: Map<Model<unknown>, Change> | undefined = onSaveCallback ? new Map() : undefined;

            let result: T | undefined;
            try {
                await txnStorage.run(txn, async function() {
                    result = await fn();

                    // Call preCommit() on all instances before writing.
                    // Note: Set iteration visits newly added items, so preCommit() creating
                    // new instances is handled correctly.
                    for (const instance of txn.instances) {
                        instance.preCommit?.();
                    }

                    // Save all modified instances before committing
                    // This needs to happen inside txnStorage.run, because resolving default values
                    // for identifiers requires database access.
                    for (const instance of txn.instances) {
                        const change = instance._write(txn);
                        if (onSaveItems && change) {
                            onSaveItems.set(instance, change);
                        }
                    }
                });
            } catch (e: any) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                throw e;
            } finally {
                // Make the instances read-only to make it clear that their transaction has ended.
                for (const instance of txn.instances) {
                    delete instance._oldValues;
                    Object.defineProperty(instance, "_txn", STALE_INSTANCE_DESCRIPTOR);
                    Object.freeze(instance);
                }
                // Destroy the transaction object, to make sure things crash if they are used after
                // this point, and to help the GC reclaim memory.
                txn.id = txn.instances = txn.instancesByPk = undefined as any;
            }

            const commitResult = lowlevel.commitTransaction(txnId);
            const commitSeq = typeof commitResult === 'number' ? commitResult : await commitResult;

            if (commitSeq > 0) {
                // Success
                if (onSaveItems?.size) {
                    onSaveCallback!(commitSeq, onSaveItems);
                }
                return result as T;
            }

            // Race condition - retry
        }
        throw new DatabaseError("Transaction keeps getting raced", "RACING_TRANSACTION");
    // } catch (e: Error | any) {
    //     // This hackery is required to provide useful stack traces.
    //     const callerStack = new Error().stack?.replace(/^.*?\n/, '');
    //     e.stack += "\nat async:\n" + callerStack;
    //     throw e;
    // }
}

/**
 * Set the maximum number of retries for a transaction in case of conflicts.
 * The default value is 6. Setting it to 0 will disable retries and cause transactions to fail immediately on conflict.
 *
 * @param count The maximum number of retries for a transaction.
 */
export function setMaxRetryCount(count: number) {
    maxRetryCount = count;
}

let onSaveCallback: ((commitId: number, items: Map<Model<any>, Change>) => void) | undefined;
 
/**
 * Set a callback function to be called after a model is saved and committed.
 *
 * @param callback The callback function to set. It gets called after each successful
 * `transact()` commit that has changes, with the following arguments:
 *   - A sequential number. Higher numbers have been committed after lower numbers.
 *   - A map of model instances to their changes. The change can be "created", "deleted", or an object containing the old values.
 */
export function setOnSaveCallback(callback: ((commitId: number, items: Map<Model<any>, Change>) => void) | undefined) {
    onSaveCallback = callback;
}


export async function deleteEverything(): Promise<void> {
    let done = false;
    while (!done) {
        await transact(() => {
            const txn = currentTxn();
            const iteratorId = lowlevel.createIterator(txn.id, undefined, undefined, false);
            const deadline = Date.now() + 150;
            let count = 0;
            try {
                while (true) {
                    const raw = lowlevel.readIterator(iteratorId);
                    if (!raw) { done = true; break; }
                    lowlevel.del(txn.id, raw.key);
                    if (++count >= 4096 || Date.now() >= deadline) break;
                }
            } finally {
                lowlevel.closeIterator(iteratorId);
            }
        });
    }
    // Re-init indexes since metadata was deleted
    for (const model of Object.values(modelRegistry)) {
        if (!model.fields) continue;
        await model._delayedInit(true);
    }
}
