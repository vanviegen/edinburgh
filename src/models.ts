import { DatabaseError } from "olmdb";
import * as olmdb from "olmdb";
import { TypeWrapper, identifier } from "./types.js";
import { BaseIndex, TARGET_SYMBOL, PrimaryIndex } from "./indexes.js";
import { assert, addErrorPath, logLevel } from "./utils.js";

/**
 * Configuration interface for model fields.
 * @template T - The field type.
 */
export interface FieldConfig<T> {
    /** The type wrapper that defines how this field is serialized/validated. */
    type: TypeWrapper<T>;
    /** Optional human-readable description of the field. */
    description?: string;
    /** Optional default value or function that generates default values. */
    default?: T | ((model: Record<string,any>) => T);
}

/**
 * Create a field definition for a model property.
 * 
 * This function uses TypeScript magic to return the field configuration object
 * while appearing to return the actual field value type to the type system.
 * This allows for both runtime introspection and compile-time type safety.
 * 
 * @template T - The field type.
 * @param type - The type wrapper for this field.
 * @param options - Additional field configuration options.
 * @returns The field value (typed as T, but actually returns FieldConfig<T>).
 * 
 * @example
 * ```typescript
 * class User extends E.Model<User> {
 *   name = E.field(E.string, {description: "User's full name"});
 *   age = E.field(E.opt(E.number), {description: "User's age", default: 25});
 * }
 * ```
 */
export function field<T>(type: TypeWrapper<T>, options: Partial<FieldConfig<T>> = {}): T {
    // Return the config object, but TypeScript sees it as type T
    options.type = type;
    return options as any;
}

// Model registration and initialization
let uninitializedModels = new Set<typeof Model<unknown>>();
export const modelRegistry: Record<string, typeof Model> = {};

export function resetModelCaches() {
    for(const model of Object.values(modelRegistry)) {
        for(const index of model._indexes || []) {
            index._cachedIndexId = undefined;
        }
    }
}

function isObjectEmpty(obj: object) {
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) return false;
    }
    return true;
}

type OnSaveType = (model: InstanceType<typeof Model>, newKey: Uint8Array | undefined, oldKey: Uint8Array | undefined) => void;
let onSave: OnSaveType | undefined;
/**
 * Set a callback function to be called after a model is saved and committed.
 *
 * @param callback The callback function to set. As arguments, it receives the model instance, the new key (undefined in case of a delete), and the old key (undefined in case of a create).
 */
export function setOnSaveCallback(callback: OnSaveType | undefined) {
    onSave = callback;
}
const onSaveQueue: [InstanceType<typeof Model>, Uint8Array | undefined, Uint8Array | undefined][] = [];
function onSaveRevert() {
    onSaveQueue.length = 0;
}
function onSaveCommit() {
    if (onSave) {
        for(let arr of onSaveQueue) {
            onSave(...arr);
        }
    }
    onSaveQueue.length = 0;
}
function queueOnSave(arr: [InstanceType<typeof Model>, Uint8Array | undefined, Uint8Array | undefined]) {
    if (onSave) {
        if (!onSaveQueue.length) {
            olmdb.onCommit(onSaveCommit);
            olmdb.onRevert(onSaveRevert);
        }
        onSaveQueue.push(arr);
    }
}

/**
 * Register a model class with the Edinburgh ORM system.
 * 
 * This decorator function transforms the model class to use a proxy-based constructor
 * that enables change tracking and automatic field initialization. It also extracts
 * field metadata and sets up default values on the prototype.
 * 
 * @template T - The model class type.
 * @param MyModel - The model class to register.
 * @returns The enhanced model class with ORM capabilities.
 * 
 * @example
 * ```typescript
 * ⁣@E.registerModel
 * class User extends E.Model<User> {
 *   static pk = E.index(User, ["id"], "primary");
 *   id = E.field(E.identifier);
 *   name = E.field(E.string);
 * }
 * ```
 */
