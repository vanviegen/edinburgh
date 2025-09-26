import { DataPack } from "./datapack.js";
import * as olmdb from "olmdb";
import { DatabaseError } from "olmdb";
import { Model, modelRegistry, getMockModel } from "./models.js";
import { assert, addErrorPath } from "./utils.js";


/**
* @internal Abstract base class for all type wrappers in the Edinburgh ORM system.
* 
* This is an implementation detail and should not be referenced directly in user code.
* Type wrappers define how values are serialized to/from the database and how they are validated.
* Each type wrapper must implement serialization, deserialization, and validation logic.
* 
* @template T - The TypeScript type this wrapper represents.
*/
export abstract class TypeWrapper<const T> {
    /** @internal Used for TypeScript type inference - this field is required for the type system */
    _T!: T;
    
    /** A string identifier for this type, used during serialization */
    abstract kind: string;
    
    constructor() {}
    
    /**
    * Serialize a value from an object property to a Pack.
    * @param value - The value to serialize.
    * @param pack - The Pack instance to write to.
    */
    abstract serialize(value: T, pack: DataPack): void;

    /**
    * Deserialize a value from a Pack into an object property.
    * @param pack - The Pack instance to read from.
    */
    abstract deserialize(pack: DataPack): T;

    /**
    * Validate a value.
    * @param value - The value to validate.
    * @returns - A DatabaseError if validation fails.
    */
    abstract getError(value: T): DatabaseError | void;
    
    /**
    * Serialize type metadata to a Pack (for schema serialization).
    * @param pack - The Pack instance to write to.
    */
    serializeType(pack: DataPack) {}
    
    /**
    * Check if indexing should be skipped for this field value.
    * @param obj - The object containing the value.
    * @param prop - The property name or index.
    * @returns true if indexing should be skipped.
    */
    containsNull(value: T): boolean {
        return false;
    }
    
    toString(): string {
        return `${this.kind}`;
    }

    clone(value: T): T {
        return value;
    }

    equals(value1: T, value2: T): boolean {
        return value1 === value2;
    }
}


export interface TypeWrapper<T> {
    /**
    * Generate a default value for this type.
    * @param model - The model instance.
    * @returns The default value.
    */
    default?(model: any): T;
}


class StringType extends TypeWrapper<string> {
    kind = 'string';
    
    serialize(value: string, pack: DataPack) {
        pack.write(value);
    }
    
    deserialize(pack: DataPack): string {
        return pack.readString();
    }

    getError(value: string) {
        if (typeof value !== 'string') {
            return new DatabaseError(`Expected string, got ${typeof value}`, 'INVALID_TYPE');
        }
    }
}


class OrderedStringType extends StringType {
    serialize(value: string, pack: DataPack) {
        pack.writeOrderedString(value);
    }
}


class NumberType extends TypeWrapper<number> {
    kind = 'number';

    serialize(value: number, pack: DataPack) {
        pack.write(value);
    }

    deserialize(pack: DataPack): number {
        return pack.readNumber();
    }

    getError(value: number) {
        if (typeof value !== 'number' || isNaN(value)) {
            return new DatabaseError(`Expected number, got ${typeof value}`, 'INVALID_TYPE');
        }
    }
}

class DateTimeType extends TypeWrapper<Date> {
    kind = 'dateTime';

    serialize(value: Date, pack: DataPack) {
        pack.write(value);
    }

    deserialize(pack: DataPack): Date {
        return pack.readDate();;
    }

    getError(value: Date) {
        if (!(value instanceof Date)) {
            return new DatabaseError(`Expected Date, got ${typeof value}`, 'INVALID_TYPE');
        }
    }

    default(): Date {
        return new Date();
    }

}

class BooleanType extends TypeWrapper<boolean> {
    kind = 'boolean';

    serialize(value: boolean, pack: DataPack) {
        pack.write(value);
    }

    deserialize(pack: DataPack): boolean {
        return pack.readBoolean();
    }

    getError(value: boolean) {
        if (typeof value !== 'boolean') {
            return new DatabaseError(`Expected boolean, got ${typeof value}`, 'INVALID_TYPE');
        }
    }
}

