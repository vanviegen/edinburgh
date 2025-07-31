import { Bytes } from "./bytes.js";
import { DatabaseError } from "olmdb";
import { Model, registerModel, modelRegistry } from "./models.js";
import { assert, addErrorPath, ERROR_AT } from "./utils.js";

/**
 * Abstract base class for all type wrappers in the Edinburgh ORM system.
 * 
 * Type wrappers define how values are serialized to/from the database and how they are validated.
 * Each type wrapper must implement serialization, deserialization, and validation logic.
 * 
 * @template T - The TypeScript type this wrapper represents
 */
export abstract class TypeWrapper<const T> {
    /** @internal Used for TypeScript type inference - this field is required for the type system */
    _T!: T;
    
    /** A string identifier for this type, used during serialization */
    abstract kind: string;

    constructor() {}
    
    /**
     * Serialize a value from an object property to bytes
     * @param obj - The object containing the value
     * @param prop - The property name or index
     * @param bytes - The Bytes instance to write to
     * @param model - Optional model instance for context
     */
    abstract serialize(obj: any, prop: string|number, bytes: Bytes, model?: any): void;
    
    /**
     * Deserialize a value from bytes into an object property
     * @param obj - The object to set the value on
     * @param prop - The property name or index
     * @param bytes - The Bytes instance to read from
     * @param model - Optional model instance for context
     */
    abstract deserialize(obj: any, prop: string|number, bytes: Bytes, model?: any): void;
    
    /**
     * Validate a value and return any validation errors
     * @param obj - The object containing the value
     * @param prop - The property name or index
     * @returns Array of validation errors (empty if valid)
     */
    abstract getErrors(obj: any, prop: string | number): DatabaseError[];
    
    /**
     * Validate a value and serialize it, throwing on validation errors
     * @param obj - The object containing the value
     * @param prop - The property name or index
     * @param bytes - The Bytes instance to write to
     * @param model - Optional model instance for context
     * @throws {DatabaseError} If validation fails
     */
    validateAndSerialize(obj: any, prop: string|number, bytes: Bytes, model?: any): void {
        const errors = this.getErrors(obj, prop);
        if (errors.length) throw errors[0];
        this.serialize(obj, prop, bytes, model);
    }
    
    /**
     * Serialize type metadata to bytes (for schema serialization)
     * @param bytes - The Bytes instance to write to
     */
    serializeType(bytes: Bytes) {}
    
    /**
     * Check if indexing should be skipped for this field value
     * @param obj - The object containing the value
     * @param prop - The property name or index
     * @returns true if indexing should be skipped
     */
    checkSkipIndex(obj: any, prop: string | number): boolean {
        return false;
    }
}

/**
 * Optional interface for type wrappers that can provide default values
 * @template T - The TypeScript type this wrapper represents
 */
export interface TypeWrapper<T> {
    /**
     * Generate a default value for this type
     * @param model - The model instance
     * @returns The default value
     */
    default?(model: any): T;
}

/**
 * Type wrapper for string values
 */
export class StringType extends TypeWrapper<string> {
    kind = 'string';
    
    serialize(obj: any, prop: string, bytes: Bytes, model?: any) {
        bytes.writeString(obj[prop]);
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: any): void {
        obj[prop] = bytes.readString();
    }
    
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        if (typeof obj[prop] !== 'string') {
            return [new DatabaseError(`Expected string, got ${typeof obj[prop]}`, 'INVALID_TYPE')];
        }
        return [];
    }
}

/**
 * Type wrapper for number values
 */
export class NumberType extends TypeWrapper<number> {
    kind = 'number';
    
