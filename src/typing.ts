import { Bytes } from "./bytes";
import { DatabaseError } from "olmdb";
import * as olmdb from "olmdb";

// We use recursive proxies to track modifications made to, say, arrays within models. In
// order to know which model a nested object belongs to, we maintain a WeakMap that maps
// objects to their owner (unproxied) model.
const modificationOwnerMap = new WeakMap<object, Model<any>>();

// A cache for the proxies around nested objects, so that we don't need to recreate them
// every time we access a property on a nested object (and so that their identity remains
// the same).
const modificationProxyCache = new WeakMap<object, any>();

// This symbol can be read as a property to get the underlying model from a proxy.
const TARGET_SYMBOL = Symbol('target');

// This symbol is used to attach a set of modified instances to the running transaction.
const MODIFIED_INSTANCES_SYMBOL = Symbol('modifiedInstances');

let logLevel = 0;


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

export {DatabaseError, init, onCommit, onRevert, getTransactionData, setTransactionData} from "olmdb";

const ERROR_AT = /^(.*) at ([a-zA-Z0-9_.]+)$/

function addErrorPath(error: DatabaseError, path: string | number): DatabaseError {
    const m = error.message.match(ERROR_AT);
    error.message = m ? `${m[1]} at ${path}.${m[2]}` : `${error.message} at ${path}`;
    return error;
}


// Single proxy handler for both models and nested objects
const modificationTracker: ProxyHandler<any> = {
    get(target, prop) {
        if (prop === TARGET_SYMBOL) return target;
        const value = target[prop];
        if (!value || typeof value !== 'object' || (value instanceof Model)) return value;

        // Check cache first
        let proxy = modificationProxyCache.get(value);
        if (proxy) return proxy;

        let model;
        if (target instanceof Model) {
            if (!target._fields[prop as string]) {
                // No need to track properties that are not model fields.
                return value;
            }
            model = target;
        } else {
            model = modificationOwnerMap.get(target);
            assert(model);
        }

        let state = model._state;
        if (state !== 0 && state !== 2) {
            // We don't need to track changes for this model (anymore). So we can just return the unproxied object.
            // As we doing the modificationProxyCache lookup first, the identity of returned objects will not change:
            // once a proxied object is returned, the same property will always return a proxied object.
            return value;
        }
        
        if (modificationOwnerMap.get(value)) {
            throw new DatabaseError("Object cannot be embedded in multiple model instances", 'VALUE_ERROR');
        }
        modificationOwnerMap.set(value, model);
        proxy = new Proxy(value, modificationTracker);
        modificationProxyCache.set(value, proxy);
        return proxy;
    },
    set(target, prop, value) {
        let model;
        if (target instanceof Model) {
            model = target;
        } else {
            model = modificationOwnerMap.get(target);
            assert(model);
        }

        let state = model._state;
        if (state === 0 || state === 2) {
            const modifiedInstances = olmdb.getTransactionData(MODIFIED_INSTANCES_SYMBOL) as Set<Model<any>>;
            modifiedInstances.add(model);
            if (state === 2) {
                model._state = model.constructor._indexes!.map(idx => idx.getKeyFromModel(model, idx.type === 'primary', false));
            } else {
                model._state = 1;
            }
        }

        target[prop] = value;
        return true;
    }
};


export abstract class TypeWrapper<const T> {
    _T!: T; // This field *is* required, because of reasons!
    abstract kind: string;

    constructor() {}
    abstract serialize(obj: any, prop: string|number, bytes: Bytes, model?: Model<any>): void;
    abstract deserialize(obj: any, prop: string|number, bytes: Bytes, model?: Model<any>): void;
    abstract getErrors(obj: any, prop: string | number): DatabaseError[];
    validateAndSerialize(obj: any, prop: string|number, bytes: Bytes, model?: Model<any>): void {
        const errors = this.getErrors(obj, prop);
        if (errors.length) throw errors[0];
        this.serialize(obj, prop, bytes, model);
    }
    serializeType(bytes: Bytes) {}
    
