import { Bytes } from "./bytes";
import * as olmdb from "olmdb";


/**
 * Executes a function within a database transaction context.
 * 
 * All database operations (get, put, del) must be performed within a transaction.
 * Transactions are automatically committed if the function completes successfully,
 * or aborted if an error occurs. Failed transactions may be automatically retried
 * up to 3 times in case of validation conflicts.
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
 * });
 * ```
 */
export const transact = <T>(fn: () => T): Promise<T> => {
    return olmdb.transact(() => {
        try {
            const result = fn();
            
            // Save all modified instances before committing
            for (const instance of modifiedInstances) {
                instance.save();
            }
            
            return result;
        } catch (error) {
            // Discard changes on all modified instances
            for (const instance of modifiedInstances) {
                instance.discard();
            }
            throw error;
        } finally {
            // Clear modified instances set
            modifiedInstances.clear();
        }
    });
};
export * as olmdb from "olmdb";

// Global change tracking
const modifiedInstances = new Set<Model<any>>();
const modificationOwnerMap = new WeakMap<object, Model<any>>();
const modificationProxyCache = new WeakMap<object, any>();

// Single proxy handler for both models and nested objects
const modificationTracker: ProxyHandler<any> = {
    get(target, prop) {
        const value = target[prop];
        if (!value || typeof value !== 'object' || (value instanceof Model)) return value;

        // Check cache first
        let proxy = modificationProxyCache.get(value);
        if (proxy) return proxy;
        
        const ownerModel = modificationOwnerMap.get(target) || target;
        if (target === ownerModel && !ownerModel.fields[prop as string]) {
            // No need to track properties that are not model fields.
            return value;
        }

        if (modificationOwnerMap.get(value)) {
            throw new ModelError("Object cannot be embedded in multiple model instances");
        }
        modificationOwnerMap.set(value, ownerModel);
        proxy = new Proxy(value, modificationTracker);
        modificationProxyCache.set(value, proxy);
        return proxy;
    },
    set(target, prop, value) {
        target[prop] = value;
        const ownerModel = modificationOwnerMap.get(target) || target;
        modifiedInstances.add(ownerModel);
        return true;
    }
};

class ModelError extends Error {
    public path: (string | number)[] = [];
    addPath(...path: (string|number)[]) {
        this.path.push(...path);
        return this;
    }
}

export abstract class TypeWrapper<const T> {
    _T!: T; // This field *is* required, because of reasons!
    abstract kind: string;

    constructor() {}
    abstract serialize(value: any, bytes: Bytes): void;
    abstract deserialize(obj: any, prop: string|number, bytes: Bytes): void;
    abstract getErrors(value: any): ModelError[];
    validate(value: any): boolean {
        return this.getErrors(value).length === 0;
    }
    serializeType(bytes: Bytes) {}
    
    // Skip indexing for this field value
    skipIndex(value: T): boolean {
        return false;
    }
}

// Subclasses *may* default a default value, but usually should not.
export interface TypeWrapper<T> {
    default?(model: Model<T>): T;
}

export class StringType extends TypeWrapper<string> {
    kind = 'string';
    serialize(value: any, bytes: Bytes) {
        bytes.writeString(value);
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        obj[prop] = bytes.readString();
    }
    getErrors(value: any): ModelError[] {
        if (typeof value !== 'string') {
            return [new ModelError(`Expected string, got ${typeof value}`)];
        }
        return [];
    }
}

export class NumberType extends TypeWrapper<number> {
    kind = 'number';
    serialize(value: any, bytes: Bytes) {
        bytes.writeNumber(value);
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        obj[prop] = bytes.readNumber();
    }
    getErrors(value: any): ModelError[] {
        if (typeof value !== 'number' || isNaN(value)) {
            return [new ModelError(`Expected number, got ${typeof value}`)];
        }
        return [];
    }
}

export class ArrayType<T> extends TypeWrapper<T[]> {
    kind = 'array';
    constructor(public inner: TypeWrapper<T>, public opts: {min?: number, max?: number} = {}) {
        super();
    }

