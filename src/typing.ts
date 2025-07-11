import { Bytes } from "./bytes";
import * as olmdb from "olmdb";

class Error {
    public path: (string | number)[] = [];
    constructor(public message: string) {}
    addPath(...path: (string|number)[]) {
        this.path.push(...path);
        return this;
    }
}


export abstract class TypeWrapper<const T> {
    _T!: T;
    abstract kind: string;
    
    constructor() {}
    abstract serialize(value: any, bytes: Bytes): void;
    abstract deserialize(bytes: Bytes): T;
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
    deserialize(bytes: Bytes): string {
        return bytes.readString();
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
    deserialize(bytes: Bytes): number {
        return bytes.readNumber();
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
    constructor(public inner: TypeWrapper<T>) {
        super();
    }
    
    serialize(value: any, bytes: Bytes) {
        bytes.writeNumber(value.length);
        for(let item of value) {
            this.inner.serialize(item, bytes);
        }
    }
    deserialize(bytes: Bytes): T[] {
        const length = bytes.readNumber();
        const result: T[] = [];
        for (let i = 0; i < length; i++) {
            result.push(this.inner.deserialize(bytes));
        }
        return result;
    }
    getErrors(value: any): Error[] {
        if (!Array.isArray(value)) {
            return [new Error(`Expected array, got ${typeof value}`)];
        }
        const errors: Error[] = [];
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
    deserialize(bytes: Bytes): T {
        const index = bytes.readUIntN(this.choices.length-1);
        if (index < 0 || index >= this.choices.length) {
            throw new Error(`Invalid union type index ${index}`);
        }
        const type = this.choices[index];
        return type.deserialize(bytes) as T;
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
    deserialize(bytes: Bytes): T {
        return this.value;
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
    deserialize(bytes: Bytes): boolean {
        return bytes.readBits(1) === 1;
    }
    getErrors(value: any): Error[] {
        if (typeof value !== 'boolean') {
            return [new Error(`Expected boolean, got ${typeof value}`)];
        }
        return [];
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

export function array<const T>(inner: TypeWrapper<T>) {
    return new ArrayType<T>(inner);
}

export function or<const TWA extends (TypeWrapper<unknown>|BasicType)[]>(...choices: TWA) {
    return new OrType<WrappersToUnionType<TWA>>(choices.map(wrapIfLiteral));
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


export function createModel<const F extends Record<string, FieldConfig>>(fields: F, config: ModelConfig = {}) {
    // Create a new type for all fields in schema that maps field names to their (unwrapped) types.
    type FieldsType = { -readonly [K in keyof F]: WrapperToType<F[K]['type']> };
    
    class BaseModel {
        static fields: FieldsConfig = fields;
        static config: ModelConfig = config;
        static tableId: number | undefined;
        _loaded?: true;
        
        constructor(initial: Partial<FieldsType> = {}) {
            Object.assign(this, initial);
        }
        
        serialize(bytes: Bytes, primary?: boolean) {
            for (const [key, def] of Object.entries(fields)) {
                if (primary===undefined || primary === (def.primary||false)) {
                    def.type.serialize((this as any)[key], bytes);
                }
            }
        }

        static deserialize(bytes: Bytes): FieldsType & BaseModel {
            const instance = new this();
            for (const [key, def] of Object.entries(fields)) {
                const value = def.type.deserialize(bytes);
                (instance as any)[key] = value;
            }
            return instance as FieldsType & BaseModel;
        }

        static getTableId(): number {
            if (BaseModel.tableId === undefined) BaseModel.tableId = getTableId(config.tableName || this.constructor.name);
            return BaseModel.tableId;
        }

        save() {
            let key = new Bytes().writeNumber(BaseModel.getTableId());
            this.serialize(key, true);

            let val = new Bytes();
            this.serialize(val, false);

            olmdb.put(key.getBuffer(), val.getBuffer());
        }

        static load(...primaryKeyValues: any[]): (FieldsType & BaseModel) | undefined {
            let key = new Bytes().writeNumber(BaseModel.getTableId());
            
            // Serialize primary key values in the same order as fields
            let primaryKeyIndex = 0;
            for (const [fieldKey, def] of Object.entries(fields)) {
                if (def.primary) {
                    if (primaryKeyIndex >= primaryKeyValues.length) {
                        throw new Error(`Missing primary key value for field ${fieldKey}`);
                    }
                    def.type.serialize(primaryKeyValues[primaryKeyIndex], key);
                    primaryKeyIndex++;
                }
            }
            
            if (primaryKeyIndex !== primaryKeyValues.length) {
                throw new Error(`Expected ${primaryKeyIndex} primary key values, got ${primaryKeyValues.length}`);
            }

            const result = olmdb.get(key.getBuffer());
            if (!result) return undefined;

            const instance = new this();
            const valueBytes = new Bytes(result);
            
            // Deserialize non-primary fields
            for (const [fieldKey, def] of Object.entries(fields)) {
                if (!def.primary) {
                    const value = def.type.deserialize(valueBytes);
                    (instance as any)[fieldKey] = value;
                }
            }
            
            // Set primary key values on the instance
            primaryKeyIndex = 0;
            for (const [fieldKey, def] of Object.entries(fields)) {
                if (def.primary) {
                    (instance as any)[fieldKey] = primaryKeyValues[primaryKeyIndex];
                    primaryKeyIndex++;
                }
            }
            
            instance._loaded = true;
            return instance as FieldsType & BaseModel;
        }
    }
    
    // Trick TypeScript into thinking this is a typed constructor
    return BaseModel as unknown as {
        new(init?: Partial<FieldsType>): FieldsType & BaseModel;
        deserialize(bytes: Bytes): FieldsType & BaseModel;
        load(...primaryKeyValues: any[]): (FieldsType & BaseModel) | undefined;
        fields: FieldsConfig;
        config: ModelConfig;
    };
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