    // Skip indexing for this field value
    checkSkipIndex(obj: any, prop: string | number): boolean {
        return false;
    }
}

// Subclasses *may* default a default value, but usually should not.
export interface TypeWrapper<T> {
    default?(model: Model<T>): T;
}

export class StringType extends TypeWrapper<string> {
    kind = 'string';
    serialize(obj: any, prop: string, bytes: Bytes, model?: Model<any>) {
        bytes.writeString(obj[prop]);
    }
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>): void {
        obj[prop] = bytes.readString();
    }
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        if (typeof obj[prop] !== 'string') {
            return [new DatabaseError(`Expected string, got ${typeof obj[prop]}`, 'INVALID_TYPE')];
        }
        return [];
    }
}

export class NumberType extends TypeWrapper<number> {
    kind = 'number';
    serialize(obj: any, prop: string, bytes: Bytes, model?: Model<any>) {
        bytes.writeNumber(obj[prop]);
    }
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>): void {
        obj[prop] = bytes.readNumber();
    }
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        const value = obj[prop];
        if (typeof value !== 'number' || isNaN(value)) {
            return [new DatabaseError(`Expected number, got ${typeof value}`, 'INVALID_TYPE')];
        }
        return [];
    }
}

export class ArrayType<T> extends TypeWrapper<T[]> {
    kind = 'array';
    constructor(public inner: TypeWrapper<T>, public opts: {min?: number, max?: number} = {}) {
        super();
    }

    serialize(obj: any, prop: string, bytes: Bytes, model?: Model<any>) {
        const value = obj[prop] as T[];
        bytes.writeNumber(value.length);
        for(let i=0; i<value.length; i++) {
            this.inner.serialize(value, i, bytes, model);
        }
    }
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>): void {
        const length = bytes.readNumber();
        const result: T[] = [];
        for (let i = 0; i < length; i++) {
            this.inner.deserialize(result, i, bytes, model);
        }
        obj[prop] = result;
    }
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        const value = obj[prop];
        if (!Array.isArray(value)) {
            return [new DatabaseError(`Expected array, got ${typeof value}`, 'INVALID_TYPE')];
        }
        const errors: DatabaseError[] = [];
        if (this.opts.min !== undefined && value.length < this.opts.min) {
            errors.push(new DatabaseError(`Array length ${value.length} is less than minimum ${this.opts.min}`, 'OUT_OF_BOUNDS'));
        }
        if (this.opts.max !== undefined && value.length > this.opts.max) {
            errors.push(new DatabaseError(`Array length ${value.length} is greater than maximum ${this.opts.max}`, 'OUT_OF_BOUNDS'));
        }
        for (let i = 0; i < value.length; i++) {
            for(let itemError of this.inner.getErrors(value, i)) {
                errors.push(addErrorPath(itemError, i));
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
    _getChoiceIndex(obj: any, prop: string | number): number {
        for (const [i, choice] of this.choices.entries()) {
            if (choice.getErrors(obj, prop).length === 0) {
                return i;
            }
        }
        throw new DatabaseError(`Value does not match any union type: ${obj[prop]}`, 'INVALID_TYPE');
    }
    serialize(obj: any, prop: string, bytes: Bytes, model?: Model<any>) {
        const choiceIndex = this._getChoiceIndex(obj, prop);
        bytes.writeUIntN(choiceIndex, this.choices.length-1);
        this.choices[choiceIndex].serialize(obj, prop, bytes, model);
    }
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>): void {
        const index = bytes.readUIntN(this.choices.length-1);
        if (index < 0 || index >= this.choices.length) {
            throw new DatabaseError(`Could not deserialize invalid union index ${index}`, 'DESERIALIZATION_ERROR');
        }
        const type = this.choices[index];
        type.deserialize(obj, prop, bytes, model);
    }
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        const errors: DatabaseError[] = [];
        for (let i = 0; i < this.choices.length; i++) {
            const type = this.choices[i];
            const subErrors = type.getErrors(obj, prop);
            if (subErrors.length === 0) return [];
            for (let err of subErrors) {
                errors.push(addErrorPath(err, `opt${i+1}`));
            }
        }
        return errors;
    }
    checkSkipIndex(obj: any, prop: string | number): boolean {
        const choiceIndex = this._getChoiceIndex(obj, prop);
        return this.choices[choiceIndex].checkSkipIndex(obj, prop);
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
    serialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>) {
    }
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>): void {
        obj[prop] = this.value;
    }
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        return this.value===obj[prop] ? [] : [new DatabaseError(`Invalid literal value ${obj[prop]} instead of ${this.value}`, 'INVALID_TYPE')];
    }
    serializeType(bytes: Bytes): void {
        bytes.writeString(JSON.stringify(this.value));
    }

    checkSkipIndex(obj: any, prop: string | number): boolean {
        return obj[prop] == null;
    }
    
    static deserializeType(bytes: Bytes, featureFlags: number): LiteralType<any> {
        const value = JSON.parse(bytes.readString());
        return new LiteralType(value);
    }
}