    serialize(value: any, bytes: Bytes) {
        bytes.writeNumber(value.length);
        for(let item of value) {
            this.inner.serialize(item, bytes);
        }
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        const length = bytes.readNumber();
        const result: T[] = [];
        for (let i = 0; i < length; i++) {
            this.inner.deserialize(result, i, bytes);
        }
        obj[prop] = result;
    }
    getErrors(value: any): ModelError[] {
        if (!Array.isArray(value)) {
            return [new ModelError(`Expected array, got ${typeof value}`)];
        }
        const errors: ModelError[] = [];
        if (this.opts.min !== undefined && value.length < this.opts.min) {
            errors.push(new ModelError(`Array length ${value.length} is less than minimum ${this.opts.min}`));
        }
        if (this.opts.max !== undefined && value.length > this.opts.max) {
            errors.push(new ModelError(`Array length ${value.length} is greater than maximum ${this.opts.max}`));
        }
        for (let i = 0; i < value.length; i++) {
            for(let itemError of this.inner.getErrors(value[i])) {
                errors.push(itemError.addPath(i));
            }
        }
        return errors;
    }
    serializeType(bytes: Bytes): void {
        serializeType(this.inner, bytes);
    }
    static deserializeType(bytes: Bytes, featureFlags: number): ArrayType<any> {
        const inner = deserializeType(bytes, featureFlags);
        return new ArrayType(inner);
    }
}

export class OrType<const T> extends TypeWrapper<T> {
    kind = 'or';
    constructor(public choices: TypeWrapper<T>[]) {
        super();
    }
    serialize(value: T, bytes: Bytes) {
        for(let i=0; i<this.choices.length; i++) {
            const type = this.choices[i];
            if (type.validate(value)) {
                bytes.writeUIntN(i, this.choices.length-1);
                type.serialize(value, bytes);
                return;
            }
        }
        throw new ModelError(`Value does not match any union type: ${value}`);
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        const index = bytes.readUIntN(this.choices.length-1);
        if (index < 0 || index >= this.choices.length) {
            throw new ModelError(`Invalid union type index ${index}`);
        }
        const type = this.choices[index];
        type.deserialize(obj, prop, bytes);
    }
    getErrors(value: T): ModelError[] {
        const errors: ModelError[] = [];
        for (let i = 0; i < this.choices.length; i++) {
            const type = this.choices[i];
            if (type.validate(value)) {
                return [];
            }
            for (let err of type.getErrors(value)) {
                errors.push(err.addPath(`option ${i+1}`));
            }
        }
        return errors;
    }
    skipIndex(value: T): boolean {
        for (const choice of this.choices) {
            if (choice.validate(value)) {
                return choice.skipIndex(value);
            }
        }
        return false;
    }
    serializeType(bytes: Bytes): void {
        bytes.writeNumber(this.choices.length);
        for (const choice of this.choices) {
            serializeType(choice, bytes);
        }
    }
    static deserializeType(bytes: Bytes, featureFlags: number): OrType<any> {
        const count = bytes.readNumber();
        const choices: TypeWrapper<unknown>[] = [];
        for (let i = 0; i < count; i++) {
            choices.push(deserializeType(bytes, featureFlags));
        }
        return new OrType(choices);
    }
}

class LiteralType<const T> extends TypeWrapper<T> {
    kind = 'literal';
    constructor(public value: T) {
        super();
    }
    serialize(value: T, bytes: Bytes) {
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        obj[prop] = this.value;
    }
    getErrors(value: any): ModelError[] {
        return this.value===value ? [] : [new ModelError(`Invalid literal value ${value} instead of ${this.value}`)];
    }
    serializeType(bytes: Bytes): void {
        bytes.writeString(JSON.stringify(this.value));
    }
    
    skipIndex(value: T): boolean {
        return value == null;
    }
    
    static deserializeType(bytes: Bytes, featureFlags: number): LiteralType<any> {
        const value = JSON.parse(bytes.readString());
        return new LiteralType(value);
    }
}

class BooleanType extends TypeWrapper<boolean> {
    kind = 'boolean';
    serialize(value: boolean, bytes: Bytes) {
        bytes.writeBits(value ? 1 : 0, 1);
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        obj[prop] = bytes.readBits(1) === 1;
    }
    getErrors(value: any): ModelError[] {
        if (typeof value !== 'boolean') {
            return [new ModelError(`Expected boolean, got ${typeof value}`)];
        }
        return [];
    }
}

