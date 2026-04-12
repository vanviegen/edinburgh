import * as lowlevel from "olmdb/lowlevel";
import { DatabaseError } from "olmdb/lowlevel";
import DataPack from "./datapack.js";
import { FieldConfig, getMockModel, Model, Transaction, currentTxn } from "./models.js";
import { scheduleInit, transact } from "./edinburgh.js";
import { assert, logLevel, dbGet, dbPut, dbDel, hashBytes, hashFunction, bytesEqual, toBuffer } from "./utils.js";
import { deserializeType, serializeType, TypeWrapper } from "./types.js";

// Index system types and utilities
type IndexArgTypes<M extends typeof Model<any>, F extends readonly (keyof InstanceType<M> & string)[]> = {
    [I in keyof F]: InstanceType<M>[F[I]]
}

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;
const VERSION_INFO_PREFIX = -3;

const MAX_INDEX_ID_BUFFER = new DataPack().write(MAX_INDEX_ID_PREFIX).toUint8Array();

/** Cached information about a specific version of a primary index's value format. */
interface VersionInfo {
    migrateHash: number;
    /** Non-key field names → TypeWrappers for deserialization of this version's data. */
    nonKeyFields: Map<string, TypeWrapper<any>>;
    /** Set of serialized secondary index signatures that existed in this version. */
    secondaryKeys: Set<string>;
}

/**
 * Iterator for range queries on indexes.
 * Handles common iteration logic for both primary and unique indexes.
 * Implements both Iterator and Iterable interfaces for efficiency.
 */
export class IndexRangeIterator<M extends typeof Model> implements Iterator<InstanceType<M>>, Iterable<InstanceType<M>> {
    constructor(
        private txn: Transaction,
        private iteratorId: number,
        private indexId: number,
        private parentIndex: BaseIndex<M, any>
    ) {
    }

    [Symbol.iterator](): Iterator<InstanceType<M>> {
        return this;
    }

    next(): IteratorResult<InstanceType<M>> {
        if (this.iteratorId < 0) return { done: true, value: undefined };
        const raw = lowlevel.readIterator(this.iteratorId);
        if (!raw) {
            lowlevel.closeIterator(this.iteratorId);
            this.iteratorId = -1;
            return { done: true, value: undefined };
        }
        
        // Dispatches to the _pairToInstance specific to the index type
        const model = this.parentIndex._pairToInstance(this.txn, raw.key, raw.value);

        return { done: false, value: model };
    }

    count(): number {
        let result = 0;
        for (const _ of this) result++;
        return result;
    }

    fetch(): InstanceType<M> | undefined {
        for (const model of this) {
            return model; // Return the first model found
        }
    }
}

type ArrayOrOnlyItem<ARG_TYPES extends readonly any[]> = ARG_TYPES extends readonly [infer A] ? (A | Partial<ARG_TYPES>) : Partial<ARG_TYPES>;

