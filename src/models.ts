import { DatabaseError } from "olmdb/lowlevel";
import { AsyncLocalStorage } from "node:async_hooks";
import { TypeWrapper, identifier } from "./types.js";

export const txnStorage = new AsyncLocalStorage<Transaction>();

/**
 * Returns the current transaction from AsyncLocalStorage.
 * Throws if called outside a transact() callback.
 * @internal
 */
export function currentTxn(): Transaction {
    const txn = txnStorage.getStore();
    if (!txn) throw new DatabaseError("No active transaction. Operations must be performed within a transact() callback.", 'NO_TRANSACTION');
    return txn;
}

export interface Transaction {
    id: number;
    instances: Set<Model<unknown>>;
    instancesByPk: Map<number, Model<unknown>>;
}
import { BaseIndex as BaseIndex, PrimaryIndex, IndexRangeIterator } from "./indexes.js";
import { addErrorPath, logLevel, assert, dbGet, hashBytes } from "./utils.js";

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
export const modelRegistry: Record<string, typeof Model> = {};
export const modelsNeedingDelayedInit: Set<typeof Model> = new Set();

function isObjectEmpty(obj: object) {
    for (let _ of Object.keys(obj)) {
        return false;
    }
    return true;
}

export type Change = Record<any, any> | "created" | "deleted";

