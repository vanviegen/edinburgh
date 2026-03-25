import * as lowlevel from "olmdb/lowlevel";
import { DatabaseError } from "olmdb/lowlevel";
import DataPack from "./datapack.js";
import { FieldConfig, getMockModel, Model, Transaction, currentTxn } from "./models.js";
import { assert, logLevel, dbGet, dbPut, dbDel, hashBytes, toBuffer } from "./utils.js";
import { deserializeType, serializeType, TypeWrapper } from "./types.js";

// Index system types and utilities
type IndexArgTypes<M extends typeof Model<any>, F extends readonly (keyof InstanceType<M> & string)[]> = {
    [I in keyof F]: InstanceType<M>[F[I]]
}

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;

const MAX_INDEX_ID_BUFFER = new DataPack().write(MAX_INDEX_ID_PREFIX).toUint8Array();

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
        
        // Extract the key without the index ID
        const keyBytes = new DataPack(new Uint8Array(raw.key));
        const entryIndexId = keyBytes.readNumber();
        assert(entryIndexId === this.indexId);

        // Use polymorphism to get the model from the entry
        const model = this.parentIndex._pairToInstance(this.txn, keyBytes, new Uint8Array(raw.value));

        if (!model) {
            // This shouldn't happen, but skip if it does
            return this.next();
        }

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
export abstract class BaseIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> {
    public _MyModel: M;
    public _fieldTypes: Map<keyof InstanceType<M> & string, TypeWrapper<any>> = new Map();
    public _fieldCount!: number;

    /**
     * Create a new index.
     * @param MyModel - The model class this index belongs to.
     * @param _fieldNames - Array of field names that make up this index.
     */
    constructor(MyModel: M, public _fieldNames: F) {
        this._MyModel = getMockModel(MyModel);
    }

    async _delayedInit() {
        for(const fieldName of this._fieldNames) {
            assert(typeof fieldName === 'string', 'Field names must be strings');
            this._fieldTypes.set(fieldName, this._MyModel.fields[fieldName].type);
        }
        this._fieldCount = this._fieldNames.length;
        await this._retrieveIndexId();
    }

    _indexId?: number;

    /**
     * Serialize array of key values to a (index-id prefixed) Bytes instance that can be used as a key.
     * @param args - Field values to serialize (can be partial for range queries).
     * @returns A Bytes instance containing the index id and serialized key parts.
     * @internal
     */
    _argsToKeyBytes(args: [], allowPartial: boolean): DataPack;
    _argsToKeyBytes(args: Partial<IndexArgTypes<M, F>>, allowPartial: boolean): DataPack;

    _argsToKeyBytes(args: any, allowPartial: boolean) {
        assert(allowPartial ? args.length <= this._fieldCount : args.length === this._fieldCount);
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        let index = 0;
        for(const fieldType of this._fieldTypes.values()) {
            // For partial keys, undefined values are acceptable and represent open range suffixes
            if (index >= args.length) break;
            fieldType.serialize(args[index++], bytes);
        }
        return bytes;
    }