type FindOptions<ARG_TYPES extends readonly any[]> = (
    (
        {is: ArrayOrOnlyItem<ARG_TYPES>;} // Shortcut for setting `from` and `to` to the same value
    |
        (
            (
                {from: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {after: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {}
            )
        &
            (
                {to: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {before: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {}
            )
        )
    ) &
    {
        reverse?: boolean;
    }
);


/**
 * Base class for database indexes for efficient lookups on model fields.
 * 
 * Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export abstract class BaseIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[], ARGS extends readonly any[] = IndexArgTypes<M, F>> {
    public _MyModel: M;
    public _fieldTypes: Map<keyof InstanceType<M> & string, TypeWrapper<any>> = new Map();
    public _fieldCount!: number;
    _resetIndexFieldDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    _computeFn?: (data: any) => any[];
    
    /**
     * Create a new index.
     * @param MyModel - The model class this index belongs to.
     * @param _fieldNames - Array of field names that make up this index.
     */
    constructor(MyModel: M, public _fieldNames: F) {
        this._MyModel = getMockModel(MyModel);
    }

    async _delayedInit() {
        if (this._indexId != null) return; // Already initialized
        if (this._computeFn) {
            this._fieldCount = 1;
        } else {
            for(const fieldName of this._fieldNames) {
                assert(typeof fieldName === 'string', 'Field names must be strings');
                this._fieldTypes.set(fieldName, this._MyModel.fields[fieldName].type);
            }
            this._fieldCount = this._fieldNames.length;
        }
        await this._retrieveIndexId();

        // Human-readable signature for version tracking, e.g. "secondary category:string"
        if (this._computeFn) {
            this._signature = this._getTypeName() + ' ' + hashFunction(this._computeFn);
        } else {
            this._signature = this._getTypeName() + ' ' +
                Array.from(this._fieldTypes.entries()).map(([n, t]) => n + ':' + t).join(' ');
        }

        for(const fieldName of this._fieldTypes.keys()) {
            this._resetIndexFieldDescriptors[fieldName] = {
                writable: true,
                configurable: true,
                enumerable: true
            };
        }
    }

    _indexId?: number;

    /** Human-readable signature for version tracking, e.g. "secondary category:string" */
    _signature?: string;

    /**
     * Serialize array of key values to a (index-id prefixed) Bytes instance that can be used as a key.
     * @param args - Field values to serialize (can be partial for range queries).
     * @returns A Bytes instance containing the index id and serialized key parts.
     * @internal
     */
    _argsToKeyBytes(args: [], allowPartial: boolean): DataPack;
    _argsToKeyBytes(args: Partial<ARGS>, allowPartial: boolean): DataPack;

    _argsToKeyBytes(args: any, allowPartial: boolean) {
        assert(allowPartial ? args.length <= this._fieldCount : args.length === this._fieldCount);
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        if (this._computeFn) {
            if (args.length > 0) bytes.write(args[0]);
        } else {
            let index = 0;
            for(const fieldType of this._fieldTypes.values()) {
                // For partial keys, undefined values are acceptable and represent open range suffixes
                if (index >= args.length) break;
                fieldType.serialize(args[index++], bytes);
            }
        }
        return bytes;
    }

    /**
     * Extract model from iterator entry - implemented differently by each index type.
     * @param keyBuffer - Key bytes (including index id).
     * @param valueBuffer - Value bytes from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    abstract _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, valueBuffer: ArrayBuffer): InstanceType<M>;

    _hasNullIndexValues(data: Record<string, any>) {
        assert(!this._computeFn);
        for(const fieldName of this._fieldTypes.keys()) {
            if (data[fieldName] == null) return true;
        }
        return false;
    }

    // Must return the exact key that will be used to write to the K/V store
    abstract _serializeKey(primaryKey: Uint8Array, data: Record<string, any>): Uint8Array;

    // Returns the indexId + serialized key fields. Used in some _serializeKey implementations
    // and for calculating _primaryKey.
    _serializeKeyFields(data: Record<string, any>): DataPack {
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        if (this._computeFn) {
            for (const v of this._computeFn(data)) bytes.write(v);
        } else {
            for(const [fieldName, fieldType] of this._fieldTypes.entries()) {
                fieldType.serialize(data[fieldName], bytes);
            }
        }
        return bytes;
    }

    /**
     * Retrieve (or create) a stable index ID from the DB, with retry on transaction races.
     * Sets `this._indexId` on success.
     */
    async _retrieveIndexId(): Promise<void> {
        const indexNameBytes = new DataPack().write(INDEX_ID_PREFIX).write(this._MyModel.tableName).write(this._getTypeName());
        if (this._computeFn) {
            indexNameBytes.write(hashFunction(this._computeFn));
        } else {
            for(let name of this._fieldNames) {
                indexNameBytes.write(name);
                serializeType(this._MyModel.fields[name].type, indexNameBytes);
            }
        }
        // For non-primary indexes, include primary key field info to avoid misinterpreting
        // values when the primary key schema changes.
        if (this._MyModel._primary !== (this as any)) {
            indexNameBytes.write(undefined); // separator
            for (const name of this._MyModel._primary._fieldNames) {
                indexNameBytes.write(name);
                serializeType(this._MyModel.fields[name].type, indexNameBytes);
            }
        }
        const indexNameBuf = indexNameBytes.toUint8Array();

        while (true) {
            const txnId = lowlevel.startTransaction();
            try {
                let result = dbGet(txnId, indexNameBuf);
                let id: number;
                if (result) {
                    id = new DataPack(result).readNumber();
                } else {
                    result = dbGet(txnId, MAX_INDEX_ID_BUFFER);
                    id = result ? new DataPack(result).readNumber() + 1 : 1;
                    const idBuf = new DataPack().write(id).toUint8Array();
                    dbPut(txnId, indexNameBuf, idBuf);
                    dbPut(txnId, MAX_INDEX_ID_BUFFER, idBuf);
                    if (logLevel >= 1) console.log(`[edinburgh] Create index ${this}`);
                }
                const commitResult = lowlevel.commitTransaction(txnId);
                const commitSeq = typeof commitResult === 'number' ? commitResult : await commitResult;
                if (commitSeq > 0) {
                    this._indexId = id;
                    return;
                }
            } catch (e) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                throw e;
            }
        }
    }


    abstract _delete(txn: Transaction, primaryKey: Uint8Array, model: InstanceType<M>): void;
    abstract _write(txn: Transaction, primaryKey: Uint8Array, model: InstanceType<M>): void;

    /**
     * Find model instances using flexible range query options.
     * 
     * Supports exact matches, inclusive/exclusive range queries, and reverse iteration.
     * For single-field indexes, you can pass values directly or in arrays.
     * For multi-field indexes, pass arrays or partial arrays for prefix matching.
     * 
     * @param opts - Query options object
     * @param opts.is - Exact match (sets both `from` and `to` to same value)
     * @param opts.from - Range start (inclusive)
     * @param opts.after - Range start (exclusive)
     * @param opts.to - Range end (inclusive)
     * @param opts.before - Range end (exclusive)
     * @param opts.reverse - Whether to iterate in reverse order
     * @returns An iterable of model instances matching the query
     * 
     * @example
     * ```typescript
     * // Exact match
     * for (const user of User.byEmail.find({is: "john@example.com"})) {
     *   console.log(user.name);
     * }
     * 
     * // Range query (inclusive)
     * for (const user of User.byEmail.find({from: "a@", to: "m@"})) {
     *   console.log(user.email);
     * }
     * 
     * // Range query (exclusive)
     * for (const user of User.byEmail.find({after: "a@", before: "m@"})) {
     *   console.log(user.email);
     * }
     * 
     * // Open-ended ranges
     * for (const user of User.byEmail.find({from: "m@"})) { // m@ and later
     *   console.log(user.email);
     * }
     * 
     * for (const user of User.byEmail.find({to: "m@"})) { // up to and including m@
     *   console.log(user.email);
     * }
     * 
     * // Reverse iteration
     * for (const user of User.byEmail.find({reverse: true})) {
     *   console.log(user.email); // Z to A order
     * }
     * 
     * // Multi-field index prefix matching
     * for (const item of CompositeModel.pk.find({from: ["electronics", "phones"]})) {
     *   console.log(item.name); // All electronics/phones items
     * }
     * 
     * // For single-field indexes, you can use the value directly
     * for (const user of User.byEmail.find({is: "john@example.com"})) {
     *   console.log(user.name);
     * }
     * ```
     */
    _computeKeyBounds(opts: FindOptions<ARGS>): [DataPack | undefined, DataPack | undefined] | null {
        let startKey: DataPack | undefined;
        let endKey: DataPack | undefined;
        if ('is' in opts) {
            startKey = this._argsToKeyBytes(toArray(opts.is), true);
            endKey = startKey.clone(true).increment();
        } else {
            if ('from' in opts) {
                startKey = this._argsToKeyBytes(toArray(opts.from), true);
            } else if ('after' in opts) {
                startKey = this._argsToKeyBytes(toArray(opts.after), true);
                if (!startKey.increment()) return null;
            } else {
                startKey = this._argsToKeyBytes([], true);
            }
            if ('to' in opts) {
                endKey = this._argsToKeyBytes(toArray(opts.to), true).increment();
            } else if ('before' in opts) {
                endKey = this._argsToKeyBytes(toArray(opts.before), true);
            } else {
                endKey = this._argsToKeyBytes([], true).increment();
            }
        }
        return [startKey, endKey];
    }

    public find(opts: FindOptions<ARGS> = {}): IndexRangeIterator<M> {
        const txn = currentTxn();
        const indexId = this._indexId!;

        const bounds = this._computeKeyBounds(opts);
        if (!bounds) return new IndexRangeIterator(txn, -1, indexId, this);
        const [startKey, endKey] = bounds;

        // For reverse scans, swap start/end keys since OLMDB expects it
        const scanStart = opts.reverse ? endKey : startKey;
        const scanEnd = opts.reverse ? startKey : endKey;

        if (logLevel >= 3) {
            console.log(`[edinburgh] Scan ${this} start=${scanStart} end=${scanEnd} reverse=${opts.reverse||false}`);
        }
        const startBuf = scanStart?.toUint8Array();
        const endBuf = scanEnd?.toUint8Array();
        const iteratorId = lowlevel.createIterator(
            txn.id,
            startBuf ? toBuffer(startBuf) : undefined,
            endBuf ? toBuffer(endBuf) : undefined,
            opts.reverse || false,
        );
        
        return new IndexRangeIterator(txn, iteratorId, indexId, this);
    }

    /**
     * Process all matching rows in batched transactions.
     *
     * Uses the same query options as {@link find}. The batch is committed and a new
     * transaction started once either `limitSeconds` or `limitRows` is exceeded.
     *
     * @param opts - Query options (same as `find()`), plus:
     * @param opts.limitSeconds - Max seconds per transaction batch (default: 1)
     * @param opts.limitRows - Max rows per transaction batch (default: 4096)
     * @param callback - Called for each matching row within a transaction
     */
    public async batchProcess(
        opts: FindOptions<ARGS> & { limitSeconds?: number; limitRows?: number } = {} as any,
        callback: (row: InstanceType<M>) => void | Promise<void>
    ): Promise<void> {
        const limitMs = (opts.limitSeconds ?? 1) * 1000;
        const limitRows = opts.limitRows ?? 4096;
        const reverse = opts.reverse ?? false;

        const bounds = this._computeKeyBounds(opts);
        if (!bounds) return;
        const startKey = bounds[0]?.toUint8Array();
        const endKey = bounds[1]?.toUint8Array();
        let cursor: Uint8Array | undefined;

        while (true) {
            const next = await transact(async (): Promise<Uint8Array | null> => {
                const txn = currentTxn();
                const batchStart = cursor && !reverse ? cursor : startKey;
                const batchEnd = cursor && reverse ? cursor : endKey;
                const scanStart = reverse ? batchEnd : batchStart;
                const scanEnd = reverse ? batchStart : batchEnd;

                const iteratorId = lowlevel.createIterator(
                    txn.id,
                    scanStart ? toBuffer(scanStart) : undefined,
                    scanEnd ? toBuffer(scanEnd) : undefined,
                    reverse,
                );

                const t0 = Date.now();
                let count = 0;
                let lastRawKey: Uint8Array | undefined;
                try {
                    while (true) {
                        const raw = lowlevel.readIterator(iteratorId);
                        if (!raw) return null;
                        lastRawKey = new Uint8Array(raw.key);
                        await callback(this._pairToInstance(txn, raw.key, raw.value));
                        if (++count >= limitRows || Date.now() - t0 >= limitMs) break;
                    }
                } finally {
                    lowlevel.closeIterator(iteratorId);
                }

                lastRawKey = lastRawKey.slice(); // Copy, as lastRawKey points at OLMDB's internal read-only mmap
                if (reverse) return lastRawKey!;
                const nk = new DataPack(lastRawKey!);
                return nk.increment() ? nk.toUint8Array() : null;
            });

            if (next === null) break;
            cursor = next;
        }
    }

    abstract _getTypeName(): string;

    toString() {
        return `${this._indexId}:${this._MyModel.tableName}:${this._getTypeName()}[${Array.from(this._fieldTypes.keys()).join(',')}]`;
    }
}

function toArray<ARG_TYPES extends readonly any[]>(args: ArrayOrOnlyItem<ARG_TYPES>): Partial<ARG_TYPES> {
    // Convert single value or array to array format compatible with Partial<ARG_TYPES>
    return (Array.isArray(args) ? args : [args]) as Partial<ARG_TYPES>;
}

/**
 * Primary index that stores the actual model data.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class PrimaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F, IndexArgTypes<M, F>> {

    _nonKeyFields!: (keyof InstanceType<M> & string)[];
    _lazyDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    _resetDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    _freezePrimaryKeyDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};

    /** Current version number for this primary index's value format. */
    _currentVersion!: number;
    /** Hash of the current migrate() function source, or 0 if none. */
    _currentMigrateHash!: number;
    /** Cached version info for old versions (loaded on demand). */
    _versions: Map<number, VersionInfo> = new Map();

    constructor(MyModel: M, fieldNames: F) {
        super(MyModel, fieldNames);
        if (MyModel._primary) {
            throw new DatabaseError(`There's already a primary index defined: ${MyModel._primary}. This error may also indicate that your tsconfig.json needs to have "target": "ES2022" set.`, 'INIT_ERROR');
        }
        MyModel._primary = this;
    }

    async _delayedInit() {
        if (this._indexId != null) return; // Already initialized
        await super._delayedInit();
        const MyModel = this._MyModel;
        this._nonKeyFields = Object.keys(MyModel.fields).filter(fieldName => !this._fieldNames.includes(fieldName as any)) as any;

        for(const fieldName of this._nonKeyFields) {
            this._lazyDescriptors[fieldName] = {
                configurable: true,
                enumerable: true,
                get(this: InstanceType<M>) {
                    this.constructor._primary._lazyNow(this);
                    return this[fieldName];
                },
                set(this: InstanceType<M>, value: any) {
                    this.constructor._primary._lazyNow(this);
                    this[fieldName] = value;
                }
            };
            this._resetDescriptors[fieldName] = {
                writable: true,
                enumerable: true
            };
        }

        for(const fieldName of this._fieldNames) {
            this._freezePrimaryKeyDescriptors[fieldName] = {
                writable: false,
                enumerable: true
            };
        }

    }

    /** Serialize the current version fingerprint as a DataPack object. */
    _serializeVersionValue(): Uint8Array {
        const fields: [string, Uint8Array][] = [];
        for (const fieldName of this._nonKeyFields) {
            const tp = new DataPack();
            serializeType(this._MyModel.fields[fieldName].type, tp);
            fields.push([fieldName, tp.toUint8Array()]);
        }
        return new DataPack().write({
            migrateHash: this._currentMigrateHash,
            fields,
            secondaryKeys: new Set((this._MyModel._secondaries || []).map(sec => sec._signature!)),
        }).toUint8Array();
    }

    /** Look up or create the current version number for this primary index. */
    async _initVersioning(): Promise<void> {
        // Compute migrate hash from function source
        const migrateFn = (this._MyModel as any)._original?.migrate ?? (this._MyModel as any).migrate;
        this._currentMigrateHash = migrateFn ? hashFunction(migrateFn) : 0;

        const currentValueBytes = this._serializeVersionValue();

        // Scan last 20 version info rows for this primary index
        const scanStart = new DataPack().write(VERSION_INFO_PREFIX).write(this._indexId!);
        const scanEnd = scanStart.clone(true).increment();

        while (true) {
            const txnId = lowlevel.startTransaction();
            try {
                const iteratorId = lowlevel.createIterator(
                    txnId,
                    scanEnd ? toBuffer(scanEnd.toUint8Array()) : undefined,
                    toBuffer(scanStart.toUint8Array()),
                    true // reverse - scan newest versions first
                );

                let count = 0;
                let maxVersion = 0;
                let found = false;

                try {
                    while (count < 20) {
                        const raw = lowlevel.readIterator(iteratorId);
                        if (!raw) break;
                        count++;

                        const keyPack = new DataPack(new Uint8Array(raw.key));
                        keyPack.readNumber(); // skip VERSION_INFO_PREFIX
                        keyPack.readNumber(); // skip indexId
                        const versionNum = keyPack.readNumber();
                        maxVersion = Math.max(maxVersion, versionNum);

                        const valueBytes = new Uint8Array(raw.value);
                        if (bytesEqual(valueBytes, currentValueBytes)) {
                            this._currentVersion = versionNum;
                            found = true;
                            break;
                        }
                    }
                } finally {
                    lowlevel.closeIterator(iteratorId);
                }

                if (found) {
                    lowlevel.abortTransaction(txnId);
                    return;
                }

                // No match found - create new version
                this._currentVersion = maxVersion + 1;
                const versionKey = new DataPack()
                    .write(VERSION_INFO_PREFIX)
                    .write(this._indexId!)
                    .write(this._currentVersion)
                    .toUint8Array();
                dbPut(txnId, versionKey, currentValueBytes);
                if (logLevel >= 1) console.log(`[edinburgh] Create version ${this._currentVersion} for ${this}`);

                const commitResult = lowlevel.commitTransaction(txnId);
                const commitSeq = typeof commitResult === 'number' ? commitResult : await commitResult;
                if (commitSeq > 0) return;
                // Race - retry
            } catch (e) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                throw e;
            }
        }
    }

    /**
     * Get a model instance by primary key values.
     * @param args - The primary key values.
     * @returns The model instance if found, undefined otherwise.
     * 
     * @example
     * ```typescript
     * const user = User.pk.get("john_doe");
     * ```
     */
    get(...args: IndexArgTypes<M, F>): InstanceType<M> | undefined {
        return this._get(currentTxn(), args, true);
    }

    /**
     * Does the same as as `get()`, but will delay loading the instance from disk until the first
     * property access. In case it turns out the instance doesn't exist, an error will be thrown
     * at that time.
     * @param args Primary key field values. (Or a single Uint8Array containing the key.)
     * @returns The (lazily loaded) model instance.
     */
    getLazy(...args: IndexArgTypes<M, F>): InstanceType<M> {
        return this._get(currentTxn(), args, false);
    }

    _get(txn: Transaction, args: IndexArgTypes<M, F> | Uint8Array, loadNow: false | Uint8Array): InstanceType<M>;
    _get(txn: Transaction, args: IndexArgTypes<M, F> | Uint8Array, loadNow: true): InstanceType<M> | undefined;
    _get(txn: Transaction, args: IndexArgTypes<M, F> | Uint8Array, loadNow: boolean | Uint8Array) {
        let key: Uint8Array, keyParts;
        if (args instanceof Uint8Array) {
            key = args;
        } else {
            key = this._argsToKeyBytes(args as IndexArgTypes<M, F>, false).toUint8Array();
            keyParts = args;
        }

        const keyHash = hashBytes(key);
        const cached = txn.instancesByPk.get(keyHash) as InstanceType<M>;
        if (cached) {
            if (loadNow && loadNow !== true) {
                // The object already exists, but it may still be lazy-loaded
                Object.defineProperties(cached, this._resetDescriptors);
                this._setNonKeyValues(cached, loadNow);
            }
            return cached;
        }
        
        let valueBuffer: Uint8Array | undefined;
        if (loadNow) {
            if (loadNow === true) {
                valueBuffer = dbGet(txn.id, key);
                if (logLevel >= 3) {
                    console.log(`[edinburgh] Get ${this} key=${new DataPack(key)} result=${valueBuffer && new DataPack(valueBuffer)}`);
                }
                if (!valueBuffer) return;
            } else {
                valueBuffer = loadNow; // Uint8Array
            }
        }
        
        // This is a primary index. So we can now deserialize all primary and non-primary fields into instance values.
        const model = new (this._MyModel as any)(undefined, txn) as InstanceType<M>;

        // Set to the original value for all fields that are loaded by _setLoadedField
        model._oldValues = {};

        // Set the primary key fields on the model
        if (keyParts) {
            let index = 0;
            for(const fieldName of this._fieldTypes.keys()) {
                model._setLoadedField(fieldName, keyParts[index++] as any);
            }
        } else {
            const bytes = new DataPack(key);
            assert(bytes.readNumber() === this._MyModel._primary._indexId); // Skip index id
            for(const [fieldName, fieldType] of this._fieldTypes.entries()) {
                model._setLoadedField(fieldName, fieldType.deserialize(bytes));
            }
        }

        // Store the canonical primary key on the model, set the hash, and freeze the primary key fields.
        model._setPrimaryKey(key, keyHash);

        if (valueBuffer) {
            // Non-lazy load. Set other fields
            this._setNonKeyValues(model, valueBuffer);
        } else {
            // Lazy - set getters for other fields
            Object.defineProperties(model, this._lazyDescriptors);
            // When creating a lazy instance, we don't need to add it to txn.instances yet, as only the
            // primary key fields are loaded, and they cannot be modified (so we don't need to check).
            // When any other field is set, that will trigger a lazy-load, adding the instance to
            // txn.instances.
        }

        txn.instancesByPk.set(keyHash, model);
        return model;
    }

    _serializeKey(primaryKey: Uint8Array, _data: Record<string, any>): Uint8Array {
        return primaryKey;
    }

    _lazyNow(model: InstanceType<M>) {
        let valueBuffer = dbGet(model._txn.id, model._primaryKey!);
        if (logLevel >= 3) {
            console.log(`[edinburgh] Lazy retrieve ${this} key=${new DataPack(model._primaryKey)} result=${valueBuffer && new DataPack(valueBuffer)}`);
        }
        if (!valueBuffer) throw new DatabaseError(`Lazy-loaded ${model.constructor.name}#${model._primaryKey} does not exist`, 'LAZY_FAIL');
        Object.defineProperties(model, this._resetDescriptors);
        this._setNonKeyValues(model, valueBuffer);
    }

    _setNonKeyValues(model: InstanceType<M>, valueArray: Uint8Array) {
        const fieldConfigs = this._MyModel.fields;
        const valuePack = new DataPack(valueArray);
        const version = valuePack.readNumber();

        if (version === this._currentVersion) {
            for (const fieldName of this._nonKeyFields) {
                model._setLoadedField(fieldName, fieldConfigs[fieldName].type.deserialize(valuePack));
            }
        } else {
            this._migrateFromVersion(model, version, valuePack);
        }
    }

    /** Load a version's info from DB, caching the result. */
    _loadVersionInfo(txnId: number, version: number): VersionInfo {
        let info = this._versions.get(version);
        if (info) return info;

        const key = new DataPack()
            .write(VERSION_INFO_PREFIX)
            .write(this._indexId!)
            .write(version)
            .toUint8Array();
        const raw = dbGet(txnId, key);
        if (!raw) throw new DatabaseError(`Version ${version} info not found for index ${this}`, 'CONSISTENCY_ERROR');

        const obj = new DataPack(raw).read() as any;
        if (!obj || typeof obj.migrateHash !== 'number' || !Array.isArray(obj.fields) || !(obj.secondaryKeys instanceof Set))
            throw new DatabaseError(`Version ${version} info is corrupted for index ${this}`, 'CONSISTENCY_ERROR');

        const nonKeyFields = new Map<string, TypeWrapper<any>>();
        for (const [name, typeBytes] of obj.fields) {
            nonKeyFields.set(name, deserializeType(new DataPack(typeBytes), 0));
        }

        info = { migrateHash: obj.migrateHash, nonKeyFields, secondaryKeys: obj.secondaryKeys as Set<string> };
        this._versions.set(version, info);
        return info;
    }

    /** Deserialize and migrate a row from an old version. */
    _migrateFromVersion(model: InstanceType<M>, version: number, valuePack: DataPack) {
        const versionInfo = this._loadVersionInfo(model._txn.id, version);

        // Deserialize using old field types into a plain record
        const record: Record<string, any> = {};
        for (const [name] of this._fieldTypes.entries()) record[name] = (model as any)[name]; // pk fields
        for (const [name, type] of versionInfo.nonKeyFields.entries()) {
            record[name] = type.deserialize(valuePack);
        }

        // Run migrate() if it exists
        const migrateFn = (this._MyModel as any).migrate;
        if (migrateFn) migrateFn(record);

        // Set non-key fields on model from the (possibly migrated) record
        for (const fieldName of this._nonKeyFields) {
            if (fieldName in record) {
                model._setLoadedField(fieldName, record[fieldName]);
            } else if (fieldName in model) {
                // Instantiate the default value
                model._setLoadedField(fieldName, (model as any)[fieldName]);
            } else {
                throw new DatabaseError(`Field ${fieldName} is missing in migrated data for ${model}`, 'MIGRATION_ERROR');
            }
        }
    }

    _keyToArray(key: Uint8Array): IndexArgTypes<M, F> {
        const bytes = new DataPack(key);
        assert(bytes.readNumber() === this._indexId);
        const result = [] as any[];
        for (const fieldType of this._fieldTypes.values()) {
            result.push(fieldType.deserialize(bytes));
        }
        return result as any;
    }

    _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, valueBuffer: ArrayBuffer): InstanceType<M> {
        return this._get(txn, new Uint8Array(keyBuffer), new Uint8Array(valueBuffer));
    }

    _getTypeName(): string {
        return 'primary';
    }

    _write(txn: Transaction, primaryKey: Uint8Array, data: Record<string, any>) {
        let valueBytes = new DataPack();
        valueBytes.write(this._currentVersion);
        const fieldConfigs = this._MyModel.fields as any;
        for (const fieldName of this._nonKeyFields) {
            const fieldConfig = fieldConfigs[fieldName] as FieldConfig<unknown>;
            fieldConfig.type.serialize(data[fieldName], valueBytes);
        }
        if (logLevel >= 2) {
            console.log(`[edinburgh] Write ${this} key=${new DataPack(primaryKey)} value=${valueBytes}`);
        }
        dbPut(txn.id, primaryKey, valueBytes.toUint8Array());
    }

    _delete(txn: Transaction, primaryKey: Uint8Array, _data: Record<string, any>) {
        if (logLevel >= 2) {
            console.log(`[edinburgh] Delete ${this} key=${new DataPack(primaryKey)}`);
        }
        dbDel(txn.id, primaryKey);
    }
}

