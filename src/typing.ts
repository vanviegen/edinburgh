import { Bytes } from "./bytes";
import * as olmdb from "olmdb";

const EMPTY_MAP = new Map<string, any>(); // Don't change!

class Error {
    public path: (string | number)[] = [];
    constructor(public message: string) {}
    addPath(...path: (string|number)[]) {
        this.path.push(...path);
        return this;
    }
}

abstract class Model<T extends Record<string, any>> {
    static _config: ExtendedModelConfig;
    _config: ExtendedModelConfig;
    _originalValues?: Map<string, any>;

    constructor(initial: Partial<T>) {
        Object.assign(this, initial);
        // Cache the config reference for better performance
        this._config = (this.constructor as typeof Model)._config;
    }

    // Instance methods that access the cached config
    getTableName(): string {
        return this._config.tableName ||= this.constructor.name;
    }

    getTableId(): number {
        if (this._config.tableId === undefined) {
            this._config.tableId = getTableId(this.getTableName());
        }
        return this._config.tableId;
    }

    save() {
        let keyBytes = new Bytes().writeNumber(this.getTableId());
        let valBytes = new Bytes();

        for (const [key, def] of Object.entries(this._config.fields)) {
            def.type.serialize((this as any)[key], def.primary ? keyBytes : valBytes);
        }

        olmdb.put(keyBytes.getBuffer(), valBytes.getBuffer());
    }

    // Static method with proper typing
    static load<M extends Model<any>>(this: new (init?: any) => M, ...primaryKeyValues: any[]): M | undefined {
        const instance = new this();
        return instance.load(...primaryKeyValues) ? instance : undefined;
    }

    // Instance method for loading
    load(...primaryKeyValues: any[]): boolean {
        let keyBytes = new Bytes().writeNumber(this.getTableId());

        // Serialize primary key values in the same order as fields
        let primaryKeyIndex = 0;
        for (const [fieldKey, def] of Object.entries(this._config.fields)) {
            if (def.primary) {
                if (primaryKeyIndex >= primaryKeyValues.length) {
                    throw new Error(`Missing primary key value for field ${fieldKey}`);
                }
                def.type.serialize(primaryKeyValues[primaryKeyIndex], keyBytes);
                primaryKeyIndex++;
            }
        }

        if (primaryKeyIndex !== primaryKeyValues.length) {
            throw new Error(`Expected ${primaryKeyIndex} primary key values, got ${primaryKeyValues.length}`);
        }

        const result = olmdb.get(keyBytes.getBuffer());
        if (!result) return false;
        const valueBytes = new Bytes(result);

        // Deserialize non-primary fields
        primaryKeyIndex = 0;
        for (const [fieldKey, def] of Object.entries(this._config.fields)) {
            if (def.primary) { // Set primary key value on the instance
                (this as any)[fieldKey] = primaryKeyValues[primaryKeyIndex];
                primaryKeyIndex++;
            } else { // Set non-primary key value
                def.type.deserialize((this as any), fieldKey, valueBytes);
            }
        }

        // Indicate that the model has been loaded
        this._originalValues = new Map();
        return true;
    }
}

// Type that captures all static methods of Model
type ModelStaticMembers = typeof Model;

export function createModel<F extends Record<string, FieldConfig>>(
    fields: F,
    config: ModelConfig = {}
) {
    // Create a new type for all fields in schema
    type FieldsType = { [K in keyof F]: WrapperToType<F[K]['type']> };

    // Create a complete model instance type that includes both field properties and Model methods
    type ModelInstanceType = FieldsType & Model<FieldsType>;

    // Create a complete model class type that includes all static methods from Model
    type ModelClassType = {
        new(init?: Partial<FieldsType>): ModelInstanceType;
    } & Omit<ModelStaticMembers, 'prototype' | 'name' | 'length'>;

    let extConfig = config as ExtendedModelConfig;
    extConfig.fields = fields;

    class CreatedModel extends Model<FieldsType> {
        static _config = extConfig;
    }

    return CreatedModel as ModelClassType;
}


const MODEL_REGISTRY: Record<string, typeof Model> = {};

export abstract class TypeWrapper<const T> {
    _T!: T;
    abstract kind: string;

    constructor() {}
    abstract serialize(value: any, bytes: Bytes): void;
    abstract deserialize(obj: any, prop: string|number, bytes: Bytes): void;
    abstract getErrors(value: any): Error[];
    validate(value: any): boolean {
        return this.getErrors(value).length === 0;
    }
    serializeType(bytes: Bytes) {}
}