    serialize(obj: any, prop: string, bytes: Bytes, model?: any) {
        bytes.writeNumber(obj[prop]);
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: any): void {
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

/**
 * Type wrapper for boolean values
 */
export class BooleanType extends TypeWrapper<boolean> {
    kind = 'boolean';
    
    serialize(obj: any, prop: string, bytes: Bytes, model?: any) {
        bytes.writeBits(obj[prop] ? 1 : 0, 1);
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: any): void {
        obj[prop] = bytes.readBits(1) === 1;
    }
    
    getErrors(obj: any, prop: string | number): DatabaseError[] {
        if (typeof obj[prop] !== 'boolean') {
            return [new DatabaseError(`Expected boolean, got ${typeof obj[prop]}`, 'INVALID_TYPE')];
        }
        return [];
    }
}

/**
 * Type wrapper for array values with optional length constraints
 * @template T - The type of array elements
 */
export class ArrayType<T> extends TypeWrapper<T[]> {
    kind = 'array';
    
    /**
     * Create a new ArrayType
     * @param inner - Type wrapper for array elements
     * @param opts - Array constraints (min/max length)
     */
    constructor(public inner: TypeWrapper<T>, public opts: {min?: number, max?: number} = {}) {
        super();
    }

    serialize(obj: any, prop: string, bytes: Bytes, model?: any) {
        const value = obj[prop] as T[];
        bytes.writeNumber(value.length);
        for(let i=0; i<value.length; i++) {
            this.inner.serialize(value, i, bytes, model);
        }
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: any): void {
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

/**
 * Type wrapper for union/discriminated union types
 * @template T - The union type this wrapper represents
 */
export class OrType<const T> extends TypeWrapper<T> {
    kind = 'or';
    
    /**
     * Create a new OrType
     * @param choices - Array of type wrappers representing the union choices
     */
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
    
    serialize(obj: any, prop: string, bytes: Bytes, model?: any) {
        const choiceIndex = this._getChoiceIndex(obj, prop);
        bytes.writeUIntN(choiceIndex, this.choices.length-1);
        this.choices[choiceIndex].serialize(obj, prop, bytes, model);
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: any): void {
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

/**
 * Type wrapper for literal values (constants)
 * @template T - The literal type this wrapper represents
 */
export class LiteralType<const T> extends TypeWrapper<T> {
    kind = 'literal';
    
    /**
     * Create a new LiteralType
     * @param value - The literal value this type represents
     */
    constructor(public value: T) {
        super();
    }
    
    serialize(obj: any, prop: string | number, bytes: Bytes, model?: any) {
        // Literal values don't need to be serialized since they're constants
    }
    
    deserialize(obj: any, prop: string | number, bytes: Bytes, model?: any): void {
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

const ID_SIZE = 7;

/**
 * Type wrapper for auto-generated unique identifier strings
 */
export class IdentifierType extends TypeWrapper<string> {
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

    default(model: any): string {
        // This will be implemented by importing olmdb in the models file
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
        } while (false); // Will be replaced with proper database check in models.ts
        return id;
    }
}

const WANT_PK_ARRAY = {};

export type KeysOfType<T, TProp> = { [P in keyof T]: T[P] extends TProp? P : never}[keyof T];

/**
 * Type wrapper for model relationships (foreign keys)
 * @template T - The target model class type
 */
export class LinkType<T extends typeof Model<any>> extends TypeWrapper<InstanceType<T>> {
    kind = 'link';
    TargetModel: T;

    /**
     * Create a new LinkType
     * @param TargetModel - The model class this link points to
     * @param reverse - Optional reverse link field name for bidirectional relationships
     */
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

        const targetInstance = pk.get(...pkArray!);
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

// Pre-defined type instances for convenience
/** Predefined string type instance */
export const string = new StringType();

/** Predefined number type instance */
export const number = new NumberType();

/** Predefined boolean type instance */
export const boolean = new BooleanType();

/** Predefined identifier type instance */
export const identifier = new IdentifierType();

/**
 * Create a literal type wrapper for a constant value
 * @template T - The literal type
 * @param value - The literal value
 * @returns A LiteralType instance
 * 
 * @example
 * ```typescript
 * const statusType = literal("active");
 * const countType = literal(42);
 * ```
 */
export function literal<const T>(value: T) {
    return new LiteralType<T>(value);
}

/**
 * Create a union type wrapper from multiple type choices
 * @template T - Array of type wrapper or basic types
 * @param choices - The type choices for the union
 * @returns An OrType instance
 * 
 * @example
 * ```typescript
 * const stringOrNumber = or(string, number);
 * const status = or("active", "inactive", "pending");
 * ```
 */
export function or<const T extends (TypeWrapper<unknown>|BasicType)[]>(...choices: T) {
    return new OrType<UnwrapTypes<T>>(choices.map(wrapIfLiteral) as any);
}

const undef = new LiteralType(undefined);

/**
 * Create an optional type wrapper (allows undefined)
 * @template T - TypeWrapper or basic type to make optional
 * @param inner - The inner type to make optional
 * @returns An OrType that accepts the inner type or undefined
 * 
 * @example
 * ```typescript
 * const optionalString = opt(string);
 * const optionalNumber = opt(number);
 * ```
 */
export function opt<const T extends TypeWrapper<unknown>|BasicType>(inner: T) {
    return or(undef, inner);
}

/**
 * Create an array type wrapper with optional length constraints
 * @template T - The element type
 * @param inner - Type wrapper for array elements
 * @param opts - Optional constraints (min/max length)
 * @returns An ArrayType instance
 * 
 * @example
 * ```typescript
 * const stringArray = array(string);
 * const boundedArray = array(number, {min: 1, max: 10});
 * ```
 */
export function array<const T>(inner: TypeWrapper<T>, opts: {min?: number, max?: number} = {}) {
    return new ArrayType<T>(wrapIfLiteral(inner), opts);
}

/**
 * Create a link type wrapper for model relationships
 * @template T - The target model class
 * @param TargetModel - The model class this link points to
 * @param reverse - Optional reverse link field name for bidirectional relationships
 * @returns A LinkType instance
 * 
 * @example
 * ```typescript
 * class User extends Model<User> {
 *   posts = field(array(link(Post, 'author')));
 * }
 * 
 * class Post extends Model<Post> {
 *   author = field(link(User));
 * }
 * ```
 */
export function link<const T extends typeof Model<any>>(TargetModel: T, reverse?: string & KeysOfType<InstanceType<T>, Model<any>[]>) {
    return new LinkType<T>(TargetModel, reverse);
}


// Utility types and functions
export type BasicType = TypeWrapper<any> | string | number | boolean | undefined | null;

export type UnwrapTypes<T extends BasicType[]> = {
    [K in keyof T]: T[K] extends TypeWrapper<infer U> ? U : T[K];
}[number];

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
    id: identifier,
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




