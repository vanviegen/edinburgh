#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createProgram, ScriptTarget, SyntaxKind, SymbolFlags, NodeFlags, ModuleResolutionKind, ModuleKind } from 'typescript';

// @ts-ignore
if (typeof __dirname === 'undefined') global.__dirname = (typeof import.meta === 'undefined') ? process.cwd() : path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(__dirname, '..');

/**
* Generate markdown documentation for a TypeScript file using TypeScript compiler API
* @param {string} filePath Path to the TypeScript file
* @param {string} headingPrefix The heading prefix to use (e.g., '###' for level 3)
* @returns {Promise<string>} Generated markdown documentation
*/
async function generateMarkdownDoc(filePath, headingPrefix = '###') {
    const program = createProgram([filePath], {
        target: ScriptTarget.ES2022,
        module: ModuleKind.CommonJS,
        moduleResolution: ModuleResolutionKind.Node16,
        allowJs: true,
        declaration: true,
        esModuleInterop: true,
        skipLibCheck: false,
        forceConsistentCasingInFileNames: true
    });
    
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFiles().filter(sf => path.resolve(sf.fileName) == path.resolve(filePath))[0];

    // Process each exported symbol
    let output = '';
    for(const [name, symbol] of sourceFile.symbol.exports) {
        output += generateSymbolDoc(name, symbol, checker, headingPrefix);
    }

    return output;
}

/**
 * Generate documentation for a single symbol
 */
function generateSymbolDoc(name, symbol, checker, headingPrefix = '###') {
    // Get the first declaration (main one)
    const declaration = symbol.valueDeclaration || symbol.declarations?.[0];
    if (!declaration) {
        return `### ${name}\n\n*No declaration found*\n\n`;
    }

    // For re-exports, try to get the original symbol
    let originalSymbol = symbol;
    let originalDeclaration = declaration;
    
    if (declaration.kind === SyntaxKind.ExportSpecifier && symbol.flags & SymbolFlags.Alias) {
        try {
            const aliasedSymbol = checker.getAliasedSymbol(symbol);
            if (aliasedSymbol && aliasedSymbol.valueDeclaration) {
                originalSymbol = aliasedSymbol;
                originalDeclaration = aliasedSymbol.valueDeclaration || aliasedSymbol.declarations?.[0];
            }
        } catch (error) {
            // Fall back to original symbol if aliasing fails
        }
    }

    // Determine the type for the title
    let typeLabel = 'unknown';
    if (originalDeclaration.kind === SyntaxKind.FunctionDeclaration) {
        typeLabel = 'function';
    } else if (originalDeclaration.kind === SyntaxKind.ClassDeclaration) {
        typeLabel = 'class';
    } else if (originalDeclaration.kind === SyntaxKind.VariableDeclaration) {
        // Check if it's a constant by looking at the parent VariableDeclarationList flags
        let isConst = false;
        // Try different levels of the AST to find the const declaration
        if (originalDeclaration.parent?.flags & NodeFlags.Const) {
            isConst = true;
        } else if (originalDeclaration.parent?.parent?.flags & NodeFlags.Const) {
            isConst = true;
        } else {
            // Check the keyword on the variable statement
            const varStatement = originalDeclaration.parent?.parent;
            if (varStatement && varStatement.kind === SyntaxKind.VariableStatement) {
                const declarationList = varStatement.declarationList;
                if (declarationList && declarationList.flags & NodeFlags.Const) {
                    isConst = true;
                }
            }
        }
        typeLabel = isConst ? 'constant' : 'variable';
    } else {
        // Try to get type information for better labeling
        try {
            const type = checker.getTypeOfSymbolAtLocation(originalSymbol, originalDeclaration);
            const typeString = checker.typeToString(type);
            if (typeString.includes('=>')) {
                typeLabel = 'function';
            } else {
                typeLabel = 'value';
            }
        } catch (error) {
            typeLabel = 'value';
        }
    }

    let doc = `${headingPrefix} ${name} (${typeLabel})\n\n`;

    // Extract JSDoc comment - try original declaration first, then the export
    let jsDoc = originalDeclaration?.jsDoc?.[0] || declaration.jsDoc?.[0];
    if (jsDoc && jsDoc.comment) {
        doc += `${jsDoc.comment}\n\n`;
    }

    // Get type information
    try {
        const type = checker.getTypeOfSymbolAtLocation(originalSymbol, originalDeclaration);
        const typeString = checker.typeToString(type);
        
        // Handle different kinds of exports
        if (originalDeclaration.kind === SyntaxKind.FunctionDeclaration) {
            doc += generateFunctionDoc(originalDeclaration, typeString, checker, headingPrefix);
        } else if (originalDeclaration.kind === SyntaxKind.ClassDeclaration) {
            doc += generateClassDoc(originalDeclaration, typeString, checker, headingPrefix);
        } else if (originalDeclaration.kind === SyntaxKind.VariableDeclaration) {
            doc += generateVariableDoc(originalDeclaration, typeString, checker, headingPrefix);
        } else {
            doc += `**Type:** \`${typeString}\`\n\n`;
        }
    } catch (error) {
        console.warn(`Warning: Could not get type information for ${name}:`, error.message);
        doc += `*Type information unavailable*\n\n`;
    }

    return doc;
}

