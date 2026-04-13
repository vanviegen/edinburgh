#!/usr/bin/env node

/**
 * See `npx migrate-edinburgh --help` for usage.
 */

import { runMigration, type MigrationOptions } from './migrate.js';

function parseArgs(args: string[]): { importPath: string, options: MigrationOptions & { dbDir?: string } } {
    let importPath = '';
    const options: MigrationOptions & { dbDir?: string } = {};
    const tables: string[] = [];
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--db':
                options.dbDir = args[++i];
                break;
            case '+secondaries': options.populateSecondaries = true; break;
            case '-secondaries': options.populateSecondaries = false; break;
            case '+primaries': options.migratePrimaries = true; break;
            case '-primaries': options.migratePrimaries = false; break;
            case '+data': options.rewriteData = true; break;
            case '-data': options.rewriteData = false; break;
            case '+orphans': options.removeOrphans = true; break;
            case '-orphans': options.removeOrphans = false; break;
            default:
                if (arg.startsWith('-') || arg.startsWith('+')) {
                    console.error(`Unknown option: ${arg}`);
                    process.exit(1);
                }
                if (!importPath) {
                    importPath = arg;
                } else {
                    tables.push(arg);
                }
        }
    }
    
    if (tables.length > 0) options.tables = tables;
    
    if (!importPath) {
        console.error('Usage: npx migrate-edinburgh <import_path> [<table> ...] [options]');
        console.error('');
        console.error('  <import_path>     Module that registers all models (required)');
        console.error('  <table>           Table names to migrate (default: all)');
        console.error('');
        console.error('Options:');
        console.error('  --db <path>       Database directory (default: .edinburgh)');
        console.error('  -secondaries      Skip populating secondary indexes');
        console.error('  -primaries        Skip migrating old primary indexes');
        console.error('  -orphans          Skip removing orphaned index entries');
        console.error('  +data             Rewrite all row data to latest schema version');
        process.exit(1);
    }
    
    return { importPath, options };
}

async function main() {
    const nodeArgs = process.argv.slice(2);
    const { importPath, options } = parseArgs(nodeArgs);
    
    // Initialize DB if specified
    if (options.dbDir) {
        const E = await import('./edinburgh.js');
        E.init(options.dbDir);
    }
    
    // Import user's models module (this registers all models)
    const resolvedPath = importPath.startsWith('.') || importPath.startsWith('/')
        ? (await import('node:path')).resolve(process.cwd(), importPath)
        : importPath;
    await import(resolvedPath);

    let lastPhase = '';
    options.onProgress = (info) => {
        if (info.phase !== lastPhase) {
            if (lastPhase) console.log();
            lastPhase = info.phase;
        }
        const suffix = info.table ? ` [${info.table}]` : '';
        process.stdout.write(`\r  ${info.phase}: ${info.processed} upgraded${suffix}  `);
    };
    
    console.log('Starting migration...');
    const result = await runMigration(options);
    console.log('\n');
    
    // Report results
    if (Object.keys(result.secondaries).length > 0) {
        console.log('Populated secondary indexes:');
        for (const [table, count] of Object.entries(result.secondaries)) {
            console.log(`  ${table}: ${count}`);
        }
    }
    
    if (Object.keys(result.rewritten).length > 0) {
        console.log('Rewritten rows:');
        for (const [table, count] of Object.entries(result.rewritten)) {
            console.log(`  ${table}: ${count}`);
        }
    }
    
    if (Object.keys(result.primaries).length > 0) {
        console.log('Migrated old primary rows:');
        for (const [table, count] of Object.entries(result.primaries)) {
            console.log(`  ${table}: ${count}`);
        }
    }
    
    if (Object.keys(result.conversionFailures).length > 0) {
        console.log('Conversion failures:');
        for (const [table, failures] of Object.entries(result.conversionFailures)) {
            for (const [reason, count] of Object.entries(failures)) {
                console.log(`  ${table}: ${count} (${reason})`);
            }
        }
    }
    
    if (result.orphans > 0) {
        console.log(`Deleted ${result.orphans} orphaned index entries`);
    }
    
    if (Object.keys(result.secondaries).length === 0 && Object.keys(result.primaries).length === 0 && Object.keys(result.rewritten).length === 0 && result.orphans === 0) {
        console.log('No migration needed - database is up to date.');
    }
    
    console.log('Done.');
}

main().catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
});