export function registerModel<T extends typeof Model<unknown>>(MyModel: T): T {
    const MockModel = getMockModel(MyModel);

    // Copy own static methods/properties
    for(const name of Object.getOwnPropertyNames(MyModel)) {
        if (name !== 'length' && name !== 'prototype' && name !== 'name' && name !== 'mock') {
            (MockModel as any)[name] = (MyModel as any)[name];
        }
    }

    // Initialize an empty `fields` object, and set it on both constructors, as well as on the prototype.
    MockModel.fields = MockModel.prototype._fields = {};
    MockModel.tableName ||= MyModel.name; // Set the table name to the class name if not already set

    // Register the constructor by name
    if (MockModel.tableName in modelRegistry) throw new DatabaseError(`Model with table name '${MockModel.tableName}' already registered`, 'INIT_ERROR');
    modelRegistry[MockModel.tableName] = MockModel;

    // Attempt to instantiate the class and gather field metadata
    uninitializedModels.add(MyModel);
    initModels();

    return MockModel;
}

export function getMockModel<T extends typeof Model<unknown>>(OrgModel: T): T {
    const AnyOrgModel = OrgModel as any;
    if (AnyOrgModel._isMock) return OrgModel;
    if (AnyOrgModel._mock) return AnyOrgModel._mock;

    const MockModel = function (this: any, initial?: Record<string,any>) {
        if (uninitializedModels.has(this.constructor)) {
            throw new DatabaseError("Cannot instantiate while linked models haven't been registered yet", 'INIT_ERROR');
        }
        if (initial && !isObjectEmpty(initial)) {
            Object.assign(this, initial);
            const modifiedInstances = olmdb.getTransactionData(MODIFIED_INSTANCES_SYMBOL) as Set<Model<any>>;
            modifiedInstances.add(this);
        }

        return new Proxy(this, modificationTracker);
    } as any as T;

    // We want .constructor to point at our fake constructor function.
    OrgModel.prototype.constructor = MockModel as any;

    // Copy the prototype chain for the constructor as well as for instantiated objects
    Object.setPrototypeOf(MockModel, Object.getPrototypeOf(OrgModel));
    MockModel.prototype = OrgModel.prototype;
    (MockModel as any)._isMock = true;
    AnyOrgModel._mock = MockModel;
    return MockModel;
}

