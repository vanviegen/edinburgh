#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { buildDocumentation, documentationToMarkdown } from 'tsdoc-markdown';
import { fileURLToPath } from 'url';
import { createProgram, forEachChild, getCombinedModifierFlags, ModifierFlags } from 'typescript';

// @ts-ignore
if (typeof __dirname === 'undefined') global.__dirname = (typeof import.meta === 'undefined') ? process.cwd() : path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(__dirname, '..');

/**
* Generate markdown documentation for a TypeScript file using tsdoc-markdown
* @param {string} filePath Path to the TypeScript file
* @returns {Promise<string>} Generated markdown documentation
*/
async function generateMarkdownDoc(filePath) {

    // Delete .tsdoc dir and recreate it
    // const tsdocDir = path.join(projectRoot, '.tsdoc');
    // await fs.rm(tsdocDir, { recursive: true, force: true });
    // await fs.mkdir(tsdocDir, { recursive: true });
    // await $`bun tsc --outFile .tsdoc/bundle.ts --module amd --moduleResolution node10`;

    const program = createProgram([filePath], {});
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFiles().filter(sf => path.resolve(sf.fileName) == path.resolve(filePath))[0];

    for(const [name, symbol] of sourceFile.symbol.exports) {
        for(const decl of symbol.declarations) {
            console.log("### "+name);
            console.log(decl.jsDoc?.[0]?.comment);
            for(const [localName, local] of decl.locals ?? []) {
                console.log(`| ${localName} | ${local.declarations[0].getText()} |`);
                console.log(local);
            }
        }
        // console.log(symbol);
    }

        // console.log(sourceFile);
        // console.log(sourceFile);
        // forEachChild(sourceFile, (node) => {
            // if (!(getCombinedModifierFlags(node) & ModifierFlags.Export)) return;
            // console.log(node);
            // if (node.jsDoc?.[0]?.comment) console.log(node.jsDoc[0].comment);
            // if (node.symbol?.exports) console.log(node.symbol.exports);
        // });
    return "";


    // Only include functions and classes that are actually exported
    entries = entries.filter((doc) => {
        return true;
        // Only include documented exports and main functions/classes
        const isExported = doc.name && !doc.name.startsWith('_');
        const isImportantType = ['function', 'class'].includes(doc.doc_type);
        
        return isExported && isImportantType;
    });

    const markdownContent = documentationToMarkdown({entries, options: {
        emoji: null,
        headingLevel: "###",
    }});
    
    // Remove headers and TOCs
    return markdownContent;
}

/**
* Update README.md with generated TSDoc content
*/
async function updateReadme() {
    const readmePath = path.join(projectRoot, 'README.md');
    const readme = await fs.readFile(readmePath, 'utf8');
    
    // Find the marker
    const markerRegex = /(The following is auto-generated from `([^`]+)`:\s*\n)([\s\S]*?)(?=\n## |$)/g;
    let match;
    let updatedReadme = readme;
    let filesProcessed = 0;
    
    // Process each marker found in the README
    while ((match = markerRegex.exec(readme)) !== null) {
        const [fullMatch, startLine, sourceFile, oldContent] = match;
        const absoluteSourcePath = path.resolve(projectRoot, sourceFile);
        
        console.log(`Generating docs for ${sourceFile}...`);
        const newContent = await generateMarkdownDoc(absoluteSourcePath);
        
        // Replace the old content with new content
        updatedReadme = updatedReadme.replace(fullMatch,startLine+newContent);
        
        filesProcessed++;
    }
    
    if (filesProcessed === 0) {
        console.error('Could not find any auto-generated markers in README.md');
        process.exit(1);
    }
    
    await fs.writeFile(readmePath, updatedReadme);
    console.log(`Updated documentation for ${filesProcessed} file(s) in README.md`);
}

updateReadme().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