// Field configuration interface
export interface FieldConfig<T> {
    type: TypeWrapper<T>;
    description?: string;
    default?: T | ((model: Model<any>) => T);
}


/**
 * Okay, so this is pretty hacky/interesting... We're defining model fields by creating instance
 * properties that are initialized with calls to `field()`. That function basically just returns
 * the field configuration object (which will be assigned to the property on model instantiation),
 * but lies about it to TypeScript, claiming that it is the type of the actual field value, 
 * derived from the type property in the field configuration object.
 * 
 * We can then scan all field configuration objects in a model instance to obtain field info
 * at runtime, while replacing the field properties with the default values specified in the
 * field configuration.
 * 
 * However, for performance, we don't want every instance of a model to have to instantiate all type
 * info using calls to field(), only to then have the resulting config objects replaced by the default
 * values. So, what the `registerModel` does is swap out the real constructor for a fake constructor,
 * that does not do the property initialization.
 * 
 * We *do* want the real constructor to run once, in order obtain the field info at runtime, so
 * we try to instantiate the actual class once in the `registerModel`. Based on that, we save all
 * field info to `.fields` on the constructor (of the fake constructor), and we set the default
 * values on its prototype. Instantiation the class can fail though, in case the class has a field
 * that links to another class that hasn't been defined yet. This happens for circular references.
 * 
 * In order to solve this, we maintain a queue of uninitialized methods, retrying initialization
 * of failing models whenever a new model has been defined.
 */

// The updated field function returns the config, but is typed as the value type
export function field<T>(type: TypeWrapper<T>, options: Partial<FieldConfig<T>> = {}): T {
    // Return the config object, but TypeScript sees it as type T
    options.type = type;
    return options as any;
}

let uninitializedModels = new Set<typeof Model<unknown>>();
const MODEL_REGISTRY: Record<string, typeof Model> = {};

export function registerModel<T extends typeof Model<unknown>>(cls: T): T {
    function constructor(this: any, initial?: Record<string,any>) {
        if (uninitializedModels.has(this.constructor)) {
            throw new ModelError("Cannot instantiate while linked models haven't been registered yet");
        }
        if (initial) Object.assign(this, initial);
        
        return new Proxy(this, modificationTracker);
    }

    // Copy the prototype chain for the constructor as well as for instantiated objects
    Object.setPrototypeOf(constructor, Object.getPrototypeOf(cls));
    constructor.prototype = cls.prototype;

    // Copy own static methods/properties
    for(const name of Object.getOwnPropertyNames(cls)) {
        if (name !== 'length' && name !== 'prototype' && name !== 'name') {
            (constructor as any)[name] = (cls as any)[name];
        }
    }

    // Initialize an empty `fields` object, and set it on both constructors, as well as on the prototype.
    constructor.fields = cls.fields = constructor.prototype.fields = {};

    // Attempt to instantiate the class and father field metadata
    uninitializedModels.add(cls);
    initModels();

    const result = constructor as unknown as T;
    MODEL_REGISTRY[cls.tableName] = result;
    return result;
}