/**
 * Register a model class with the Edinburgh ORM system.
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

    MockModel.tableName ||= MyModel.name; // Set the table name to the class name if not already set

    // Register the constructor by name
    if (MockModel.tableName in modelRegistry) throw new DatabaseError(`Model with table name '${MockModel.tableName}' already registered`, 'INIT_ERROR');
    modelRegistry[MockModel.tableName] = MockModel;

    return MockModel;   
}

export function getMockModel<T extends typeof Model<unknown>>(OrgModel: T): T {
    const AnyOrgModel = OrgModel as any;
    if (AnyOrgModel._isMock) return OrgModel;
    if (AnyOrgModel._mock) return AnyOrgModel._mock;

    const MockModel = function(this: any, initial?: Record<string,any>) {
        // This constructor should only be called when the user does 'new Model'. We'll bypass this when
        // loading objects. Add to 'instances', so the object will be saved.
        currentTxn().instances.add(this);
        if (initial) {
            Object.assign(this, initial);
        }
    } as any as T;

    // We want .constructor to point at our fake constructor function.
    OrgModel.prototype.constructor = MockModel as any;

    // Copy the prototype chain for the constructor as well as for instantiated objects
    Object.setPrototypeOf(MockModel, Object.getPrototypeOf(OrgModel));
    MockModel.prototype = OrgModel.prototype;
    (MockModel as any)._isMock = true;
    (MockModel as any)._original = OrgModel;
    AnyOrgModel._mock = MockModel;
    modelsNeedingDelayedInit.add(MockModel);
    return MockModel;
}

// Model base class and related symbols/state
const INIT_INSTANCE_SYMBOL = Symbol();

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
    static _primary: PrimaryIndex<any, any>;

    /** @internal All non-primary indexes for this model. */
    static _secondaries?: BaseIndex<any, readonly (keyof any & string)[]>[];

    /** The database table name (defaults to class name). */
    static tableName: string;

    /** Field configuration metadata. */
    static fields: Record<string | symbol | number, FieldConfig<unknown>>;

    /*
     * IMPORTANT: We cannot use instance property initializers here, because we will be
     * initializing the class through a fake constructor that will skip these. This is
     * intentional, as we don't want to run the initializers for the fields.
     */
    
    /** 
     * @internal
     * - _oldValues===undefined: New instance, not yet saved.
     * - _oldValues===null: Instance is to be deleted.
     * - _oldValues is an object: Loaded (possibly only partial, still lazy) from disk, _oldValues contains (partial) old values
     */
    _oldValues: Record<string, any> | undefined | null;
    _primaryKey: Uint8Array | undefined;
    _primaryKeyHash: number | undefined;

    constructor(initial: Partial<Omit<SUB, "constructor">> = {}) {
        // This constructor will only be called once, from `initModels`. All other instances will
        // be created by the 'fake' constructor. The typing for `initial` *is* important though.
        if (initial as any === INIT_INSTANCE_SYMBOL) return;
        throw new DatabaseError("The model needs a @registerModel decorator", 'INIT_ERROR');
    }

    static async _delayedInit(): Promise<void> {
        const MockModel = getMockModel(this);
        // Create an instance (the only one to ever exist) of the actual class,
        // in order to gather field config data.
        const OrgModel = (MockModel as any)._original || this;
        const instance = new (OrgModel as any)(INIT_INSTANCE_SYMBOL);

        // If no primary key exists, create one using 'id' field
        if (!MockModel._primary) {
            // If no `id` field exists, add it automatically
            if (!instance.id) {
                instance.id = { type: identifier }; 
            }
            // @ts-ignore-next-line - `id` is not part of the type, but the user probably shouldn't touch it anyhow
            new PrimaryIndex(MockModel, ['id']);
        }

        MockModel.fields = {};
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
                                writable: true,
                                enumerable: true,
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
            console.log(`Registered model ${MockModel.tableName} with fields: ${Object.keys(MockModel.fields).join(' ')}`);
        }
        await MockModel._primary._delayedInit();
        for (const sec of MockModel._secondaries || []) await sec._delayedInit();
    }

    _setLoadedField(fieldName: string, value: any) {
        const oldValues = this._oldValues!;
        if (oldValues.hasOwnProperty(fieldName)) return; // Already loaded earlier (as part of index key?)

        this[fieldName as keyof Model<SUB>] = value;
        if (typeof value === 'object' && value !== null) {            
            const fieldType = (this.constructor.fields[fieldName] as FieldConfig<unknown>).type;
            oldValues[fieldName] = fieldType.clone(value);
        } else {
            // This path is just an optimization
            oldValues[fieldName] = value;
        }
    }

    /**
     * @returns The primary key for this instance.
     */
    getPrimaryKey(): Uint8Array {
        let key = this._primaryKey;
        if (key === undefined) {
            key = this.constructor._primary!._instanceToKeyBytes(this).toUint8Array();
            this._setPrimaryKey(key);
        }
        return key;
    }

    _setPrimaryKey(key: Uint8Array, hash?: number) {
        this._primaryKey = key;
        this._primaryKeyHash = hash ?? hashBytes(key);
        Object.defineProperties(this, this.constructor._primary._freezePrimaryKeyDescriptors);
    }

    /**
     * @returns A 53-bit positive integer non-cryptographic hash of the primary key, or undefined if not yet saved.
     */
    getPrimaryKeyHash(): number {
        if (this._primaryKeyHash === undefined) this.getPrimaryKey();
        return this._primaryKeyHash!;
    }

    isLazyField(field: keyof this) {
        const descr = this.constructor._primary!._lazyDescriptors[field];
        return descr && 'get' in descr && descr.get === Reflect.getOwnPropertyDescriptor(this, field)?.get;
    }

    _write(txn: Transaction): undefined | Change {
        const oldValues = this._oldValues;

        if (oldValues === null) { // Delete instance
            this.constructor._primary._delete(txn, this);
            for(const index of this.constructor._secondaries || []) {
                index._delete(txn, this);
            }
            
            return "deleted";
        }
        
        if (oldValues === undefined) { // Create instance
            this.validate(true);

            // Make sure the primary key does not already exist
            if (dbGet(txn.id, this.getPrimaryKey())) {
                throw new DatabaseError("Unique constraint violation", "UNIQUE_CONSTRAINT");
            }

            // Insert the primary index
            this.constructor._primary!._write(txn, this);

            // Insert all secondaries
            for (const index of this.constructor._secondaries || []) {
                index._write(txn, this);
            }

            return "created";
        }

        // oldValues is an object.
        // We're doing an update. Note that we may still be in a lazy state, and we don't want to load
        // the whole object just to see if something changed.

        // Add old values of changed fields to 'changed'.
        const fields = this.constructor.fields;
        let changed : Record<any, any> = {};
        for(const fieldName of Object.keys(oldValues) as Iterable<keyof Model<SUB>>) {
            const oldValue = oldValues[fieldName];
            if (!(fields[fieldName] as FieldConfig<unknown>).type.equals(this[fieldName], oldValue)) {
                changed[fieldName] = oldValue;
            }
        }
        if (isObjectEmpty(changed)) return; // No changes, nothing to do

        // Make sure primary has not been changed
        for (const field of this.constructor._primary!._fieldTypes.keys()) {
            if (changed.hasOwnProperty(field)) {
                throw new DatabaseError(`Cannot modify primary key field: ${field}`, "CHANGE_PRIMARY");
            }
        }

        // We have changes. Now it's okay for any lazy fields to be loaded (which the validate will trigger).

        // Raise any validation errors
        this.validate(true);

        // Update the primary index
        this.constructor._primary!._write(txn, this);

        // Update any secondaries with changed fields
        for (const index of this.constructor._secondaries || []) {
            for (const field of index._fieldTypes.keys()) {
                if (changed.hasOwnProperty(field)) {
                    // We need to update this index - first delete the old one
                    index._delete(txn, oldValues);
                    index._write(txn, this)
                    break;
                }
            }
        }
        return changed;
    }

    /**
     * Prevent this instance from being persisted to the database.
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
        currentTxn().instances.delete(this);
        return this;
    }

    /**
     * Find all instances of this model in the database, ordered by primary key.
     * @param opts - Optional parameters.
     * @param opts.reverse - If true, iterate in reverse order.
     * @returns An iterator.
     */
    static findAll<T extends typeof Model<unknown>>(this: T, opts?: {reverse?: boolean}): IndexRangeIterator<T> {
        return this._primary!.find(opts);
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
        if (this._oldValues === undefined) throw new DatabaseError("Cannot delete unsaved instance", "NOT_SAVED");
        this._oldValues = null;
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
    validate(raise: boolean = false): Error[] {
        const errors: Error[] = [];
        
        for (const [key, fieldConfig] of Object.entries(this.constructor.fields)) {
            let e = fieldConfig.type.getError((this as any)[key]);
            if (e) {
                e = addErrorPath(e, this.constructor.tableName+"."+key);
                if (raise) throw e;
                errors.push(e as Error);
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

    getState(): "deleted" | "created" | "loaded" {
        if (this._oldValues === null) return "deleted";
        if (this._oldValues === undefined) return "created";
        return "loaded";
    }

    toString(): string {
        const primary = this.constructor._primary;
        const pk = primary._keyToArray(this._primaryKey || primary._instanceToKeyBytes(this).toUint8Array(false));
        return `{Model:${this.constructor.tableName} ${this.getState()} ${pk}}`;
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
        return this.toString();
    }
}