/**
* @internal Type wrapper for array values with optional length constraints.
* @template T - The type of array elements.
*/
class ArrayType<T> extends TypeWrapper<T[]> {
    kind = 'array';
    
    /**
    * Create a new ArrayType.
    * @param inner - Type wrapper for array elements.
    * @param opts - Array constraints (min/max length).
    */
    constructor(public inner: TypeWrapper<T>, public opts: {min?: number, max?: number} = {}) {
        super();
    }
    
    serialize(value: T[], pack: DataPack) {
        pack.write(value.length);
        for(let i=0; i<value.length; i++) {
            this.inner.serialize(value[i], pack);
        }
    }
    
    deserialize(pack: DataPack): T[] {
        const length = pack.readNumber();
        const result: T[] = [];
        for (let i = 0; i < length; i++) {
            result.push(this.inner.deserialize(pack));
        }
        return result;
    }

    getError(value: T[]) {
        if (!Array.isArray(value)) {
            return new DatabaseError(`Expected array, got ${typeof value}`, 'INVALID_TYPE');
        }

        if (this.opts.min !== undefined && value.length < this.opts.min) {
            return new DatabaseError(`Array length ${value.length} is less than minimum ${this.opts.min}`, 'OUT_OF_BOUNDS');
        }
        if (this.opts.max !== undefined && value.length > this.opts.max) {
            return new DatabaseError(`Array length ${value.length} is greater than maximum ${this.opts.max}`, 'OUT_OF_BOUNDS');
        }
        for (let i = 0; i < value.length; i++) {
            let error = this.inner.getError(value[i]);
            if (error) return addErrorPath(error, i);
        }
    }
    
    serializeType(pack: DataPack): void {
        serializeType(this.inner, pack);
    }
    
    static deserializeType(pack: DataPack, featureFlags: number): ArrayType<any> {
        const inner = deserializeType(pack, featureFlags);
        return new ArrayType(inner);
    }

    clone(value: T[]): T[] {
        return value.map(this.inner.clone.bind(this.inner));
    }

    equals(a: T[], b: T[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!this.inner.equals(a[i], b[i])) return false;
        }
        return true;
    }

}

/**
* @internal Type wrapper for array values with optional length constraints.
* @template T - The type of array elements.
*/
export class SetType<T> extends TypeWrapper<Set<T>> {
    kind = 'set';

    /**
    * Create a new SetType.
    * @param inner - Type wrapper for set elements.
    */
    constructor(public inner: TypeWrapper<T>, public opts: {min?: number, max?: number} = {}) {
        super();
    }

    serialize(value: Set<T>, pack: DataPack) {
        pack.write(value.size);
        for (const item of value) {
            this.inner.serialize(item, pack);
        }
    }

    deserialize(pack: DataPack): Set<T> {
        const length = pack.readNumber();
        const result = new Set<T>();
        for (let i = 0; i < length; i++) {
            result.add(this.inner.deserialize(pack));
        }
        return result;
    }

    getError(value: Set<T>) {
        if (!(value instanceof Set)) {
            return new DatabaseError(`Expected Set, got ${typeof value}`, 'INVALID_TYPE');
        }

        if (this.opts.min !== undefined && value.size < this.opts.min) {
            return new DatabaseError(`Set size ${value.size} is less than minimum ${this.opts.min}`, 'OUT_OF_BOUNDS');
        }
        if (this.opts.max !== undefined && value.size > this.opts.max) {
            return new DatabaseError(`Set size ${value.size} is greater than maximum ${this.opts.max}`, 'OUT_OF_BOUNDS');
        }

        try {
            for (const item of value) {
                this.inner.getError(item);
            }
        } catch (err) {
            throw addErrorPath(err, 'item');
        }
    }
    
    serializeType(pack: DataPack): void {
        serializeType(this.inner, pack);
    }
    
    static deserializeType(pack: DataPack, featureFlags: number): SetType<any> {
        const inner = deserializeType(pack, featureFlags);
        return new SetType(inner);
    }

    default(): Set<T> {
        return new Set<T>();
    }

    clone(value: Set<T>): Set<T> {
        const cloned = new Set<T>();
        for (const item of value) {
            cloned.add(this.inner.clone(item));
        }
        return cloned;
    }