function initModels() {
    for(const cls of uninitializedModels) {
        // Create an instance (the only one to ever exist) of the actual class,
        // in order to gather field config data. 
        let instance;
        try {
            instance = new (cls as any)(INIT_INSTANCE_SYMBOL);
        } catch(e) {
            if (!(e instanceof ReferenceError)) throw e;
            // ReferenceError: Cannot access 'SomeLinkedClass' before initialization.
            // We'll try again after the next class has successfully initialized.
            continue;
        }

        uninitializedModels.delete(cls);
        
        // If no primary key exists, create one using 'id' field
        if (!cls.pk) {
            // If no `id` field exists, add it automatically
            if (!instance.id) {
                instance.id = { type: identifier }; 
            }
            // @ts-ignore-next-line - `id` is not part of the type, but the user probably shouldn't touch it anyhow
            new Index(cls, ['id'], 'primary');
        }

        for (const key in instance) {
            const value = instance[key] as FieldConfig<unknown>;
            // Check if this property contains field metadata
            if (value && value.type instanceof TypeWrapper) {
                // Set the configuration on the constructor's `fields` property
                cls.fields[key] = value;
                
                // Set default value on the prototype
                const def = value.default || value.type.default;
                if (typeof def === 'function') {
                    // The default is a function. We'll define a getter on the property in the model prototype,
                    // and once it is read, we'll run the function and set the value as a plain old property
                    // on the instance object.
                    Object.defineProperty(cls.prototype, key, {    
                        get() {
                            // This will call set(), which will define the property on the instance.
                            return (this[key] = def(this));
                        },
                        set(val: any) {
                            Object.defineProperty(this, key, {
                                value: val,
                                configurable: true,
                                writable: true
                            })
                        },
                        configurable: true,    
                    });
                } else {
                    (cls.prototype as any)[key] = def;
                }
            }
        }
    }
}


type IndexTuple<M extends typeof Model<any>, F extends readonly (keyof InstanceType<M> & string)[]> = {
  [I in keyof F]: InstanceType<M>[F[I]]
}

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;

class Index<M extends typeof Model<any>, const F extends readonly (keyof InstanceType<M> & string)[]> {
    constructor(private MyModel: M, public fieldNames: F, private type: 'primary' | 'unique' | 'secondary' = 'secondary') {
        this.MyModel._indexes.push(this);
        
        if (type === 'primary') {
            if (MyModel.pk) throw new ModelError(`Model ${MyModel.name} already has a primary key defined`);
            MyModel.pk = this;
        }
    }

    cachedIndexId?: number;

