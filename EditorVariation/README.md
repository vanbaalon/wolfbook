# Unicode Character Replacement

This folder contains Unicode character mappings extracted from Mathematica's character encoding system.

## Files

- **unicode_mappings.json** - Complete mapping of all 1,160 `\[Name]` notation characters
- **unicode_mappings_filtered.json** - Filtered mapping of 596 characters that display well in standard fonts (used by extension)

## Features

### Automatic Replacement
When typing in Wolfram Language files (`.wl`, `.m`, `.wls`) and notebooks (`.vsnb`), `\[Name]` patterns are automatically converted to Unicode:
- Type `\[Alpha]` → automatically becomes `α`
- Type `\[Beta]` → automatically becomes `β`
- Type `\[Theta]` → automatically becomes `θ`

### Completion Suggestions
After typing `\[`, you'll get IntelliSense suggestions for all available Unicode characters.

### Manual Conversion
Select text containing `\[Name]` patterns and run the command:
**Wolfram Language: Convert Selection to Unicode**

## Settings

- `wolfram.editor.autoReplaceUnicode` - Enable/disable automatic replacement (default: true)

## Examples

| You Type | It Becomes | Name |
|----------|------------|------|
| `\[Alpha]` | α | Greek letter Alpha |
| `\[Beta]` | β | Greek letter Beta |
| `\[Gamma]` | γ | Greek letter Gamma |
| `\[Theta]` | θ | Greek letter Theta |
| `\[Lambda]` | λ | Greek letter Lambda |
| `\[Infinity]` | ∞ | Infinity symbol |
| `\[Element]` | ∈ | Element of |
| `\[ForAll]` | ∀ | For all quantifier |

## Source

Mappings extracted from:
```
/Applications/Wolfram 3.app/Contents/SystemFiles/FrontEnd/TextResources/UnicodeCharacters.tr
```

- Original: 1,160 character mappings
- Filtered: 596 character mappings (excludes private use area and non-standard variants)

The filtered version excludes:
- Private use area characters (may not display)
- "Formal" variants (specialized mathematical fonts)
- "Script" variants (specialized mathematical fonts)
- "Gothic" and "DoubleStruck" variants
- Raw control characters

This ensures all characters display correctly in standard fonts like Monaco, Menlo, SF Mono, and Consolas.
