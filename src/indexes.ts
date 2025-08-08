import * as olmdb from "olmdb";
import { DatabaseError } from "olmdb";
import { Bytes } from "./bytes.js";
import { getMockModel, Model, modelRegistry } from "./models.js";
import { assert, logLevel } from "./utils.js";
import { deserializeType, serializeType, TypeWrapper } from "./types.js";

/** @internal Symbol used to access the underlying model from a proxy */
export const TARGET_SYMBOL = Symbol('target');

// Index system types and utilities
type IndexArgTypes<M extends typeof Model<any>, F extends readonly (keyof InstanceType<M> & string)[]> = {
    [I in keyof F]: InstanceType<M>[F[I]]
}

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;

/**
 * Iterator for range queries on indexes.
 * Handles common iteration logic for both primary and unique indexes.
 * Implements both Iterator and Iterable interfaces for efficiency.
 */
class IndexRangeIterator<M extends typeof Model, F extends readonly (keyof InstanceType<M> & string)[]> implements Iterator<InstanceType<M>>, Iterable<InstanceType<M>> {
    constructor(
        private iterator: olmdb.DbIterator<any,any> | undefined,
        private indexId: number,
        private parentIndex: BaseIndex<M, F>
    ) {}

    [Symbol.iterator](): Iterator<InstanceType<M>> {
        return this;
    }

    next(): IteratorResult<InstanceType<M>> {
        if (!this.iterator) return { done: true, value: undefined };
        const entry = this.iterator.next();
        if (entry.done) {
            this.iterator.close();
            return { done: true, value: undefined };
        }
        
        // Extract the key without the index ID
        const keyBytes = new Bytes(entry.value.key);
        const entryIndexId = keyBytes.readNumber();
        assert(entryIndexId === this.indexId);

        // Use polymorphism to get the model from the entry
        const model = this.parentIndex._getModelFromEntry(keyBytes, new Bytes(entry.value.value));

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
    public MyModel: M;
    
    /**
     * Create a new index.
     * @param MyModel - The model class this index belongs to.
     * @param fieldNames - Array of field names that make up this index.
     */
    constructor(MyModel: M, public fieldNames: F) {
        this.MyModel = MyModel = getMockModel(MyModel);
        (MyModel._indexes ||= []).push(this);
    }

    cachedIndexId?: number;

    /**
     * Deserialize index key bytes back to field values.
     * @param bytes - Bytes to read from.
     * @returns Array of field values.
     */
    deserializeKey(bytes: Bytes): IndexArgTypes<M, F> {
        const result: IndexArgTypes<M, F> = [] as any;
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = (this.MyModel.fields as any)[fieldName] as any;
            fieldConfig.type.deserialize(result, i, bytes);
        }
        return result;
    }

    /**
     * Extract model from iterator entry - implemented differently by each index type.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBytes - Value bytes from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    abstract _getModelFromEntry(keyBytes: Bytes, valueBytes: Bytes): InstanceType<M> | undefined;

    /**
     * Serialize field values to bytes for index key.
     * @param args - Field values to serialize (can be partial for range queries).
     * @param bytes - Bytes to write to.
     * @internal
     */
    _serializeArgs(args: Partial<IndexArgTypes<M, F>> | readonly any[], bytes: Bytes) {
        const argsArray = Array.isArray(args) ? args : Object.values(args);
        assert(argsArray.length <= this.fieldNames.length);
        for (let i = 0; i < argsArray.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.validateAndSerialize(argsArray, i, bytes);
        }
    }

    /**
     * Create database key from field values.
     * @param args - Field values.
     * @returns Database key bytes.
     */
    getKeyFromArgs(args: IndexArgTypes<M, F>): Uint8Array {
        assert(args.length === this.fieldNames.length);
        let indexId = this.getIndexId();
        let keyBytes = new Bytes().writeNumber(indexId);
        this._serializeArgs(args, keyBytes);
        return keyBytes.getBuffer();
    }