    deserializeKey(bytes: Bytes): IndexTuple<M, F> {
        const result: IndexTuple<M, F> = [] as any;
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = (this.MyModel.fields as any)[fieldName] as FieldConfig<unknown>;
            fieldConfig.type.deserialize(result, i, bytes);
        }
        return result;
    }

    serializeKey(args: IndexTuple<M, F>, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.serialize(args[i], bytes);
        }
    }

    serializeModelKey(model: InstanceType<M>, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.serialize(model[fieldName], bytes);
        }
    }

    getIndexId() {
        // Resolve an index to a number
        if (this.cachedIndexId == null) {

            const indexNameBytes = new Bytes().writeNumber(INDEX_ID_PREFIX).writeString(this.MyModel.tableName).writeString(this.type);
            for(let name of this.fieldNames) indexNameBytes.writeString(name);
            const indexNameBuf = indexNameBytes.getBuffer();

            let result = olmdb.get(indexNameBuf);
            if (result) {
                this.cachedIndexId = new Bytes(result).readNumber();
            } else {
                const maxIndexIdBuf = new Bytes().writeNumber(MAX_INDEX_ID_PREFIX).getBuffer();
                result = olmdb.get(maxIndexIdBuf);
                this.cachedIndexId = result ? new Bytes(result).readNumber() + 1 : 1;
                // TODO: only cache if transaction succeeds

                const idBuf = new Bytes().writeNumber(this.cachedIndexId).getBuffer()
                olmdb.put(indexNameBuf, idBuf);
                olmdb.put(maxIndexIdBuf, idBuf); // This will also cause the transaction to rerun if we were raced
                olmdb.onRevert(() => {
                    // When raced, unset the cached index id
                    this.cachedIndexId = undefined;
                });
            }
        }
        return this.cachedIndexId;
    }

    // args should be an array with the types that the names in F have in InstanceType<M>
    get(...args: IndexTuple<M, F>): InstanceType<M> | undefined {
        if (this.type === 'secondary') {
            throw new ModelError(`Cannot get index ${this.MyModel.name}[${this.fieldNames.join(', ')}]: it is not a primary or unique index`);
        }
        let indexId = this.getIndexId(); // We're pretty sure field names should not be number or symbols, right?
        let keyBytes = new Bytes().writeNumber(indexId);
        this.serializeKey(args, keyBytes);

        let valueBuffer = olmdb.get(keyBytes.getBuffer());
        if (!valueBuffer) return;
        
        if (this.type === 'unique') {
            // valueBuffer contains the index id and key of the primary key that holds the actual data.
            valueBuffer = olmdb.get(valueBuffer);
            if (!valueBuffer) throw new ModelError(`Unique index ${this.MyModel.name}[${this.fieldNames.join(', ')}] points at non-existing primary for key: ${args.join(', ')}`);
        }
        
        // This is a primary index. So we can now deserialize all primary and non-primary fields into instance values.
        const valueBytes = new Bytes(valueBuffer);
        let primaryKeyIndex = 0;
        let values = {} as Record<string, any>;
        for (const fieldName of this.fieldNames) {
            const fieldConfig = this.MyModel.fields[fieldName];
            if (this.type === 'primary' && this.fieldNames.includes(fieldName as any)) {
                values[fieldName as string] = args[primaryKeyIndex];
                primaryKeyIndex++;
            } else {
                fieldConfig.type.deserialize(values, fieldName, valueBytes);
            }
        }

        // Track that the model has been loaded
        const result = new (this.MyModel as any)(values) as InstanceType<M>;
        result._originalValues = deepClone(values);
        return result;
    }

    save(model: InstanceType<M>) {        
        if (this.type === 'primary') this.savePrimary(model);
        else if (this.type === 'unique') this.saveUnique(model);
        else throw new ModelError(`Index type '${this.type}' not implemented yet`);
    }

    skipIndex(model: InstanceType<M>): boolean {
        for (const fieldName of this.fieldNames) {
            const fieldConfig = this.MyModel.fields[fieldName];
            if (fieldConfig.type.skipIndex(model[fieldName])) return true;
        }
        return false;
    }

    savePrimary(model: InstanceType<M>) {
        let keyBytes = new Bytes().writeNumber(this.getIndexId());
        this.serializeModelKey(model, keyBytes);
        
        let valBytes = new Bytes();
        // Serialize all non-primary key fields
        for (const [fieldName, fieldConfig] of Object.entries(model.fields)) {
            if (!this.fieldNames.includes(fieldName as any)) {
                if (!fieldConfig.type.skipIndex((model as any)[fieldName])) {
                    fieldConfig.type.serialize((model as any)[fieldName], valBytes);
                }
            }
        }
        
        olmdb.put(keyBytes.getBuffer(), valBytes.getBuffer());
    }

    /**
     * TODO
     * Does it make sense to include the primary key index id within each secondary index value?
     * It's convenient, because we don't need to prefix the buffer (which we can only do by rewriting it.)
     * It does waste space though.
     */

    saveUnique(model: InstanceType<M>) {
        let newKeyBytes;
        if (!this.skipIndex(model)) {
            newKeyBytes = new Bytes().writeNumber(this.getIndexId());
            this.serializeModelKey(model, newKeyBytes);
        }

        // Check if index values have changed
        if (model._originalValues) {
            let orgKeyBytes;
            if (!this.skipIndex(model._originalValues as any)) {
                orgKeyBytes = new Bytes().writeNumber(this.getIndexId());
                this.serializeModelKey(model._originalValues as any, orgKeyBytes);
            }
            if ((!newKeyBytes && !orgKeyBytes) || (newKeyBytes && orgKeyBytes && Buffer.compare(newKeyBytes.getBuffer(), orgKeyBytes.getBuffer()) === 0)) {
                // No change in index key, nothing to do
                return;
            }
            // Delete the old key
            if (orgKeyBytes) olmdb.del(orgKeyBytes.getBuffer());
        }
        
        if (!newKeyBytes) {
            // No new key, nothing to do
            return;
        }

        // Check if key already exists
        if (olmdb.get(newKeyBytes.getBuffer())) {
            throw new ModelError(`Unique constraint violation for ${model.constructor.tableName}[${this.fieldNames.join('+')}]`);
        }
        
        // Value is the primary key
        let valBytes = new Bytes().writeNumber(model.constructor.pk!.getIndexId());
        model.constructor.pk!.serializeModelKey(model, valBytes);

        olmdb.put(newKeyBytes.getBuffer(), valBytes.getBuffer());
    }
}