/**
 * Unique index that stores references to the primary key.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class UniqueIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[], ARGS extends readonly any[] = IndexArgTypes<M, F>> extends BaseIndex<M, F, ARGS> {

    constructor(MyModel: M, fieldsOrFn: F | ((data: any) => any[])) {
        super(MyModel, typeof fieldsOrFn === 'function' ? [] as any : fieldsOrFn);
        if (typeof fieldsOrFn === 'function') this._computeFn = fieldsOrFn;
        (this._MyModel._secondaries ||= []).push(this);
        scheduleInit();
    }

    /**
     * Get a model instance by unique index key values.
     * @param args - The unique index key values.
     * @returns The model instance if found, undefined otherwise.
     * 
     * @example
     * ```typescript
     * const userByEmail = User.byEmail.get("john@example.com");
     * ```
     */
    get(...args: ARGS): InstanceType<M> | undefined {
        const txn = currentTxn();
        let keyBuffer = this._argsToKeyBytes(args, false).toUint8Array();

        let valueBuffer = dbGet(txn.id, keyBuffer);
        if (logLevel >= 3) {
            console.log(`[edinburgh] Get ${this} key=${new DataPack(keyBuffer)} result=${valueBuffer}`);
        }
        if (!valueBuffer) return;

        const pk = this._MyModel._primary!;
        const result = pk._get(txn, valueBuffer, true);
        if (!result) throw new DatabaseError(`Unique index ${this} points at non-existing primary for key: ${args.join(', ')}`, 'CONSISTENCY_ERROR');
        return result;
    }

    _serializeKey(primaryKey: Uint8Array, data: Record<string, any>): Uint8Array {
        return this._serializeKeyFields(data).toUint8Array();
    }

    _delete(txn: Transaction, primaryKey: Uint8Array, data: Record<string, any>) {
        if (this._computeFn) {
            for (const value of this._computeFn(data)) {
                const key = new DataPack().write(this._indexId!).write(value).toUint8Array();
                if (logLevel >= 2) console.log(`[edinburgh] Delete ${this} fn-key=${key}`);
                dbDel(txn.id, key);
            }
            return;
        }
        if (!this._hasNullIndexValues(data)) {
            const key = this._serializeKey(primaryKey, data);
            if (logLevel >= 2) {
                console.log(`[edinburgh] Delete ${this} key=${key}`);
            }
            dbDel(txn.id, key);
        }
    }

    _write(txn: Transaction, primaryKey: Uint8Array, data: Record<string, any>) {
        if (this._computeFn) {
            for (const value of this._computeFn(data)) {
                const key = new DataPack().write(this._indexId!).write(value).toUint8Array();
                if (logLevel >= 2) console.log(`[edinburgh] Write ${this} fn-key=${key} value=${new DataPack(primaryKey)}`);
                if (dbGet(txn.id, key)) throw new DatabaseError(`Unique constraint violation for ${this} key ${key}`, 'UNIQUE_CONSTRAINT');
                dbPut(txn.id, key, primaryKey);
            }
            return;
        }
        if (!this._hasNullIndexValues(data)) {
            const key = this._serializeKey(primaryKey, data);
            if (logLevel >= 2) {
                console.log(`[edinburgh] Write ${this} key=${key} value=${new DataPack(primaryKey)}`);
            }
            if (dbGet(txn.id, key)) {
                throw new DatabaseError(`Unique constraint violation for ${this} key ${key}`, 'UNIQUE_CONSTRAINT');
            }
            dbPut(txn.id, key, primaryKey);
        }
    }

    _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, valueBuffer: ArrayBuffer): InstanceType<M> {
        // For unique indexes, the value contains the primary key

        const pk = this._MyModel._primary!;
        const model = pk._get(txn, new Uint8Array(valueBuffer), false);

        if (!this._computeFn) {
            const keyPack = new DataPack(new Uint8Array(keyBuffer));
            keyPack.readNumber(); // discard index id

            // _get will have created lazy-load getters for our indexed fields. Let's turn them back into
            // regular properties:
            Object.defineProperties(model, this._resetIndexFieldDescriptors);

            // Set the values for our indexed fields
            for(const [name, fieldType] of this._fieldTypes.entries()) {
                model._setLoadedField(name, fieldType.deserialize(keyPack));
            }
        }

        return model;
    }

    _getTypeName(): string {
        return this._computeFn ? 'fn-unique' : 'unique';
    }
}

