#!/usr/bin/env python3
"""
Fix double UTF-8 encoding in .vsnb files.
Wolfram's Export with CharacterEncoding -> "UTF8" produces double-encoded UTF-8,
where each UTF-8 byte is treated as a Latin-1 character and then re-encoded as UTF-8.

For example:
- ℱ (U+2131) → UTF-8 bytes: e2 84 b1
- Each byte treated as Latin-1: â (c3 a2), „ (c2 84), ± (c2 b1)  
- Result in file: â±

This script fixes the double-encoding by reading the file as bytes,
decoding as UTF-8 (gets the mojibake string), encoding as latin-1 (gets original UTF-8 bytes),
then writing back.
"""
import sys

if len(sys.argv) != 2:
    print("Usage: python3 fix_vsnb_encoding.py <file.vsnb>")
    sys.exit(1)

filename = sys.argv[1]

try:
    # Read the file as bytes
    with open(filename, 'rb') as f:
        data = f.read()
    
    # Fix all double-UTF-8 encodings
    # These are the characters we convert in the Wolfram script that get double-encoded
    replacements = [
        (b'\xc3\xa2\xc2\x84\xc2\xb1', b'\xe2\x84\xb1'),  # ℱ Script F
        (b'\xc3\xa2\xc2\x84\xc2\xac', b'\xe2\x84\xac'),  # ℬ Script B
        (b'\xc3\xb0\xc2\x9d\xc2\x92\xc2\xab', b'\xf0\x9d\x92\xab'),  # 𝒫 Script P
        (b'\xc3\xa2\xc2\x84\xc2\x8b', b'\xe2\x84\x8b'),  # ℋ Script H
        (b'\xc3\xa2\xc2\x84\xc2\x92', b'\xe2\x84\x92'),  # ℒ Script L
        (b'\xc3\xa2\xc2\x84\xc2\xb3', b'\xe2\x84\xb3'),  # ℳ Script M
        (b'\xc3\xb0\xc2\x9d\xc2\x92\xc2\xa9', b'\xf0\x9d\x92\xa9'),  # 𝒩 Script N
        (b'\xc3\xb0\xc2\x9d\xc2\x92\xc2\xae', b'\xf0\x9d\x92\xae'),  # 𝒮 Script S
        (b'\xc3\xa2\xc2\x84\xc2\x82', b'\xe2\x84\x82'),  # ℂ Double-struck C
        (b'\xc3\xb0\xc2\x9d\xc2\x94\xc2\xbd', b'\xf0\x9d\x94\xbd'),  # 𝔽 Double-struck F
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x81', b'\xf0\x9d\x95\x81'),  # 𝕁 Double-struck J
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x84', b'\xf0\x9d\x95\x84'),  # 𝕄 Double-struck M
        (b'\xc3\xa2\xc2\x84\xc2\x95', b'\xe2\x84\x95'),  # ℕ Double-struck N
        (b'\xc3\xa2\xc2\x84\xc2\x99', b'\xe2\x84\x99'),  # ℙ Double-struck P
        (b'\xc3\xa2\xc2\x84\xc2\x9a', b'\xe2\x84\x9a'),  # ℚ Double-struck Q
        (b'\xc3\xa2\xc2\x84\xc2\x9d', b'\xe2\x84\x9d'),  # ℝ Double-struck R
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x8a', b'\xf0\x9d\x95\x8a'),  # 𝕊 Double-struck S
        (b'\xc3\xa2\xc2\x84\xc2\xa4', b'\xe2\x84\xa4'),  # ℤ Double-struck Z
        (b'\xc3\x8f\xc2\x91', b'\xcf\x91'),  # ϑ vartheta
        (b'\xc3\x8e\xc2\xb5', b'\xce\xb5'),  # ε varepsilon
        (b'\xc3\x8f\xc2\x86', b'\xcf\x86'),  # φ varphi
        (b'\xc3\xa2\xc2\x88\xc2\x9e', b'\xe2\x88\x9e'),  # ∞ Infinity
        (b'\xc3\xa2\xc2\x88\xc2\x88', b'\xe2\x88\x88'),  # ∈ Element
        (b'\xc3\xa2\xc2\x88\xc2\x89', b'\xe2\x88\x89'),  # ∉ NotElement
        (b'\xc3\xa2\xc2\x88\xc2\x82', b'\xe2\x88\x82'),  # ∂ PartialD
        (b'\xc3\xa2\xc2\x88\xc2\x87', b'\xe2\x88\x87'),  # ∇ Del/Nabla
        (b'\xc3\xa2\xc2\x96\xc2\xa1', b'\xe2\x96\xa1'),  # □ Square
        (b'\xc3\xa2\xc2\x88\xc2\x85', b'\xe2\x88\x85'),  # ∅ EmptySet
        (b'\xc3\xa2\xc2\x88\xc2\x80', b'\xe2\x88\x80'),  # ∀ ForAll
        (b'\xc3\xa2\xc2\x88\xc2\x83', b'\xe2\x88\x83'),  # ∃ Exists
        # Lowercase blackboard letters (𝕒-𝕫) - double UTF-8 encoded
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x92', b'\xf0\x9d\x95\x92'),  # 𝕒 (a)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x93', b'\xf0\x9d\x95\x93'),  # 𝕓 (b)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x94', b'\xf0\x9d\x95\x94'),  # 𝕔 (c)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x95', b'\xf0\x9d\x95\x95'),  # 𝕕 (d)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x96', b'\xf0\x9d\x95\x96'),  # 𝕖 (e)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x97', b'\xf0\x9d\x95\x97'),  # 𝕗 (f)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x98', b'\xf0\x9d\x95\x98'),  # 𝕘 (g)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x99', b'\xf0\x9d\x95\x99'),  # 𝕙 (h)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x9a', b'\xf0\x9d\x95\x9a'),  # 𝕚 (i)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x9b', b'\xf0\x9d\x95\x9b'),  # 𝕛 (j)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x9c', b'\xf0\x9d\x95\x9c'),  # 𝕜 (k)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x9d', b'\xf0\x9d\x95\x9d'),  # 𝕝 (l)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x9e', b'\xf0\x9d\x95\x9e'),  # 𝕞 (m)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\x9f', b'\xf0\x9d\x95\x9f'),  # 𝕟 (n)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa0', b'\xf0\x9d\x95\xa0'),  # 𝕠 (o)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa1', b'\xf0\x9d\x95\xa1'),  # 𝕡 (p)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa2', b'\xf0\x9d\x95\xa2'),  # 𝕢 (q)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa3', b'\xf0\x9d\x95\xa3'),  # 𝕣 (r)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa4', b'\xf0\x9d\x95\xa4'),  # 𝕤 (s)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa5', b'\xf0\x9d\x95\xa5'),  # 𝕥 (t)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa6', b'\xf0\x9d\x95\xa6'),  # 𝕦 (u)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa7', b'\xf0\x9d\x95\xa7'),  # 𝕧 (v)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa8', b'\xf0\x9d\x95\xa8'),  # 𝕨 (w)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xa9', b'\xf0\x9d\x95\xa9'),  # 𝕩 (x)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xaa', b'\xf0\x9d\x95\xaa'),  # 𝕪 (y)
        (b'\xc3\xb0\xc2\x9d\xc2\x95\xc2\xab', b'\xf0\x9d\x95\xab'),  # 𝕫 (z)
    ]
    
    for double_encoded, correct_utf8 in replacements:
        data = data.replace(double_encoded, correct_utf8)
    
    # Write back the fixed bytes
    with open(filename, 'wb') as f:
        f.write(data)
    
    # Now handle Private Use Area characters for lowercase blackboard letters
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
    
    lowercase_blackboard = {
        '\uf4db': '𝕒', '\uf4dc': '𝕓', '\uf4dd': '𝕔', '\uf4de': '𝕕',
        '\uf4df': '𝕖', '\uf4e0': '𝕗', '\uf4e1': '𝕘', '\uf4e2': '𝕙',
        '\uf4e3': '𝕚', '\uf4e4': '𝕛', '\uf4e5': '𝕜', '\uf4e6': '𝕝',
        '\uf4e7': '𝕞', '\uf4e8': '𝕟', '\uf4e9': '𝕠', '\uf4ea': '𝕡',
        '\uf4eb': '𝕢', '\uf4ec': '𝕣', '\uf4ed': '𝕤', '\uf4ee': '𝕥',
        '\uf4ef': '𝕦', '\uf4f0': '𝕧', '\uf4f1': '𝕨', '\uf4f2': '𝕩',
        '\uf4f3': '𝕪', '\uf4f4': '𝕫',
    }
    
    replacements_made = 0
    for pua_char, unicode_char in lowercase_blackboard.items():
        if pua_char in content:
            count = content.count(pua_char)
            content = content.replace(pua_char, unicode_char)
            replacements_made += count
    
    # Write back
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"✓ Fixed double-UTF-8 encoding in {filename}")
    if replacements_made > 0:
        print(f"  Replaced {replacements_made} blackboard letters")
        
except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
