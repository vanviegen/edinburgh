import * as lowlevel from "olmdb/lowlevel";
import { DatabaseError } from "olmdb/lowlevel";
import DataPack from "./datapack.js";
import { deserializeType, serializeType, TypeWrapper, identifier } from "./types.js";
import { transact, currentTxn, type Transaction } from "./edinburgh.js";

import { PrimaryKey, NonPrimaryIndex, IndexRangeIterator, UniqueIndex, SecondaryIndex, FindOptions, VersionInfo } from "./indexes.js";
import { addErrorPath, dbGet, hashBytes, hashFunction } from "./utils.js";

let nextFakePkHash = -1;


const PREVENT_PERSIST_DESCRIPTOR = {
    get() {
        throw new DatabaseError("Operation not allowed after preventPersist()", "NO_PERSIST");
    },
};

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
 * @param type The type wrapper for this field.
 * @param options Additional field configuration options.
 * @returns The field value (typed as T, but actually returns FieldConfig<T>).
 * 
 * @example
 * ```typescript
 * const User = E.defineModel("User", class {
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

function isObjectEmpty(obj: object) {
    for (const _ of Object.keys(obj)) {
        return false;
    }
    return true;
}

export type Change = Record<any, any> | "created" | "deleted";

type FieldsOf<T> = T extends new () => infer I ? I : never;

type PKArgs<FIELDS, PK> =
    PK extends readonly (keyof FIELDS & string)[]
        ? { [I in keyof PK]: PK[I] extends keyof FIELDS ? FIELDS[PK[I]] : never }
        : PK extends keyof FIELDS & string
            ? [FIELDS[PK]]
            : [string];

type IndexArgs<FIELDS, SPEC> =
    SPEC extends readonly (keyof FIELDS & string)[]
        ? { [I in keyof SPEC]: SPEC[I] extends keyof FIELDS ? FIELDS[SPEC[I]] : never }
    : SPEC extends keyof FIELDS & string
        ? [FIELDS[SPEC]]
    : SPEC extends (instance: any) => infer R
        ? R extends (infer V)[] ? [V] : [R]
    : never;

export type AnyModelClass = ModelClass<any, readonly any[], any, any>;

type SecondaryRegistry<FIELDS> = Record<string, NonPrimaryIndex<Model<FIELDS>, readonly (keyof FIELDS & string)[], readonly any[]>>;

// Model registration and initialization
export const modelRegistry: Record<string, AnyModelClass> = {};
export const pendingModelInits = new Set<AnyModelClass>();

// These static members are attached dynamically in defineModel(), so 'declare' tells TypeScript
// they exist at runtime without emitting duplicate class fields that would shadow those assignments.
class ModelClassRuntime<FIELDS, PKA extends readonly any[], UNIQUE = {}, INDEX = {}> extends PrimaryKey<Model<FIELDS>, readonly (keyof FIELDS & string)[], PKA> {
    // Runtime table identifier used for index naming and diagnostics.
    declare tableName: string;
    // Field schema map used for validation and serialization.
    declare fields: Record<string | symbol | number, FieldConfig<unknown>>;
    // Registered unique/secondary indexes for this model.
    declare _secondaries?: SecondaryRegistry<FIELDS>;
    // Signals model definition override semantics during registration.
    declare override?: boolean;
    // Reference to the original user class to preserve static hooks like migrate().
    declare _original?: new () => any;
    // Cached list of non-primary fields used for value serialization.
    _nonKeyFields!: (keyof FIELDS & string)[];
    // Lazy getter/setter descriptors installed on unloaded non-key fields.
    _lazyDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    // Writable descriptors temporarily installed before hydrating value fields.
    _resetDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    // Frozen descriptors applied to primary-key fields after key materialization.
    _freezePrimaryKeyDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};
    // Active schema version number for value encoding.
    _currentVersion!: number;
    // Hash of the active migrate() function for schema identity.
    _currentMigrateHash!: number;
    // Cached historical schema metadata for lazy migration of old rows.
    _versions: Map<number, VersionInfo> = new Map();

    _serializeVersionValue(): Uint8Array {
        const fields: [string, Uint8Array][] = [];
        for (const fieldName of this._nonKeyFields) {
            const tp = new DataPack();
            serializeType(this.fields[fieldName].type, tp);
            fields.push([fieldName, tp.toUint8Array()]);
        }
        return new DataPack().write({
            migrateHash: this._currentMigrateHash,
            fields,
            secondaryKeys: new Set(Object.values(this._secondaries || {}).map(sec => sec._signature!)),
        }).toUint8Array();
    }

    async _initialize(reset = false): Promise<void> {
        const allFieldTypes = new Map<string, TypeWrapper<any>>();
        for (const [fieldName, fieldConfig] of Object.entries(this.fields)) {
            allFieldTypes.set(fieldName, fieldConfig.type);
        }
        await super._initializeIndex(allFieldTypes, reset);

        if (reset || this._nonKeyFields === undefined) {
            this._nonKeyFields = Object.keys(this.fields).filter(fieldName => !this._indexFields.has(fieldName as any)) as any;
            this._lazyDescriptors = {};
            this._resetDescriptors = {};
            this._freezePrimaryKeyDescriptors = {};

            for (const fieldName of this._nonKeyFields) {
                this._lazyDescriptors[fieldName] = {
                    configurable: true,
                    enumerable: true,
                    get(this: Model<FIELDS>) {
                        this.constructor._lazyLoad(this);
                        return this[fieldName];
                    },
                    set(this: Model<FIELDS>, value: any) {
                        this.constructor._lazyLoad(this);
                        this[fieldName] = value;
                    },
                };
                this._resetDescriptors[fieldName] = {
                    writable: true,
                    enumerable: true,
                };
            }

            for (const fieldName of this._indexFields.keys()) {
                this._freezePrimaryKeyDescriptors[fieldName] = {
                    writable: false,
                    enumerable: true,
                };
            }
        }

        for (const sec of Object.values(this._secondaries || {})) {
            await sec._initializeIndex(allFieldTypes, reset, this._indexFields);
        }

        const migrateFn = (this._original as any)?.migrate ?? (this as any).migrate;
        this._currentMigrateHash = migrateFn ? hashFunction(migrateFn) : 0;

        const currentValueBytes = this._serializeVersionValue();
        this._currentVersion = (await this._ensureVersionEntry(currentValueBytes)).version;
    }

    _getSecondary(name: string) {
        const index = this._secondaries?.[name];
        if (!index) throw new DatabaseError(`Unknown index '${name}' on model '${this.tableName}'`, 'INIT_ERROR');
        return index;
    }

    _get(txn: Transaction, args: PKA | Uint8Array, loadNow: false | Uint8Array): Model<FIELDS>;
    _get(txn: Transaction, args: PKA | Uint8Array, loadNow: true): Model<FIELDS> | undefined;
    _get(txn: Transaction, args: PKA | Uint8Array, loadNow: boolean | Uint8Array): Model<FIELDS> | undefined {
        let key: Uint8Array;
        let keyParts: readonly any[] | undefined;
        if (args instanceof Uint8Array) {
            key = args;
        } else {
            key = this._argsToKeyBytes(args, false).toUint8Array();
            keyParts = args;
        }

        const keyHash = hashBytes(key);
        const cached = txn.instances.get(keyHash) as Model<FIELDS> | undefined;
        if (cached) {
            if (loadNow && loadNow !== true) {
                Object.defineProperties(cached, this._resetDescriptors);
                this._loadValueFields(cached, loadNow);
            }
            return cached;
        }

        let valueBuffer: Uint8Array | undefined;
        if (loadNow) {
            if (loadNow === true) {
                valueBuffer = dbGet(txn.id, key);
                if (!valueBuffer) return;
            } else {
                valueBuffer = loadNow;
            }
        }

        const model = Object.create((this as any).prototype) as Model<FIELDS>;
        model._txn = txn;
        model._oldValues = {};
        txn.instances.set(keyHash, model);

        if (keyParts) {
            let i = 0;
            for (const fieldName of this._indexFields.keys()) {
                model._setLoadedField(fieldName, keyParts[i++]);
            }
        } else {
            const keyPack = new DataPack(key);
            keyPack.readNumber();
            for (const [fieldName, fieldType] of this._indexFields.entries()) {
                model._setLoadedField(fieldName, fieldType.deserialize(keyPack));
            }
        }

        model._setPrimaryKey(key, keyHash);
        if (valueBuffer) {
            this._loadValueFields(model, valueBuffer);
        } else {
            Object.defineProperties(model, this._lazyDescriptors);
        }
        return model;
    }

    _lazyLoad(model: Model<FIELDS>) {
        const key = model._primaryKey!;
        const valueBuffer = dbGet(model._txn.id, key);
        if (!valueBuffer) throw new DatabaseError(`Lazy-loaded ${this.tableName}#${key} does not exist`, 'LAZY_FAIL');
        Object.defineProperties(model, this._resetDescriptors);
        this._loadValueFields(model, valueBuffer);
    }

    get(...args: PKA): Model<FIELDS> | undefined {
        return this._get(currentTxn(), args, true);
    }

    getLazy(...args: PKA): Model<FIELDS> {
        return this._get(currentTxn(), args, false);
    }

    _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, valueBuffer: ArrayBuffer): Model<FIELDS> {
        return this._get(txn, new Uint8Array(keyBuffer), new Uint8Array(valueBuffer))!;
    }

    /**
     * Load an existing instance by primary key and update it, or create a new one.
      * If a row already exists, its non-primary-key fields are updated in place.
      * Otherwise, a new instance is created with `obj` as its initial properties.
     *
     * @param obj Partial model data that **must** include every primary key field.
     */
    replaceInto(obj: Partial<FIELDS>): Model<FIELDS> {
        const keyArgs: any[] = [];
        for (const fieldName of this._indexFields.keys()) {
            if (!(fieldName in (obj as any))) {
                throw new DatabaseError(`replaceInto: missing primary key field '${fieldName}'`, "MISSING_PRIMARY_KEY");
            }
            keyArgs.push((obj as any)[fieldName]);
        }
        const existing = this.get(...keyArgs as any) as Model<FIELDS> | undefined;
        if (existing) {
            for (const key in obj as any) {
                if (!this._indexFields.has(key as any)) {
                    (existing as any)[key] = (obj as any)[key];
                }
            }
            return existing;
        }
        return new (this as any)(obj);
    }

    getBy<K extends string & keyof UNIQUE>(name: K, ...args: IndexArgs<FIELDS, UNIQUE[K]>): Model<FIELDS> | undefined {
        return (this._getSecondary(name) as any).getPK(...args);
    }

    findBy<K extends string & keyof (UNIQUE & INDEX)>(name: K, opts: FindOptions<IndexArgs<FIELDS, (UNIQUE & INDEX)[K]>, 'first'>): Model<FIELDS> | undefined;
    findBy<K extends string & keyof (UNIQUE & INDEX)>(name: K, opts: FindOptions<IndexArgs<FIELDS, (UNIQUE & INDEX)[K]>, 'single'>): Model<FIELDS>;
    findBy<K extends string & keyof (UNIQUE & INDEX)>(name: K, opts?: FindOptions<IndexArgs<FIELDS, (UNIQUE & INDEX)[K]>>): IndexRangeIterator<Model<FIELDS>>;
    findBy(name: string, opts?: any): any {
        return this._getSecondary(name).find(opts);
    }

    batchProcessBy<K extends string & keyof (UNIQUE & INDEX)>(
        name: K,
        opts: FindOptions<IndexArgs<FIELDS, (UNIQUE & INDEX)[K]>> & { limitSeconds?: number; limitRows?: number },
        callback: (row: Model<FIELDS>) => any,
    ): Promise<void> {
        return this._getSecondary(name).batchProcess(opts, callback as any);
    }

    _loadValueFields(model: Model<FIELDS>, valueArray: Uint8Array) {
        const valuePack = new DataPack(valueArray);
        const version = valuePack.readNumber();

        if (version === this._currentVersion) {
            for (const fieldName of this._nonKeyFields) {
                model._setLoadedField(fieldName, this.fields[fieldName].type.deserialize(valuePack));
            }
        } else {
            this._migrateValueFields(model, version, valuePack);
        }
    }

    _loadVersionInfo(txnId: number, version: number): VersionInfo {
        let info = this._versions.get(version);
        if (info) return info;

        const key = this._versionInfoKey(version);
        const raw = dbGet(txnId, key);
        if (!raw) throw new DatabaseError(`Version ${version} info not found for index ${this}`, 'CONSISTENCY_ERROR');

        const obj = new DataPack(raw).read() as any;
        if (!obj || typeof obj.migrateHash !== 'number' || !Array.isArray(obj.fields) || !(obj.secondaryKeys instanceof Set)) {
            throw new DatabaseError(`Version ${version} info is corrupted for index ${this}`, 'CONSISTENCY_ERROR');
        }

        const nonKeyFields = new Map<string, TypeWrapper<any>>();
        for (const [name, typeBytes] of obj.fields) {
            nonKeyFields.set(name, deserializeType(new DataPack(typeBytes), 0));
        }

        info = { migrateHash: obj.migrateHash, nonKeyFields, secondaryKeys: obj.secondaryKeys as Set<string> };
        this._versions.set(version, info);
        return info;
    }

    _migrateValueFields(model: Model<FIELDS>, version: number, valuePack: DataPack) {
        const versionInfo = this._loadVersionInfo(model._txn.id, version);
        const record: Record<string, any> = {};
        for (const [name] of this._indexFields.entries()) record[name] = (model as any)[name];
        for (const [name, type] of versionInfo.nonKeyFields.entries()) {
            record[name] = type.deserialize(valuePack);
        }

        const migrateFn = (this as any).migrate;
        if (migrateFn) migrateFn(record);

        for (const fieldName of this._nonKeyFields) {
            if (fieldName in record) {
                model._setLoadedField(fieldName, record[fieldName]);
            } else if (fieldName in model) {
                model._setLoadedField(fieldName, (model as any)[fieldName]);
            } else {
                throw new DatabaseError(`Field ${fieldName} is missing in migrated data for ${model}`, 'MIGRATION_ERROR');
            }
        }
    }

    _serializeValue(data: Record<string, any>): Uint8Array {
        const valueBytes = new DataPack();
        valueBytes.write(this._currentVersion);
        for (const fieldName of this._nonKeyFields) {
            const fieldConfig = this.fields[fieldName] as FieldConfig<unknown>;
            fieldConfig.type.serialize(data[fieldName], valueBytes);
        }
        return valueBytes.toUint8Array();
    }
}