// OLMDB does not support storing empty values, so we use a single byte value for secondary indexes.
const SECONDARY_VALUE = new DataPack().write(undefined).toUint8Array(); // Single byte value for secondary indexes

/**
 * Secondary index for non-unique lookups.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class SecondaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[], ARGS extends readonly any[] = IndexArgTypes<M, F>> extends BaseIndex<M, F, ARGS> {

    constructor(MyModel: M, fieldsOrFn: F | ((data: any) => any[])) {
        super(MyModel, typeof fieldsOrFn === 'function' ? [] as any : fieldsOrFn);
        if (typeof fieldsOrFn === 'function') this._computeFn = fieldsOrFn;
        (this._MyModel._secondaries ||= []).push(this);
        scheduleInit();
    }

    _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, _valueBuffer: ArrayBuffer): InstanceType<M> {
        // For secondary indexes, the primary key is stored after the index fields in the key

        const keyPack = new DataPack(new Uint8Array(keyBuffer));
        keyPack.readNumber(); // discard index id
        
        // Read the index fields (or skip computed value)
        const indexFields = new Map();
        if (this._computeFn) {
            keyPack.read(); // skip computed value
        } else {
            for(const [name, type] of this._fieldTypes.entries()) {
                indexFields.set(name, type.deserialize(keyPack));
            }
        }

        const primaryKey = keyPack.readUint8Array();
        const model = this._MyModel._primary!._get(txn, primaryKey, false);

        if (indexFields.size > 0) {
            // _get will have created lazy-load getters for our indexed fields. Let's turn them back into
            // regular properties:
            Object.defineProperties(model, this._resetIndexFieldDescriptors);

            // Set the values for our indexed fields
            for(const [name, value] of indexFields) {
                model._setLoadedField(name, value);
            }
        }

        return model;
    }

    _serializeKey(primaryKey: Uint8Array, model: InstanceType<M>): Uint8Array {
        // index id + index fields + primary key
        const bytes = super._serializeKeyFields(model);
        bytes.write(primaryKey);
        return bytes.toUint8Array();
    }

    _write(txn: Transaction, primaryKey: Uint8Array, model: InstanceType<M>) {
        if (this._computeFn) {
            for (const value of this._computeFn(model)) {
                const key = new DataPack().write(this._indexId!).write(value).write(primaryKey).toUint8Array();
                if (logLevel >= 2) console.log(`[edinburgh] Write ${this} fn-key=${key}`);
                dbPut(txn.id, key, SECONDARY_VALUE);
            }
            return;
        }
        if (this._hasNullIndexValues(model)) return;
        const key = this._serializeKey(primaryKey, model);
        if (logLevel >= 2) {
            console.log(`[edinburgh] Write ${this} key=${key}`);
        }
        dbPut(txn.id, key, SECONDARY_VALUE);
    }

    _delete(txn: Transaction, primaryKey: Uint8Array, model: InstanceType<M>): void {
        if (this._computeFn) {
            for (const value of this._computeFn(model)) {
                const key = new DataPack().write(this._indexId!).write(value).write(primaryKey).toUint8Array();
                if (logLevel >= 2) console.log(`[edinburgh] Delete ${this} fn-key=${key}`);
                dbDel(txn.id, key);
            }
            return;
        }
        if (this._hasNullIndexValues(model)) return;
        const key = this._serializeKey(primaryKey, model);
        if (logLevel >= 2) {
            console.log(`[edinburgh] Delete ${this} key=${key}`);
        }
        dbDel(txn.id, key);
    }

    _getTypeName(): string {
        return this._computeFn ? 'fn-secondary' : 'secondary';
    }
}

// Type alias for backward compatibility
export type Index<M extends typeof Model, F extends readonly (keyof InstanceType<M> & string)[]> = 
    PrimaryIndex<M, F> | UniqueIndex<M, F> | SecondaryIndex<M, F>;

/**
 * Create a primary index on model fields.
 * @template M - The model class.
 * @template F - The field name (for single field index).
 * @template FS - The field names array (for composite index).
 * @param MyModel - The model class to create the index for.
 * @param field - Single field name for simple indexes.
 * @param fields - Array of field names for composite indexes.
 * @returns A new PrimaryIndex instance.
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   static pk = E.primary(User, ["id"]);
 *   static pkSingle = E.primary(User, "id");
 * }
 * ```
 */