class BooleanType extends TypeWrapper<boolean> {
    kind = 'boolean';
    serialize(obj: any, prop: string, bytes: Bytes, model?: Model<any>) {
        bytes.writeBits(obj[prop] ? 1 : 0, 1);
    }
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: Model<any>): void {
        obj[prop] = bytes.readBits(1) === 1;
    }
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        if (typeof obj[prop] !== 'boolean') {
            return [new DatabaseError(`Expected boolean, got ${typeof obj[prop]}`, 'INVALID_TYPE')];
        }
        return [];
    }
}

// Field configuration interface
export interface FieldConfig<T> {
    type: TypeWrapper<T>;
    description?: string;
    default?: T | ((model: Record<string,any>) => T);
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
const modelRegistry: Record<string, typeof Model> = {};
const registerModelCache = new WeakMap<typeof Model, typeof Model>();

function isObjectEmpty(obj: object) {
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) return false;
    }
    return true;
}

export function registerModel<T extends typeof Model<unknown>>(cls: T): T {
    if (cls.isProxied) return cls; // Object is already wrapped
    if (registerModelCache.has(cls)) {
        return registerModelCache.get(cls) as T;
    }
    function constructor(this: any, initial?: Record<string,any>) {
        if (uninitializedModels.has(this.constructor)) {
            throw new DatabaseError("Cannot instantiate while linked models haven't been registered yet", 'INIT_ERROR');
        }
        if (initial && !isObjectEmpty(initial)) {
            Object.assign(this, initial);
            const modifiedInstances = olmdb.getTransactionData(MODIFIED_INSTANCES_SYMBOL) as Set<Model<any>>;
            modifiedInstances.add(this);
        }

        return new Proxy(this, modificationTracker);
    }

    // We want .constructor to point at our fake constructor function.
    cls.prototype.constructor = constructor as any;

    // Copy the prototype chain for the constructor as well as for instantiated objects
    Object.setPrototypeOf(constructor, Object.getPrototypeOf(cls));
    constructor.prototype = cls.prototype;
    cls.tableName ||= cls.name; // Set the table name to the class name if not already set

    // Copy own static methods/properties
    for(const name of Object.getOwnPropertyNames(cls)) {
        if (name !== 'length' && name !== 'prototype' && name !== 'name') {
            (constructor as any)[name] = (cls as any)[name];
        }
    }

    // Initialize an empty `fields` object, and set it on both constructors, as well as on the prototype.
    const result = constructor as unknown as T;
    result.fields = cls.fields = constructor.prototype._fields = {};
    result.isProxied = true;

    // Register the constructor both by name and by original class
    registerModelCache.set(cls, result);
    modelRegistry[result.tableName] = result;

    // Attempt to instantiate the class and father field metadata
    uninitializedModels.add(cls);
    initModels();

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

        const proxied = registerModelCache.get(cls);
        assert(proxied);
        
        // If no primary key exists, create one using 'id' field
        if (!proxied._pk) {
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
                const def = value.default ?? value.type.default;
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
                } else if (def !== undefined) {
                    (cls.prototype as any)[key] = def;
                }
            }
        }

        if (logLevel >= 1) {
            console.log(`Registered model ${cls.tableName}[${proxied._pk?.fieldNames.join(',')}] with fields: ${Object.keys(cls.fields).join(' ')}`);
        }
    }
}