/**
 * Generate documentation for function declarations
 */
function generateFunctionDoc(declaration, typeString, checker, headingPrefix = '###') {
    let doc = `**Signature:** \`${typeString}\`\n\n`;
    
    // Extract type parameters
    if (declaration.typeParameters && declaration.typeParameters.length > 0) {
        doc += `**Type Parameters:**\n\n`;
        for (const typeParam of declaration.typeParameters) {
            const paramName = typeParam.name.getText();
            const constraint = typeParam.constraint ? ` extends ${typeParam.constraint.getText()}` : '';
            const defaultType = typeParam.default ? ` = ${typeParam.default.getText()}` : '';
            doc += `- \`${paramName}${constraint}${defaultType}\`\n`;
        }
        doc += `\n`;
    }
    
    // Extract runtime parameters with their TypeScript types
    if (declaration.parameters && declaration.parameters.length > 0) {
        doc += `**Parameters:**\n\n`;
        for (const param of declaration.parameters) {
            const paramName = param.name.getText();
            const paramType = param.type ? param.type.getText() : 'any';
            const isOptional = param.questionToken ? '?' : '';
            const hasDefault = param.initializer ? ' (optional)' : '';
            
            // Try to get JSDoc comment for this parameter
            const jsDoc = declaration.jsDoc?.[0];
            let paramComment = '';
            if (jsDoc && jsDoc.tags) {
                const paramTag = jsDoc.tags.find(tag => 
                    tag.tagName?.escapedText === 'param' && 
                    (tag.name?.escapedText === paramName || tag.name?.getText?.() === paramName)
                );
                paramComment = paramTag ? ` - ${paramTag.comment || ''}` : '';
            }
            
            doc += `- \`${paramName}${isOptional}: ${paramType}\`${hasDefault}${paramComment}\n`;
        }
        doc += `\n`;
    }
    
    // Extract other JSDoc information
    const jsDoc = declaration.jsDoc?.[0];
    if (jsDoc && jsDoc.tags) {
        const returnTag = jsDoc.tags.find(tag => tag.tagName?.escapedText === 'returns');
        const throwsTags = jsDoc.tags.filter(tag => tag.tagName?.escapedText === 'throws');
        const exampleTags = jsDoc.tags.filter(tag => tag.tagName?.escapedText === 'example');
        
        if (returnTag && returnTag.comment) {
            doc += `**Returns:** ${returnTag.comment}\n\n`;
        }
        
        if (throwsTags.length > 0) {
            doc += `**Throws:**\n\n`;
            for (const throwsTag of throwsTags) {
                doc += `- ${throwsTag.comment}\n`;
            }
            doc += `\n`;
        }
        
        if (exampleTags.length > 0) {
            doc += `**Examples:**\n\n`;
            for (const example of exampleTags) {
                doc += `${example.comment}\n\n`;
            }
        }
    }
    
    return doc;
}

/**
 * Generate documentation for class declarations
 */
function generateClassDoc(declaration, typeString, checker, headingPrefix = '###') {
    let doc = '';
    
    // Extract constructor parameters if available
    const constructor = declaration.members?.find(member => member.kind === SyntaxKind.Constructor);
    if (constructor) {
        const jsDoc = constructor.jsDoc?.[0];
        if (jsDoc && jsDoc.tags) {
            const paramTags = jsDoc.tags.filter(tag => tag.tagName?.escapedText === 'param');
            if (paramTags.length > 0) {
                doc += `**Constructor Parameters:**\n\n`;
                for (const param of paramTags) {
                    const paramName = param.name?.escapedText || param.name?.getText?.() || 'unknown';
                    const paramComment = param.comment || '';
                    doc += `- \`${paramName}\`: ${paramComment}\n`;
                }
                doc += `\n`;
            }
        }
    }
    
    // Document static members
    const staticMembers = declaration.members?.filter(member => 
        member.modifiers?.some(mod => mod.kind === SyntaxKind.StaticKeyword) &&
        !member.name?.getText().startsWith('_')
    ) || [];
    
    for (const member of staticMembers) {
        doc += generateClassMemberDoc(member, checker, true, headingPrefix);
    }
    
    // Document instance members (properties and methods)
    const instanceMembers = declaration.members?.filter(member => 
        !member.modifiers?.some(mod => mod.kind === SyntaxKind.StaticKeyword) &&
        member.kind !== SyntaxKind.Constructor &&
        !member.name?.getText().startsWith('_')
    ) || [];
    
    for (const member of instanceMembers) {
        doc += generateClassMemberDoc(member, checker, false, headingPrefix);
    }
    
    return doc;
}