    equals(a: Set<T>, b: Set<T>): boolean {
        if (a.size !== b.size) return false;
        for(const v of a) {
            if (!b.has(v)) return false;
        }
        return true;
    }
}


/**
* @internal Type wrapper for union/discriminated union types.
* @template T - The union type this wrapper represents.
*/
class OrType<const T> extends TypeWrapper<T> {
    kind = 'or';
    
    /**
    * Create a new OrType.
    * @param choices - Array of type wrappers representing the union choices.
    */
    constructor(public choices: TypeWrapper<T>[]) {
        super();
    }
    
    _getChoiceIndex(value: any): number {
        for (const [i, choice] of this.choices.entries()) {
            if (!choice.getError(value)) return i;
        }
        throw new DatabaseError(`Value does not match any union type: ${value}`, 'INVALID_TYPE');
    }
    
    serialize(value: T, pack: DataPack) {
        const choiceIndex = this._getChoiceIndex(value);
        pack.write(choiceIndex);
        this.choices[choiceIndex].serialize(value, pack);
    }
    
    deserialize(pack: DataPack) {
        const index = pack.readNumber();
        if (index < 0 || index >= this.choices.length) {
            throw new DatabaseError(`Could not deserialize invalid union index ${index}`, 'DESERIALIZATION_ERROR');
        }
        const type = this.choices[index];
        return type.deserialize(pack);
    }
    
    getError(value: any) {
        for (const choice of this.choices.values()) {
            if (!choice.getError(value)) return;
        }
        return new DatabaseError(`Value does not match any union type: ${value}`, 'INVALID_TYPE');
    }
    
    containsNull(value: T): boolean {
        const choiceIndex = this._getChoiceIndex(value);
        return this.choices[choiceIndex].containsNull(value);
    }
    
    serializeType(pack: DataPack): void {
        pack.write(this.choices.length);
        for (const choice of this.choices) {
            serializeType(choice, pack);
        }
    }
    
    static deserializeType(pack: DataPack, featureFlags: number): OrType<any> {
        const count = pack.readNumber();
        const choices: TypeWrapper<unknown>[] = [];
        for (let i = 0; i < count; i++) {
            choices.push(deserializeType(pack, featureFlags));
        }
        return new OrType(choices);
    }
    
    clone(value: T): T {
        const choiceIndex = this._getChoiceIndex(value);
        return this.choices[choiceIndex].clone(value);
    }

    equals(a: T, b: T): boolean {
        const ca = this._getChoiceIndex(a);
        const cb = this._getChoiceIndex(b);
        return ca === cb && this.choices[ca].equals(a, b);
    }
}

/**
* @internal Type wrapper for literal values (constants).
* @template T - The literal type this wrapper represents.
*/
class LiteralType<const T> extends TypeWrapper<T> {
    kind = 'literal';
    
    /**
    * Create a new LiteralType.
    * @param value - The literal value this type represents.
    */
    constructor(public value: T) {
        super();
    }
    
    serialize(value: T, pack: DataPack) {
        // Literal values don't need to be serialized since they're constants
    }
    
    deserialize(pack: DataPack) {
        return this.value;
    }
    
    getError(value: any) {
        if (this.value!==value) {
            return new DatabaseError(`Invalid literal value ${value} instead of ${this.value}`, 'INVALID_TYPE');
        }
    }
    
    serializeType(pack: DataPack): void {
        pack.write(this.value===undefined ? "" : JSON.stringify(this.value));
    }
    
    containsNull(value: T): boolean {
        return value == null;
    }
    
    static deserializeType(pack: DataPack, featureFlags: number): LiteralType<any> {
        const json = pack.readString();
        const value = json==="" ? undefined : JSON.parse(json);
        return new LiteralType(value);
    }
    
    default(): T {
        return this.value;
    }
}

const ID_SIZE = 8;

/**
* @internal Type wrapper for auto-generated unique identifier strings.
*/
class IdentifierType extends TypeWrapper<string> {
    kind = 'id';
    
    serialize(value: string, pack: DataPack): void {
        assert(value.length === ID_SIZE);
        pack.writeIdentifier(value);
    }

