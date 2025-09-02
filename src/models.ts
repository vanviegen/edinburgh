import * as olmdb from "olmdb";
import { DatabaseError } from "olmdb";
import { TypeWrapper, identifier } from "./types.js";
import { BaseIndex as BaseIndex, PrimaryIndex, IndexRangeIterator } from "./indexes.js";
import { addErrorPath, logLevel, tryDelayedInits, delayedInits } from "./utils.js";
import { on } from "events";

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

export function resetModelCaches() {
    for(const model of Object.values(modelRegistry)) {
        for(const index of model._secondaries || []) {
            index._cachedIndexId = undefined;
        }
        delete model._primary?._cachedIndexId;
    }
}

function isObjectEmpty(obj: object) {
    for (let _ of Object.keys(obj)) {
        return false;
    }
    return true;
}

export type ChangedModel = Model<unknown> & {
    changed: Record<any, any> | "updated" | "deleted";
}

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

    // Attempt to instantiate the class and gather field metadata
    delayedInits.add(MyModel);
    tryDelayedInits();

    return MockModel;   
}

export function getMockModel<T extends typeof Model<unknown>>(OrgModel: T): T {
    const AnyOrgModel = OrgModel as any;
    if (AnyOrgModel._isMock) return OrgModel;
    if (AnyOrgModel._mock) return AnyOrgModel._mock;

    const name =  OrgModel.tableName || OrgModel.name;
    const MockModel = function(this: any, initial?: Record<string,any>) {
        if (delayedInits.has(this.constructor)) {
            throw new DatabaseError("Cannot instantiate while linked models haven't been registered yet", 'INIT_ERROR');
        }
        if (initial && !isObjectEmpty(initial)) {
            Object.assign(this, initial);
        }
        const instances = olmdb.getTransactionData(INSTANCES_SYMBOL) as Set<Model<any>>;
        instances.add(this);
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

// Model base class and related symbols/state
const INIT_INSTANCE_SYMBOL = Symbol();

/** @internal Symbol used to attach modified instances to running transaction */
export const INSTANCES_SYMBOL = Symbol('instances');

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
     * - !_oldValues: New instance, not yet saved.
     * - _oldValues && _primaryKey: Loaded (possibly only partial, still lazy) from disk, _oldValues contains (partial) old values
     */
    _oldValues: Partial<Model<SUB>> | undefined;
    _primaryKey: Uint8Array | undefined;

    /**
     * This property can be used in `setOnSave` callbacks to determine how a model instance has changed.
     * If the value is undefined, the instance has been created. If it's "deleted" the instance has
     * been deleted. If its an object, the instance has been modified and the object contains the old values.
     * 
     * Note: this property should **not** be accessed *during* a `transact()` -- it's state is an implementation
     * detail that may change semantics at any minor release.
     */
    changed?: Record<any,any> | "deleted" | "created";

    // Reference the static `fields` property; the mock constructor copies it here for performance
    _fields!: Record<string | symbol | number, FieldConfig<unknown>>;

    constructor(initial: Partial<Omit<SUB, "constructor">> = {}) {
        // This constructor will only be called once, from `initModels`. All other instances will
        // be created by the 'fake' constructor. The typing for `initial` *is* important though.
        if (initial as any !== INIT_INSTANCE_SYMBOL) {
            throw new DatabaseError("The model needs a @registerModel decorator", 'INIT_ERROR');
        }
    }

    static _delayedInit(): boolean {
        const MockModel = getMockModel(this);
        // Create an instance (the only one to ever exist) of the actual class,
        // in order to gather field config data. 
        let instance;
        try {
            instance = new (this as any)(INIT_INSTANCE_SYMBOL);
        } catch(e) {
            if (!(e instanceof ReferenceError)) throw e;
            // ReferenceError: Cannot access 'SomeLinkedClass' before initialization.
            // We'll try again after the next class has successfully initialized.
            return false;
        }

        // If no primary key exists, create one using 'id' field
        if (!MockModel._primary) {
            // If no `id` field exists, add it automatically
            if (!instance.id) {
                instance.id = { type: identifier }; 
            }
            // @ts-ignore-next-line - `id` is not part of the type, but the user probably shouldn't touch it anyhow
            new PrimaryIndex(MockModel, ['id']);
        }

        MockModel.fields = MockModel.prototype._fields = {};
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

        return true;
    }

    _setLoadedField(fieldName: string, value: any) {
        const orgValues = this._oldValues ||= Object.create(Object.getPrototypeOf(this));
        if (orgValues.hasOwnProperty(fieldName)) return; // Already loaded earlier (as part of index key?)

        const fieldType = (this._fields[fieldName] as FieldConfig<unknown>).type;
        this[fieldName as keyof Model<SUB>] = value;
        orgValues[fieldName] = fieldType.clone(value);
    }

    /**
     * @returns The primary key for this instance, or undefined if not yet saved.
     */
    getPrimaryKey(): Uint8Array | undefined {
        return this._primaryKey;
    }

    _getCreatePrimaryKey(): Uint8Array {
        return this._primaryKey ||= this.constructor._primary!._instanceToKeySingleton(this);
    }

    isLazyField(field: keyof this) {
        const descr = this.constructor._primary!._lazyDescriptors[field];
        return !!(descr && 'get' in descr && descr.get === Reflect.getOwnPropertyDescriptor(this, field)?.get);
    }

    _onCommit(onSaveQueue: ChangedModel[] | undefined) {
        const oldValues = this._oldValues;
        let changed : Record<any, any> | "created" | "deleted";

        if (oldValues)  {
            // We're doing an update. Note that we may still be in a lazy state, and we don't want to load
            // the whole object just to see if something changed.

            //  Delete all items from this.changed that have not actually changed.
            const fields = this._fields;
            changed = {};
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
            this.constructor._primary!._write(this);

            // Update any secondaries with changed fields
            for (const index of this.constructor._secondaries || []) {
                for (const field of index._fieldTypes.keys()) {
                    if (changed.hasOwnProperty(field)) {
                        // We need to update this index - first delete the old one
                        index._delete(oldValues);
                        index._write(this)
                        break;
                    }
                }
            }
        } else if (this._primaryKey) { // Deleted instance
            this.constructor._primary._delete(this);
            for(const index of this.constructor._secondaries || []) {
                index._delete(this);
            }
            changed = "deleted";
        } else {
            // New instance
            // Raise any validation errors
            this.validate(true);

            // Make sure the primary key does not already exist
            if (olmdb.get(this._getCreatePrimaryKey())) {
                throw new DatabaseError("Unique constraint violation", "UNIQUE_CONSTRAINT");
            }

            // Insert the primary index
            this.constructor._primary!._write(this);

            // Insert all secondaries
            for (const index of this.constructor._secondaries || []) {
                index._write(this);
            }

            changed = "created";
        }

        if (onSaveQueue) {
            this.changed = changed;
            onSaveQueue.push(this as ChangedModel);
        }
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
        const instances = olmdb.getTransactionData(INSTANCES_SYMBOL) as Set<Model<any>>;
        instances.delete(this);
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
        if (!this._primaryKey) throw new DatabaseError("Cannot delete unsaved instance", "NOT_SAVED");
        this._oldValues = undefined;
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
        
        for (const [key, fieldConfig] of Object.entries(this._fields)) {
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
}
