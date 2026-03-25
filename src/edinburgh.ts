import * as olmdb from "olmdb";
import { Model, INSTANCES_SYMBOL, resetModelCaches } from "./models.js";
import { INSTANCES_BY_PK_SYMBOL } from "./indexes.js";

// Re-export public API from models
export {
    Model,
    registerModel,
    field,
} from "./models.js";

import type { ChangedModel } from "./models.js";

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

// Re-export from OLMDB
export { init, onCommit, onRevert, getTransactionData, setTransactionData, DatabaseError } from "olmdb";

/**
* Executes a function within a database transaction context.
* 
* Loading models (also through links in other models) and changing models can only be done from
* within a transaction.
* 
* Transactions have a consistent view of the database, and changes made within a transaction are
* isolated from other transactions until they are committed. In case a commit clashes with changes
* made by another transaction, the transaction function will automatically be re-executed up to 10
* times.
* 
* @template T - The return type of the transaction function.
* @param fn - The function to execute within the transaction context.
* @returns A promise that resolves with the function's return value.
* @throws {TypeError} If nested transactions are attempted.
* @throws {DatabaseError} With code "RACING_TRANSACTION" if the transaction fails after retries due to conflicts.
* @throws {DatabaseError} With code "TRANSACTION_FAILED" if the transaction fails for other reasons.
* @throws {DatabaseError} With code "TXN_LIMIT" if maximum number of transactions is reached.
* @throws {DatabaseError} With code "LMDB-{code}" for LMDB-specific errors.
* 
* @example
* ```typescript
* const paid = await E.transact(() => {
*   const user = User.pk.get("john_doe");
*   // This is concurrency-safe - the function will rerun if it is raced by another transaction
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
*   const counter = Counter.load("global") || new Counter({id: "global", value: 0});
*   counter.value++;
* });
* ```
*/
export async function transact<T>(fn: () => T): Promise<T> {
    const instances: Set<Model<any>> = new Set();
    const onSaveQueue: ChangedModel[] | undefined = onSaveCallback ? [] : undefined;
    console.log('transact', onSaveCallback ? 'with onSaveCallback' : 'without onSaveCallback');

    let result!: T;
    try {
        const commitSeq = await olmdb.transact(async () => {
            // In case of a retry, we'll want to clear these collections
            for(const instance of instances) Object.freeze(instance);
            instances.clear();
            if (onSaveQueue) onSaveQueue.length = 0;

            // Set async-task-local storage for this transaction
            olmdb.setTransactionData(INSTANCES_SYMBOL, instances);
            olmdb.setTransactionData(INSTANCES_BY_PK_SYMBOL, new Map());
            
            // Execute the user function
            result = await fn();

            // Save all modified instances before committing.
            for (const instance of instances) {
                console.log('Saving instance', instance);
                instance._preCommit(onSaveQueue);
            }

            // Instruct OLMDB to return the commit sequence number
            return olmdb.RETURN_COMMIT_SEQ;
        });

        // After a successful commit, call the onSaveCallback if anything was changed
        console.log('Transaction committed with commitSeq', commitSeq, onSaveQueue);
        if (onSaveCallback && onSaveQueue?.length) {
            onSaveCallback(commitSeq, onSaveQueue);
        }

        return result;
    } catch (e: Error | any) {
        // This hackery is required to provide useful stack traces. Without this,
        // both Bun and Node (even with --async-stack-traces) don't show which
        // line called the transact(), which is pretty important info when validation
        // fails, for instance. Though the line numbers in Bun still don't really
        // make sense. Probably this bug: https://github.com/oven-sh/bun/issues/15859
        e.stack += "\nat async:\n" + new Error().stack?.replace(/^.*?\n/, '');
        throw e;
    } finally {
        for (const instance of instances) {
            Object.freeze(instance);
        }
        instances.clear();
    }
}

let onSaveCallback: ((commitId: number, items: ChangedModel[]) => void) | undefined;

/**
 * Set a callback function to be called after a model is saved and committed.
 *
 * @param callback The callback function to set. It gets called after each successful
 * `transact()` commit that has changes, with the following arguments:
 *   - A sequential number. Higher numbers have been committed after lower numbers.
 *   - An array of model instances that have been modified, created, or deleted.
 *     You can used its {@link Model.changed} property to figure out what changed.
 */
export function setOnSaveCallback(callback: ((commitId: number, items: ChangedModel[]) => void) | undefined) {
    onSaveCallback = callback;
}


export async function deleteEverything(): Promise<void> {
    await olmdb.transact(() => {
        for (const {key} of olmdb.scan()) {
            olmdb.del(key);
        }
    });
    await resetModelCaches();
}