export function primary<M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): PrimaryIndex<M, [F]>;
export function primary<M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): PrimaryIndex<M, FS>;

export function primary(MyModel: typeof Model, fields: any): PrimaryIndex<any, any> {
    return new PrimaryIndex(MyModel, Array.isArray(fields) ? fields : [fields]);
}

/**
 * Create a unique index on model fields, or a computed unique index using a function.
 *
 * For field-based indexes, pass a field name or array of field names.
 * For computed indexes, pass a function that takes a model instance and returns an array of
 * index keys. Return `[]` to skip indexing for that instance. Each array element creates a
 * separate index entry, enabling multi-value indexes (e.g., indexing by each word in a name).
 *
 * @template M - The model class.
 * @template V - The computed index value type (for function-based indexes).
 * @template F - The field name (for single field index).
 * @template FS - The field names array (for composite index).
 * @param MyModel - The model class to create the index for.
 * @param field - Field name, array of field names, or a compute function.
 * @returns A new UniqueIndex instance.
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   static byEmail = E.unique(User, "email");
 *   static byNameAge = E.unique(User, ["name", "age"]);
 *   static byFullName = E.unique(User, (u: User) => [`${u.firstName} ${u.lastName}`]);
 * }
 * ```
 */
export function unique<M extends typeof Model, V>(MyModel: M, fn: (instance: InstanceType<M>) => V[]): UniqueIndex<M, [], [V]>;
export function unique<M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): UniqueIndex<M, [F]>;
export function unique<M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): UniqueIndex<M, FS>;

