const fs = require('fs');
const path = require('path');

// Parse UnicodeCharacters.tr file to extract alias mappings.
// This file is part of a local Wolfram Language installation (not redistributable).
// Typical location on macOS: /Applications/Wolfram <version>.app/Contents/SystemFiles/FrontEnd/TextResources/UnicodeCharacters.tr
// On Linux: <wolfram_dir>/SystemFiles/FrontEnd/TextResources/UnicodeCharacters.tr
// Pass the path as a command-line argument, or set it here:
const filePath = process.argv[2] || 'UnicodeCharacters.tr';
const content = fs.readFileSync(filePath, 'utf8');

const aliasMap = {};
const greekAliases = {}; // Higher priority
const lines = content.split('\n');

// Define priority character types (Greek letters, common math symbols)
const priorityPatterns = [
    /Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega/,
    /Infinity|Integral|Sum|Product|PartialD|Del|Nabla/,
    /Arrow|Implies|ForAll|Exists|Element|NotElement/,
    /LessEqual|GreaterEqual|NotEqual|Equivalent|Similar/
];

for (const line of lines) {
    // Skip headers and empty lines
    if (!line.trim() || line.startsWith('@@')) continue;
    
    // Parse line: 0x03B1  \[Alpha]  ($a$   $alpha$   $&alpha;$   $\alpha$)  Letter
    const regex = new RegExp('^0x([0-9A-F]+)\\s+\\\\\\[(\\w+)\\]\\s+\\(([^)]+)\\)');
    const match = line.match(regex);
    if (!match) continue;
    
    const [, codepoint, charName, aliasesStr] = match;
    const unicodeChar = String.fromCharCode(parseInt(codepoint, 16));
    
    // Check if this is a priority character
    const isPriority = priorityPatterns.some(pattern => pattern.test(charName));
    
    // Extract aliases from the parentheses
    // Format: ($a$   $alpha$   $&alpha;$   $\alpha$)
    const aliases = aliasesStr
        .split('$')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('&')); // Include LaTeX-style aliases with backslash
    
    // Store each alias
    const targetMap = isPriority ? greekAliases : aliasMap;
    
    for (const alias of aliases) {
        if (alias && alias.length <= 20) { // Skip very long HTML entities
            targetMap[alias] = {
                name: charName,
                unicode: unicodeChar,
                fullName: `\\[${charName}]`,
                codepoint: `0x${codepoint}`
            };
        }
    }
}

// Merge with priority - Greek letters overwrite conflicts
const finalMap = { ...aliasMap, ...greekAliases };

// Export to JSON
const outputPath = path.join(__dirname, 'wolfram_escape_aliases.json');
fs.writeFileSync(outputPath, JSON.stringify(finalMap, null, 2));

console.log(`Total aliases: ${Object.keys(finalMap).length}`);
console.log(`Priority aliases: ${Object.keys(greekAliases).length}`);
console.log(`Exported to: ${outputPath}`);
console.log(`\nSample Greek aliases:`);
console.log(`  'a' -> ${finalMap['a']?.unicode} (${finalMap['a']?.name})`);
console.log(`  'b' -> ${finalMap['b']?.unicode} (${finalMap['b']?.name})`);
console.log(`  'g' -> ${finalMap['g']?.unicode} (${finalMap['g']?.name})`);
console.log(`  'alpha' -> ${finalMap['alpha']?.unicode} (${finalMap['alpha']?.name})`);
console.log(`  'pi' -> ${finalMap['pi']?.unicode} (${finalMap['pi']?.name})`);
console.log(`  'inf' -> ${finalMap['inf']?.unicode} (${finalMap['inf']?.name})`);
