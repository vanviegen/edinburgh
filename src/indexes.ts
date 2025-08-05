import * as olmdb from "olmdb";
import { DatabaseError } from "olmdb";
import { Bytes } from "./bytes.js";
import { getMockModel, Model, modelRegistry } from "./models.js";
import { assert, logLevel } from "./utils.js";
import { deserializeType, serializeType, TypeWrapper } from "./types.js";

/** @internal Symbol used to access the underlying model from a proxy */
export const TARGET_SYMBOL = Symbol('target');

// Index system types and utilities
type IndexTuple<M extends typeof Model<any>, F extends readonly (keyof InstanceType<M> & string)[]> = {
    [I in keyof F]: InstanceType<M>[F[I]]
}

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;

export type IndexType = 'primary' | 'unique' | 'secondary';

/**
 * Iterator for range queries on indexes.
 * Handles common iteration logic for both primary and unique indexes.
 * Implements both Iterator and Iterable interfaces for efficiency.
 */
class IndexRangeIterator<M extends typeof Model, F extends readonly (keyof InstanceType<M> & string)[]> implements Iterator<InstanceType<M>>, Iterable<InstanceType<M>> {
    constructor(
        private iterator: any,
        private indexId: number,
        private parentIndex: BaseIndex<M, F>
    ) {}

    [Symbol.iterator](): Iterator<InstanceType<M>> {
        return this;
    }

