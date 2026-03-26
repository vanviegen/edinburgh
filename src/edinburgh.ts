import * as lowlevel from "olmdb/lowlevel";
import { init as olmdbInit, DatabaseError } from "olmdb/lowlevel";
import { modelsNeedingDelayedInit, modelRegistry, txnStorage, currentTxn } from "./models.js";

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

export {
    setLogLevel
} from "./utils.js";

export { BaseIndex, UniqueIndex, PrimaryIndex } from './indexes.js';

export type { Transaction } from './models.js';
export { DatabaseError } from "olmdb/lowlevel";

let olmdbReady = false;

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
    while (modelsNeedingDelayedInit.size) {
        // Make sure only one async task is doing the inits, the rest should wait for it
        if (pendingInit) {
            await pendingInit;
        } else {
            pendingInit = (async () => {
                if (!olmdbReady) olmdbInit('.edinburgh');
                olmdbReady = true;

                for (const model of modelsNeedingDelayedInit) {
                    await model._delayedInit();
                    modelsNeedingDelayedInit.delete(model);
                }
                pendingInit = undefined;
            })();
        }
    }

    try {
        for (let retryCount = 0; ; retryCount++) {
            const txnId = lowlevel.startTransaction();
            const txn: Transaction = { id: txnId, instances: new Set(), instancesByPk: new Map() };
            const onSaveQueue: Map<Model<unknown>, Change> | undefined = onSaveCallback ? new Map() : undefined;

            try {
                const result = await txnStorage.run(txn, fn);

                // Save all modified instances before committing
                for (const instance of txn.instances) {
                    const change = instance._write(txn);
                    if (onSaveQueue && change) {
                        onSaveQueue.set(instance, change);
                    }
                }

                const commitResult = lowlevel.commitTransaction(txnId);
                const commitSeq = typeof commitResult === 'number' ? commitResult : await commitResult;

                if (commitSeq > 0) {
                    // Success
                    closeTransaction(txn);
                    if (onSaveQueue?.size) {
                        onSaveCallback!(commitSeq, onSaveQueue);
                    }
                    return result;
                } else {
                    // Race condition - retry
                    closeTransaction(txn);
                    if (retryCount >= 6) {
                        throw new DatabaseError("Transaction keeps getting raced", "RACING_TRANSACTION");
                    }
                    continue;
                }
            } catch (e: any) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                closeTransaction(txn);
                throw e;
            }
        }
    } catch (e: Error | any) {
        // This hackery is required to provide useful stack traces.
        const callerStack = new Error().stack?.replace(/^.*?\n/, '');
        e.stack += "\nat async:\n" + callerStack;
        throw e;
    }
}

function closeTransaction(txn: Transaction) {
    // Reset instances back to uninitialized lazy-loading state, so if they get recycled in
    // another transaction, they will be reloaded there.
    for (const instance of txn.instances) {
        Object.defineProperties(instance, instance.constructor._primary._lazyDescriptors);
        instance._oldValues = {};
    }
    // Destroy the transaction object, to make sure things crash if they are used after
    // this point, and to help the GC reclaim memory.
    txn.id = txn.instances = txn.instancesByPk = undefined as any;
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
    await transact(() => {
        const txn = currentTxn();
        const iteratorId = lowlevel.createIterator(txn.id, undefined, undefined, false);
        try {
            while (true) {
                const raw = lowlevel.readIterator(iteratorId);
                if (!raw) break;
                lowlevel.del(txn.id, raw.key);
            }
        } finally {
            lowlevel.closeIterator(iteratorId);
        }
    });
    // Re-assign index IDs since metadata was deleted
    for (const model of Object.values(modelRegistry)) {
        if (modelsNeedingDelayedInit.has(model)) continue; // Will be done in the pendingInit loop in transact()
        await model._primary._retrieveIndexId();
        for (const sec of model._secondaries || []) await sec._retrieveIndexId();
    }
}