export function unique(MyModel: typeof Model, fields: any): UniqueIndex<any, any, any> {
    return new UniqueIndex(MyModel, typeof fields === 'string' ? [fields] : fields);
}

/**
 * Create a secondary index on model fields, or a computed secondary index using a function.
 *
 * For field-based indexes, pass a field name or array of field names.
 * For computed indexes, pass a function that takes a model instance and returns an array of
 * index keys. Return `[]` to skip indexing for that instance. Each array element creates a
 * separate index entry, enabling multi-value indexes (e.g., indexing by each word in a name).
 *
 * @template M - The model class.
 * @template V - The computed index value type (for function-based indexes).
 * @template F - The field name (for single field index).
 * @template FS - The field names array (for composite index).
 * @param MyModel - The model class to create the index for.
 * @param field - Field name, array of field names, or a compute function.
 * @returns A new SecondaryIndex instance.
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   static byAge = E.index(User, "age");
 *   static byTagsDate = E.index(User, ["tags", "createdAt"]);
 *   static byWord = E.index(User, (u: User) => u.name.split(" "));
 * }
 * ```
 */
export function index<M extends typeof Model, V>(MyModel: M, fn: (instance: InstanceType<M>) => V[]): SecondaryIndex<M, [], [V]>;
export function index<M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): SecondaryIndex<M, [F]>;
export function index<M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): SecondaryIndex<M, FS>;