/**
 * Generate documentation for a class member (method or property)
 */
function generateClassMemberDoc(member, checker, isStatic, headingPrefix = '###') {
    const memberName = member.name?.getText() || 'unknown';
    
    // Determine the member type for the title
    let memberType = 'member';
    if (member.kind === SyntaxKind.MethodDeclaration) {
        memberType = isStatic ? 'static method' : 'method';
    } else if (member.kind === SyntaxKind.PropertyDeclaration) {
        memberType = isStatic ? 'static property' : 'property';
    } else if (member.kind === SyntaxKind.GetAccessor) {
        memberType = isStatic ? 'static getter' : 'getter';
    } else if (member.kind === SyntaxKind.SetAccessor) {
        memberType = isStatic ? 'static setter' : 'setter';
    }
    
    let doc = `${headingPrefix}# ${memberName} (${memberType})\n\n`;
    
    // Extract JSDoc comment
    const jsDoc = member.jsDoc?.[0];
    if (jsDoc && jsDoc.comment) {
        doc += `${jsDoc.comment}\n\n`;
    }
    
    try {
        // Get type information
        const symbol = checker.getSymbolAtLocation(member.name);
        if (symbol) {
            const type = checker.getTypeOfSymbolAtLocation(symbol, member);
            const typeString = checker.typeToString(type);
            
            if (member.kind === SyntaxKind.MethodDeclaration) {
                // Handle methods like functions
                doc += `**Signature:** \`${typeString}\`\n\n`;
                doc += generateMethodJSDocInfo(member);
            } else if (member.kind === SyntaxKind.PropertyDeclaration) {
                // Handle properties
                doc += `**Type:** \`${typeString}\`\n\n`;
                if (jsDoc && jsDoc.tags) {
                    const exampleTags = jsDoc.tags.filter(tag => tag.tagName?.escapedText === 'example');
                    if (exampleTags.length > 0) {
                        doc += `**Examples:**\n\n`;
                        for (const example of exampleTags) {
                            doc += `${example.comment}\n\n`;
                        }
                    }
                }
            } else {
                doc += `**Type:** \`${typeString}\`\n\n`;
            }
        } else {
            doc += `*Type information unavailable*\n\n`;
        }
    } catch (error) {
        console.warn(`Warning: Could not get type information for ${memberName}:`, error.message);
        doc += `*Type information unavailable*\n\n`;
    }
    
    return doc;
}

/**
 * Generate JSDoc information for methods (similar to functions)
 */
function generateMethodJSDocInfo(methodDeclaration) {
    let doc = '';
    
    // Extract type parameters
    if (methodDeclaration.typeParameters && methodDeclaration.typeParameters.length > 0) {
        doc += `**Type Parameters:**\n\n`;
        for (const typeParam of methodDeclaration.typeParameters) {
            const paramName = typeParam.name.getText();
            const constraint = typeParam.constraint ? ` extends ${typeParam.constraint.getText()}` : '';
            const defaultType = typeParam.default ? ` = ${typeParam.default.getText()}` : '';
            doc += `- \`${paramName}${constraint}${defaultType}\`\n`;
        }
        doc += `\n`;
    }
    
    // Extract runtime parameters with their TypeScript types
    if (methodDeclaration.parameters && methodDeclaration.parameters.length > 0) {
        doc += `**Parameters:**\n\n`;
        for (const param of methodDeclaration.parameters) {
            const paramName = param.name.getText();
            const paramType = param.type ? param.type.getText() : 'any';
            const isOptional = param.questionToken ? '?' : '';
            const hasDefault = param.initializer ? ' (optional)' : '';
            
            // Try to get JSDoc comment for this parameter
            const jsDoc = methodDeclaration.jsDoc?.[0];
            let paramComment = '';
            if (jsDoc && jsDoc.tags) {
                const paramTag = jsDoc.tags.find(tag => 
                    tag.tagName?.escapedText === 'param' && 
                    (tag.name?.escapedText === paramName || tag.name?.getText?.() === paramName)
                );
                paramComment = paramTag ? ` - ${paramTag.comment || ''}` : '';
            }
            
            doc += `- \`${paramName}${isOptional}: ${paramType}\`${hasDefault}${paramComment}\n`;
        }
        doc += `\n`;
    }
    
    const jsDoc = methodDeclaration.jsDoc?.[0];
    if (jsDoc && jsDoc.tags) {
        const returnTag = jsDoc.tags.find(tag => tag.tagName?.escapedText === 'returns');
        const throwsTags = jsDoc.tags.filter(tag => tag.tagName?.escapedText === 'throws');
        const exampleTags = jsDoc.tags.filter(tag => tag.tagName?.escapedText === 'example');
        
        if (returnTag && returnTag.comment) {
            doc += `**Returns:** ${returnTag.comment}\n\n`;
        }
        
        if (throwsTags.length > 0) {
            doc += `**Throws:**\n\n`;
            for (const throwsTag of throwsTags) {
                doc += `- ${throwsTag.comment}\n`;
            }
            doc += `\n`;
        }
        
        if (exampleTags.length > 0) {
            doc += `**Examples:**\n\n`;
            for (const example of exampleTags) {
                doc += `${example.comment}\n\n`;
            }
        }
    }
    
    return doc;
}

