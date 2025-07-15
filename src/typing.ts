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

// Base type wrapper remains the same
export abstract class TypeWrapper<const T> {
    _T!: T; // This field *is* required, because of reasons!
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

// Type wrappers (StringType, NumberType, etc.) remain the same
// ... keep all your existing type wrapper implementations ...

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

// Field configuration interface
export interface FieldConfig {
    type: TypeWrapper<any>;
    description?: string;
    default?: any;
    primary?: boolean;
}

// The updated field function returns the config, but is typed as the value type
export function field<T>(type: TypeWrapper<T>, options: Partial<FieldConfig> = {}): T {
    // Return the config object, but TypeScript sees it as type T
    options.type = type;
    return options as any;
}

// Base Model class
export class Model {
    static tableName: string = this.name;
    static indexes?: Array<string|string[]>;
    private static fields?: Record<string, FieldConfig>;
    private static tableId?: number;
    
    // Track original values for change detection
    private _originalValues?: Map<string, any>;
    
    constructor(initial: Partial<any> = {}) {
        // Initialize the class if not already done
        if (!("fields" in this.constructor)) (this.constructor as typeof Model).initializeClass();

        // Apply initial values from constructor
        Object.assign(this, initial);
    }
    
    // Initialize class fields from metadata
    private static initializeClass(this: typeof Model) {
        // Look for field definitions in the prototype
        const proto: any = this.prototype;
        const fields: Record<string, FieldConfig> = {};
        
        for (const key in proto) {
            const value = proto[key] as FieldConfig;
            // Check if this property contains field metadata
            if (value && value.type instanceof TypeWrapper) {
                fields[key] = value;
                
                // Set default value on the prototype
                proto[key] = value.default;
            }
        }
        // Store field definitions on the constructor
        this.fields = fields;
        MODEL_REGISTRY[this.tableName] = this;
    }
    
    // Get all field definitions for this model class
    static getFields(): Record<string, FieldConfig> {
        if (!("fields" in this)) this.initializeClass();
        return this.fields!;
    }
    
    getTableId(): number {
        const model = (this.constructor as typeof Model);
        if (model.tableId === undefined) {
            model.tableId = getTableId(model.tableName);
        }
        return model.tableId;
    }

    // Serialization and persistence
    save() {
        const fields = (this.constructor as typeof Model).fields!;
        let keyBytes = new Bytes().writeNumber(this.getTableId());
        let valBytes = new Bytes();

        for (const [key, fieldConfig] of Object.entries(fields)) {
            const value = (this as any)[key];
            fieldConfig.type.serialize(value, fieldConfig.primary ? keyBytes : valBytes);
        }

        olmdb.put(keyBytes.getBuffer(), valBytes.getBuffer());
        return this;
    }

    // Static load method
    static load(...primaryKeyValues: any[]): Model | undefined {
        const instance = new this();
        return instance.load(...primaryKeyValues) ? instance : undefined;
    }