    /**
     * Extract model from iterator entry - implemented differently by each index type.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBuffer - Value Uint8Array from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    abstract _pairToInstance(txn: Transaction, keyBytes: DataPack, valueBuffer: Uint8Array): InstanceType<M> | undefined;

    _hasNullIndexValues(model: InstanceType<M>) {
        for(const fieldName of this._fieldTypes.keys()) {
            if (model[fieldName] == null) return true;
        }
        return false;
    }

    _instanceToKeyBytes(model: InstanceType<M>): DataPack {
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        for(const [fieldName, fieldType] of this._fieldTypes.entries()) {
            fieldType.serialize(model[fieldName], bytes);
        }
        return bytes;
    }

    /**
     * Retrieve (or create) a stable index ID from the DB, with retry on transaction races.
     * Sets `this._indexId` on success.
     */
    async _retrieveIndexId(): Promise<void> {
        const indexNameBytes = new DataPack().write(INDEX_ID_PREFIX).write(this._MyModel.tableName).write(this._getTypeName());
        for(let name of this._fieldNames) {
            indexNameBytes.write(name);
            serializeType(this._MyModel.fields[name].type, indexNameBytes);
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
                    if (logLevel >= 1) console.log(`Create index ${this}`);
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


    abstract _delete(txn: Transaction, model: InstanceType<M>): void;
    abstract _write(txn: Transaction, model: InstanceType<M>): void;

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
    public find(opts: FindOptions<IndexArgTypes<M, F>> = {}): IndexRangeIterator<M> {
        const txn = currentTxn();
        const indexId = this._indexId!;
        
        let startKey: DataPack | undefined;
        let endKey: DataPack | undefined;

        if ('is' in opts) {
            // Exact match - set both 'from' and 'to' to the same value
            startKey = this._argsToKeyBytes(toArray(opts.is), true);
            endKey = startKey.clone(true).increment();
        } else {
            // Range query
            if ('from' in opts) {
                startKey = this._argsToKeyBytes(toArray(opts.from), true);
            } else if ('after' in opts) {
                startKey = this._argsToKeyBytes(toArray(opts.after), true);
                if (!startKey.increment()) {
                    // There can be nothing 'after' - return an empty iterator
                    return new IndexRangeIterator(txn, -1, indexId, this);
                }
            } else {
                // Open start: begin at first key for this index id
                startKey = this._argsToKeyBytes([], true);
            }
            
            if ('to' in opts) {
                endKey = this._argsToKeyBytes(toArray(opts.to), true).increment();
            } else if ('before' in opts) {
                endKey = this._argsToKeyBytes(toArray(opts.before), true);
            } else {
                // Open end: end at first key of the next index id
                endKey = this._argsToKeyBytes([], true).increment(); // Next indexId
            }
        }

        // For reverse scans, swap start/end keys since OLMDB expects it
        const scanStart = opts.reverse ? endKey : startKey;
        const scanEnd = opts.reverse ? startKey : endKey;

        if (logLevel >= 3) {
            console.log(`Scan ${this} start=${scanStart} end=${scanEnd} reverse=${opts.reverse||false}`);
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
export class PrimaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {

    _nonKeyFields!: (keyof InstanceType<M> & string)[];
    _lazyDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    _resetDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};

    constructor(MyModel: M, fieldNames: F) {
        super(MyModel, fieldNames);
        if (MyModel._primary) {
            throw new DatabaseError(`There's already a primary index defined: ${MyModel._primary}. This error may also indicate that your tsconfig.json needs to have "target": "ES2022" set.`, 'INIT_ERROR');
        }
        MyModel._primary = this;
    }

    async _delayedInit() {
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
    get(...args: IndexArgTypes<M, F> | [Uint8Array]): InstanceType<M> | undefined {
        return this._get(currentTxn(), args, false);
    }

    /**
     * Does the same as as `get()`, but will delay loading the instance from disk until the first
     * property access. In case it turns out the instance doesn't exist, an error will be thrown
     * at that time.
     * @param args Primary key field values. (Or a single Uint8Array containing the key.)
     * @returns The (lazily loaded) model instance.
     */
    getLazy(...args: IndexArgTypes<M, F> | [Uint8Array]): InstanceType<M> {
        return this._get(currentTxn(), args, true);
    }

    _get(txn: Transaction, args: IndexArgTypes<M, F> | [Uint8Array], lazy: true): InstanceType<M>;
    _get(txn: Transaction, args: IndexArgTypes<M, F> | [Uint8Array], lazy: false): InstanceType<M> | undefined;
    _get(txn: Transaction, args: IndexArgTypes<M, F> | [Uint8Array], lazy: boolean) {
        let key: Uint8Array, keyParts;
        if (args.length === 1 && args[0] instanceof Uint8Array) {
            key = args[0];
        } else {
            key = this._argsToKeyBytes(args as IndexArgTypes<M, F>, false).toUint8Array();
            keyParts = args;
        }

        const keyHash = hashBytes(key);
        const cached = txn.instancesByPk.get(keyHash);
        if (cached) return cached;
        
        let valueBuffer;
        if (!lazy) {
            valueBuffer = dbGet(txn.id, key);
            if (logLevel >= 3) {
                console.log(`Get ${this} key=${new DataPack(key)} result=${valueBuffer && new DataPack(valueBuffer)}`);
            }
            if (!valueBuffer) return;
        }
        
        // This is a primary index. So we can now deserialize all primary and non-primary fields into instance values.
        const model = new (this._MyModel as any)() as InstanceType<M>;

        // Store the canonical primary key on the model
        model._primaryKey = key;
        model._primaryKeyHash = keyHash;

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

        if (valueBuffer) {
            // Non-lazy load. Set other fields
            this._setNonKeyValues(model, new DataPack(valueBuffer));
        } else {
            // Lazy - set getters for other fields
            Object.defineProperties(model, this._lazyDescriptors);
        }

        txn.instancesByPk.set(keyHash, model);
        return model;
    }

    _lazyNow(model: InstanceType<M>) {
        const txn = model._txn;
        if (!txn) throw new DatabaseError(`Cannot lazy-load ${model.constructor.name} after transaction has ended`, 'STALE_MODEL');
        let valueBuffer = dbGet(txn.id, model._primaryKey!);
        if (logLevel >= 3) {
            console.log(`Lazy retrieve ${this} key=${new DataPack(model._primaryKey)} result=${valueBuffer && new DataPack(valueBuffer)}`);
        }
        if (!valueBuffer) throw new DatabaseError(`Lazy-loaded ${model.constructor.name}#${model._primaryKey} does not exist`, 'LAZY_FAIL');
        Object.defineProperties(model, this._resetDescriptors);
        this._setNonKeyValues(model, new DataPack(valueBuffer));
    }

    _setNonKeyValues(model: InstanceType<M>, valueBytes: DataPack) {
        const fieldConfigs = this._MyModel.fields;

        for (const fieldName of this._nonKeyFields) {
            const value = fieldConfigs[fieldName].type.deserialize(valueBytes);
            model._setLoadedField(fieldName, value);
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

    _pairToInstance(txn: Transaction, keyBytes: DataPack, valueBuffer: Uint8Array): InstanceType<M> | undefined {
        const valueBytes = new DataPack(valueBuffer);
        const model = new (this._MyModel as any)() as InstanceType<M>;

        for(const [fieldName, fieldType] of this._fieldTypes.entries()) {
            model._setLoadedField(fieldName, fieldType.deserialize(keyBytes));
        }
        model._primaryKey = keyBytes.toUint8Array();
        
        this._setNonKeyValues(model, valueBytes);

        return model;
    }

    _getTypeName(): string {
        return 'primary';
    }

    _write(txn: Transaction, model: InstanceType<M>) {
        let valueBytes = new DataPack();
        const fieldConfigs = this._MyModel.fields as any;
        for (const fieldName of this._nonKeyFields) {
            const fieldConfig = fieldConfigs[fieldName] as FieldConfig<unknown>;
            fieldConfig.type.serialize(model[fieldName], valueBytes);
        }
        if (logLevel >= 2) {
            console.log(`Write ${this} key=${new DataPack(model._getCreatePrimaryKey())} value=${valueBytes}`);
        }
        dbPut(txn.id, model._getCreatePrimaryKey(), valueBytes.toUint8Array());
    }

    _delete(txn: Transaction, model: InstanceType<M>) {
        if (model._primaryKey) {
            if (logLevel >= 2) {
                console.log(`Delete ${this} key=${new DataPack(model._primaryKey)}`);
            }
            dbDel(txn.id, model._primaryKey);
        }
    }
}

/**
 * Unique index that stores references to the primary key.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class UniqueIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {

    constructor(MyModel: M, fieldNames: F) {
        super(MyModel, fieldNames);
        (this._MyModel._secondaries ||= []).push(this);
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
    get(...args: IndexArgTypes<M, F>): InstanceType<M> | undefined {
        const txn = currentTxn();
        let keyBuffer = this._argsToKeyBytes(args, false).toUint8Array();

        let valueBuffer = dbGet(txn.id, keyBuffer);
        if (logLevel >= 3) {
            console.log(`Get ${this} key=${new DataPack(keyBuffer)} result=${valueBuffer}`);
        }
        if (!valueBuffer) return;

        const pk = this._MyModel._primary!;
        const result = pk._get(txn, [valueBuffer], false);
        if (!result) throw new DatabaseError(`Unique index ${this} points at non-existing primary for key: ${args.join(', ')}`, 'CONSISTENCY_ERROR');
        return result;
    }

    _delete(txn: Transaction, model: InstanceType<M>) {
        if (!this._hasNullIndexValues(model)) {
            const keyBytes = this._instanceToKeyBytes(model);
            if (logLevel >= 2) {
                console.log(`Delete ${this} key=${keyBytes}`);
            }
            dbDel(txn.id, keyBytes.toUint8Array());
        }
    }

    _write(txn: Transaction, model: InstanceType<M>) {
        if (!this._hasNullIndexValues(model)) {
            const key = this._instanceToKeyBytes(model);
            if (logLevel >= 2) {
                console.log(`Write ${this} key=${key} value=${new DataPack(model._primaryKey)}`);
            }
            const keyBuffer = key.toUint8Array();
            if (dbGet(txn.id, keyBuffer)) {
                throw new DatabaseError(`Unique constraint violation for ${this} key ${key}`, 'UNIQUE_CONSTRAINT');
            }
            dbPut(txn.id, keyBuffer, model._primaryKey!);
        }
    }

    /**
     * Extract model from iterator entry for unique index.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBytes - Value bytes from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    _pairToInstance(txn: Transaction, keyBytes: DataPack, valueBuffer: Uint8Array): InstanceType<M> | undefined {
        // For unique indexes, the value contains the primary key

        const pk = this._MyModel._primary!;
        const model = pk._get(txn, [valueBuffer], true);

        // Read the index fields from the key, overriding lazy loading for these fields
        for(const [name, fieldType] of this._fieldTypes.entries()) {
            // getLazy will have created a getter for this field - make it a normal property instead
            Object.defineProperty(model, name, {
                writable: true,
                configurable: true,
                enumerable: true
            });
            model._setLoadedField(name, fieldType.deserialize(keyBytes));
        }

        return model;
    }


    _getTypeName(): string {
        return 'unique';
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
export class SecondaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {

    constructor(MyModel: M, fieldNames: F) {
        super(MyModel, fieldNames);
        (this._MyModel._secondaries ||= []).push(this);
    }

    /**
     * Extract model from iterator entry for secondary index.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBuffer - Value Uint8Array from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    _pairToInstance(txn: Transaction, keyBytes: DataPack, valueBuffer: Uint8Array): InstanceType<M> | undefined {
        // For secondary indexes, the primary key is stored after the index fields in the key
        
        // Read the index fields, saving them for later
        const indexFields = new Map();
        for(const [name, type] of this._fieldTypes.entries()) {
            indexFields.set(name, type.deserialize(keyBytes));
        }

        const primaryKey = keyBytes.readUint8Array();
        const model = this._MyModel._primary!._get(txn, [primaryKey], true);

        // Add the index fields to the model, overriding lazy loading for these fields
        for(const [name, value] of indexFields) {
            // getLazy will have created a getter for this field - make it a normal property instead
            Object.defineProperty(model, name, {
                writable: true,
                configurable: true,
                enumerable: true
            });
            model._setLoadedField(name, value);
        }

        return model;
    }

    _instanceToKeyBytes(model: InstanceType<M>): DataPack {
        // index id + index fields + primary key
        const bytes = super._instanceToKeyBytes(model);
        bytes.write(model._getCreatePrimaryKey());
        return bytes;
    }

    _write(txn: Transaction, model: InstanceType<M>) {
        if (this._hasNullIndexValues(model)) return;
        const keyBytes = this._instanceToKeyBytes(model);
        if (logLevel >= 2) {
            console.log(`Write ${this} key=${keyBytes}`);
        }
        dbPut(txn.id, keyBytes.toUint8Array(), SECONDARY_VALUE);
    }

    _delete(txn: Transaction, model: InstanceType<M>): void {
        if (this._hasNullIndexValues(model)) return;
        const keyBytes = this._instanceToKeyBytes(model);
        if (logLevel >= 2) {
            console.log(`Delete ${this} key=${keyBytes}`);
        }
        dbDel(txn.id, keyBytes.toUint8Array());
    }

    _getTypeName(): string {
        return 'secondary';
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
 * Create a unique index on model fields.
 * @template M - The model class.
 * @template F - The field name (for single field index).
 * @template FS - The field names array (for composite index).
 * @param MyModel - The model class to create the index for.
 * @param field - Single field name for simple indexes.
 * @param fields - Array of field names for composite indexes.
 * @returns A new UniqueIndex instance.
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   static byEmail = E.unique(User, "email");
 *   static byNameAge = E.unique(User, ["name", "age"]);
 * }
 * ```
 */
export function unique<M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): UniqueIndex<M, [F]>;
export function unique<M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): UniqueIndex<M, FS>;

export function unique(MyModel: typeof Model, fields: any): UniqueIndex<any, any> {
    return new UniqueIndex(MyModel, Array.isArray(fields) ? fields : [fields]);
}

/**
 * Create a secondary index on model fields.
 * @template M - The model class.
 * @template F - The field name (for single field index).
 * @template FS - The field names array (for composite index).
 * @param MyModel - The model class to create the index for.
 * @param field - Single field name for simple indexes.
 * @param fields - Array of field names for composite indexes.
 * @returns A new SecondaryIndex instance.
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   static byAge = E.index(User, "age");
 *   static byTagsDate = E.index(User, ["tags", "createdAt"]);
 * }
 * ```
 */
export function index<M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): SecondaryIndex<M, [F]>;
export function index<M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): SecondaryIndex<M, FS>;

export function index(MyModel: typeof Model, fields: any): SecondaryIndex<any, any> {
    return new SecondaryIndex(MyModel, Array.isArray(fields) ? fields : [fields]);
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
    console.log("--- Database dump ---")
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
        } else if (indexId === INDEX_ID_PREFIX) {
            const name = kb.readString();
            const type = kb.readString();
            const fields: Record<string, TypeWrapper<any>> = {};
            while(kb.readAvailable()) {
                const name = kb.readString();
                fields[name] = deserializeType(kb, 0);
            }
            const indexId = vb.readNumber();
            console.log(`* Index definition ${indexId}:${name}:${type}[${Object.keys(fields).join(',')}]`);
            indexesById.set(indexId, {name, type, fields});
        } else if (indexId > 0 && indexesById.has(indexId)) {
            const index = indexesById.get(indexId)!;
            const {name, type, fields} = index;
            const rowKey: any = {};
            for(const [fieldName, fieldType] of Object.entries(fields)) {
                rowKey[fieldName] = fieldType.deserialize(kb);
            }
            // const Model = modelRegistry[name]!;
            // TODO: once we're storing schemas (serializeType) in the db, we can deserialize here
            console.log(`* Row for ${indexId}:${name}:${type}[${Object.keys(fields).join(',')}] key=${kb} value=${vb}`);
        } else {
            console.log(`* Unhandled '${indexId}' key=${kb} value=${vb}`);
        }
    }
    } finally { lowlevel.closeIterator(iteratorId); }
    console.log("--- End of database dump ---")
}