/**
 * Generate documentation for variable declarations
 */
function generateVariableDoc(declaration, typeString, checker, headingPrefix = '###') {
    return `**Value:** \`${typeString}\`\n\n`;
}

/**
 * Find the next heading boundary after a given position
 * @param {string} text The text to search in
 * @param {number} startPos The position to start searching from
 * @param {number} maxLevel The maximum heading level to consider as boundary
 * @returns {number} The position of the next boundary, or text length if none found
 */
function findNextHeadingBoundary(text, startPos, maxLevel) {
    const headingRegex = /^(#{1,6})\s+/gm;
    headingRegex.lastIndex = startPos;
    
    let match;
    while ((match = headingRegex.exec(text)) !== null) {
        const headingLevel = match[1].length;
        if (headingLevel <= maxLevel) {
            return match.index;
        }
    }
    
    return text.length;
}

/**
* Update README.md with generated TSDoc content
*/
async function updateReadme() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let filename = 'README.md';
    let searchPhrase = 'The following is auto-generated from';
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' && i + 1 < args.length) {
            filename = args[i + 1];
            i++;
        } else if (args[i] === '--search' && i + 1 < args.length) {
            searchPhrase = args[i + 1];
            i++;
        }
    }
    
    const readmePath = path.join(projectRoot, filename);
    const readme = await fs.readFile(readmePath, 'utf8');
    
    // Escape the search phrase for regex
    const escapedSearchPhrase = searchPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerRegex = new RegExp(
        `(^(#{1,6})\\s+.*\\n)?` +        // Optional preceding heading
        `(.*?${escapedSearchPhrase}[ \`]*([^\`]+)[\`: ]*\\n)`, // Search phrase with source file
        'gm'
    );
    
    let updatedReadme = readme;
    let filesProcessed = 0;
    
    // Process all matches in reverse order to avoid index shifting issues
    const matches = Array.from(readme.matchAll(markerRegex)).reverse();
    
    for (const match of matches) {
        const [fullMatch, precedingHeadingLine, precedingHeadingLevel, beforeSearch, sourceFile] = match;
        const absoluteSourcePath = path.resolve(projectRoot, sourceFile);
        
        // Determine the heading level for generated content
        let baseHeadingLevel = 2; // Default to level 2
        if (precedingHeadingLevel) {
            baseHeadingLevel = precedingHeadingLevel.length;
        }
        
        // Find the end of content to replace
        const contentStart = match.index + fullMatch.length;
        const contentEnd = findNextHeadingBoundary(readme, contentStart, baseHeadingLevel);
        
        // Generated content should be at least one level deeper
        const contentHeadingLevel = baseHeadingLevel + 1;
        const headingPrefix = '#'.repeat(contentHeadingLevel);
        
        console.log(`Generating docs for ${sourceFile} with heading level ${contentHeadingLevel}...`);
        const newContent = await generateMarkdownDoc(absoluteSourcePath, headingPrefix);
        
        // Build the replacement text
        const replacement = (precedingHeadingLine || '') + beforeSearch + newContent;
        
        // Replace the content between marker and next heading
        updatedReadme = updatedReadme.substring(0, match.index) + replacement + updatedReadme.substring(contentEnd);
        
        filesProcessed++;
    }
    
    if (filesProcessed === 0) {
        console.error(`Could not find any "${searchPhrase}" markers in ${filename}`);
        process.exit(1);
    }
    
    await fs.writeFile(readmePath, updatedReadme);
    console.log(`Updated documentation for ${filesProcessed} file(s) in ${filename}`);
}

updateReadme().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