    /**
     * Serialize model fields to bytes for index key.
     * @param model - Model instance.
     * @param bytes - Bytes to write to.
     */
    serializeModel(model: InstanceType<M>, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.validateAndSerialize(model, fieldName, bytes, model);
        }
    }

    /**
     * Create database key from model instance.
     * @param model - Model instance.
     * @param includeIndexId - Whether to include index ID in key.
     * @returns Database key bytes or undefined if skipped.
     * @internal
     */
    _getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean): Uint8Array {
        const bytes = new Bytes();
        if (includeIndexId) bytes.writeNumber(this.getIndexId());
        this.serializeModel(model, bytes);
        return bytes.getBuffer();
    }

    /**
     * Extract field values from model for this index.
     * @param model - Model instance.
     * @returns Field values or undefined if should be skipped.
     * @internal
     */
    _modelToArgs(model: InstanceType<M>): IndexArgTypes<M, F> | undefined {
        return this.checkSkip(model) ? undefined: this.fieldNames.map((fieldName) => model[fieldName]) as unknown as IndexArgTypes<M, F>;
    }

    /**
     * Get or create unique index ID for this index.
     * @returns Numeric index ID.
     */
    protected getIndexId(): number {
        // Resolve an index to a number
        let indexId = this.cachedIndexId;
        if (indexId == null) {
            const indexNameBytes = new Bytes().writeNumber(INDEX_ID_PREFIX).writeString(this.MyModel.tableName).writeString(this.getTypeName());
            for(let name of this.fieldNames) {
                indexNameBytes.writeString(name);
                serializeType(this.MyModel.fields[name].type, indexNameBytes);
            }
            const indexNameBuf = indexNameBytes.getBuffer();

            let result = olmdb.get(indexNameBuf);
            if (result) {
                indexId = this.cachedIndexId = new Bytes(result).readNumber();
            } else {
                const maxIndexIdBuf = new Bytes().writeNumber(MAX_INDEX_ID_PREFIX).getBuffer();
                result = olmdb.get(maxIndexIdBuf);
                indexId = result ? new Bytes(result).readNumber() + 1 : 1;
                olmdb.onCommit(() => {
                    // Only if the transaction succeeds can we cache this id
                    this.cachedIndexId = indexId;
                });

                const idBuf = new Bytes().writeNumber(indexId).getBuffer();
                olmdb.put(indexNameBuf, idBuf);
                olmdb.put(maxIndexIdBuf, idBuf); // This will also cause the transaction to rerun if we were raced
                if (logLevel >= 1) {
                    console.log(`Created index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] with id ${indexId}`);
                }
            }
        }
        return indexId;
    }

    /**
     * Check if indexing should be skipped for a model instance.
     * @param model - Model instance.
     * @returns true if indexing should be skipped.
     */
    protected checkSkip(model: InstanceType<M>): boolean {
        for (const fieldName of this.fieldNames) {
            const fieldConfig = this.MyModel.fields[fieldName] as any;
            if (fieldConfig.type.checkSkipIndex(model, fieldName)) return true;
        }
        return false;
    }

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
    find(opts: FindOptions<IndexArgTypes<M, F>> = {}): IndexRangeIterator<M,F> {
        const indexId = this.getIndexId();
        
        let startKey: Bytes | undefined = new Bytes().writeNumber(indexId);
        let endKey: Bytes | undefined = startKey.copy();

        if ('is' in opts) {
            // Exact match - set both start and end to the same value
            this._serializeArgs(toArray(opts.is), startKey);
            endKey = startKey.copy().increment();
        } else {
            // Range query
            if ('from' in opts) {
                this._serializeArgs(toArray(opts.from), startKey);
            } else if ('after' in opts) {
                this._serializeArgs(toArray(opts.after), startKey);
                if (!startKey.increment()) {
                    // There can be nothing 'after' - return an empty iterator
                    return new IndexRangeIterator(undefined, indexId, this);
                }
            }
            
            if ('to' in opts) {
                this._serializeArgs(toArray(opts.to), endKey);
                endKey.increment();
            } else if ('before' in opts) {
                this._serializeArgs(toArray(opts.before), endKey);
            } else {
                endKey = endKey.increment(); // Next indexId
            }
        }

        // For reverse scans, swap start/end keys since OLMDB expects it
        const scanStart = opts.reverse ? endKey : startKey;
        const scanEnd = opts.reverse ? startKey : endKey;

        const iterator = olmdb.scan({
            start: scanStart?.getBuffer(),
            end: scanEnd?.getBuffer(),
            reverse: opts.reverse || false,
        });
        
        return new IndexRangeIterator(iterator, indexId, this);
    }

    /**
     * Save index entry for a model instance.
     * @param model - Model instance to save.
     * @param originalKey - Original key if updating.
     */
    abstract save(model: InstanceType<M>, originalKey?: Uint8Array): void;

    abstract getTypeName(): string;
}

function toArray<T>(args: T): T extends readonly any[] ? T : [T] {
    // Use type assertion to satisfy TypeScript while maintaining runtime correctness
    return (Array.isArray(args) ? args : [args]) as T extends readonly any[] ? T : [T];
}

