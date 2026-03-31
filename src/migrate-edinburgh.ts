#!/usr/bin/env node

/**
 * migrate-edinburgh CLI tool
 * 
 * Runs database migrations: upgrades all rows to the latest schema version,
 * converts old primary indices, and cleans up orphaned secondary indices.
 * 
 * Usage:
 *   npx migrate-edinburgh --import ./src/models.ts [options]
 * 
 * Options:
 *   --import <path>     Path to the module that registers all models (required)
 *   --db <path>         Database directory (default: .edinburgh)
 *   --tables <names>    Comma-separated list of table names to migrate
 *   --batch-size <n>    Number of rows per transaction batch (default: 500)
 *   --no-convert        Skip converting old primary indices
 *   --no-cleanup        Skip deleting orphaned secondary indices
 *   --no-upgrade        Skip upgrading rows to latest version
 */

import { runMigration, type MigrationOptions } from './migrate.js';

function parseArgs(args: string[]): { importPath: string, options: MigrationOptions & { dbDir?: string } } {
    let importPath = '';
    const options: MigrationOptions & { dbDir?: string } = {};
    
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--import':
                importPath = args[++i];
                break;
            case '--db':
                options.dbDir = args[++i];
                break;
            case '--tables':
                options.tables = args[++i].split(',').map(s => s.trim());
                break;
            case '--no-convert':
                options.convertOldPrimaries = false;
                break;
            case '--no-cleanup':
                options.deleteOrphanedIndexes = false;
                break;
            case '--no-upgrade':
                options.upgradeVersions = false;
                break;
            default:
                if (args[i].startsWith('-')) {
                    console.error(`Unknown option: ${args[i]}`);
                    process.exit(1);
                }
        }
    }
    
    if (!importPath) {
        console.error('Usage: migrate-edinburgh --import <path> [options]');
        console.error('  --import <path>     Module that registers all models (required)');
        console.error('  --db <path>         Database directory (default: .edinburgh)');
        console.error('  --tables <names>    Comma-separated table names');
        console.error('  --no-convert        Skip old primary conversion');
        console.error('  --no-cleanup        Skip orphaned index cleanup');
        console.error('  --no-upgrade        Skip version upgrades');
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
        console.log('Upgraded rows:');
        for (const [table, count] of Object.entries(result.secondaries)) {
            console.log(`  ${table}: ${count}`);
        }
    }
    
    if (Object.keys(result.primaries).length > 0) {
        console.log('Converted old primary rows:');
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
    
    if (result.orphaned > 0) {
        console.log(`Deleted ${result.orphaned} orphaned index entries`);
    }
    
    if (Object.keys(result.secondaries).length === 0 && Object.keys(result.primaries).length === 0 && result.orphaned === 0) {
        console.log('No migration needed - database is up to date.');
    }
    
    console.log('Done.');
}

main().catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
});
