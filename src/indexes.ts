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
 * Database index for efficient lookups on model fields.
 * 
 * Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.
 * Primary indexes store the actual model data, while unique indexes store references to the primary key.
 * 
 * @template M - The model class this index belongs to.
 * @template F - The field names that make up this index.
 */
export class Index<M extends typeof Model, const F extends readonly (keyof InstanceType<M> & string)[]> {
    public MyModel: M;
    
    /**
     * Create a new index.
     * @param MyModel - The model class this index belongs to.
     * @param fieldNames - Array of field names that make up this index.
     * @param type - The index type ("primary", "unique", or "secondary").
     */
    constructor(MyModel: M, public fieldNames: F, public type: IndexType) {
        this.MyModel = MyModel = getMockModel(MyModel);
        (MyModel._indexes ||= []).push(this);

        if (type === 'primary') {
            if (MyModel._pk && MyModel._pk !== this) throw new DatabaseError(`Model ${MyModel.tableName} already has a primary key defined`, 'INIT_ERROR');
            MyModel._pk = this;
        }
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
    serializeModel(model: any, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.validateAndSerialize(model, fieldName, bytes, model);
        }
    }

    getKeyFromModel(model: any, includeIndexId: boolean, checkSkip: true): Uint8Array | undefined;
    getKeyFromModel(model: any, includeIndexId: boolean, checkSkip: false): Uint8Array;

    /**
     * Create database key from model instance.
     * @param model - Model instance.
     * @param includeIndexId - Whether to include index ID in key.
     * @param checkSkip - Whether to check if indexing should be skipped.
     * @returns Database key bytes or undefined if skipped.
     */
    getKeyFromModel(model: any, includeIndexId: boolean, checkSkip: boolean): Uint8Array | undefined {
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
    modelToArgs(model: any): IndexTuple<M, F> | undefined {
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
     * Get a model instance by index key values.
     * @param args - The index key values.
     * @returns The model instance if found, undefined otherwise.
     * 
     * @example
     * ```typescript
     * const user = User.pk.get("john_doe");
     * const userByEmail = User.byEmail.get("john@example.com");
     * ```
     */
    get(...args: IndexTuple<M, F>): InstanceType<M> | undefined {
        if (this.type === 'secondary') {    
            throw new Error(`secondary indexes do not support get()`);
        }
        let keyBuffer = this.getKeyFromArgs(args as IndexTuple<M, F>);
        if (logLevel >= 3) {
            console.log(`Getting primary ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] (id=${this.getIndexId()}) with key`, args, keyBuffer);
        }

        let valueBuffer = olmdb.get(keyBuffer);
        if (!valueBuffer) return;

        if (this.type === 'unique') {
            const pk = this.MyModel._pk!;
            const valueArgs = pk.deserializeKey(new Bytes(valueBuffer))
            const result = pk.get(...valueArgs);
            if (!result) throw new DatabaseError(`Unique index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] points at non-existing primary for key: ${args.join(', ')}`, 'CONSISTENCY_ERROR');
            return result;
        }
        
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
     * Save index entry for a model instance.
     * @param model - Model instance to save.
     * @param originalKey - Original key if updating.
     */
    save(model: any, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);
        if (this.type === 'primary') this.savePrimary(model, originalKey);
        else if (this.type === 'unique') this.saveUnique(model, originalKey);
        else throw new DatabaseError(`Index type '${this.type}' not implemented yet`, 'NOT_IMPLEMENTED');
    }

    /**
     * Check if indexing should be skipped for a model instance.
     * @param model - Model instance.
     * @returns true if indexing should be skipped.
     */
    checkSkip(model: any): boolean {
        for (const fieldName of this.fieldNames) {
            const fieldConfig = this.MyModel.fields[fieldName] as any;
            if (fieldConfig.type.checkSkipIndex(model, fieldName)) return true;
        }
        return false;
    }

    /**
     * Save primary index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    savePrimary(model: any, originalKey?: Uint8Array) {
        let newKey = this.getKeyFromModel(model, true, false); // Cannot be undefined for primary
        if (originalKey && Buffer.compare(newKey, originalKey)) throw new DatabaseError(`Cannot change primary key for ${this.MyModel.tableName}[${this.fieldNames.join(', ')}]: ${originalKey} -> ${newKey}`, 'PRIMARY_CHANGE');

        // Serialize all non-primary key fields
        let valBytes = new Bytes();
        for (const [fieldName, fieldConfig] of Object.entries(model._fields)) {
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

    /**
     * Save unique index entry.
     * @param model - Model instance.
     * @param originalKey - Original key if updating.
     */
    saveUnique(model: any, originalKey?: Uint8Array) {
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
            throw new DatabaseError(`Unique constraint violation for ${model.constructor.tableName}[${this.fieldNames.join('+')}]`, 'UNIQUE_CONSTRAINT');
        }
        
        let linkKey = model.constructor._pk!.getKeyFromModel(model, false, false);
        olmdb.put(newKey, linkKey);

        if (logLevel >= 2) {
            console.log(`Saved unique index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] with key`, this.deserializeKey(new Bytes(newKey)));
        }
    }
}

/**
 * Create an index on model fields.
 * @template M - The model class.
 * @template F - The field name (for single field index).
 * @template FS - The field names array (for composite index).
 * @param MyModel - The model class to create the index for.
 * @param field - Single field name for simple indexes.
 * @param fields - Array of field names for composite indexes.
 * @param type - The index type ("primary", "unique", or "secondary").
 * @returns A new Index instance.
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   static pk = E.index(User, ["id"], "primary");
 *   static byEmail = E.index(User, "email", "unique");
 *   static byNameAge = E.index(User, ["name", "age"], "secondary");
 * }
 * ```
 */
export function index<M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F, type?: IndexType) : Index<M, [F]>;
export function index<M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS, type?: IndexType) : Index<M, FS>;

export function index(MyModel: typeof Model, fields: any, type: IndexType = 'secondary') {
    return new Index(MyModel, Array.isArray(fields) ? fields : [fields], type);
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