export const ModelClass = ModelClassRuntime;

export type ModelClass<FIELDS, PKA extends readonly any[], UNIQUE = {}, INDEX = {}> = ModelClassRuntime<FIELDS, PKA, UNIQUE, INDEX> & {
    new (initial?: Partial<FIELDS>, txn?: Transaction): Model<FIELDS>;
};

export interface ModelBase {
    constructor: AnyModelClass;
}

/**
 * Register a model class with the Edinburgh ORM system.
 *
 * Converts a plain class into a fully-featured model with database persistence,
 * typed fields, primary key access, and optional secondary and unique indexes.
 *
 * @param tableName The database table name for this model.
 * @param cls A plain class whose properties use E.field().
 * @param opts Registration options.
 * @param opts.pk Primary key field name or array of field names.
 * @param opts.unique Named unique index specifications (field name, field array, or compute function).
 * @param opts.index Named secondary index specifications (field name, field array, or compute function).
 * @param opts.override Replace a previous model with the same table name.
 * @returns The enhanced model constructor.
 */
export function defineModel<
    T extends new () => any,
    const PK extends (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[],
    const UNIQUE extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>,
    const INDEX extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>,
>(
    tableName: string,
    cls: T,
    opts?: { pk?: PK, unique?: UNIQUE, index?: INDEX, override?: boolean }
): ModelClass<FieldsOf<T>, PKArgs<FieldsOf<T>, PK>, UNIQUE, INDEX> {
    Object.setPrototypeOf(cls.prototype, ModelBase.prototype);
    const MockModel = function(this: any, initial?: Record<string, any>, txn: Transaction = currentTxn()) {
        this._txn = txn;
        txn.instances.set(nextFakePkHash--, this);
        if (initial) Object.assign(this, initial);
    } as any;

    const normalizeSpec = (spec: any) => typeof spec === 'string' ? [spec] : spec;
    const queueInitialization = () => { pendingModelInits.add(MockModel); };
    const loadPrimary = (txn: Transaction, primaryKey: Uint8Array, loadNow: boolean | Uint8Array) => MockModel._get(txn, primaryKey, loadNow);

    cls.prototype.constructor = MockModel;
    Object.setPrototypeOf(MockModel, ModelClassRuntime.prototype);
    MockModel.prototype = cls.prototype;
    MockModel._original = cls;

    for (const name of Object.getOwnPropertyNames(cls)) {
        if (name !== 'length' && name !== 'prototype' && name !== 'name') {
            MockModel[name] = (cls as any)[name];
        }
    }

    MockModel.tableName = tableName;

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

    const primaryFields = opts?.pk ? (Array.isArray(opts.pk) ? opts.pk : [opts.pk]) : ['id'];
    MockModel._indexFields = new Map();
    for (const fieldName of primaryFields) {
        const fieldConfig = MockModel.fields[fieldName];
        if (!fieldConfig) {
            throw new DatabaseError(`Unknown primary key field '${fieldName}' on model '${tableName}'`, 'INIT_ERROR');
        }
        MockModel._indexFields.set(fieldName, fieldConfig.type);
    }

    MockModel._secondaries = {};
    MockModel._lazyDescriptors = {};
    MockModel._resetDescriptors = {};
    MockModel._freezePrimaryKeyDescriptors = {};
    MockModel._versions = new Map();

    if (opts?.unique) {
        for (const [name, spec] of Object.entries<any>(opts.unique)) {
            MockModel._secondaries[name] = new UniqueIndex(tableName, normalizeSpec(spec), loadPrimary, queueInitialization);
        }
    }
    if (opts?.index) {
        for (const [name, spec] of Object.entries<any>(opts.index)) {
            MockModel._secondaries[name] = new SecondaryIndex(tableName, normalizeSpec(spec), loadPrimary, queueInitialization);
        }
    }

    modelRegistry[MockModel.tableName] = MockModel;
    pendingModelInits.add(MockModel);
    return MockModel;
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
 * @example
 * ```typescript
 * const User = E.defineModel("User", class {
 *   id = E.field(E.identifier);
 *   name = E.field(E.string);
 *   email = E.field(E.string);
 * }, {
 *   pk: "id",
 *   unique: { byEmail: "email" },
 * });
 * // Optional: declare a companion type so `let u: User` works.
 * // Not needed if you only use `new User()`, `User.find()`, etc.
 * type User = InstanceType<typeof User>;
 * ```
 */
export abstract class ModelBase {
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
     * - _oldValues===false: Instance excluded from persistence (preventPersist).
     * - _oldValues is an object: Loaded (possibly only partial, still lazy) from disk, _oldValues contains (partial) old values
     */
    _oldValues: Record<string, any> | undefined | null | false;
    _primaryKey: Uint8Array | undefined;
    _primaryKeyHash: number | undefined;
    _txn!: Transaction;

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
     * const Post = E.defineModel("Post", class {
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

    _setLoadedField(fieldName: string, value: any) {
        const oldValues = this._oldValues! as Record<string, any>;
        if (oldValues.hasOwnProperty(fieldName)) return; // Already loaded earlier (as part of index key?)

        this[fieldName as keyof ModelBase] = value;
        if (typeof value === 'object' && value !== null) {            
            const fieldType = (this.constructor.fields[fieldName] as FieldConfig<unknown>).type;
            oldValues[fieldName] = fieldType.clone(value);
        } else {
            // This path is just an optimization
            oldValues[fieldName] = value;
        }
    }

    _restoreLazyFields() {
        const oldValues = this._oldValues;
        if (!oldValues || oldValues === null) return;
        for (const [fieldName, descriptor] of Object.entries(this.constructor._lazyDescriptors)) {
            if (!oldValues.hasOwnProperty(fieldName)) {
                Object.defineProperty(this, fieldName, descriptor);
            }
        }
    }

    /**
     * @returns The primary key for this instance.
     */
    getPrimaryKey(): Uint8Array {
        let key = this._primaryKey;
        if (key === undefined) {
            if (this._oldValues === false) throw new DatabaseError("Operation not allowed after preventPersist()", "NO_PERSIST");
            key = this.constructor._serializePK(this).toUint8Array();
            this._setPrimaryKey(key);
        }
        return key;
    }

    _setPrimaryKey(key: Uint8Array, hash?: number) {
        this._primaryKey = key;
        this._primaryKeyHash = hash ?? hashBytes(key);
        Object.defineProperties(this, this.constructor._freezePrimaryKeyDescriptors);
    }

    /**
     * @returns A 53-bit positive integer non-cryptographic hash of the primary key, or undefined if not yet saved.
     */
    getPrimaryKeyHash(): number {
        if (this._primaryKeyHash === undefined) this.getPrimaryKey();
        return this._primaryKeyHash!;
    }

    isLazyField(field: keyof this) {
        const oldValues = this._oldValues;
        return !!(oldValues && oldValues !== null && field in this.constructor._lazyDescriptors && !oldValues.hasOwnProperty(field));
    }

    _write(txn: Transaction): undefined | Change {
        const oldValues = this._oldValues;

        if (oldValues === false) return; // preventPersist() was called

        if (oldValues === null) { // Delete instance
            const pk = this._primaryKey;
            // Temporarily restore _oldValues so computed indexes can trigger lazy loads
            this._oldValues = {};
            for (const index of Object.values(this.constructor._secondaries || {})) {
                index._delete(txn, pk!, this);
            }
            this.constructor._deletePK(txn, pk!, this);
            
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
            this.constructor._writePK(txn, pk!, this);

            // Insert all secondaries
            for (const index of Object.values(this.constructor._secondaries || {})) {
                index._write(txn, pk!, this);
            }

            return "created";
        }

        // oldValues is an object.
        // We're doing an update. Note that we may still be in a lazy state, and we don't want to load
        // the whole object just to see if something changed.

        // Add old values of changed fields to 'changed'.
        const changed: Record<string, any> = {};
        const cls = this.constructor;
        const fields = cls.fields;
        for(const fieldName in oldValues) {
            const oldValue = oldValues[fieldName];
            const newValue = this[fieldName as keyof ModelBase];
            if (newValue !== oldValue  && !(fields[fieldName] as FieldConfig<unknown>).type.equals(newValue, oldValue)) {
                changed[fieldName] = oldValue;
            }
        }

        if (isObjectEmpty(changed)) return; // No changes, nothing to do

        // Make sure primary has not been changed
        for (const field of cls._indexFields.keys()) {
            if (changed.hasOwnProperty(field)) {
                throw new DatabaseError(`Cannot modify primary key field: ${field}`, "CHANGE_PRIMARY");
            }
        }

        // We have changes. Now it's okay for any lazy fields to be loaded (which the validate will trigger).

        // Raise any validation errors
        this.validate(true);

        // Update the primary index
        const pk = this._primaryKey!;
        cls._writePK(txn, pk, this);

        // Update any secondaries with changed fields
        for (const index of Object.values(cls._secondaries || {})) {
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
        if (this._oldValues === undefined && this._primaryKey !== undefined) {
            throw new DatabaseError("Cannot preventPersist() after PK has been used", "INVALID");
        }
        this._oldValues = false;
        // Have access to '_txn' throw a descriptive error:
        Object.defineProperty(this, "_txn", PREVENT_PERSIST_DESCRIPTOR);
        return this;
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
        if (this._oldValues === undefined) throw new DatabaseError("Cannot delete unsaved instance", "INVALID");
        this._oldValues = null;
    }

    /**
     * Validate all fields in this model instance.
     * @param raise If true, throw on first validation error.
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
        const cls = this.constructor;
        
        for (const [key, fieldConfig] of Object.entries(cls.fields)) {
            let e = fieldConfig.type.getError((this as any)[key]);
            if (e) {
                e = addErrorPath(e, cls.tableName+"."+key);
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
        for(const [key,descr] of Object.entries(this.constructor._lazyDescriptors)) {
            if (descr && 'get' in descr && descr.get === Reflect.getOwnPropertyDescriptor(this, key)?.get) {
                return "lazy";
            }
        }
        return "loaded";
    }

    toString(): string {
        const cls = this.constructor;
        const pk = cls._pkToArray(this._primaryKey || cls._serializePK(this).toUint8Array(false));
        return `{Model:${cls.tableName} ${this.getState()} ${pk}}`;
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
        return this.toString();
    }
}

export async function deleteEverything(): Promise<void> {
    let done = false;
    while (!done) {
        await transact(() => {
            const txn = currentTxn();
            const iteratorId = lowlevel.createIterator(txn.id, undefined, undefined, false);
            const deadline = Date.now() + 150;
            let count = 0;
            try {
                while (true) {
                    const raw = lowlevel.readIterator(iteratorId);
                    if (!raw) {
                        done = true;
                        break;
                    }
                    lowlevel.del(txn.id, raw.key);
                    if (++count >= 4096 || Date.now() >= deadline) break;
                }
            } finally {
                lowlevel.closeIterator(iteratorId);
            }
        });
    }

    for (const model of Object.values(modelRegistry)) {
        pendingModelInits.delete(model);
        await model._initialize(true);
    }
}

/**
 * A model instance, including its user-defined fields.
 * @template FIELDS - The fields defined on this model.
 */
export type Model<FIELDS> = FIELDS & ModelBase;
export const Model = ModelBase;
