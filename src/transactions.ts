import { DatabaseError } from "olmdb";
import * as olmdb from "olmdb";
import { Model, MODIFIED_INSTANCES_SYMBOL } from "./models.js";

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
 * @template T - The return type of the transaction function
 * @param fn - The function to execute within the transaction context
 * @returns A promise that resolves with the function's return value
 * @throws {TypeError} If nested transactions are attempted
 * @throws {DatabaseError} With code "RACING_TRANSACTION" if the transaction fails after retries due to conflicts
 * @throws {DatabaseError} With code "TRANSACTION_FAILED" if the transaction fails for other reasons
 * @throws {DatabaseError} With code "TXN_LIMIT" if maximum number of transactions is reached
 * @throws {DatabaseError} With code "LMDB-{code}" for LMDB-specific errors
 * 
 * @example
 * ```typescript
 * const result = await transact(() => {
 *   const user = User.load("john_doe");
 *   user.credits--;
 *   user.save();
 *   return user.credits;
 * });
 * ```
 * 
 * @example
 * ```typescript
 * // Transaction with automatic retry on conflicts
 * await transact(() => {
 *   const counter = Counter.load("global") || new Counter({id: "global", value: 0});
 *   counter.value++;
 *   counter.save();
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
                    instance.save();
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

/**
 * Initialize the database with the specified path.
 * Must be called before any database operations.
 * 
 * @param path - The filesystem path where the database should be stored
 * @throws {DatabaseError} With code "DUP_INIT" if already initialized
 * 
 * @example
 * ```typescript
 * init("./my-database");
 * ```
 */
export const init = olmdb.init;

/**
 * Register a callback to be executed when a transaction commits successfully.
 * 
 * @param callback - Function to execute on commit
 * 
 * @example
 * ```typescript
 * onCommit(() => {
 *   console.log("Transaction committed successfully");
 *   // Send notifications, update caches, etc.
 * });
 * ```
 */
export const onCommit = olmdb.onCommit;

/**
 * Register a callback to be executed when a transaction is reverted.
 * 
 * @param callback - Function to execute on revert
 * 
 * @example
 * ```typescript
 * onRevert(() => {
 *   console.log("Transaction was reverted");
 *   // Clean up temporary state, etc.
 * });
 * ```
 */
export const onRevert = olmdb.onRevert;

/**
 * Get transaction-specific data that was previously set.
 * 
 * @param key - The key to retrieve data for
 * @returns The stored data or undefined if not found
 * 
 * @example
 * ```typescript
 * const userId = getTransactionData("currentUserId");
 * ```
 */
export const getTransactionData = olmdb.getTransactionData;

/**
 * Set transaction-specific data that persists for the duration of the transaction.
 * 
 * @param key - The key to store data under
 * @param value - The data to store
 * 
 * @example
 * ```typescript
 * setTransactionData("currentUserId", "user123");
 * ```
 */
export const setTransactionData = olmdb.setTransactionData;

// Re-export DatabaseError
export { DatabaseError };