function initModels() {
    for(const OrgModel of uninitializedModels) {
        const MockModel = getMockModel(OrgModel);
        // Create an instance (the only one to ever exist) of the actual class,
        // in order to gather field config data. 
        let instance;
        try {
            instance = new (OrgModel as any)(INIT_INSTANCE_SYMBOL);
        } catch(e) {
            if (!(e instanceof ReferenceError)) throw e;
            // ReferenceError: Cannot access 'SomeLinkedClass' before initialization.
            // We'll try again after the next class has successfully initialized.
            continue;
        }

        uninitializedModels.delete(OrgModel);

        // If no primary key exists, create one using 'id' field
        if (!MockModel._pk) {
            // If no `id` field exists, add it automatically
            if (!instance.id) {
                instance.id = { type: identifier }; 
            }
            // @ts-ignore-next-line - `id` is not part of the type, but the user probably shouldn't touch it anyhow
            new PrimaryIndex(MockModel, ['id']);
        }

        for (const key in instance) {
            const value = instance[key] as FieldConfig<unknown>;
            // Check if this property contains field metadata
            if (value && value.type instanceof TypeWrapper) {
                // Set the configuration on the constructor's `fields` property
                MockModel.fields[key] = value;

                // Set default value on the prototype
                const defObj = value.default===undefined ? value.type : value;
                const def = defObj.default;
                if (typeof def === 'function') {
                    // The default is a function. We'll define a getter on the property in the model prototype,
                    // and once it is read, we'll run the function and set the value as a plain old property
                    // on the instance object.
                    Object.defineProperty(MockModel.prototype, key, {    
                        get() {
                            // This will call set(), which will define the property on the instance.
                            return (this[key] = def.call(defObj, this));
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
                    (MockModel.prototype as any)[key] = def;
                }
            }
        }

        if (logLevel >= 1) {
            console.log(`Registered model ${MockModel.tableName}[${MockModel._pk!._fieldNames.join(',')}] with fields: ${Object.keys(MockModel.fields).join(' ')}`);
        }
    }
}

// Model base class and related symbols/state
const INIT_INSTANCE_SYMBOL = Symbol();

/** @internal Symbol used to attach modified instances to running transaction */
export const MODIFIED_INSTANCES_SYMBOL = Symbol('modifiedInstances');

/** @internal Symbol used to access the underlying model from a proxy */

/**
 * Model interface that ensures proper typing for the constructor property.
 * @template SUB - The concrete model subclass.
 */
export interface Model<SUB> {
  constructor: typeof Model<SUB>;
}

/**
 * Base class for all database models in the Edinburgh ORM.
 * 
 * Models represent database entities with typed fields, automatic serialization,
 * change tracking, and relationship management. All model classes should extend
 * this base class and be decorated with `@registerModel`.
 *
 * @template SUB - The concrete model subclass (for proper typing).
 * 
 * @example
 * ```typescript
 * ⁣@E.registerModel
 * class User extends E.Model<User> {
 *   static pk = E.index(User, ["id"], "primary");
 *   
 *   id = E.field(E.identifier);
 *   name = E.field(E.string);
 *   email = E.field(E.string);
 *   
 *   static byEmail = E.index(User, "email", "unique");
 * }
 * ```
 */
export abstract class Model<SUB> {
    /** @internal Primary key index for this model. */
    static _pk?: PrimaryIndex<any, any>;
    /** @internal All indexes for this model, the primary key being first. */
    static _indexes?: BaseIndex<any, any>[];

    /** The database table name (defaults to class name). */
    static tableName: string;
    /** Field configuration metadata. */
    static fields: Record<string, FieldConfig<unknown>>;

    /*
     * IMPORTANT: We cannot use instance property initializers here, because we will be
     * initializing the class through a fake constructor that will skip these. This is
     * intentional, as we don't want to run the initializers for the fields.
     */
    
    /** @internal Field configuration for this instance. */
    _fields!: Record<string, FieldConfig<unknown>>;

    /** 
     * @internal State tracking for this model instance:
     * - undefined: new instance, unmodified
     * - 1: new instance, modified (and in modifiedInstances)
     * - 2: loaded from disk, unmodified
     * - 3: persistence disabled
     * - array: loaded from disk, modified (and in modifiedInstances), array values are original index buffers
     */
    _state: undefined | 1 | 2 | 3 | Array<Uint8Array>;

    constructor(initial: Partial<Omit<SUB, "constructor">> = {}) {
        // This constructor will only be called once, from `initModels`. All other instances will
        // be created by the 'fake' constructor. The typing for `initial` *is* important though.
        if (initial as any !== INIT_INSTANCE_SYMBOL) {
            throw new DatabaseError("The model needs a @registerModel decorator", 'INIT_ERROR');
        }
    }

    _save() {
        // For performance, we'll work on the unproxied object, as we know we don't require change tracking for save.
        const unproxiedModel = ((this as any)[TARGET_SYMBOL] || this) as Model<SUB>;

        unproxiedModel.validate(true);

        // Handle unique indexes
        const indexes = this.constructor._indexes!;
        const originalKeys = typeof unproxiedModel._state === 'object' ? unproxiedModel._state : undefined;
        const newPk = indexes[0]._save(unproxiedModel, originalKeys?.[0]);
        for (let i=1; i<indexes.length; i++) {
            indexes[i]._save(unproxiedModel, originalKeys?.[i]);
        }

        queueOnSave([this, newPk, originalKeys?.[0]]);

        unproxiedModel._state = 2; // Loaded from disk, unmodified
    }


    /**
     * Load a model instance by primary key.
     * @param args - Primary key field values.
     * @returns The model instance if found, undefined otherwise.
     * 
     * @example
     * ```typescript
     * const user = User.load("user123");
     * const post = Post.load("post456", "en");
     * ```
     */
    static load<SUB>(this: typeof Model<SUB>, ...args: any[]): SUB | undefined {
        return this._pk!.get(...args);
    }

    /**
     * Prevent this instance from being persisted to the database.
     * 
     * Removes the instance from the modified instances set and disables
     * automatic persistence at transaction commit.
     * 
     * @returns This model instance for chaining.
     * 
     * @example
     * ```typescript
     * const user = User.load("user123");
     * user.name = "New Name";
     * user.preventPersist(); // Changes won't be saved
     * ```
     */
    preventPersist() {
        const modifiedInstances = olmdb.getTransactionData(MODIFIED_INSTANCES_SYMBOL) as Set<Model<any>>;
        const unproxiedModel = (this as any)[TARGET_SYMBOL] || this;
        modifiedInstances.delete(unproxiedModel);

        unproxiedModel._state = 3; // no persist
        return this;
    }

    /**
     * Delete this model instance from the database.
     * 
     * Removes the instance and all its index entries from the database and prevents further persistence.
     * 
     * @example
     * ```typescript
     * const user = User.load("user123");
     * user.delete(); // Removes from database
     * ```
     */
    delete() {
        const unproxiedModel = ((this as any)[TARGET_SYMBOL] || this) as Model<SUB>;
        
        if (this._state === 2 || typeof this._state === 'object') {
            for(const index of unproxiedModel.constructor._indexes!) {
                const key = index._getKeyFromModel(unproxiedModel, true);
                olmdb.del(key);
                if (index instanceof PrimaryIndex) queueOnSave([this, undefined, key]);
            }
        }

        this.preventPersist();
    }

    /**
     * Validate all fields in this model instance.
     * @param raise - If true, throw on first validation error.
     * @returns Array of validation errors (empty if valid).
     * 
     * @example
     * ```typescript
     * const user = new User();
     * const errors = user.validate();
     * if (errors.length > 0) {
     *   console.log("Validation failed:", errors);
     * }
     * ```
     */
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
    
    /**
     * Check if this model instance is valid.
     * @returns true if all validations pass.
     * 
     * @example
     * ```typescript
     * const user = new User({name: "John"});
     * if (!user.isValid()) shoutAtTheUser();
     * ```
     */
    isValid(): boolean {
        return this.validate().length === 0;
    }
}

// We use recursive proxies to track modifications made to, say, arrays within models. In
// order to know which model a nested object belongs to, we maintain a WeakMap that maps
// objects to their owner (unproxied) model.
const modificationOwnerMap = new WeakMap<object, Model<any>>();

// A cache for the proxies around nested objects, so that we don't need to recreate them
// every time we access a property on a nested object (and so that their identity remains
// the same).
const modificationProxyCache = new WeakMap<object, any>();

// Single proxy handler for both models and nested objects
export const modificationTracker: ProxyHandler<any> = {
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
        if (state !== undefined && state !== 2) {
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
            if (!model._fields[prop as string]) {
                // No need to track properties that are not model fields.
                (target as any)[prop] = value;
                return true;
            }
        } else {
            model = modificationOwnerMap.get(target);
            assert(model);
        }
        
        let state = model._state;
        if (state === undefined || state === 2) {
            const modifiedInstances = olmdb.getTransactionData(MODIFIED_INSTANCES_SYMBOL) as Set<Model<any>>;
            modifiedInstances.add(model);
            if (state === 2) {
                model._state = model.constructor._indexes!.map(idx => idx._getKeyFromModel(model, true));
            } else {
                model._state = 1;
            }
        }

        target[prop] = value;
        return true;
    }
};