export function index(MyModel: typeof Model, fields: any): SecondaryIndex<any, any, any> {
    return new SecondaryIndex(MyModel, typeof fields === 'string' ? [fields] : fields);
}

/**
 * Dump database contents for debugging.
 * 
 * Prints all indexes and their data to the console for inspection.
 * This is primarily useful for development and debugging purposes.
 */
export function dump() {
    const txn = currentTxn();
    let indexesById = new Map<number, {name: string, type: string, fields: Record<string, TypeWrapper<any>>}>();
    let versions = new Map<number, Map<number, Map<string, TypeWrapper<any>>>>();
    console.log("--- edinburgh database dump ---")
    const iteratorId = lowlevel.createIterator(txn.id, undefined, undefined, false);
    try {
    while (true) {
        const raw = lowlevel.readIterator(iteratorId);
        if (!raw) break;
        const kb = new DataPack(new Uint8Array(raw.key));
        const vb = new DataPack(new Uint8Array(raw.value));
        const indexId = kb.readNumber();
        if (indexId === MAX_INDEX_ID_PREFIX) {
            console.log("* Max index id", vb.readNumber());
        } else if (indexId === VERSION_INFO_PREFIX) {
            const idxId = kb.readNumber();
            const version = kb.readNumber();
            const obj = vb.read() as any;
            const nonKeyFields = new Map<string, TypeWrapper<any>>();
            for (const [name, typeBytes] of obj.fields) {
                nonKeyFields.set(name, deserializeType(new DataPack(typeBytes), 0));
            }
            if (!versions.has(idxId)) versions.set(idxId, new Map());
            versions.get(idxId)!.set(version, nonKeyFields);
            console.log(`* Version ${version} for index ${idxId}: fields=[${[...nonKeyFields.keys()].join(',')}]`);
        } else if (indexId === INDEX_ID_PREFIX) {
            const name = kb.readString();
            const type = kb.readString();
            const fields: Record<string, TypeWrapper<any>> = {};
            while(kb.readAvailable()) {
                const name = kb.read();
                if (typeof name !== 'string') break; // undefined separator or computed hash
                fields[name] = deserializeType(kb, 0);
            }

            const indexId = vb.readNumber();
            console.log(`* Index definition ${indexId}:${name}:${type}[${Object.keys(fields).join(',')}]`);
            indexesById.set(indexId, {name, type, fields});
        } else if (indexId > 0 && indexesById.has(indexId)) {
            const index = indexesById.get(indexId)!;
            let name, type, rowKey: any, rowValue: any;
            if (index) {
                name = index.name;
                type = index.type;
                const fields = index.fields;
                rowKey = {};
                for(const [fieldName, fieldType] of Object.entries(fields)) {
                    rowKey[fieldName] = fieldType.deserialize(kb);
                }
                if (type === 'primary') {
                    const version = vb.readNumber();
                    const vFields = versions.get(indexId)?.get(version);
                    if (vFields) {
                        rowValue = {};
                        for (const [fieldName, fieldType] of vFields) {
                            rowValue[fieldName] = fieldType.deserialize(vb);
                        }
                    }
                }
            }
            console.log(`* Row for ${indexId}:${name}:${type}`, rowKey ?? kb, rowValue ?? vb);
        } else {
            console.log(`* Unhandled '${indexId}' key=${kb} value=${vb}`);
        }
    }
    } finally { lowlevel.closeIterator(iteratorId); }
    console.log("--- end ---")
}
