import { DatabaseError } from "olmdb/lowlevel";
import { AsyncLocalStorage } from "node:async_hooks";
import { TypeWrapper, identifier } from "./types.js";
import { scheduleInit } from "./edinburgh.js";

export const txnStorage = new AsyncLocalStorage<Transaction>();


const PREVENT_PERSIST_DESCRIPTOR = {
    get() {
        throw new DatabaseError("Operation not allowed after preventPersist()", "NO_PERSIST");
    },
};

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
import { BaseIndex, NonPrimaryIndex, PrimaryIndex, IndexRangeIterator, UniqueIndex, SecondaryIndex, FindOptions } from "./indexes.js";
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
 * const User = E.defineModel(class {
 *   name = E.field(E.string, {description: "User's full name"});
 *   age = E.field(E.opt(E.number), {description: "User's age", default: 25});
 * });
 * ```
 */
export function field<T>(type: TypeWrapper<T>, options: Partial<FieldConfig<T>> = {}): T {
    // Return the config object, but TypeScript sees it as type T
    options.type = type;
    return options as any;
}

// Model registration and initialization
export const modelRegistry: Record<string, typeof Model> = {};

function isObjectEmpty(obj: object) {
    for (let _ of Object.keys(obj)) {
        return false;
    }
    return true;
}

export type Change = Record<any, any> | "created" | "deleted";

let autoTableNameId = 0;

type FieldsOf<T> = T extends new () => infer I ? I : never;
type ModelInstance<FIELDS> = FIELDS & Model<FIELDS>;

type PKArgs<FIELDS, PK> =
    PK extends readonly (keyof FIELDS & string)[]
        ? { [I in keyof PK]: PK[I] extends keyof FIELDS ? FIELDS[PK[I]] : never }
        : PK extends keyof FIELDS & string
            ? [FIELDS[PK]]
            : [string];

type UniqueFor<SPEC> =
    SPEC extends readonly string[] ? UniqueIndex<any, SPEC>
    : SPEC extends string ? UniqueIndex<any, [SPEC]>
    : SPEC extends (instance: any) => infer R
        ? R extends (infer V)[] ? UniqueIndex<any, [], [V]>
        : UniqueIndex<any, [], [R]>
    : never;

type SecondaryFor<SPEC> =
    SPEC extends readonly string[] ? SecondaryIndex<any, SPEC>
    : SPEC extends string ? SecondaryIndex<any, [SPEC]>
    : SPEC extends (instance: any) => infer R
        ? R extends (infer V)[] ? SecondaryIndex<any, [], [V]>
        : SecondaryIndex<any, [], [R]>
    : never;

type RegisteredModel<FIELDS, PKA extends readonly any[], UNIQUE, INDEX> = {
    new (initial?: Partial<FIELDS>): ModelInstance<FIELDS>;
    tableName: string;
    fields: Record<string | symbol | number, FieldConfig<unknown>>;
    get(...args: PKA): ModelInstance<FIELDS> | undefined;
    getLazy(...args: PKA): ModelInstance<FIELDS>;
    find(opts: FindOptions<PKA, 'first'>): ModelInstance<FIELDS> | undefined;
    find(opts: FindOptions<PKA, 'single'>): ModelInstance<FIELDS>;
    find(opts?: FindOptions<PKA>): IndexRangeIterator<any>;
    batchProcess(opts?: FindOptions<PKA> & { limitSeconds?: number; limitRows?: number }, callback?: (row: ModelInstance<FIELDS>) => any): Promise<void>;
    replaceInto(obj: Partial<FIELDS>): ModelInstance<FIELDS>;
} &
    { [K in keyof UNIQUE]: UniqueFor<UNIQUE[K]> } &
    { [K in keyof INDEX]: SecondaryFor<INDEX[K]> };

/**
 * Register a model class with the Edinburgh ORM system.
 *
 * Converts a plain class into a fully-featured model with database persistence,
 * typed fields, primary key access, and optional secondary and unique indexes.
 *
 * @param cls - A plain class whose properties use E.field().
 * @param opts - Registration options.
 * @param opts.pk - Primary key field name or array of field names.
 * @param opts.unique - Named unique index specifications (field name, field array, or compute function).
 * @param opts.index - Named secondary index specifications (field name, field array, or compute function).
 * @param opts.tableName - Explicit database table name.
 * @param opts.override - Replace a previous model with the same table name.
 * @returns The enhanced model constructor.
 */
export function defineModel<
    T extends new () => any,
    const PK extends (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[],
    const UNIQUE extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>,
    const INDEX extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>,
>(
    cls: T,
    opts?: { pk?: PK, unique?: UNIQUE, index?: INDEX, tableName?: string, override?: boolean }
): RegisteredModel<FieldsOf<T>, PKArgs<FieldsOf<T>, PK>, UNIQUE, INDEX>;

export function defineModel(cls: any, opts?: any): any {
    Object.setPrototypeOf(cls.prototype, Model.prototype);

    const MockModel = function(this: any, initial?: Record<string, any>, txn: Transaction = currentTxn()) {
        this._txn = txn;
        txn.instances.add(this);
        if (initial) Object.assign(this, initial);
    } as any;

    cls.prototype.constructor = MockModel;
    Object.setPrototypeOf(MockModel, Model);
    MockModel.prototype = cls.prototype;
    MockModel._original = cls;

    for (const name of Object.getOwnPropertyNames(cls)) {
        if (name !== 'length' && name !== 'prototype' && name !== 'name') {
            MockModel[name] = cls[name];
        }
    }

    MockModel.tableName = opts?.tableName || cls.name || `Model${++autoTableNameId}`;

    if (MockModel.tableName in modelRegistry) {
        if (!opts?.override) {
            throw new DatabaseError(`Model with table name '${MockModel.tableName}' already registered`, 'INIT_ERROR');
        }
        delete modelRegistry[MockModel.tableName];
    }

    const instance = new cls();
    if (!opts?.pk && !instance.id) {
        instance.id = { type: identifier };
    }

    MockModel.fields = {};
    for (const key in instance) {
        const value = instance[key] as FieldConfig<unknown>;
        if (value && value.type instanceof TypeWrapper) {
            MockModel.fields[key] = value;

            const defObj = value.default === undefined ? value.type : value;
            const def = defObj.default;
            if (typeof def === 'function') {
                Object.defineProperty(MockModel.prototype, key, {
                    get() {
                        return (this[key] = def.call(defObj, this));
                    },
                    set(val: any) {
                        Object.defineProperty(this, key, {
                            value: val,
                            configurable: true,
                            writable: true,
                            enumerable: true,
                        });
                    },
                    configurable: true,
                });
            } else if (def !== undefined) {
                MockModel.prototype[key] = def;
            }
        }
    }

    if (opts?.pk) {
        new PrimaryIndex(MockModel, Array.isArray(opts.pk) ? opts.pk : [opts.pk]);
    } else {
        new PrimaryIndex(MockModel, ['id']);
    }

    const normalizeSpec = (spec: any) => typeof spec === 'string' ? [spec] : spec;

    if (opts?.unique) {
        for (const [name, spec] of Object.entries<any>(opts.unique)) {
            MockModel[name] = new UniqueIndex(MockModel, normalizeSpec(spec));
        }
    }
    if (opts?.index) {
        for (const [name, spec] of Object.entries<any>(opts.index)) {
            MockModel[name] = new SecondaryIndex(MockModel, normalizeSpec(spec));
        }
    }

    modelRegistry[MockModel.tableName] = MockModel;
    scheduleInit();
    return MockModel;
}

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
 * change tracking, and relationship management. Model classes are created using
 * `E.defineModel()`.
 *
 * ### Schema Evolution
 *
 * Edinburgh tracks the schema version of each model automatically. When you add, remove, or
 * change the types of fields, or add/remove indexes, Edinburgh detects the new schema version.
 *
 * **Lazy migration:** Changes to non-key field values are migrated lazily, when a row with an
 * old schema version is read from disk, it is deserialized using the old schema and optionally
 * transformed by the static `migrate()` function. This happens transparently on every read
 * and requires no downtime or batch processing.
 *
 * **Batch migration (via `npx migrate-edinburgh` or `runMigration()`):** Certain schema changes
 * require an explicit migration run:
 * - Adding or removing secondary/unique indexes
 * - Changing the fields or types of an existing index
 * - A `migrate()` function that changes values used in secondary index fields
 *
 * The batch migration tool populates new indexes, deletes orphaned ones, and updates index
 * entries whose values were changed by `migrate()`. It does *not* rewrite primary data rows
 * (lazy migration handles that).
 *
 * ### Lifecycle Hooks
 *
 * - **`static migrate(record)`**: Called when deserializing rows written with an older schema
 *   version. Receives a plain record object; mutate it in-place to match the current schema.
 *   See {@link Model.migrate}.
 *
 * - **`preCommit()`**: Called on each modified instance right before the transaction commits.
 *   Useful for computing derived fields, enforcing cross-field invariants, or creating related
 *   instances. See {@link Model.preCommit}.
 *
 * @template SUB - The concrete model subclass (for proper typing).
 * 
 * @example
 * ```typescript
 * const User = E.defineModel(class {
 *   id = E.field(E.identifier);
 *   name = E.field(E.string);
 *   email = E.field(E.string);
 * }, {
 *   pk: "id",
 *   unique: { byEmail: "email" },
 * });
 * ```
 */


export abstract class Model<SUB> {
    static _primary: PrimaryIndex<any, any>;

    /** @internal All non-primary indexes for this model. */
    static _secondaries?: NonPrimaryIndex<any, readonly (keyof any & string)[]>[];

    /** The database table name (defaults to class name). */
    static tableName: string;

    /** When true, defineModel replaces an existing model with the same tableName. */
    static override?: boolean;

    /** Field configuration metadata. */
    static fields: Record<string | symbol | number, FieldConfig<unknown>>;

    // Alias statics that delegate to _primary, used by migrate.ts
    static get _indexId() { return this._primary?._indexId; }
    static get _currentVersion() { return this._primary._currentVersion; }
    static get _pkFieldTypes() { return this._primary._fieldTypes; }
    static _loadVersionInfo(txnId: number, version: number) { return this._primary._loadVersionInfo(txnId, version); }
    static _writePrimary(txn: Transaction, pk: Uint8Array, data: Record<string, any>) { this._primary._write(txn, pk, data as any); }

    /**
     * Optional migration function called when deserializing rows written with an older schema version.
     * Receives a plain record with all fields (primary key fields + value fields) and should mutate it
     * in-place to match the current schema.
     *
     * This is called both during lazy loading (when a row is read from disk) and during batch
     * migration (via `runMigration()` / `npx migrate-edinburgh`). The function's source code is hashed
     * to detect changes. Modifying `migrate()` triggers a new schema version.
     *
     * If `migrate()` changes values of fields used in secondary or unique indexes, those indexes
     * will only be updated when `runMigration()` is run (not during lazy loading).
     *
     * @param record - A plain object with all field values from the old schema version.
     *
     * @example
     * ```typescript
     * const User = E.defineModel(class {
     *   id = E.field(E.identifier);
     *   name = E.field(E.string);
     *   role = E.field(E.string);  // new field
     *
     *   static migrate(record: Record<string, any>) {
     *     record.role ??= "user";  // default for rows that predate the 'role' field
     *   }
     * }, { pk: "id" });
     * ```
     */
    static migrate?(record: Record<string, any>): void;

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
    _txn!: Transaction;

    constructor(initial: Partial<Omit<SUB, "constructor">> = {}) {
        throw new DatabaseError("Use defineModel() to create model classes", 'INIT_ERROR');
    }

    /**
     * Optional hook called on each modified instance right before the transaction commits.
     * Runs before data is written to disk, so changes made here are included in the commit.
     *
     * Common use cases:
     * - Computing derived or denormalized fields
     * - Enforcing cross-field validation rules
     * - Creating or updating related model instances (newly created instances will also
     *   have their `preCommit()` called)
     *
     * @example
     * ```typescript
     * const Post = E.defineModel(class {
     *   id = E.field(E.identifier);
     *   title = E.field(E.string);
     *   slug = E.field(E.string);
     *
     *   preCommit() {
     *     this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
     *   }
     * }, { pk: "id" });
     * ```
     */
    preCommit?(): void;

    static _resetIndexes(): void {
        this._primary._indexId = undefined;
        this._primary._versions.clear();
        for (const sec of this._secondaries || []) sec._indexId = undefined;
    }

    static async _loadCreateIndexes(): Promise<void> {
        await this._primary._delayedInit();
        for (const sec of this._secondaries || []) await sec._delayedInit();
        await this._primary._initVersioning();
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
            key = this.constructor._primary!._serializeKey(this).toUint8Array();
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
        return !!(descr && 'get' in descr && descr.get === Reflect.getOwnPropertyDescriptor(this, field)?.get);
    }

    _write(txn: Transaction): undefined | Change {
        const oldValues = this._oldValues;

        if (oldValues === null) { // Delete instance
            const pk = this._primaryKey;
            // Temporarily restore _oldValues so computed indexes can trigger lazy loads
            this._oldValues = {};
            for(const index of this.constructor._secondaries || []) {
                index._delete(txn, pk!, this);
            }
            this.constructor._primary._delete(txn, pk!, this);
            
            return "deleted";
        }
        
        if (oldValues === undefined) { // Create instance
            this.validate(true);

            // Make sure the primary key does not already exist
            const pk = this.getPrimaryKey();
            if (dbGet(txn.id, pk!)) {
                throw new DatabaseError("Unique constraint violation", "UNIQUE_CONSTRAINT");
            }

            // Insert the primary index
            this.constructor._primary!._write(txn, pk!, this);

            // Insert all secondaries
            for (const index of this.constructor._secondaries || []) {
                index._write(txn, pk!, this);
            }

            return "created";
        }

        // oldValues is an object.
        // We're doing an update. Note that we may still be in a lazy state, and we don't want to load
        // the whole object just to see if something changed.

        // Add old values of changed fields to 'changed'.
        const changed: Record<string, any> = {};
        const fields = this.constructor.fields;
        for(const fieldName in oldValues) {
            const oldValue = oldValues[fieldName];
            const newValue = this[fieldName as keyof Model<SUB>];
            if (newValue !== oldValue  && !(fields[fieldName] as FieldConfig<unknown>).type.equals(newValue, oldValue)) {
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
        const pk = this._primaryKey!;
        this.constructor._primary!._write(txn, pk, this);

        // Update any secondaries with changed fields
        for (const index of this.constructor._secondaries || []) {
            index._update(txn, pk, this, oldValues);
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
     * const user = User.get("user123");
     * user.name = "New Name";
     * user.preventPersist(); // Changes won't be saved
     * ```
     */
    preventPersist() {
        this._txn.instances.delete(this);
        // Have access to '_txn' throw a descriptive error:
        Object.defineProperty(this, "_txn", PREVENT_PERSIST_DESCRIPTOR);
        return this;
    }

    static get(...args: any[]): any {
        return this._primary!.get(...args);
    }

    static getLazy(...args: any[]): any {
        return this._primary!.getLazy(...args);
    }

    static find(opts?: any): any {
        return this._primary!.find(opts);
    }

    static batchProcess(opts: any, callback?: any): any {
        return this._primary!.batchProcess(opts, callback);
    }

    /**
     * Load an existing instance by primary key and update it, or create a new one.
     *
     * The provided object must contain all primary key fields. If a matching row exists,
     * the remaining properties from `obj` are set on the loaded instance. Otherwise a
     * new instance is created with `obj` as its initial properties.
     *
     * @param obj - Partial model data that **must** include every primary key field.
     * @returns The loaded-and-updated or newly created instance.
     */
    static replaceInto<T extends typeof Model<any>>(this: T, obj: Partial<Record<string, any>>): InstanceType<T> {
        const pk = this._primary!;
        const keyArgs = [];
        for (const fieldName of pk._fieldTypes.keys()) {
            if (!(fieldName in (obj as any))) {
                throw new DatabaseError(`replaceInto: missing primary key field '${fieldName}'`, "MISSING_PRIMARY_KEY");
            }
            keyArgs.push((obj as any)[fieldName]);
        }

        const existing = pk.get(...keyArgs as any) as InstanceType<T> | undefined;
        if (existing) {
            for (const key in obj as any) {
                if (!pk._fieldTypes.has(key as any)) {
                    (existing as any)[key] = (obj as any)[key];
                }
            }
            return existing;
        }
        return new (this as any)(obj) as InstanceType<T>;
    }

    /**
     * Delete this model instance from the database.
     * 
     * Removes the instance and all its index entries from the database and prevents further persistence.
     * 
     * @example
     * ```typescript
     * const user = User.get("user123");
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

    getState(): "deleted" | "created" | "loaded" | "lazy" {
        if (this._oldValues === null) return "deleted";
        if (this._oldValues === undefined) return "created";
        for(const [key,descr] of Object.entries(this.constructor._primary!._lazyDescriptors)) {
            if (descr && 'get' in descr && descr.get === Reflect.getOwnPropertyDescriptor(this, key)?.get) {
                return "lazy";
            }
        }
        return "loaded";
    }

    toString(): string {
        const primary = this.constructor._primary;
        const pk = primary._keyToArray(this._primaryKey || primary._serializeKey(this).toUint8Array(false));
        return `{Model:${this.constructor.tableName} ${this.getState()} ${pk}}`;
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
        return this.toString();
    }
}