    next(): IteratorResult<InstanceType<M>> {
        const entry = this.iterator.next();
        if (entry.done) {
            this.iterator.close();
            return { done: true, value: undefined };
        }

        // Extract the key without the index ID
        const keyBytes = new Bytes(entry.value.key);
        const entryIndexId = keyBytes.readNumber();
        if (entryIndexId !== this.indexId) {
            // We've moved past this index
            this.iterator.close();
            return { done: true, value: undefined };
        }

        // Deserialize the index key
        const keyArgs = [] as any;
        for (let i = 0; i < this.parentIndex.fieldNames.length; i++) {
            const fieldName = this.parentIndex.fieldNames[i];
            const fieldConfig = this.parentIndex.MyModel.fields[fieldName];
            (fieldConfig as any).type.deserialize(keyArgs, i, keyBytes);
        }

        // Get the model - different logic for primary vs unique indexes
        let model: InstanceType<M> | undefined;
        if (this.parentIndex.type === 'primary') {
            model = (this.parentIndex as PrimaryIndex<M, F>).get(...keyArgs as IndexTuple<M, F>);
        } else if (this.parentIndex.type === 'unique') {
            // For unique indexes, the value contains the primary key
            const pk = this.parentIndex.MyModel._pk!;
            const primaryKeyArgs = pk.deserializeKey(new Bytes(entry.value.value));
            model = pk.get(...primaryKeyArgs);
        }

        if (!model) {
            // This shouldn't happen, but skip if it does
            return this.next();
        }

        return { done: false, value: model };
    }
}

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
    public abstract type: IndexType;
    
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
    deserializeKey(bytes: Bytes): IndexTuple<M, F> {
        const result: IndexTuple<M, F> = [] as any;
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = (this.MyModel.fields as any)[fieldName] as any;
            fieldConfig.type.deserialize(result, i, bytes);
        }
        return result;
    }

    /**
     * Serialize field values to bytes for index key.
     * @param args - Field values to serialize.
     * @param bytes - Bytes to write to.
     */
    serializeArgs(args: IndexTuple<M, F>, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.validateAndSerialize(args, i, bytes);
        }
    }

    /**
     * Create database key from field values.
     * @param args - Field values.
     * @returns Database key bytes.
     */
    getKeyFromArgs(args: IndexTuple<M, F>): Uint8Array {
        let indexId = this.getIndexId();
        let keyBytes = new Bytes().writeNumber(indexId);
        this.serializeArgs(args, keyBytes);
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

    getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean, checkSkip: true): Uint8Array | undefined;
    getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean, checkSkip: false): Uint8Array;

    /**
     * Create database key from model instance.
     * @param model - Model instance.
     * @param includeIndexId - Whether to include index ID in key.
     * @param checkSkip - Whether to check if indexing should be skipped.
     * @returns Database key bytes or undefined if skipped.
     */
    getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean, checkSkip: boolean): Uint8Array | undefined {
        if (checkSkip && this.checkSkip(model)) return undefined;
        const bytes = new Bytes();
        if (includeIndexId) bytes.writeNumber(this.getIndexId());
        this.serializeModel(model, bytes);
        return bytes.getBuffer();
    }

    /**
     * Extract field values from model for this index.
     * @param model - Model instance.
     * @returns Field values or undefined if should be skipped.
     */
    modelToArgs(model: InstanceType<M>): IndexTuple<M, F> | undefined {
        return this.checkSkip(model) ? undefined: this.fieldNames.map((fieldName) => model[fieldName]) as unknown as IndexTuple<M, F>;
    }

    /**
     * Get or create unique index ID for this index.
     * @returns Numeric index ID.
     */
    getIndexId(): number {
        // Resolve an index to a number
        let indexId = this.cachedIndexId;
        if (indexId == null) {
            const indexNameBytes = new Bytes().writeNumber(INDEX_ID_PREFIX).writeString(this.MyModel.tableName).writeString(this.type);
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
     * Create a range iterator for this index.
     * @param startArgs - Starting key arguments
     * @param endArgs - Ending key arguments  
     * @param inclusive - Whether the end key should be inclusive
     * @returns An IndexRangeIterator for model instances
     */
    protected createRangeIterator(startArgs?: any, endArgs?: any, inclusive: boolean = true): IndexRangeIterator<M, F> {
        // Handle single-field case by wrapping in array
        if (this.fieldNames.length === 1 && startArgs !== null && startArgs !== undefined && !Array.isArray(startArgs)) {
            startArgs = [startArgs];
        }
        if (this.fieldNames.length === 1 && endArgs !== null && endArgs !== undefined && !Array.isArray(endArgs)) {
            endArgs = [endArgs];
        }
        
        const indexId = this.getIndexId();
        const startKey = startArgs ? this.getKeyFromArgs(startArgs) : new Bytes().writeNumber(indexId).getBuffer();
        let endKey: Uint8Array | undefined;
        
        if (endArgs) {
            const endKeyBytes = new Bytes().writeNumber(indexId);
            this.serializeArgs(endArgs, endKeyBytes);
            if (inclusive) {
                // For inclusive end, add a single byte with value 255 to make it the next possible key
                endKeyBytes.ensureCapacity(1);
                endKeyBytes.buffer[endKeyBytes.writeByte++] = 255;
            }
            endKey = endKeyBytes.getBuffer();
        } else {
            // If endArgs is null, we want to scan to the end of this index
            endKey = new Bytes().writeNumber(indexId + 1).getBuffer();
        }

        const iterator = olmdb.scan({
            start: startKey,
            end: endKey,
            reverse: false
        });

        return new IndexRangeIterator(iterator, indexId, this);
    }

    /**
     * Check if indexing should be skipped for a model instance.
     * @param model - Model instance.
     * @returns true if indexing should be skipped.
     */
    checkSkip(model: InstanceType<M>): boolean {
        for (const fieldName of this.fieldNames) {
            const fieldConfig = this.MyModel.fields[fieldName] as any;
            if (fieldConfig.type.checkSkipIndex(model, fieldName)) return true;
        }
        return false;
    }

    /**
     * Find model instances within a range of index key values (inclusive).
     * This method supports both single-field and multi-field indices.
     * 
     * For single-field indices, you can pass the values directly:
     *   find(startValue, endValue)
     * 
     * For multi-field indices, pass arrays:
     *   find([field1Start, field2Start], [field1End, field2End])
     * 
     * @param startArgs - The starting index key values (inclusive). If null, starts from beginning.
     * @param endArgs - The ending index key values (inclusive). If null, goes to end. If omitted, defaults to startArgs.
     * @returns An iterable of model instances.
     */
    find(startArgs?: any, endArgs?: any): Iterable<InstanceType<M>> {
        // Default endArgs to startArgs if not provided
        if (arguments.length === 1) {
            endArgs = startArgs;
        }
        
        return this.createRangeIterator(startArgs, endArgs, true);
    }

    /**
     * Find model instances within a range of index key values (exclusive of end).
     * This method supports both single-field and multi-field indices.
     * 
     * For single-field indices, you can pass the values directly:
     *   findUpTil(startValue, endValue)
     * 
     * For multi-field indices, pass arrays:
     *   findUpTil([field1Start, field2Start], [field1End, field2End])
     * 
     * @param startArgs - The starting index key values (inclusive). If null, starts from beginning.
     * @param endArgs - The ending index key values (exclusive). If null, goes to end. If omitted, defaults to startArgs.
     * @returns An iterable of model instances.
     */
    findUpTil(startArgs?: any, endArgs?: any): Iterable<InstanceType<M>> {
        // Default endArgs to startArgs if not provided
        if (arguments.length === 1) {
            endArgs = startArgs;
        }
        
        return this.createRangeIterator(startArgs, endArgs, false);
    }

    /**
     * Save index entry for a model instance.
     * @param model - Model instance to save.
     * @param originalKey - Original key if updating.
     */
    abstract save(model: InstanceType<M>, originalKey?: Uint8Array): void;
}

/**
 * Primary index that stores the actual model data.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class PrimaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {
    public readonly type = 'primary' as const;
    
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
    get(...args: IndexTuple<M, F>): InstanceType<M> | undefined {
        let keyBuffer = this.getKeyFromArgs(args as IndexTuple<M, F>);
        if (logLevel >= 3) {
            console.log(`Getting primary ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] (id=${this.getIndexId()}) with key`, args, keyBuffer);
        }

        let valueBuffer = olmdb.get(keyBuffer);
        if (!valueBuffer) return;
        
        // This is a primary index. So we can now deserialize all primary and non-primary fields into instance values.
        const result = new (this.MyModel as any)() as any;
        // We'll want to set all loaded values on the unproxied target object.
        const values = (result as any)[TARGET_SYMBOL];

        const valueBytes = new Bytes(valueBuffer);
        let primaryKeyIndex = 0;
        for (const [fieldName, fieldConfig] of Object.entries(this.MyModel.fields)) {
            if (this.fieldNames.includes(fieldName as any)) { // Value is part of primary key
                values[fieldName as string] = args[primaryKeyIndex];
                primaryKeyIndex++;
            } else {
                // We're passing in the proxied model
                (fieldConfig as any).type.deserialize(values, fieldName, valueBytes, result);
            }
        }

        return result;
    }

    /**
     * Save primary index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);
        
        let newKey = this.getKeyFromModel(model, true, false); // Cannot be undefined for primary
        if (originalKey && Buffer.compare(newKey, originalKey)) throw new DatabaseError(`Cannot change primary key for ${this.MyModel.tableName}[${this.fieldNames.join(', ')}]: ${originalKey} -> ${newKey}`, 'PRIMARY_CHANGE');

        // Serialize all non-primary key fields
        let valBytes = new Bytes();
        for (const [fieldName, fieldConfig] of Object.entries((model as any)._fields)) {
            if (!this.fieldNames.includes(fieldName as any)) {
                (fieldConfig as any).type.validateAndSerialize(model, fieldName, valBytes, model);
            }
        }
        
        olmdb.put(newKey, valBytes.getBuffer());

        if (logLevel >= 2) {
            const keyBytes = new Bytes(newKey);
            let indexId = keyBytes.readNumber();
            console.log(`Saved primary ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] (id=${indexId}) with key`, this.deserializeKey(keyBytes), keyBytes.getBuffer());
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
    get(...args: IndexTuple<M, F>): InstanceType<M> | undefined {
        let keyBuffer = this.getKeyFromArgs(args as IndexTuple<M, F>);
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
     * Save unique index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);
        
        let newKey = this.getKeyFromModel(model, true, true);

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
        
        let linkKey = (model.constructor as any)._pk!.getKeyFromModel(model, false, false);
        olmdb.put(newKey, linkKey);

        if (logLevel >= 2) {
            console.log(`Saved unique index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] with key`, this.deserializeKey(new Bytes(newKey)));
        }
    }
}

/**
 * Secondary index for non-unique lookups (not yet implemented).
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class SecondaryIndex<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> extends BaseIndex<M, F> {
    public readonly type = 'secondary' as const;

    /**
     * Secondary indexes do not support get() method.
     */
    get(...args: IndexTuple<M, F>): never {
        throw new Error(`secondary indexes do not support get()`);
    }

    /**
     * Save secondary index entry (not yet implemented).
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        throw new DatabaseError(`Index type 'secondary' not implemented yet`, 'NOT_IMPLEMENTED');
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
 * Create a secondary index on model fields (not yet implemented).
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
    let indexesById = new Map<number, {type: string, fields: Record<string, TypeWrapper<any>>}>();
    for(const {key,value} of olmdb.scan()) {
        const kb = new Bytes(key);
        const vb = new Bytes(value);
        const indexId = kb.readNumber();
        if (indexId === MAX_INDEX_ID_PREFIX) {
            console.log("Max index id", vb.readNumber());
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
            console.log(`Definition for ${type} ${indexId} for ${name}[${fieldDescription.join(',')}]`);
            indexesById.set(indexId, {type, fields});
        } else if (indexId > 0 && indexesById.has(indexId)) {
            const {type, fields} = indexesById.get(indexId)!;
            const rowKey = {};
            for(const [fieldName, fieldType] of Object.entries(fields)) {
                fieldType.deserialize(rowKey, fieldName, kb);
            }
            console.log(`Row for ${type} ${indexId} with key ${JSON.stringify(rowKey)}`, vb);
        } else {
            console.log(`Unhandled ${indexId} index`, kb.readString(), vb.getBuffer());
        }
    }
}
