import * as lowlevel from "olmdb/lowlevel";
import DataPack from "./datapack.js";
import { modelRegistry, currentTxn, Transaction } from "./models.js";
import { dbDel, toBuffer } from "./utils.js";
import { PrimaryIndex } from "./indexes.js";
import { deserializeType, TypeWrapper } from "./types.js";
import { transact } from "./edinburgh.js";

const INDEX_ID_PREFIX = -2;

export interface MigrationOptions {
    /** Limit migration to specific table names. */
    tables?: string[];
    /** Whether to convert old primary indices for known tables (default: true). */
    convertOldPrimaries?: boolean;
    /** Whether to delete orphaned secondary/unique indices (default: true). */
    deleteOrphanedIndexes?: boolean;
    /** Whether to upgrade rows to the latest version (default: true). */
    upgradeVersions?: boolean;
    /** Progress callback. */
    onProgress?: (info: ProgressInfo) => void;
}

export interface ProgressInfo {
    phase: string;
    processed: number;
    total?: number;
    table?: string;
}

export interface MigrationResult {
    /** Per-table stats for row upgrades. */
    secondaries: Record<string, number>;
    /** Per-table stats for old primary conversions. */
    primaries: Record<string, number>;
    /** Per-table conversion failure counts by reason. */
    conversionFailures: Record<string, Record<string, number>>;
    /** Number of orphaned index entries deleted. */
    orphaned: number;
}

interface IndexDef {
    id: number;
    tableName: string;
    typeName: string;
    fieldNames: string[];
    fieldTypes: TypeWrapper<any>[];
}

/**
 * Iterate over all rows for a given index ID prefix in batches,
 * calling processBatch for each row within a transaction.
 */
async function forEachRow(
    indexId: number,
    processBatch: (txn: Transaction, key: Uint8Array, value: Uint8Array) => void
): Promise<void> {
    let done = false;
    let lastKey: Uint8Array | undefined;
    const prefixPack = new DataPack().write(indexId);
    const endBuf = toBuffer(prefixPack.clone(true).increment()!.toUint8Array());

    while (!done) {
        await transact(() => {
            const txn = currentTxn();
            let startBuf: ArrayBufferLike;
            if (lastKey) {
                const resumePack = new DataPack(lastKey).increment();
                if (!resumePack) { done = true; return; }
                startBuf = toBuffer(resumePack.toUint8Array());
            } else {
                startBuf = toBuffer(prefixPack.toUint8Array());
            }
            const iteratorId = lowlevel.createIterator(txn.id, startBuf, endBuf, false);
            const batchStart = Date.now();
            let batchCount = 0;
            try {
                while (true) {
                    const raw = lowlevel.readIterator(iteratorId);
                    if (!raw) { done = true; break; }
                    const keyBuf = new Uint8Array(raw.key);
                    lastKey = keyBuf;
                    processBatch(txn, keyBuf, new Uint8Array(raw.value));
                    if (++batchCount >= 4096 || Date.now() - batchStart >= 2000) break;
                }
            } finally {
                lowlevel.closeIterator(iteratorId);
            }
        });
    }
}

/**
 * Run database migration: upgrade all rows to the latest schema version,
 * convert old primary indices, and clean up orphaned secondary indices.
 */