/**
 * Primary index that stores the actual model data.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class PrimaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {
    
    constructor(MyModel: M, fieldNames: F) {
        super(MyModel, fieldNames);
        if (MyModel._pk && MyModel._pk !== this) {
            throw new DatabaseError(`Model ${MyModel.tableName} already has a primary key defined`, 'INIT_ERROR');
        }
        MyModel._pk = this;
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
        let keyBuffer = this.getKeyFromArgs(args as IndexArgTypes<M, F>);
        if (logLevel >= 3) {
            console.log(`Getting primary ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] (id=${this.getIndexId()}) with key`, args, keyBuffer);
        }

        let valueBuffer = olmdb.get(keyBuffer);
        if (!valueBuffer) return;
        
        // This is a primary index. So we can now deserialize all primary and non-primary fields into instance values.
        const model = new (this.MyModel as any)() as InstanceType<M>;
        // We'll want to set all loaded values on the unproxied target object.
        const unproxied = (model as any)[TARGET_SYMBOL];
        unproxied._state = 2; // Loaded from disk, unmodified

        const valueBytes = new Bytes(valueBuffer);
        let primaryKeyIndex = 0;
        for (const [fieldName, fieldConfig] of Object.entries(this.MyModel.fields)) {
            if (this.fieldNames.includes(fieldName as any)) { // Value is part of primary key
                unproxied[fieldName as string] = args[primaryKeyIndex];
                primaryKeyIndex++;
            } else {
                // We're passing in the proxied model
                fieldConfig.type.deserialize(unproxied, fieldName, valueBytes, model);
            }
        }

        return model;
    }

    /**
     * Extract model from iterator entry for primary index.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBytes - Value bytes from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    _getModelFromEntry(keyBytes: Bytes, valueBytes: Bytes): InstanceType<M> | undefined {
        const model = new (this.MyModel as any)() as InstanceType<M>;
        // We'll want to set all loaded values on the unproxied target object.
        const unproxied = (model as any)[TARGET_SYMBOL];
        unproxied._state = 2; // Loaded from disk, unmodified

        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = (this.MyModel.fields as any)[fieldName] as any;
            fieldConfig.type.deserialize(unproxied, fieldName, keyBytes);
        }

        for (const [fieldName, fieldConfig] of Object.entries(this.MyModel.fields)) {
            if (this.fieldNames.includes(fieldName as any)) continue; // Value is part of primary key
            // We're passing in the proxied model
            fieldConfig.type.deserialize(unproxied, fieldName, valueBytes, model);
        }

        return model;
    }

    /**
     * Save primary index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);
        
        let newKey = this._getKeyFromModel(model, true);
        if (originalKey && Buffer.compare(newKey, originalKey)) throw new DatabaseError(`Cannot change primary key for ${this.MyModel.tableName}[${this.fieldNames.join(', ')}]: ${originalKey} -> ${newKey}`, 'PRIMARY_CHANGE');

        // Serialize all non-primary key fields
        let valBytes = new Bytes();
        for (const [fieldName, fieldConfig] of Object.entries(model._fields)) {
            if (!this.fieldNames.includes(fieldName as any)) {
                fieldConfig.type.validateAndSerialize(model, fieldName, valBytes, model);
            }
        }
        
        olmdb.put(newKey, valBytes.getBuffer());

        if (logLevel >= 2) {
            const keyBytes = new Bytes(newKey);
            let indexId = keyBytes.readNumber();
            console.log(`Saved primary ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] (id=${indexId}) with key`, this.deserializeKey(keyBytes), keyBytes.getBuffer());
        }
    }

    getTypeName(): string {
        return 'primary';
    }
}

/**
 * Unique index that stores references to the primary key.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class UniqueIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {
    public readonly type = 'unique' as const;

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
        let keyBuffer = this.getKeyFromArgs(args as IndexArgTypes<M, F>);
        if (logLevel >= 3) {
            console.log(`Getting unique ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] (id=${this.getIndexId()}) with key`, args, keyBuffer);
        }

        let valueBuffer = olmdb.get(keyBuffer);
        if (!valueBuffer) return;

        const pk = this.MyModel._pk!;
        const valueArgs = pk.deserializeKey(new Bytes(valueBuffer))
        const result = pk.get(...valueArgs);
        if (!result) throw new DatabaseError(`Unique index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] points at non-existing primary for key: ${args.join(', ')}`, 'CONSISTENCY_ERROR');
        return result;
    }

    /**
     * Extract model from iterator entry for unique index.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBytes - Value bytes from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    _getModelFromEntry(keyBytes: Bytes, valueBytes: Bytes): InstanceType<M> | undefined {
        // For unique indexes, the value contains the primary key
        const pk = this.MyModel._pk!;
        const primaryKeyArgs = pk.deserializeKey(valueBytes);
        return pk.get(...primaryKeyArgs);
    }

    /**
     * Save unique index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);

        let newKey = this.checkSkip(model) ? undefined : this._getKeyFromModel(model, true);

        if (originalKey) {
            if (newKey && Buffer.compare(newKey, originalKey) === 0) {
                // No change in index key, nothing to do
                return;
            }
            olmdb.del(originalKey);
        }
        
        if (!newKey) {
            // No new key, nothing to do
            return;
        }

        // Check that this is not a duplicate key
        if (olmdb.get(newKey)) {
            throw new DatabaseError(`Unique constraint violation for ${(model.constructor as any).tableName}[${this.fieldNames.join('+')}]`, 'UNIQUE_CONSTRAINT');
        }
        
        let linkKey = (model.constructor as any)._pk!._getKeyFromModel(model, false);
        olmdb.put(newKey, linkKey);

        if (logLevel >= 2) {
            console.log(`Saved unique index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] with key ${newKey}`);
        }
    }

    getTypeName(): string {
        return 'unique';
    }
}

// OLMDB does not support storing empty values, so we use a single byte value for secondary indexes.
const SECONDARY_VALUE = new Uint8Array([1]); // Single byte value for secondary indexes

/**
 * Secondary index for non-unique lookups.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class SecondaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {
    public readonly type = 'secondary' as const;

    /**
     * Save secondary index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);

        let newKey = this._getKeyFromModel(model, true);

        if (originalKey) {
            if (newKey && Buffer.compare(newKey, originalKey) === 0) {
                // No change in index key, nothing to do
                return;
            }
            olmdb.del(originalKey);
        }
        
        if (!newKey) {
            // No new key, nothing to do (index should be skipped)
            return;
        }

        // For secondary indexes, we store a single byte value
        olmdb.put(newKey, SECONDARY_VALUE);

        if (logLevel >= 2) {
            console.log(`Saved secondary index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] with key ${newKey}`);
        }
    }

    /**
     * Extract model from iterator entry for secondary index.
     * @param keyBytes - Key bytes with index ID already read.
     * @param valueBytes - Value bytes from the entry.
     * @returns Model instance or undefined.
     * @internal
     */
    _getModelFromEntry(keyBytes: Bytes, valueBytes: Bytes): InstanceType<M> | undefined {
        // For secondary indexes, the primary key is stored after the index fields in the key
        
        // First skip past the index fields
        const temp = [] as any[];
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.deserialize(temp, 0, keyBytes);
        }
        
        // Now deserialize the primary key from the remaining bytes
        const pk = this.MyModel._pk!;
        const primaryKeyArgs = pk.deserializeKey(keyBytes);
        return pk.get(...primaryKeyArgs);
    }

    /**
     * Create secondary index key that includes both index fields and primary key.
     * @param model - Model instance.
     * @returns Database key bytes or undefined if skipped.
     */
    _getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean): Uint8Array {
        const bytes = new Bytes();
        if (includeIndexId) bytes.writeNumber(this.getIndexId());
        
        // Write the index fields
        this.serializeModel(model, bytes);
        
        // Write the primary key fields
        const pk = this.MyModel._pk!;
        pk.serializeModel(model, bytes);
        
        return bytes.getBuffer();
    }

    getTypeName(): string {
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
    let indexesById = new Map<number, {name: string, type: string, fields: Record<string, TypeWrapper<any>>}>();
    console.log("--- Database dump ---")
    for(const {key,value} of olmdb.scan()) {
        const kb = new Bytes(key);
        const vb = new Bytes(value);
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
            const fieldDescription = Object.entries(fields).map(([name, type]) => `${name}:${type}`);
            const indexId = vb.readNumber();
            console.log(`* Definition for ${type} ${indexId} for ${name}[${fieldDescription.join(',')}]`);
            indexesById.set(indexId, {name, type, fields});
        } else if (indexId > 0 && indexesById.has(indexId)) {
            const index = indexesById.get(indexId)!;
            const {name, type, fields} = index;
            const rowKey: any = {};
            for(const [fieldName, fieldType] of Object.entries(fields)) {
                fieldType.deserialize(rowKey, fieldName, kb);
            }
            const Model = modelRegistry[name]!;
            // TODO: once we're storing schemas (serializeType) in the db, we can deserialize here
            let displayValue = (type === 'secondary') ? Model._pk!.deserializeKey(kb) : vb;
            console.log(`* Row for ${type} ${indexId} with key ${JSON.stringify(rowKey)}`, displayValue);
        } else {
            console.log(`* Unhandled ${indexId} index key=${kb} value=${vb}`);
        }
    }
    console.log("--- End of database dump ---")
}