function deepClone(obj: Record<string, any>): Record<string, any> {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(deepClone);
    
    const clone: Record<string, any> = {};
    for (const key in obj) {
        clone[key] = deepClone(obj[key]);
    }
    return clone;
}

type IndexType = 'primary' | 'unique' | 'secondary';

export function index<M extends typeof Model<any>, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F, type?: IndexType) : Index<M, [F]>;
export function index<M extends typeof Model<any>, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS, type?: IndexType) : Index<M, FS>;

export function index(MyModel: typeof Model<any>, fields: any, type: IndexType = 'secondary') {
    return new Index(MyModel, Array.isArray(fields) ? fields : [fields], type);
}


const INIT_INSTANCE_SYMBOL = Symbol();

export interface Model<SUB> {
  constructor: typeof Model<SUB>;
}

// Base Model class
export abstract class Model<SUB> {
    static pk?: Index<any, any>;
    static _indexes: Index<any, any>[] = [];

    static tableName: string = this.name;
    static fields: Record<string, FieldConfig<unknown>>;
    fields!: Record<string, FieldConfig<unknown>>;
    
    // Track original values for change detection
    _originalValues?: Record<string, any>;

    constructor(initial: Partial<Omit<SUB, "constructor">> = {}) {
        // This constructor will only be called once, from `initModels`. All other instances will
        // be created by the 'fake' constructor. The typing for `initial` *is* important though.
        if (initial as any !== INIT_INSTANCE_SYMBOL) {
            throw new ModelError("The model needs a @registerModel decorator");
        }
    }

    // Serialization and persistence
    save() {
        this.validate(true);
        
        
        // Handle unique indexes
        for (const idx of this.constructor._indexes) {
            idx.save(this)
        }
        
        // Update original values
        const originalOriginalValues = this._originalValues;
        this._originalValues = deepClone(this as any);
        olmdb.onRevert(() => {
            this._originalValues = originalOriginalValues
        });
        return this;
    }

    // Static load method
    static load(...args: any[]) {
        return this.pk!.get(...args);
    }

    // Discard changes by restoring original values
    discard() {
        if (this._originalValues) {
            Object.assign(this, deepClone(this._originalValues));
        }
    }

    validate(raise: boolean = false): ModelError[] {
        const errors: ModelError[] = [];
        
        for (const [key, fieldConfig] of Object.entries(this.fields)) {
            const value = (this as any)[key];
            for (const error of fieldConfig.type.getErrors(value)) {
                if (raise) throw error.addPath(key);
                errors.push(error.addPath(key));
            }
        }
        return errors;
    }
    
    isValid(): boolean {
        return this.validate().length === 0;
    }
}

// Link type for models
class LinkType<T extends typeof Model<any>> extends TypeWrapper<InstanceType<T>> {
    kind = 'link';
    
    constructor(public TargetModel: T) {
        super();
    }
    
    serialize(value: InstanceType<T>, bytes: Bytes): void {
        this.TargetModel.pk!.serializeModelKey(value, bytes);
    }
    
    deserialize(obj: any, prop: string, bytes: Bytes) {
        const pk = this.TargetModel.pk!.deserializeKey(bytes);
        const TargetModel = this.TargetModel;

        // Define a getter to load the model on first access
        Object.defineProperty(obj, prop, {
            get: function() {
                const model = new (TargetModel as any)();
                if (!model.load(...pk)) {
                    throw new ModelError(`Failed to load model ${TargetModel.name} with primary key ${pk}`);
                }
                // Override this property with the loaded value
                this[prop] = model;
                return model;
            },
            set: function(newValue) {
                Object.defineProperty(this, prop, {
                    value: newValue,
                    writable: true,
                    enumerable: true,
                    configurable: true
                });
            },
            enumerable: true,
            configurable: true
        });
    }
    
    getErrors(value: any): ModelError[] {
        if (!(value instanceof this.TargetModel)) {
            return [new ModelError(`Expected instance of ${this.TargetModel.name}, got ${typeof value}`)];
        }
        return [];
    }
    
    serializeType(bytes: Bytes): void {
        bytes.writeString(this.TargetModel.tableName);
    }
    
