import * as lowlevel from "olmdb/lowlevel";
import { DatabaseError } from "olmdb/lowlevel";
import DataPack from "./datapack.js";
import { currentTxn, transact, type Transaction } from "./edinburgh.js";
import { assert, logLevel, dbGet, dbPut, dbDel, hashBytes, hashFunction, bytesEqual, toBuffer } from "./utils.js";
import { deserializeType, serializeType, TypeWrapper } from "./types.js";

type IndexItem = {
    _setLoadedField(fieldName: string, value: any): void;
    _restoreLazyFields?(): void;
};
type PrimaryKeyItem = IndexItem & {
    _oldValues: Record<string, any> | undefined | null | false;
    _primaryKey: Uint8Array | undefined;
    _txn: Transaction;
    _setPrimaryKey(key: Uint8Array, hash?: number): void;
};
type FieldTypes = ReadonlyMap<string, TypeWrapper<any>>;
type LoadPrimary<ITEM> = (txn: Transaction, primaryKey: Uint8Array, loadNow: boolean | Uint8Array) => ITEM | undefined;
type QueueInitialization = () => void;
type IndexArgTypes<ITEM, F extends readonly (keyof ITEM & string)[]> = {
    [I in keyof F]: ITEM[F[I]]
};

const MAX_INDEX_ID_PREFIX = -1;
const INDEX_ID_PREFIX = -2;
const VERSION_INFO_PREFIX = -3;

const MAX_INDEX_ID_BUFFER = new DataPack().write(MAX_INDEX_ID_PREFIX).toUint8Array();

/** Cached information about a specific version of a primary index's value format. */
export interface VersionInfo {
    migrateHash: number;
    /** Non-key field names → TypeWrappers for deserialization of this version's data. */
    nonKeyFields: Map<string, TypeWrapper<any>>;
    /** Set of serialized secondary index signatures that existed in this version's data. */
    secondaryKeys: Set<string>;
}

/**
 * Iterator for range queries on indexes.
 * Handles common iteration logic for both primary and unique indexes.
 * Extends built-in Iterator to provide map/filter/reduce/toArray/etc.
 */
export class IndexRangeIterator<ITEM> extends Iterator<ITEM> {
    constructor(
        private txn: Transaction,
        private iteratorId: number,
        private parentIndex: BaseIndex<ITEM, any>
    ) {
        super();
    }

    [Symbol.iterator](): this { return this; }

    next(): IteratorResult<ITEM> {
        if (this.iteratorId < 0) return { done: true, value: undefined };
        const raw = lowlevel.readIterator(this.iteratorId);
        if (!raw) {
            lowlevel.closeIterator(this.iteratorId);
            this.iteratorId = -1;
            return { done: true, value: undefined };
        }

        const model = this.parentIndex._pairToInstance(this.txn, raw.key, raw.value);
        return { done: false, value: model };
    }

    count(): number {
        let result = 0;
        for (const _ of this) result++;
        return result;
    }

    fetch(): ITEM | undefined {
        for (const model of this) {
            return model;
        }
    }
}

type ArrayOrOnlyItem<ARG_TYPES extends readonly any[]> = ARG_TYPES extends readonly [infer A] ? (A | Partial<ARG_TYPES>) : Partial<ARG_TYPES>;

/**
 * Range-query options accepted by `find()`, `findBy()`, `batchProcess()`, and `batchProcessBy()`.
 *
 * Supports exact-match lookups via `is`, inclusive bounds via `from` / `to`,
 * exclusive bounds via `after` / `before`, and reverse scans.
 *
 * For single-field indexes, values can be passed directly. For composite indexes,
 * pass tuples or partial tuples for prefix matching.
 *
 * @template ARG_TYPES - Tuple of index argument types.
 * @template FETCH - Optional fetch mode used by overloads that return one row.
 */