    // Instance loading
    load(...primaryKeyValues: any[]): boolean {
        const fields = (this.constructor as typeof Model).fields!;
        let keyBytes = new Bytes().writeNumber(this.getTableId());

        // Serialize primary key values
        let primaryKeyIndex = 0;
        for (const [fieldKey, fieldConfig] of Object.entries(fields)) {
            if (fieldConfig.primary) {
                if (primaryKeyIndex >= primaryKeyValues.length) {
                    throw new Error(`Missing primary key value for field ${fieldKey}`);
                }
                fieldConfig.type.serialize(primaryKeyValues[primaryKeyIndex], keyBytes);
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
        for (const [fieldKey, fieldConfig] of Object.entries(fields)) {
            if (fieldConfig.primary) {
                (this as any)[fieldKey] = primaryKeyValues[primaryKeyIndex];
                primaryKeyIndex++;
            } else {
                fieldConfig.type.deserialize(this, fieldKey, valueBytes);
            }
        }

        // Track that the model has been loaded
        this._originalValues = new Map();
        return true;
    }

    validate(): Error[] {
        const errors: Error[] = [];
        const fields = (this.constructor as typeof Model).fields!;
        
        for (const [key, fieldConfig] of Object.entries(fields)) {
            const value = (this as any)[key];
            for (const error of fieldConfig.type.getErrors(value)) {
                errors.push(error.addPath(key));
            }
        }
        
        return errors;
    }
    
    isValid(): boolean {
        return this.validate().length === 0;
    }
}

// Model registry for type deserialization
const MODEL_REGISTRY: Record<string, typeof Model> = {};


// Link type for models
class LinkType<T extends typeof Model> extends TypeWrapper<InstanceType<T>> {
    kind = 'link';
    TargetModel!: T;
    
    constructor(modelOrFunc: T | (() => T)) {
        super();
        if ('fields' in modelOrFunc) {
            // It's a direct model reference
            this.TargetModel = modelOrFunc;
        } else {
            // It's a function that returns a model
            const func = modelOrFunc as (() => T);
            Object.defineProperty(this, 'TargetModel', {
                get: () => {
                    const result = func();
                    Object.defineProperty(this, 'TargetModel', {
                        value: result,
                        configurable: true,
                        writable: true
                    });
                    return result;
                },
                configurable: true,
                enumerable: true,
            });
        }
    }
    
    serialize(value: InstanceType<T>, bytes: Bytes): void {
        const fields = this.TargetModel.getFields();
        for (const [key, fieldConfig] of Object.entries(fields)) {
            if (fieldConfig.primary) fieldConfig.type.serialize((value as any)[key], bytes);
        }
    }
    
    deserialize(obj: any, prop: string, bytes: Bytes) {
        const pk: any[] = [];
        const fields = this.TargetModel.getFields();
        
        for (const [key, fieldConfig] of Object.entries(fields)) {
            if (fieldConfig.primary) {
                const index = pk.length;
                fieldConfig.type.deserialize(pk, index, bytes);
            }
        }

        // Define a getter to load the model on first access
        Object.defineProperty(obj, prop, {
            get: function() {
                const model = new (this.TargetModel as any)();
                if (!model.load(...pk)) {
                    throw new Error(`Failed to load model ${this.TargetModel.name} with primary key ${pk}`);
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
    
    getErrors(value: any): Error[] {
        if (!(value instanceof this.TargetModel)) {
            return [new Error(`Expected instance of ${this.TargetModel.name}, got ${typeof value}`)];
        }
        return [];
    }
    
    serializeType(bytes: Bytes): void {
        bytes.writeString(this.TargetModel.tableName);
    }
    
    static deserializeType(bytes: Bytes, featureFlags: number): LinkType<any> {
        const tableName = bytes.readString();
        const targetModel = MODEL_REGISTRY[tableName];
        if (!targetModel) throw new Error(`Model ${tableName} not found in registry`);
        return new LinkType(targetModel);
    }
}

// Type helper shortcuts
export const string = new StringType();
export const number = new NumberType();
export const boolean = new BooleanType();

export function literal<const T>(value: T) {
    return new LiteralType<T>(value);
}

const undef = new LiteralType(undefined);
export function opt<const T>(inner: TypeWrapper<T>|BasicType) {
    return new OrType<T|undefined>([undef, wrapIfLiteral(inner)]);
}

export function array<const T>(inner: TypeWrapper<T>, opts: {min?: number, max?: number} = {}) {
    return new ArrayType<T>(wrapIfLiteral(inner), opts);
}

export function or<const TWA extends (TypeWrapper<unknown>|BasicType)[]>(...choices: TWA) {
    return new OrType<WrappersToUnionType<TWA>>(choices.map(wrapIfLiteral));
}

export function link<const T extends typeof Model>(TargetModel: T | (() => T)) {
    return new LinkType<T>(TargetModel);
}

type BasicType = TypeWrapper<any> | string | number | boolean | undefined | null;
type WrappersToUnionType<T extends BasicType[]> = {
    [K in keyof T]: T[K] extends TypeWrapper<infer U> ? U : T[K];
}[number];

// Utility functions
function wrapIfLiteral<const T>(type: TypeWrapper<T>): TypeWrapper<T>;
function wrapIfLiteral<const T>(type: T): LiteralType<T>;

function wrapIfLiteral(type: any) {
    return type instanceof TypeWrapper ? type : new LiteralType(type);
}

// Table ID mapping
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

// Model schema serialization
export function serializeModel(MyModel: typeof Model, bytes: Bytes) {
    const fields = MyModel.getFields();
    bytes.writeNumber(0); // feature flags
    bytes.writeNumber(Object.keys(fields).length);
    for (const [key, fieldConfig] of Object.entries(fields)) {
        bytes.writeString(key);
        serializeType(fieldConfig.type, bytes);
    }
}