export async function runMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
    const convertOldPrimaries = options.convertOldPrimaries ?? true;
    const deleteOrphanedIndexes = options.deleteOrphanedIndexes ?? true;
    const upgradeVersions = options.upgradeVersions ?? true;
    const onProgress = options.onProgress;

    const result: MigrationResult = {
        secondaries: {},
        primaries: {},
        conversionFailures: {},
        orphaned: 0,
    };

    // Build maps of known index IDs
    const knownIndexIds = new Set<number>();
    const primaryByIndexId = new Map<number, { model: typeof modelRegistry[string], primary: PrimaryIndex<any, any> }>();

    for (const model of Object.values(modelRegistry)) {
        if (options.tables && !options.tables.includes(model.tableName)) continue;
        const primary = model._primary;
        knownIndexIds.add(primary._indexId!);
        primaryByIndexId.set(primary._indexId!, { model, primary });
        for (const sec of model._secondaries || []) {
            knownIndexIds.add(sec._indexId!);
        }
    }

    // Scan all index definitions in the DB to find old/orphaned ones
    const allIndexDefs: IndexDef[] = [];
    await forEachRow(INDEX_ID_PREFIX, (_txn, keyBuf, valueBuf) => {
        const kb = new DataPack(keyBuf);
        kb.readNumber(); // skip INDEX_ID_PREFIX
        const tableName = kb.readString();
        const typeName = kb.readString();
        const fieldNames: string[] = [];
        const fieldTypes: TypeWrapper<any>[] = [];
        // Read field names and types (may be followed by separator + pk fields for non-primary indexes)
        while (kb.readAvailable()) {
            const name = kb.read();
            if (typeof name !== 'string') break; // 'undefined' separator before pk fields
            fieldNames.push(name);
            fieldTypes.push(deserializeType(kb, 0));
        }
        const id = new DataPack(valueBuf).readNumber();
        allIndexDefs.push({ id, tableName, typeName, fieldNames, fieldTypes });
    });

    // Phase 1: Upgrade existing rows to latest version
    if (upgradeVersions) {
        for (const [indexId, { model, primary }] of primaryByIndexId) {
            let upgraded = 0;
            const migrateFn = (model as any).migrate as ((record: Record<string, any>) => void) | undefined;
            const secondaries = model._secondaries || [];

            await forEachRow(indexId, (txn, keyBuf, valueBuf) => {
                const valuePack = new DataPack(valueBuf);
                const version = valuePack.readNumber();
                if (version === primary._currentVersion) return; // Already current

                const versionInfo = primary._loadVersionInfo(txn.id, version);

                // Deserialize pre-migrate values from key + old-format value
                const record: Record<string, any> = {};
                const keyPack = new DataPack(keyBuf);
                keyPack.readNumber(); // skip indexId
                for (const [name, type] of primary._fieldTypes.entries()) {
                    record[name] = type.deserialize(keyPack);
                }
                for (const [name, type] of versionInfo.nonKeyFields.entries()) {
                    record[name] = type.deserialize(valuePack);
                }

                // Deep-copy pre-migrate values (if migrate exists), then run migrate
                const preMigrate = migrateFn ? structuredClone(record) : undefined;
                if (migrateFn) migrateFn(record);

                // Handle secondaries (primary is left as-is for lazy migration on read)
                for (const sec of secondaries) {
                    if (!versionInfo.secondaryKeys.has(sec._signature!)) {
                        // New secondary — write entry
                        sec._write(txn, keyBuf, record as any);
                        upgraded++;
                    } else if (preMigrate) {
                        // Existing secondary — update if migrate changed any of its fields
                        for (const [field, type] of sec._fieldTypes.entries()) {
                            if (!type.equals(preMigrate[field], record[field])) {
                                sec._delete(txn, keyBuf, preMigrate as any);
                                sec._write(txn, keyBuf, record as any);
                                upgraded++;
                                break;
                            }
                        }
                    }
                }

            });

            onProgress?.({ phase: 'secondaries', processed: upgraded, table: model.tableName });
            if (upgraded > 0) result.secondaries[model.tableName] = upgraded;
        }
    }

    // Phase 2: Convert old primary indices with known table names
    if (convertOldPrimaries) {
        for (const oldDef of allIndexDefs) {
            if (oldDef.typeName !== 'primary') continue;
            if (knownIndexIds.has(oldDef.id)) continue; // Known index, skip

            const model = modelRegistry[oldDef.tableName];
            if (!model) continue; // Unknown table
            if (options.tables && !options.tables.includes(oldDef.tableName)) continue;

            let converted = 0;
            const failures: Record<string, number> = {};

            await forEachRow(oldDef.id, (txn, keyBuf) => {
                let instance;
                try {
                    // Deserialize old key
                    const keyPack = new DataPack(keyBuf);
                    keyPack.readNumber(); // skip old index id
                    const record: Record<string, any> = {};
                    for (let i = 0; i < oldDef.fieldNames.length; i++) {
                        record[oldDef.fieldNames[i]] = oldDef.fieldTypes[i].deserialize(keyPack);
                    }

                    // Run migrate
                    const migrateFn = (model as any).migrate;
                    if (migrateFn) migrateFn(record);

                    // _write validates, checks duplicates, writes primary + secondaries
                    instance = new (model as any)(record, txn);
                    instance._write(txn);
                    dbDel(txn.id, keyBuf);
                    converted++;
                } catch (e: any) {
                    if (e.code === 'UNIQUE_CONSTRAINT') {
                        failures['duplicate_key'] = (failures['duplicate_key'] || 0) + 1;
                    } else {
                        failures['error'] = (failures['error'] || 0) + 1;
                    }
                } finally {
                    if (instance) txn.instances.delete(instance);
                }
            });

            onProgress?.({ phase: 'primaries', processed: converted, table: oldDef.tableName });
            if (converted > 0) result.primaries[oldDef.tableName] = converted;
            if (Object.keys(failures).length > 0) {
                result.conversionFailures[oldDef.tableName] = failures;
            }
        }
    }

    // Phase 3: Delete orphaned secondary/unique index entries
    if (deleteOrphanedIndexes) {
        for (const def of allIndexDefs) {
            if (knownIndexIds.has(def.id) || def.typeName === 'primary') continue;
            await forEachRow(def.id, (txn, keyBuf) => {
                dbDel(txn.id, keyBuf);
                result.orphaned++;
            });
            onProgress?.({ phase: 'orphaned', processed: result.orphaned });
        }
    }

    return result;
}
