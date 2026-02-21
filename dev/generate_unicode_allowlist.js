// Generate allowed Unicode characters from mappings for VS Code settings
const fs = require('fs');
const path = require('path');

const mappingsPath = path.join(__dirname, 'EditorVariation', 'unicode_mappings_filtered.json');
const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));

// Collect all unique Unicode characters
const allowedChars = {};
data.forEach(item => {
    if (item.unicode && item.unicode.trim() !== '' && item.unicode !== ' ') {
        allowedChars[item.unicode] = true;
    }
});

// Output as JSON object suitable for package.json
console.log(JSON.stringify(allowedChars, null, 2));