    static deserializeType(bytes: Bytes, featureFlags: number): LinkType<any> {
        const tableName = bytes.readString();
        const targetModel = MODEL_REGISTRY[tableName];
        if (!targetModel) throw new ModelError(`Model ${tableName} not found in registry`);
        return new LinkType(targetModel);
    }
}

const ID_REGEX = /^[0-9a-fA-F]{10}$/;

class IdentifierType extends TypeWrapper<string> {
    kind = 'id';

    serialize(value: string, bytes: Bytes): void {
        bytes.writeHex(value);
    }
    
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        obj[prop] = bytes.readHex(5);
    }
    
    getErrors(value: any): ModelError[] {
        if (!value.match(ID_REGEX)) {
            return [new ModelError(`Invalid ID format: ${value}`)];
        }
        return [];
    }
    
    serializeType(bytes: Bytes): void {
    }
    
    static deserializeType(bytes: Bytes, featureFlags: number): IdentifierType {
        return new IdentifierType();
    }

    default(model: Model<any>): string {
        // Generate a random ID, and if it already exists in the database, retry.
        let id: string;
        do {
            id = Math.random().toString(16).slice(2, 12); // 10 hex characters
        } while (olmdb.get(new Bytes().writeNumber(model.constructor.pk!.cachedIndexId!).writeHex(id).getBuffer()));
        return id;
    }
}

// Type helper shortcuts
export const string = new StringType();
export const number = new NumberType();
export const boolean = new BooleanType();
export const identifier = new IdentifierType();

export function literal<const T>(value: T) {
    return new LiteralType<T>(value);
}

export function or<const T extends (TypeWrapper<unknown>|BasicType)[]>(...choices: T) {
    return new OrType<UnwrapTypes<T>>(choices.map(wrapIfLiteral) as any); // Not sure why we need the any cast here...
}
    
const undef = new LiteralType(undefined);
export function opt<const T extends TypeWrapper<unknown>|BasicType>(inner: T) {
    return or(undef, inner);
}

export function array<const T>(inner: TypeWrapper<T>, opts: {min?: number, max?: number} = {}) {
    return new ArrayType<T>(wrapIfLiteral(inner), opts);
}

export function link<const T extends typeof Model<any>>(TargetModel: T) {
    return new LinkType<T>(TargetModel);
}


type BasicType = TypeWrapper<any> | string | number | boolean | undefined | null;
type UnwrapTypes<T extends BasicType[]> = {
    [K in keyof T]: T[K] extends TypeWrapper<infer U> ? U : T[K];
}[number];

type UnwrapType<T extends BasicType|TypeWrapper<unknown>> = T extends TypeWrapper<infer U> ? U : T;
type WrapType<T extends BasicType|TypeWrapper<unknown>> = T extends TypeWrapper<unknown> ? T : LiteralType<T>

// Extract field types from a model class
type ModelFields<T extends typeof Model> = {
    [K in keyof InstanceType<T>]: InstanceType<T>[K] extends TypeWrapper<infer U> ? U : InstanceType<T>[K];
}

// Utility functions
function wrapIfLiteral<const T>(type: TypeWrapper<T>): TypeWrapper<T>;
function wrapIfLiteral<const T>(type: T): LiteralType<T>;

function wrapIfLiteral(type: any) {
    return type instanceof TypeWrapper ? type : new LiteralType(type);
}

// Schema serialization utilities
function serializeType(arg: TypeWrapper<any>, bytes: Bytes) {
    bytes.writeString(arg.kind);
    arg.serializeType(bytes);
}

const TYPE_WRAPPERS: Record<string, TypeWrapper<any> | {deserializeType: (bytes: Bytes, featureFlags: number) => TypeWrapper<any>}> = {
    string: string,
    number: number,
    array: ArrayType,
    or: OrType,
    literal: LiteralType,
    boolean: boolean,
    link: LinkType,
};

function deserializeType(bytes: Bytes, featureFlags: number): TypeWrapper<any> {
    const kind = bytes.readString();
    const TypeWrapper = TYPE_WRAPPERS[kind];
    if ('deserializeType' in TypeWrapper) {
        return TypeWrapper.deserializeType(bytes, featureFlags);
    } else {
        return TypeWrapper;
    }
}
