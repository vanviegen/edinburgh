import * as olmdb from "olmdb";
import { Model, MODIFIED_INSTANCES_SYMBOL, resetModelCaches } from "./models.js";

// Re-export public API from models
export {
    Model,
    registerModel,
    field,
} from "./models.js";


// Re-export public API from types (only factory functions and instances)
export {
    // Pre-defined type instances
    string,
    number,
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
*   const user = User.load("john_doe");
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
export function transact<T>(fn: () => T): Promise<T> {
    return olmdb.transact(() => {
        const modifiedInstances = new Set<Model<any>>();
        olmdb.setTransactionData(MODIFIED_INSTANCES_SYMBOL, modifiedInstances);
        
        const savedInstances: Set<Model<any>> = new Set();
        try {
            const result = fn();
            // Save all modified instances before committing.
            while(modifiedInstances.size > 0) {
                // Back referencing can cause models to be scheduled for save() a second time,
                // which is why we require the outer loop.
                for (const instance of modifiedInstances) {
                    instance._save();
                    savedInstances.add(instance);
                    modifiedInstances.delete(instance);
                }
            }
            
            return result;
        } catch (error) {
            // Discard changes on all saved and still unsaved instances
            for (const instance of savedInstances) instance.preventPersist();
            for (const instance of modifiedInstances) instance.preventPersist();
            throw error;
        }
    });
}

export async function deleteEverything(): Promise<void> {
    await olmdb.transact(() => {
        for (const {key} of olmdb.scan()) {
            olmdb.del(key);
        }
    });
    await resetModelCaches();
}
