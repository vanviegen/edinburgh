import * as lowlevel from "olmdb/lowlevel";
import { init as olmdbInit, DatabaseError } from "olmdb/lowlevel";
import { AsyncLocalStorage } from "node:async_hooks";
import { pendingModelInits } from "./models.js";


// Re-export public API from models
export {
    Model,
    type ModelClass,
    type AnyModelClass,
    type ModelBase,
    defineModel,
    deleteEverything,
    field,
} from "./models.js";

import type { Change, Model } from "./models.js";

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
    set,
    record,
    literal,
    link,
} from "./types.js";

// Re-export public API from indexes
export {
    dump,
} from "./indexes.js";

export type { FindOptions, IndexRangeIterator } from './indexes.js';

export { type Change } from './models.js';
export type { FieldConfig } from './models.js';
export { TypeWrapper } from './types.js';
export { DatabaseError } from "olmdb/lowlevel";
export { runMigration } from './migrate.js';
export type { MigrationOptions, MigrationResult } from './migrate.js';

export interface Transaction {
    id: number;
    instances: Map<number, Model<unknown>>; // pkHash => instance
}

export const txnStorage = new AsyncLocalStorage<Transaction>();

/**
 * Returns the current transaction from AsyncLocalStorage.
 * Throws if called outside a transact() callback.
 * @internal
 */
export function currentTxn(): Transaction {
    const txn = txnStorage.getStore();
    if (!txn) throw new DatabaseError("No active transaction. Operations must be performed within a transact() callback.", 'NO_TRANSACTION');
    return txn;
}

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
* @param fn The function to execute within the transaction context. Receives a Transaction instance.
* @returns A promise that resolves with the function's return value.
* @throws {DatabaseError} With code "RACING_TRANSACTION" if the transaction fails after retries due to conflicts.
* @throws {DatabaseError} With code "TXN_LIMIT" if maximum number of transactions is reached.
* @throws {DatabaseError} With code "LMDB-{code}" for LMDB-specific errors.
* 
* @example
* ```typescript
* const paid = await E.transact(() => {
*   const user = User.get("john_doe");
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
*   const counter = Counter.get("global") || new Counter({id: "global", value: 0});
*   counter.value++;
* });
* ```
*/
export async function transact<T>(fn: () => T): Promise<T> {
    while (pendingModelInits.size || pendingInit) {
        if (pendingInit) {
            await pendingInit;
        } else {
            pendingInit = (async () => {
                if (!olmdbReady) olmdbInit('.edinburgh');
                olmdbReady = true;
                const models = [...pendingModelInits];
                pendingModelInits.clear();
                for (const model of models) {
                    await model._initialize();
                }
            })();
            await pendingInit;
            pendingInit = undefined;
        }
    }

    // try {
        for (let retryCount = 0; retryCount < maxRetryCount; retryCount++) {
            const txnId = lowlevel.startTransaction();
            const txn: Transaction = { id: txnId, instances: new Map() };
            const onSaveItems: Map<Model<unknown>, Change> | undefined = onSaveCallback ? new Map() : undefined;

            let result: T | undefined;
            try {
                await txnStorage.run(txn, async function() {
                    result = await fn();

                    // Call preCommit() on all instances before writing.
                    // Note: Map iteration visits newly added items, so preCommit() creating
                    // new instances is handled correctly.
                    for (const instance of txn.instances.values()) {
                        if (instance._oldValues !== false) instance.preCommit?.();
                    }

                    // Save all modified instances before committing
                    // This needs to happen inside txnStorage.run, because resolving default values
                    // for identifiers requires database access.
                    for (const instance of txn.instances.values()) {
                        const change = instance._write(txn);
                        if (onSaveItems && change) {
                            onSaveItems.set(instance, change);
                        }
                    }
                });
            } catch (e: any) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                throw e;
            }

            if (onSaveItems?.size) {
                // Perform writes, and start a new transaction at or past the point-in-time of our commit
                const commitResult = lowlevel.commitTransaction(txnId, true);
                if (typeof commitResult === 'object') {
                    const commitSeq = await commitResult;
                    if (commitSeq <= 0) continue; // Race condition - retry
                    // Run the callback within our new transaction context, so it can fetch linked lazy fields if needed
                    onSaveCallback!(commitSeq, onSaveItems);
                }
                // else: only reads
            }

            // Make the instances read-only to make it clear that their transaction has ended.
            for (const instance of txn.instances.values()) {
                delete instance._oldValues;
                Object.defineProperty(instance, "_txn", STALE_INSTANCE_DESCRIPTOR);
                Object.freeze(instance);
            }

            // Destroy the transaction object, to make sure things crash if they are used after
            // this point, and to help the GC reclaim memory.
            txn.id = txn.instances = undefined as any;


            // Commit the transaction and actually end it
            if ((await lowlevel.commitTransaction(txnId)) <= 0) continue; // Race condition - retry

            return result as T;
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

let onSaveCallback: ((commitId: number, items: Map<Model<unknown>, Change>) => void) | undefined;
 
/**
 * Set a callback function to be called after a model is saved and committed.
 *
 * @param callback The callback function to set. It gets called after each successful
 * `transact()` commit that has changes, with the following arguments:
 *   - A sequential number. Higher numbers have been committed after lower numbers.
 *   - A map of model instances to their changes. The change can be "created", "deleted", or an object containing the old values.
 * 
 * The callback is called within a new transaction context, allowing lazy-loads to happen. However, any
 * changes made to Edinburgh models will not be saved.
 */
export function setOnSaveCallback(callback: ((commitId: number, items: Map<Model<unknown>, Change>) => void) | undefined) {
    onSaveCallback = callback;
}