    deserialize(pack: DataPack) {
        return pack.readIdentifier();
    }
    
    getError(value: any) {
        if (typeof value !== 'string' || value.length !== ID_SIZE) return new DatabaseError(`Invalid ID format: ${value}`, 'VALUE_ERROR');
    }
    
    serializeType(pack: DataPack): void {
    }
    
    static deserializeType(pack: DataPack, featureFlags: number): IdentifierType {
        return new IdentifierType();
    }
    
    default(model: Model<any>): string {
        // Generate a random ID, and if it already exists in the database, retry.
        let id: string;
        do {
            id = DataPack.generateIdentifier();
        } while (olmdb.get(new DataPack().write(model.constructor._primary!._cachedIndexId!).writeIdentifier(id).toUint8Array()));
        return id;
    }
}

/**
* @internal Type wrapper for model relationships (foreign keys).
* @template T - The target model class type.
*/
export class LinkType<T extends typeof Model<unknown>> extends TypeWrapper<InstanceType<T>> {
    kind = 'link';
    TargetModel: T;
    
    /**
    * Create a new LinkType.
    * @param TargetModel - The model class this link points to.
    */
    constructor(TargetModel: T) {
        super();
        this.TargetModel = getMockModel(TargetModel);
    }
    
    serialize(model: InstanceType<T>, pack: DataPack) {
        pack.write(model._getCreatePrimaryKey());
    }
    
    deserialize(pack: DataPack) {
        return this.TargetModel._primary!.getLazy(pack.readUint8Array());
    }
    
    getError(value: InstanceType<T>) {
        if (!(value instanceof this.TargetModel)) {
            return new DatabaseError(`Expected instance of ${this.TargetModel.tableName}, got ${typeof value}`, 'VALUE_ERROR');
        }
    }
    
    serializeType(pack: DataPack): void {
        pack.write(this.TargetModel.tableName);
    }
    
    static deserializeType(pack: DataPack, featureFlags: number): LinkType<any> {
        const tableName = pack.readString();
        const targetModel = modelRegistry[tableName];
        if (!targetModel) throw new DatabaseError(`Could not deserialize undefined model ${tableName}`, 'DESERIALIZATION_ERROR');
        return new LinkType(targetModel);
    }
}

/** Type wrapper instance for the string type. */
export const string = new StringType() as TypeWrapper<string>;

/** Type wrapper instance for the ordered string type, which is just like a string
 * except that it sorts lexicographically in the database (instead of by incrementing
 * length first), making it suitable for index fields that want lexicographic range
 * scans. Ordered strings are implemented as null-terminated UTF-8 strings, so they
 * may not contain null characters.
 */
export const orderedString = new OrderedStringType() as TypeWrapper<string>;

/** Type wrapper instance for the number type. */
export const number = new NumberType() as TypeWrapper<number>;

/** Type wrapper instance for the date/time type. */
export const dateTime = new DateTimeType() as TypeWrapper<Date>;

/** Type wrapper instance for the boolean type. */
export const boolean = new BooleanType() as TypeWrapper<boolean>;

/** Type wrapper instance for the identifier type. */
export const identifier = new IdentifierType() as TypeWrapper<string>;

/** Type wrapper instance for the 'undefined' type. */
export const undef = new LiteralType(undefined) as TypeWrapper<undefined>;

/**
* Create a literal type wrapper for a constant value.
* @template T - The literal type.
* @param value - The literal value.
* @returns A literal type instance.
* 
* @example
* ```typescript
* const statusType = E.literal("active");
* const countType = E.literal(42);
* ```
*/
export function literal<const T>(value: T): TypeWrapper<T> {
    return new LiteralType(value);
}

/**
* Create a union type wrapper from multiple type choices.
* @template T - Array of type wrapper or basic types.
* @param choices - The type choices for the union.
* @returns A union type instance.
* 
* @example
* ```typescript
* const stringOrNumber = E.or(E.string, E.number);
* const status = E.or("active", "inactive", "pending");
* ```
*/
export function or<const T extends (TypeWrapper<unknown>|BasicType)[]>(...choices: T): TypeWrapper<UnwrapTypes<T>> {
    return new OrType(choices.map(wrapIfLiteral));
}