export type FindOptions<ARG_TYPES extends readonly any[], FETCH extends 'first' | 'single' | undefined = undefined> = (
    (
        {is: ArrayOrOnlyItem<ARG_TYPES>;} // Shortcut for setting `from` and `to` to the same value
    |
        (
            (
                {from: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {after: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {}
            )
        &
            (
                {to: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {before: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {}
            )
        )
    ) &
    {
        reverse?: boolean;
    }
    & (FETCH extends undefined ? { fetch?: undefined } : { fetch: FETCH })
);

/**
 * Base class for database indexes for efficient lookups on model fields.
 *
 * Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.
 */
export abstract class BaseIndex<ITEM, const F extends readonly (keyof ITEM & string)[], ARGS extends readonly any[] = IndexArgTypes<ITEM, F>> {
    public tableName!: string;
    public _indexFields: Map<F[number], TypeWrapper<any>> = new Map();
    _computeFn?: (data: any) => any[];
    _indexId?: number;
    _signature?: string;

    constructor(tableName: string, fieldNames: F) {
        this.tableName = tableName;
        this._indexFields = new Map(fieldNames.map(fieldName => [fieldName, undefined as unknown as TypeWrapper<any>]));
    }

    async _initializeIndex(fields: FieldTypes, reset = false, primaryFieldTypes?: FieldTypes) {
        const fieldNames = [...this._indexFields.keys()];
        if (reset) {
            this._indexId = undefined;
            this._signature = undefined;
        } else if (this._indexId != null) {
            return;
        }

        if (this._computeFn) {
            this._indexFields = new Map();
        } else {
            this._indexFields = new Map();
            for (const fieldName of fieldNames) {
                assert(typeof fieldName === 'string', 'Field names must be strings');
                const fieldType = fields.get(fieldName);
                assert(fieldType, `Unknown field '${fieldName}' in ${this}`);
                this._indexFields.set(fieldName, fieldType);
            }
        }

        await this._retrieveIndexId(fields, primaryFieldTypes);

        if (this._computeFn) {
            this._signature = this._getTypeName() + ' ' + hashFunction(this._computeFn);
        } else {
            this._signature = this._getTypeName() + ' ' +
                Array.from(this._indexFields.entries()).map(([name, fieldType]) => name + ':' + fieldType).join(' ');
        }
    }

    _argsToKeyBytes(args: [], allowPartial: boolean): DataPack;
    _argsToKeyBytes(args: Partial<ARGS>, allowPartial: boolean): DataPack;
    _argsToKeyBytes(args: any, allowPartial: boolean) {
        const expectedCount = this._computeFn ? 1 : this._indexFields.size;
        assert(allowPartial ? args.length <= expectedCount : args.length === expectedCount);
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        if (this._computeFn) {
            if (args.length > 0) bytes.write(args[0]);
        } else {
            let index = 0;
            for (const fieldType of this._indexFields.values()) {
                if (index >= args.length) break;
                fieldType.serialize(args[index++], bytes);
            }
        }
        return bytes;
    }

    abstract _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, valueBuffer: ArrayBuffer): ITEM;

    abstract _getTypeName(): string;

    async _retrieveIndexId(fields: FieldTypes, primaryFieldTypes?: FieldTypes): Promise<void> {
        const indexNameBytes = new DataPack().write(INDEX_ID_PREFIX).write(this.tableName).write(this._getTypeName());
        if (this._computeFn) {
            indexNameBytes.write(hashFunction(this._computeFn));
        } else {
            for (const name of this._indexFields.keys()) {
                indexNameBytes.write(name);
                serializeType(fields.get(name)!, indexNameBytes);
            }
        }
        if (primaryFieldTypes) {
            indexNameBytes.write(undefined);
            for (const [name, fieldType] of primaryFieldTypes.entries()) {
                indexNameBytes.write(name);
                serializeType(fieldType, indexNameBytes);
            }
        }
        const indexNameBuf = indexNameBytes.toUint8Array();

        while (true) {
            const txnId = lowlevel.startTransaction();
            try {
                let result = dbGet(txnId, indexNameBuf);
                let id: number;
                if (result) {
                    id = new DataPack(result).readNumber();
                } else {
                    result = dbGet(txnId, MAX_INDEX_ID_BUFFER);
                    id = result ? new DataPack(result).readNumber() + 1 : 1;
                    const idBuf = new DataPack().write(id).toUint8Array();
                    dbPut(txnId, indexNameBuf, idBuf);
                    dbPut(txnId, MAX_INDEX_ID_BUFFER, idBuf);
                    if (logLevel >= 1) console.log(`[edinburgh] Create index ${this}`);
                }
                const commitResult = lowlevel.commitTransaction(txnId);
                const commitSeq = typeof commitResult === 'number' ? commitResult : await commitResult;
                if (commitSeq > 0) {
                    this._indexId = id;
                    return;
                }
            } catch (e) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                throw e;
            }
        }
    }

    _computeKeyBounds(opts: FindOptions<ARGS>): [DataPack | undefined, DataPack | undefined] | null {
        let startKey: DataPack | undefined;
        let endKey: DataPack | undefined;
        if ('is' in opts) {
            startKey = this._argsToKeyBytes(toArray(opts.is), true);
            endKey = startKey.clone(true).increment();
        } else {
            if ('from' in opts) {
                startKey = this._argsToKeyBytes(toArray(opts.from), true);
            } else if ('after' in opts) {
                startKey = this._argsToKeyBytes(toArray(opts.after), true);
                if (!startKey.increment()) return null;
            } else {
                startKey = this._argsToKeyBytes([], true);
            }
            if ('to' in opts) {
                endKey = this._argsToKeyBytes(toArray(opts.to), true).increment();
            } else if ('before' in opts) {
                endKey = this._argsToKeyBytes(toArray(opts.before), true);
            } else {
                endKey = this._argsToKeyBytes([], true).increment();
            }
        }
        return [startKey, endKey];
    }

    /**
     * Find rows using exact-match or range-query options.
     *
     * Supports exact matches, inclusive and exclusive bounds, open-ended ranges,
     * and reverse iteration. For single-field indexes, values can be passed
     * directly. For composite indexes, pass tuples or partial tuples.
     *
     * @example
     * ```typescript
     * const exact = User.find({ is: "user-123", fetch: "first" });
     * const email = [...User.findBy("email", { from: "a@test.com", to: "m@test.com" })];
     * const reverse = [...Product.findBy("category", { is: "electronics", reverse: true })];
     * ```
     */
    public find(opts: FindOptions<ARGS, 'first'>): ITEM | undefined;
    public find(opts: FindOptions<ARGS, 'single'>): ITEM;
    public find(opts?: FindOptions<ARGS>): IndexRangeIterator<ITEM>;
    public find(opts: any = {}): IndexRangeIterator<ITEM> | ITEM | undefined {
        const txn = currentTxn();

        const bounds = this._computeKeyBounds(opts);
        if (!bounds) {
            if (opts.fetch === 'single') throw new DatabaseError('Expected exactly one result, got none', 'NOT_FOUND');
            if (opts.fetch === 'first') return undefined;
            return new IndexRangeIterator(txn, -1, this);
        }
        const [startKey, endKey] = bounds;

        const scanStart = opts.reverse ? endKey : startKey;
        const scanEnd = opts.reverse ? startKey : endKey;

        if (logLevel >= 3) {
            console.log(`[edinburgh] Scan ${this} start=${scanStart} end=${scanEnd} reverse=${opts.reverse || false}`);
        }
        const startBuf = scanStart?.toUint8Array();
        const endBuf = scanEnd?.toUint8Array();
        const iteratorId = lowlevel.createIterator(
            txn.id,
            startBuf ? toBuffer(startBuf) : undefined,
            endBuf ? toBuffer(endBuf) : undefined,
            opts.reverse || false,
        );

        const iter = new IndexRangeIterator(txn, iteratorId, this);
        if (opts.fetch === 'first') return iter.fetch();
        if (opts.fetch === 'single') {
            const first = iter.fetch();
            if (!first) throw new DatabaseError('Expected exactly one result, got none', 'NOT_FOUND');
            if (iter.fetch() !== undefined) throw new DatabaseError('Expected exactly one result, got multiple', 'NOT_UNIQUE');
            return first;
        }
        return iter;
    }

    /**
     * Process matching rows in batched transactions.
     *
     * Uses the same range options as {@link find}, plus optional row and time
     * limits that control when the current transaction is committed and a new one starts.
     *
     * @param opts Query options plus batch limits.
     * @param callback Called for each matching row inside a transaction.
     */
    public async batchProcess(
        opts: FindOptions<ARGS> & { limitSeconds?: number; limitRows?: number } = {} as any,
        callback: (row: ITEM) => void | Promise<void>
    ): Promise<void> {
        const limitMs = (opts.limitSeconds ?? 1) * 1000;
        const limitRows = opts.limitRows ?? 4096;
        const reverse = opts.reverse ?? false;

        const bounds = this._computeKeyBounds(opts);
        if (!bounds) return;
        const startKey = bounds[0]?.toUint8Array();
        const endKey = bounds[1]?.toUint8Array();
        let cursor: Uint8Array | undefined;

        while (true) {
            const next = await transact(async (): Promise<Uint8Array | null> => {
                const txn = currentTxn();
                const batchStart = cursor && !reverse ? cursor : startKey;
                const batchEnd = cursor && reverse ? cursor : endKey;
                const scanStart = reverse ? batchEnd : batchStart;
                const scanEnd = reverse ? batchStart : batchEnd;

                const iteratorId = lowlevel.createIterator(
                    txn.id,
                    scanStart ? toBuffer(scanStart) : undefined,
                    scanEnd ? toBuffer(scanEnd) : undefined,
                    reverse,
                );

                const t0 = Date.now();
                let count = 0;
                let lastRawKey: Uint8Array | undefined;
                try {
                    while (true) {
                        const raw = lowlevel.readIterator(iteratorId);
                        if (!raw) return null;
                        lastRawKey = new Uint8Array(raw.key);
                        await callback(this._pairToInstance(txn, raw.key, raw.value));
                        if (++count >= limitRows || Date.now() - t0 >= limitMs) break;
                    }
                } finally {
                    lowlevel.closeIterator(iteratorId);
                }

                lastRawKey = lastRawKey.slice();
                if (reverse) return lastRawKey;
                const nextKey = new DataPack(lastRawKey);
                return nextKey.increment() ? nextKey.toUint8Array() : null;
            });

            if (next === null) break;
            cursor = next;
        }
    }

    toString() {
        return `${this._indexId}:${this.tableName}:${this._getTypeName()}[${Array.from(this._indexFields.keys()).join(',')}]`;
    }
}

export abstract class PrimaryKey<ITEM extends PrimaryKeyItem, const F extends readonly (keyof ITEM & string)[], ARGS extends readonly any[] = IndexArgTypes<ITEM, F>> extends BaseIndex<ITEM, F, ARGS> {
    _getTypeName(): string {
        return 'primary';
    }

    abstract _serializeValue(data: Record<string, any>): Uint8Array;

    _versionInfoKey(version: number): Uint8Array {
        return new DataPack()
            .write(VERSION_INFO_PREFIX)
            .write(this._indexId!)
            .write(version)
            .toUint8Array();
    }

    async _ensureVersionEntry(currentValueBytes: Uint8Array): Promise<{ version: number; created: boolean }> {
        const scanStart = new DataPack().write(VERSION_INFO_PREFIX).write(this._indexId!);
        const scanEnd = scanStart.clone(true).increment();

        while (true) {
            const txnId = lowlevel.startTransaction();
            try {
                const iteratorId = lowlevel.createIterator(
                    txnId,
                    scanEnd ? toBuffer(scanEnd.toUint8Array()) : undefined,
                    toBuffer(scanStart.toUint8Array()),
                    true,
                );

                let count = 0;
                let maxVersion = 0;
                let matchingVersion: number | undefined;

                try {
                    while (count < 20) {
                        const raw = lowlevel.readIterator(iteratorId);
                        if (!raw) break;
                        count++;

                        const keyPack = new DataPack(new Uint8Array(raw.key));
                        keyPack.readNumber();
                        keyPack.readNumber();
                        const versionNum = keyPack.readNumber();
                        maxVersion = Math.max(maxVersion, versionNum);

                        const valueBytes = new Uint8Array(raw.value);
                        if (bytesEqual(valueBytes, currentValueBytes)) {
                            matchingVersion = versionNum;
                            break;
                        }
                    }
                } finally {
                    lowlevel.closeIterator(iteratorId);
                }

                if (matchingVersion !== undefined) {
                    lowlevel.abortTransaction(txnId);
                    return { version: matchingVersion, created: false };
                }

                const version = maxVersion + 1;
                dbPut(txnId, this._versionInfoKey(version), currentValueBytes);
                if (logLevel >= 1) console.log(`[edinburgh] Create version ${version} for ${this}`);

                const commitResult = lowlevel.commitTransaction(txnId);
                const commitSeq = typeof commitResult === 'number' ? commitResult : await commitResult;
                if (commitSeq > 0) return { version, created: true };
            } catch (e) {
                try { lowlevel.abortTransaction(txnId); } catch {}
                throw e;
            }
        }
    }

    _serializePK(data: Record<string, any>): DataPack {
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        for (const [fieldName, fieldType] of this._indexFields.entries()) {
            fieldType.serialize(data[fieldName], bytes);
        }
        return bytes;
    }

    _pkToArray(key: Uint8Array): ARGS {
        const bytes = new DataPack(key);
        assert(bytes.readNumber() === this._indexId);
        const result = [] as any[];
        for (const fieldType of this._indexFields.values()) {
            result.push(fieldType.deserialize(bytes));
        }
        return result as unknown as ARGS;
    }

    _writePK(txn: Transaction, primaryKey: Uint8Array, data: Record<string, any>) {
        const valueBytes = this._serializeValue(data);
        if (logLevel >= 2) {
            console.log(`[edinburgh] Write ${this} key=${new DataPack(primaryKey)} value=${new DataPack(valueBytes)}`);
        }
        dbPut(txn.id, primaryKey, valueBytes);
    }

    _deletePK(txn: Transaction, primaryKey: Uint8Array, _data: Record<string, any>) {
        if (logLevel >= 2) {
            console.log(`[edinburgh] Delete ${this} key=${new DataPack(primaryKey)}`);
        }
        dbDel(txn.id, primaryKey);
    }
}

function toArray<ARG_TYPES extends readonly any[]>(args: ArrayOrOnlyItem<ARG_TYPES>): Partial<ARG_TYPES> {
    return (Array.isArray(args) ? args : [args]) as Partial<ARG_TYPES>;
}

const SECONDARY_VALUE = new DataPack().write(undefined).toUint8Array();

export abstract class NonPrimaryIndex<ITEM extends IndexItem, const F extends readonly (keyof ITEM & string)[], ARGS extends readonly any[] = IndexArgTypes<ITEM, F>> extends BaseIndex<ITEM, F, ARGS> {
    _resetIndexFieldDescriptors: Record<string | symbol | number, PropertyDescriptor> = {};

    constructor(tableName: string, fieldsOrFn: F | ((data: any) => any[]), protected _loadPrimary: LoadPrimary<ITEM>, queueInitialization: QueueInitialization) {
        super(tableName, typeof fieldsOrFn === 'function' ? [] as any : fieldsOrFn);
        if (typeof fieldsOrFn === 'function') this._computeFn = fieldsOrFn;
        queueInitialization();
    }

    async _initializeIndex(fields: FieldTypes, reset = false, primaryFieldTypes?: FieldTypes) {
        if (reset) this._resetIndexFieldDescriptors = {};
        await super._initializeIndex(fields, reset, primaryFieldTypes);
        for (const fieldName of this._indexFields.keys()) {
            this._resetIndexFieldDescriptors[fieldName] = {
                writable: true,
                configurable: true,
                enumerable: true,
            };
        }
    }

    _buildKeyPacks(data: Record<string, any>): DataPack[] {
        if (this._computeFn) {
            return this._computeFn(data).map((value: any) => {
                const bytes = new DataPack();
                bytes.write(this._indexId!);
                bytes.write(value);
                return bytes;
            });
        }
        for (const fieldName of this._indexFields.keys()) {
            if (data[fieldName] == null) return [];
        }
        const bytes = new DataPack();
        bytes.write(this._indexId!);
        for (const [fieldName, fieldType] of this._indexFields.entries()) {
            fieldType.serialize(data[fieldName], bytes);
        }
        return [bytes];
    }

    _serializeKeys(primaryKey: Uint8Array, data: Record<string, any>): Uint8Array[] {
        return this._buildKeyPacks(data).map(pack => pack.toUint8Array());
    }

    abstract _writeKey(txn: Transaction, key: Uint8Array, primaryKey: Uint8Array): void;

    _write(txn: Transaction, primaryKey: Uint8Array, model: ITEM): void {
        for (const key of this._serializeKeys(primaryKey, model as any)) {
            if (logLevel >= 2) console.log(`[edinburgh] Write ${this} key=${new DataPack(key)}`);
            this._writeKey(txn, key, primaryKey);
        }
    }

    _delete(txn: Transaction, primaryKey: Uint8Array, model: ITEM): void {
        for (const key of this._serializeKeys(primaryKey, model as any)) {
            if (logLevel >= 2) console.log(`[edinburgh] Delete ${this} key=${new DataPack(key)}`);
            dbDel(txn.id, key);
        }
    }

    _update(txn: Transaction, primaryKey: Uint8Array, newData: ITEM, oldData: Record<string, any>): number {
        const oldKeys = this._serializeKeys(primaryKey, oldData);
        const newKeys = this._serializeKeys(primaryKey, newData as any);

        if (oldKeys.length === newKeys.length && (oldKeys.length === 0 || bytesEqual(oldKeys[0], newKeys[0]))) {
            return 0;
        }

        const oldKeyMap = new Map<number, Uint8Array>();
        for (const key of oldKeys) oldKeyMap.set(hashBytes(key), key);

        let changes = 0;
        for (const key of newKeys) {
            const hash = hashBytes(key);
            if (oldKeyMap.has(hash)) {
                oldKeyMap.delete(hash);
            } else {
                if (logLevel >= 2) console.log(`[edinburgh] Write ${this} key=${new DataPack(key)}`);
                this._writeKey(txn, key, primaryKey);
                changes++;
            }
        }
        for (const key of oldKeyMap.values()) {
            if (logLevel >= 2) console.log(`[edinburgh] Delete ${this} key=${new DataPack(key)}`);
            dbDel(txn.id, key);
            changes++;
        }
        return changes;
    }
}

export class UniqueIndex<ITEM extends IndexItem, const F extends readonly (keyof ITEM & string)[], ARGS extends readonly any[] = IndexArgTypes<ITEM, F>> extends NonPrimaryIndex<ITEM, F, ARGS> {
    constructor(tableName: string, fieldsOrFn: F | ((data: any) => any[]), loadPrimary: LoadPrimary<ITEM>, queueInitialization: QueueInitialization) {
        super(tableName, fieldsOrFn, loadPrimary, queueInitialization);
    }

    _getTypeName(): string {
        return this._computeFn ? 'fn-unique' : 'unique';
    }

    getPK(...args: ARGS): ITEM | undefined {
        const txn = currentTxn();
        const keyBuffer = this._argsToKeyBytes(args, false).toUint8Array();

        const valueBuffer = dbGet(txn.id, keyBuffer);
        if (logLevel >= 3) {
            console.log(`[edinburgh] Get ${this} key=${new DataPack(keyBuffer)} result=${valueBuffer}`);
        }
        if (!valueBuffer) return;

        const result = this._loadPrimary(txn, valueBuffer, true);
        if (!result) throw new DatabaseError(`Unique index ${this} points at non-existing primary for key: ${args.join(', ')}`, 'CONSISTENCY_ERROR');
        return result;
    }

    _writeKey(txn: Transaction, key: Uint8Array, primaryKey: Uint8Array): void {
        if (dbGet(txn.id, key)) throw new DatabaseError(`Unique constraint violation for ${this}`, 'UNIQUE_CONSTRAINT');
        dbPut(txn.id, key, primaryKey);
    }

    _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, valueBuffer: ArrayBuffer): ITEM {
        const model = this._loadPrimary(txn, new Uint8Array(valueBuffer), false)!;

        if (this._indexFields.size > 0) {
            const keyPack = new DataPack(new Uint8Array(keyBuffer));
            keyPack.readNumber();

            Object.defineProperties(model, this._resetIndexFieldDescriptors);
            for (const [name, fieldType] of this._indexFields.entries()) {
                model._setLoadedField(name, fieldType.deserialize(keyPack));
            }
        }

        model._restoreLazyFields?.();

        return model;
    }
}

export class SecondaryIndex<ITEM extends IndexItem, const F extends readonly (keyof ITEM & string)[], ARGS extends readonly any[] = IndexArgTypes<ITEM, F>> extends NonPrimaryIndex<ITEM, F, ARGS> {
    constructor(tableName: string, fieldsOrFn: F | ((data: any) => any[]), loadPrimary: LoadPrimary<ITEM>, queueInitialization: QueueInitialization) {
        super(tableName, fieldsOrFn, loadPrimary, queueInitialization);
    }

    _getTypeName(): string {
        return this._computeFn ? 'fn-secondary' : 'secondary';
    }

    _pairToInstance(txn: Transaction, keyBuffer: ArrayBuffer, _valueBuffer: ArrayBuffer): ITEM {
        const keyPack = new DataPack(new Uint8Array(keyBuffer));
        keyPack.readNumber();

        const indexFields = new Map<string, any>();
        for (const [name, fieldType] of this._indexFields.entries()) {
            indexFields.set(name, fieldType.deserialize(keyPack));
        }
        if (this._computeFn) keyPack.read();

        const primaryKey = keyPack.readUint8Array();
        const model = this._loadPrimary(txn, primaryKey, false)!;

        if (indexFields.size > 0) {
            Object.defineProperties(model, this._resetIndexFieldDescriptors);
            for (const [name, value] of indexFields) {
                model._setLoadedField(name, value);
            }
        }

        model._restoreLazyFields?.();

        return model;
    }

    _serializeKeys(primaryKey: Uint8Array, data: Record<string, any>): Uint8Array[] {
        return this._buildKeyPacks(data).map(pack => {
            pack.write(primaryKey);
            return pack.toUint8Array();
        });
    }

    _writeKey(txn: Transaction, key: Uint8Array, _primaryKey: Uint8Array): void {
        dbPut(txn.id, key, SECONDARY_VALUE);
    }
}

export function dump() {
    const txn = currentTxn();
    const indexesById = new Map<number, {name: string, type: string, fields: Record<string, TypeWrapper<any>>}>();
    const versions = new Map<number, Map<number, Map<string, TypeWrapper<any>>>>();
    console.log("--- edinburgh database dump ---");
    const iteratorId = lowlevel.createIterator(txn.id, undefined, undefined, false);
    try {
        while (true) {
            const raw = lowlevel.readIterator(iteratorId);
            if (!raw) break;
            const kb = new DataPack(new Uint8Array(raw.key));
            const vb = new DataPack(new Uint8Array(raw.value));
            const indexId = kb.readNumber();
            if (indexId === MAX_INDEX_ID_PREFIX) {
                console.log("* Max index id", vb.readNumber());
            } else if (indexId === VERSION_INFO_PREFIX) {
                const idxId = kb.readNumber();
                const version = kb.readNumber();
                const obj = vb.read() as any;
                const nonKeyFields = new Map<string, TypeWrapper<any>>();
                for (const [name, typeBytes] of obj.fields) {
                    nonKeyFields.set(name, deserializeType(new DataPack(typeBytes), 0));
                }
                if (!versions.has(idxId)) versions.set(idxId, new Map());
                versions.get(idxId)!.set(version, nonKeyFields);
                console.log(`* Version ${version} for index ${idxId}: fields=[${[...nonKeyFields.keys()].join(',')}]`);
            } else if (indexId === INDEX_ID_PREFIX) {
                const name = kb.readString();
                const type = kb.readString();
                const fields: Record<string, TypeWrapper<any>> = {};
                while (kb.readAvailable()) {
                    const fieldName = kb.read();
                    if (typeof fieldName !== 'string') break;
                    fields[fieldName] = deserializeType(kb, 0);
                }

                const definedIndexId = vb.readNumber();
                console.log(`* Index definition ${definedIndexId}:${name}:${type}[${Object.keys(fields).join(',')}]`);
                indexesById.set(definedIndexId, {name, type, fields});
            } else if (indexId > 0 && indexesById.has(indexId)) {
                const index = indexesById.get(indexId)!;
                let rowKey: any = {};
                let rowValue: any;
                for (const [fieldName, fieldType] of Object.entries(index.fields)) {
                    rowKey[fieldName] = fieldType.deserialize(kb);
                }
                if (index.type === 'primary') {
                    const version = vb.readNumber();
                    const valueFields = versions.get(indexId)?.get(version);
                    if (valueFields) {
                        rowValue = {};
                        for (const [fieldName, fieldType] of valueFields) {
                            rowValue[fieldName] = fieldType.deserialize(vb);
                        }
                    }
                }
                console.log(`* Row for ${indexId}:${index.name}:${index.type}`, rowKey ?? kb, rowValue ?? vb);
            } else {
                console.log(`* Unhandled '${indexId}' key=${kb} value=${vb}`);
            }
        }
    } finally {
        lowlevel.closeIterator(iteratorId);
    }
    console.log("--- end ---");
}