export class StringType extends TypeWrapper<string> {
    kind = 'string';
    serialize(value: any, bytes: Bytes) {
        bytes.writeString(value);
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        obj[prop] = bytes.readString();
    }
    getErrors(value: any): Error[] {
        if (typeof value !== 'string') {
            return [new Error(`Expected string, got ${typeof value}`)];
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
    getErrors(value: any): Error[] {
        if (typeof value !== 'number' || isNaN(value)) {
            return [new Error(`Expected number, got ${typeof value}`)];
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
    getErrors(value: any): Error[] {
        if (!Array.isArray(value)) {
            return [new Error(`Expected array, got ${typeof value}`)];
        }
        const errors: Error[] = [];
        if (this.opts.min !== undefined && value.length < this.opts.min) {
            errors.push(new Error(`Array length ${value.length} is less than minimum ${this.opts.min}`));
        }
        if (this.opts.max !== undefined && value.length > this.opts.max) {
            errors.push(new Error(`Array length ${value.length} is greater than maximum ${this.opts.max}`));
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
    constructor(public choices: TypeWrapper<unknown>[]) {
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
        throw new Error(`Value does not match any union type: ${value}`);
    }
    deserialize(obj: any, prop: string, bytes: Bytes): void {
        const index = bytes.readUIntN(this.choices.length-1);
        if (index < 0 || index >= this.choices.length) {
            throw new Error(`Invalid union type index ${index}`);
        }
        const type = this.choices[index];
        type.deserialize(obj, prop, bytes);
    }
    getErrors(value: T): Error[] {
        const errors: Error[] = [];
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
    getErrors(value: any): Error[] {
        return this.value===value ? [] : [new Error(`Invalid literal value ${value} instead of ${this.value}`)];
    }
    serializeType(bytes: Bytes): void {
        bytes.writeString(JSON.stringify(this.value));
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
    getErrors(value: any): Error[] {
        if (typeof value !== 'boolean') {
            return [new Error(`Expected boolean, got ${typeof value}`)];
        }
        return [];
    }
}

class LinkType<T extends typeof Model> extends TypeWrapper<InstanceType<T>> {
    kind = 'link'
    TargetModel!: T;
    constructor(modelOrFunc: T  | (() => T)) {
        super();
        if ('_config' in modelOrFunc) {
            this.TargetModel = modelOrFunc;
        } else {
            // If a function is passed, we will lazily resolve it
            // This allows circular dependencies in models
            Object.defineProperty(this, 'TargetModel', {
                get: () => {
                    Object.defineProperty(this, 'TargetModel', {
                        value: modelOrFunc(),
                        configurable: true,
                        writable: true
                    });
                    return this.TargetModel;
                },
                configurable: true,
                enumerable: true,
            });
        }
    }
    serialize(value: InstanceType<T>, bytes: Bytes): void {
        for (const [key, def] of Object.entries(value._config.fields)) {
            if (def.primary) def.type.serialize((this as any)[key], bytes);
        }
    }
    deserialize(obj: any, prop: string, bytes: Bytes) {
        const pk: any[] = [];
        for (const [key, def] of Object.entries(this.TargetModel._config.fields)) {
            if (def.primary) def.type.deserialize(pk, pk.length, bytes);
        }

        // Define a getter to load the model on first access
        Object.defineProperty(obj, prop, {
            get: function() {
                const obj = new (this.TargetModel as any)();
                if (!obj.load(pk)) {
                    throw new Error(`Failed to load model ${this.TargetModel.name} with primary key ${pk}`);
                }
                // Invoke set() below, to remove the getter and setter, and just revert to a simple value property
                this[prop] = obj;
                return obj;
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
            configurable: true,
        });
    }
    getErrors(value: any): Error[] {
        if (!(value instanceof this.TargetModel)) {
            return [new Error(`Expected instance of ${this.TargetModel.name}, got ${typeof value}`)];
        }
        return [];
    }
    serializeType(bytes: Bytes): void {
        bytes.writeString(this.TargetModel._config.tableName || this.TargetModel.constructor.name);
    }
    static deserializeType(bytes: Bytes, featureFlags: number): LinkType<any> {
        const tableName = bytes.readString();
        const targetModel = MODEL_REGISTRY[tableName];
        if (!targetModel) throw new Error(`Model ${tableName} not found in registry`);
        return new LinkType(targetModel);
    }
}


export const string = new StringType();
export const number = new NumberType();
export const boolean = new BooleanType();

export function literal<const T>(value: T) {
    return new LiteralType<T>(value);
}

const undef = new LiteralType(undefined);
export function opt<const T>(inner: TypeWrapper<T>|BasicType) {
    return new OrType<T|undefined>([undef, wrapIfLiteral(inner),]);
}

export function array<const T>(inner: TypeWrapper<T>, opts: {min?: number, max?: number} = {}) {
    return new ArrayType<T>(inner, opts);
}

export function or<const TWA extends (TypeWrapper<unknown>|BasicType)[]>(...choices: TWA) {
    return new OrType<WrappersToUnionType<TWA>>(choices.map(wrapIfLiteral));
}

export function link<const T extends typeof Model>(TargetModel: T | (() => T)) {
    return new LinkType<T>(TargetModel);
}

type BasicType = TypeWrapper<any> | string | number | boolean | undefined | null;

export type FieldsConfig = {
    [K in string]: FieldConfig;
};

export interface FieldConfig {
    type: TypeWrapper<any>,
    description?: string,
    default?: any,
    primary?: boolean, // If true, this field is part of the primary key
}

export interface ModelConfig {
    tableName?: string; // defaults to class name
    indexes?: Array<string|string[]>; // defaults to []
}

export interface ExtendedModelConfig extends ModelConfig {
    fields: Record<string, FieldConfig>;
    tableId?: number; // Used internally to track table IDs
}

export type WrapperToType<T> = T extends TypeWrapper<infer U> ? U : T;

type WrappersToUnionType<T extends BasicType[]> = {
    [K in keyof T]: T[K] extends TypeWrapper<infer U> ? U : T[K];
}[number];

function wrapIfLiteral<const T>(type: TypeWrapper<T>): TypeWrapper<T>;
function wrapIfLiteral<const T>(type: T): LiteralType<T>;

function wrapIfLiteral(type: any) {
    return type instanceof TypeWrapper ? type : new LiteralType(type);
}

const MAX_TABLE_ID_ID = -1;
const TABLE_NAME_ID = -2;

function getTableId(tableName: string): number {
    const tableNameBuf = new Bytes().writeNumber(TABLE_NAME_ID).writeString(tableName).getBuffer();
    let result = olmdb.get(tableNameBuf);
    if (result) return new Bytes(result).readNumber();

    const maxTableIdBuf = new Bytes().writeNumber(MAX_TABLE_ID_ID).getBuffer();
    result = olmdb.get(maxTableIdBuf);
    const id = result ? new Bytes(result).readNumber() + 1 : 1;
    const idBuf = new Bytes().writeNumber(id).getBuffer()
    olmdb.put(tableNameBuf, idBuf);
    olmdb.put(maxTableIdBuf, idBuf);
    return id;
}


/**
 * This preserves only the *types* of a model, enough to serialize/deserialize
 * data afterwards (in order to migrate it to a new model version).
 * It does not preserve the class methods, property descriptions, validators, etc.
 */
export function serializeModel<T>(arg: {fields: FieldsConfig}, bytes: Bytes) {
    const schema = arg.fields;
    bytes.writeNumber(0); // feature flags, reserved for future use
    bytes.writeNumber(Object.keys(schema).length);
    for (const [key, def] of Object.entries(schema)) {
        bytes.writeString(key);
        serializeType(def.type, bytes);
    }
}

function serializeType(arg: TypeWrapper<any>, bytes: Bytes) {
    bytes.writeString(arg.kind);
    arg.serializeType(bytes);
}

export function deserializeModel<T>(bytes: Bytes) {
    const featureFlags = bytes.readNumber(); // reserved for future use
    const count = bytes.readNumber();
    const schema: FieldsConfig = {};
    for (let i = 0; i < count; i++) {
        const name = bytes.readString();
        const type = deserializeType(bytes, featureFlags);
        schema[name] = {type};
    }
    return createModel(schema);
}

const TYPE_WRAPPERS: Record<string,TypeWrapper<any> | {deserializeType: (bytes: Bytes, featureFlags: number) => TypeWrapper<any>}> = {
    string: string,
    number: number,
    array: ArrayType,
    or: OrType,
    literal: LiteralType,
    boolean: boolean,
    link: LinkType,
    // multiLink: MultiLinkType
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