/**
* Create an optional type wrapper (allows undefined).
* @template T - Type wrapper or basic type to make optional.
* @param inner - The inner type to make optional.
* @returns A union type that accepts the inner type or undefined.
* 
* @example
* ```typescript
* const optionalString = E.opt(E.string);
* const optionalNumber = E.opt(E.number);
* ```
*/
export function opt<const T extends TypeWrapper<unknown>|BasicType>(inner: T): TypeWrapper<UnwrapTypes<[T, typeof undef]>> {
    return or(undef, inner);
}

/**
* Create an array type wrapper with optional length constraints.
* @template T - The element type.
* @param inner - Type wrapper for array elements.
* @param opts - Optional constraints (min/max length).
* @returns An array type instance.
* 
* @example
* ```typescript
* const stringArray = E.array(E.string);
* const boundedArray = E.array(E.number, {min: 1, max: 10});
* ```
*/
export function array<const T>(inner: TypeWrapper<T>, opts: {min?: number, max?: number} = {}): TypeWrapper<T[]> {
    return new ArrayType(wrapIfLiteral(inner), opts);
}

/**
* Create a Set type wrapper with optional length constraints.
* @template T - The element type.
* @param inner - Type wrapper for set elements.
* @param opts - Optional constraints (min/max length).
* @returns A set type instance.
*
* @example
* ```typescript
* const stringSet = E.set(E.string);
* const boundedSet = E.set(E.number, {min: 1, max: 10});
* ```
*/
export function set<const T>(inner: TypeWrapper<T>, opts: {min?: number, max?: number} = {}): TypeWrapper<Set<T>> {
    return new SetType(wrapIfLiteral(inner), opts);
}

/**
* Create a link type wrapper for model relationships.
* @template T - The target model class.
* @param TargetModel - The model class this link points to.
* @returns A link type instance.
* 
* @example
* ```typescript
* class User extends E.Model<User> {
*   posts = E.field(E.array(E.link(Post, 'author')));
* }
* 
* class Post extends E.Model<Post> {
*   author = E.field(E.link(User));
* }
* ```
*/
export function link<const T extends typeof Model<any>>(TargetModel: T): TypeWrapper<InstanceType<T>> {
    return new LinkType(TargetModel);
}


// Utility types and functions
export type BasicType = string | number | boolean | undefined | null; // TypeWrapper<any>

export type UnwrapTypes<T extends (TypeWrapper<unknown> | BasicType)[]> = {
    [K in keyof T]: T[K] extends TypeWrapper<infer U> ? U : T[K];
}[number];

function wrapIfLiteral<const T>(type: TypeWrapper<T>): TypeWrapper<T>;
function wrapIfLiteral<const T>(type: T): LiteralType<T>;
function wrapIfLiteral(type: any) {
    return type instanceof TypeWrapper ? type : new LiteralType(type);
}

/**
* Serialize a type wrapper to a Pack for schema persistence.
* @param arg - The type wrapper to serialize.
* @param pack - The Pack instance to write to.
*/
export function serializeType(arg: TypeWrapper<any>, pack: DataPack) {
    pack.write(arg.kind);
    arg.serializeType(pack);
}

const TYPE_WRAPPERS: Record<string, TypeWrapper<any> | {deserializeType: (pack: DataPack, featureFlags: number) => TypeWrapper<any>}> = {
    string: string,
    number: number,
    array: ArrayType,
    or: OrType,
    literal: LiteralType,
    boolean: boolean,
    id: identifier,
    link: LinkType,
    set: SetType
};

/**
* Deserialize a type wrapper from a Pack.
* @param pack - The Pack instance to read from.
* @param featureFlags - Feature flags for version compatibility.
* @returns The deserialized type wrapper.
*/
export function deserializeType(pack: DataPack, featureFlags: number): TypeWrapper<any> {
    const kind = pack.readString();
    const TypeWrapper = TYPE_WRAPPERS[kind];
    if ('deserializeType' in TypeWrapper) {
        return TypeWrapper.deserializeType(pack, featureFlags);
    } else {
        return TypeWrapper;
    }
}