type IndexTuple<M extends typeof Model<any>, F extends readonly (keyof InstanceType<M> & string)[]> = {
  [I in keyof F]: InstanceType<M>[F[I]]
}

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;

class Index<M extends typeof Model<any>, const F extends readonly (keyof InstanceType<M> & string)[]> {
    private MyModel: M;
    constructor(MyModel: M, public fieldNames: F, public type: IndexType) {
        MyModel = this.MyModel = registerModel(MyModel);
        (MyModel._indexes ||= []).push(this);

        if (type === 'primary') {
            // Do not access .pk on the typed Model, as it will prevent to user from assigning the index
            // we're constructing to .pk on the model (circular type).
            if (MyModel._pk && MyModel._pk !== this) throw new DatabaseError(`Model ${MyModel.tableName} already has a primary key defined`, 'INIT_ERROR');
            MyModel._pk = this;
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

    serializeArgs(args: IndexTuple<M, F>, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.validateAndSerialize(args, i, bytes);
        }
    }

    getKeyFromArgs(args: IndexTuple<M, F>): Uint8Array {
        let indexId = this.getIndexId(); // We're pretty sure field names should not be number or symbols, right?
        let keyBytes = new Bytes().writeNumber(indexId);
        this.serializeArgs(args, keyBytes);
        return keyBytes.getBuffer();
    }

    serializeModel(model: InstanceType<M>, bytes: Bytes) {
        for (let i = 0; i < this.fieldNames.length; i++) {
            const fieldName = this.fieldNames[i];
            const fieldConfig = this.MyModel.fields[fieldName];
            fieldConfig.type.validateAndSerialize(model, fieldName, bytes, model);
        }
    }

    getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean, checkSkip: true): Uint8Array | undefined;
    getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean, checkSkip: false): Uint8Array;

    getKeyFromModel(model: InstanceType<M>, includeIndexId: boolean, checkSkip: boolean): Uint8Array | undefined {
        if (checkSkip && this.checkSkip(model)) return undefined;
        const bytes = new Bytes();
        if (includeIndexId) bytes.writeNumber(this.getIndexId());
        this.serializeModel(model, bytes);
        return bytes.getBuffer();
    }

    modelToArgs(model: InstanceType<M>): IndexTuple<M, F> | undefined {
        return this.checkSkip(model) ? undefined: this.fieldNames.map((fieldName) => model[fieldName]) as unknown as IndexTuple<M, F>;
    }

    getIndexId(): number {
        // Resolve an index to a number
        let indexId = this.cachedIndexId;
        if (indexId == null) {
            const indexNameBytes = new Bytes().writeNumber(INDEX_ID_PREFIX).writeString(this.MyModel.tableName).writeString(this.type);
            for(let name of this.fieldNames) indexNameBytes.writeString(name);
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

                const idBuf = new Bytes().writeNumber(indexId).getBuffer()
                olmdb.put(indexNameBuf, idBuf);
                olmdb.put(maxIndexIdBuf, idBuf); // This will also cause the transaction to rerun if we were raced
                if (logLevel >= 1) {
                    console.log(`Created index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] with id ${indexId}`);
                }
            }
        }
        return indexId;
    }

    // args should be an array with the types that the names in F have in InstanceType<M>
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
            // valueBuffer contains the index id and key of the primary key that holds the actual data.
            valueBuffer = olmdb.get(valueBuffer);
            if (!valueBuffer) throw new DatabaseError(`Unique index ${this.MyModel.tableName}[${this.fieldNames.join(', ')}] points at non-existing primary for key: ${args.join(', ')}`, 'CONSISTENCY_ERROR');
        }
        
        // This is a primary index. So we can now deserialize all primary and non-primary fields into instance values.
        const result = new (this.MyModel as any)() as InstanceType<M>;
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
                fieldConfig.type.deserialize(values, fieldName, valueBytes, result);
            }
        }

        return result;
    }

    save(model: InstanceType<M>, originalKey?: Uint8Array) {
        // Note: this can (and usually will) be called on the non-proxied model instance.
        assert(this.MyModel.prototype === model.constructor.prototype);
        if (this.type === 'primary') this.savePrimary(model, originalKey);
        else if (this.type === 'unique') this.saveUnique(model, originalKey);
        else throw new DatabaseError(`Index type '${this.type}' not implemented yet`, 'NOT_IMPLEMENTED');
    }

    checkSkip(model: InstanceType<M>): boolean {
        for (const fieldName of this.fieldNames) {
            const fieldConfig = this.MyModel.fields[fieldName];
            if (fieldConfig.type.checkSkipIndex(model, fieldName)) return true;
        }
        return false;
    }

    savePrimary(model: InstanceType<M>, originalKey?: Uint8Array) {
        let newKey = this.getKeyFromModel(model, true, false); // Cannot be undefined for primary
        // originalKey for primary includes the index id, so we can compare it directly
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

    saveUnique(model: InstanceType<M>, originalKey?: Uint8Array) {
        let newKey = this.getKeyFromModel(model, false, true);

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

function assert(cond: any, message?: string): asserts cond {
    if (!cond) {
        throw new Error(message || "Assertion failed");
    }
}

// Base Model class
export abstract class Model<SUB> {
    static _pk?: Index<any, any>;
    static _indexes?: Index<any, any>[];

    static tableName: string;
    static fields: Record<string, FieldConfig<unknown>>;
    static isProxied: boolean | undefined; // Set to true by `registerModel` to indicate that this is the proxied version.
    _fields!: Record<string, FieldConfig<unknown>>;

    // For models with reverse links, we're tracking which reverse links existed
    // when this instance was loaded, so that we know what to do on save().
    _reverseLinksToBeDeleted?: Map<LinkType<any>, Set<string>>; // The strings are JSONed primary keys

    /** The keys for all indexes *before* the instance was modified.
      * 0: new instance, unmodified
      * 1: new instance, modified (and in modifiedInstances)
      * 2: loaded from disk, unmodified
      * 3: persistence disabled
      * array: loaded from disk, modified (and in modifiedInstances), array values are original index buffers
      */
    _state: Array<Uint8Array> | 0 | 1 | 2 | 3 = 0;

    constructor(initial: Partial<Omit<SUB, "constructor">> = {}) {
        // This constructor will only be called once, from `initModels`. All other instances will
        // be created by the 'fake' constructor. The typing for `initial` *is* important though.
        if (initial as any !== INIT_INSTANCE_SYMBOL) {
            throw new DatabaseError("The model needs a @registerModel decorator", 'INIT_ERROR');
        }
    }

    // Serialization and persistence
    save() {
        // For performance, we'll work on the unproxied object, as we know we don't require change tracking for save.
        const unproxiedModel = ((this as any)[TARGET_SYMBOL] || this) as Model<SUB>;

        unproxiedModel.validate(true);

        // Handle unique indexes
        const indexes = this.constructor._indexes!;
        const originalKeys = typeof unproxiedModel._state === 'object' ? unproxiedModel._state : undefined;
        for (let i=0; i<indexes.length; i++) {
            indexes[i].save(unproxiedModel, originalKeys?.[i]);
        }

        // Delete reverse links for which source links have been removed.
        unproxiedModel._deleteReverseLinks();
        
        unproxiedModel._state = 2; // Loaded from disk, unmodified
    }

    _deleteReverseLinks() {
        if (!this._reverseLinksToBeDeleted) return;
        console.log(`Deleting reverse links for model ${this.constructor.name}`);
        for(const [linkType,jsonSet] of this._reverseLinksToBeDeleted) {
            for(const json of jsonSet) {
                const pkArray = JSON.parse(json) as any[];
                const reverseModel = linkType.TargetModel._pk!.get(...pkArray) as Model<unknown> | undefined;
                assert(reverseModel);
                const arr = (reverseModel as any)[linkType.reverse!];
                const i = arr.indexOf(this);
                assert(i >= 0);
                arr.splice(i, 1);
            }
        }
        delete this._reverseLinksToBeDeleted;
    }

    // Static load method
    static load<SUB>(this: typeof Model<SUB>, ...args: any[]): SUB | undefined {
        return this._pk!.get(...args);
    }

    // Changes to this instance will not be written to the database.
    preventPersist() {
        const modifiedInstances = olmdb.getTransactionData(MODIFIED_INSTANCES_SYMBOL) as Set<Model<any>>;
        modifiedInstances.delete((this as any)[TARGET_SYMBOL] || this);

        delete this._reverseLinksToBeDeleted;
        this._state = 3; // no persist
        return this;
    }

    delete() {
        const unproxiedModel = ((this as any)[TARGET_SYMBOL] || this) as Model<SUB>;
        unproxiedModel._deleteReverseLinks();

        olmdb.del(this.constructor._pk!.getKeyFromModel(unproxiedModel, true, false));
        this.preventPersist();
    }

    validate(raise: boolean = false): DatabaseError[] {
        const errors: DatabaseError[] = [];
        
        for (const [key, fieldConfig] of Object.entries(this._fields)) {
            for (const error of fieldConfig.type.getErrors(this, key)) {
                addErrorPath(error, key);
                if (raise) throw error;
                errors.push(error);
            }
        }
        return errors;
    }
    
    isValid(): boolean {
        return this.validate().length === 0;
    }
}

const WANT_PK_ARRAY = {};

class LinkType<T extends typeof Model<any>> extends TypeWrapper<InstanceType<T>> {
    kind = 'link';
    TargetModel: T;

    constructor(TargetModel: T, public reverse?: string & KeysOfType<InstanceType<T>, Model<any>[]>) {
        super();
        this.TargetModel = registerModel(TargetModel);
    }

    serialize(obj: any, prop: string | number, bytes: Bytes, model: Model<InstanceType<T>>): void {
        let pkArray;
        const pk = this.TargetModel._pk!;
        // If obj[prop] is getter(), it will return the primary key array (based on WANT_PK_ARRAY
        // being the receiver). Otherwise, it will just return the value, which is a model instance.
        let value = Reflect.get(obj, prop, WANT_PK_ARRAY) as any[] | Model<InstanceType<T>>;
        if (value instanceof Array) {
            // It's a pk array, and the object has not been loaded. We can just serialize it.
            pk.serializeArgs(value, bytes);
            if (!this.reverse) return;
            pkArray = value;
        } else {
            // It's a model instance that has been loaded
            pk.serializeModel(value, bytes);
            if (!this.reverse) return;
            pkArray = pk.modelToArgs(value);
        }
        const jsonSet = model._reverseLinksToBeDeleted?.get(this);

        if (jsonSet) {
            const pkJson = JSON.stringify(pkArray);
            if (jsonSet.has(pkJson)) {
                // Indicate that this link still exists, so it doesn't need to be removed from the reverse link map.
                // Nor do we need to add it.
                jsonSet.delete(pkJson);
                return;
            }
        }
        // This is a new link, so we need to add it to the reverse link map.

        // First check if the reverse link property on the target model is an array of links to this model.
        const targetType = this.TargetModel.fields[prop].type;
        if (!(targetType instanceof ArrayType)
            || !(targetType.inner instanceof LinkType)
            || (targetType.inner as LinkType<T>).TargetModel !== model.constructor
            || (targetType.inner as LinkType<T>).reverse) {
            throw new DatabaseError(`Reverse link property ${prop} on model ${this.TargetModel.tableName} should be a ${model.constructor.tableName}-links array without a reverse links`, 'INIT_ERROR');
        }

        const targetInstance = pk.get(...pkArray);
        assert(targetInstance);
        targetInstance[prop].push(obj);
        // The above will (through the Proxy) also add targetInstance back to modifiedInstances, so in case
        // it was already serialized before us, it will be serialized again. Not great, but good enough for now.
    }
    
    deserialize(obj: any, prop: string, bytes: Bytes, sourceModel: Model<unknown>) {
        const pk = this.TargetModel._pk!;
        const pkArray = pk.deserializeKey(bytes);

        if (this.reverse) {
            // We're keeping track of all reverse links, such that when we save() the model
            // later, we know which ones to remove.
            const linksWithRev = sourceModel._reverseLinksToBeDeleted ||= new Map();
            let linkSet = linksWithRev.get(this);
            if (!linkSet) linksWithRev.set(this, linkSet = new Set());
            // We need some way to serialize pkArray such that it can be used uniquely in a Set.
            // JSON kind of sucks (we loose 'undefined' values, number keys, and some other things),
            // but it's a lot easier than alternatives and relatively fast.
            linkSet.add(JSON.stringify(pkArray));
        }

        const TargetModel = this.TargetModel;

        // Define a getter to load the model on first access
        Object.defineProperty(obj, prop, {
            get: function() {
                // Special case to return the primary key array instead of load the model, used by serialize.
                if (this === WANT_PK_ARRAY) return pkArray; 
                const targetModel = TargetModel._pk!.get(...pkArray); // load by primary key Uint8Array
                if (!targetModel) {
                    throw new DatabaseError(`Linked ${TargetModel.tableName} instance ${pkArray.join(', ')} not found`, 'BROKEN_LINK');
                }
                this[prop] = targetModel; // Cause set() to be called, so our property will be come a regular value
                return targetModel;
            },
            set: function(newValue) {
                // Convert back to a regular value property
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

    getErrors(obj: any, prop: string | number): DatabaseError[] {
        if (!(obj[prop] instanceof this.TargetModel)) {
            return [new DatabaseError(`Expected instance of ${this.TargetModel.tableName}, got ${typeof obj[prop]}`, 'VALUE_ERROR')];
        }
        return [];
    }
    
    serializeType(bytes: Bytes): void {
        bytes.writeString(this.TargetModel.tableName);
    }
    
    static deserializeType(bytes: Bytes, featureFlags: number): LinkType<any> {
        const tableName = bytes.readString();
        const targetModel = modelRegistry[tableName];
        if (!targetModel) throw new DatabaseError(`Could not deserialize undefined model ${tableName}`, 'DESERIALIZATION_ERROR');
        return new LinkType(targetModel);
    }
}

const ID_SIZE = 7;

class IdentifierType extends TypeWrapper<string> {
    kind = 'id';

    serialize(obj: any, prop: string|number, bytes: Bytes): void {
        const value = obj[prop];
        assert(value.length === ID_SIZE);
        bytes.writeBase64(value);
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes): void {
        obj[prop] = bytes.readBase64(ID_SIZE);
    }
    
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        const value = obj[prop];
        if (typeof value !== 'string' || value.length !== ID_SIZE) return [new DatabaseError(`Invalid ID format: ${value}`, 'VALUE_ERROR')];
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
            // Combine a timestamp with randomness, to create locality of reference as well as a high chance of uniqueness.
            // Bits 9...42 are the date (wrapping about four times a year)
            // Bit 0...14 are random bits (partly overlapping with the date, adding up to 31ms of jitter)
            let num = Math.floor(+new Date() * (1<<9) + Math.random() * (1<<14));

            id = '';
            for(let i = 0; i < ID_SIZE; i++) {
                id = Bytes.BASE64_CHARS[num & 0x3f] + id;
                num = Math.floor(num / 64);
            }
        } while (olmdb.get(new Bytes().writeNumber(model.constructor._pk!.cachedIndexId!).writeBase64(id).getBuffer()));
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

export type KeysOfType<T, TProp> = { [P in keyof T]: T[P] extends TProp? P : never}[keyof T];

export function link<const T extends typeof Model<any>>(TargetModel: T, reverse?: string & KeysOfType<InstanceType<T>, Model<any>[]>) {
    return new LinkType<T>(TargetModel, reverse);
}


type BasicType = TypeWrapper<any> | string | number | boolean | undefined | null;
type UnwrapTypes<T extends BasicType[]> = {
    [K in keyof T]: T[K] extends TypeWrapper<infer U> ? U : T[K];
}[number];

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
