// Compute all confusable Wolfram named characters with proper JSON escape sequences
const chars = {
  "DoubleStruck BMP": {
    "DoubleStruckCapitalC": 0x2102,
    "DoubleStruckCapitalH": 0x210D,
    "DoubleStruckCapitalN": 0x2115,
    "DoubleStruckCapitalP": 0x2119,
    "DoubleStruckCapitalQ": 0x211A,
    "DoubleStruckCapitalR": 0x211D,
    "DoubleStruckCapitalZ": 0x2124,
    "CapitalDifferentialD": 0x2145,
    "DifferentialD": 0x2146,
    "ExponentialE": 0x2147,
    "ImaginaryI": 0x2148,
  },
  "Gothic BMP": {
    "GothicCapitalH": 0x210C,
    "GothicCapitalI": 0x2111,
    "GothicCapitalR": 0x211C,
    "GothicCapitalZ": 0x2128,
    "GothicCapitalC": 0x212D,
  },
  "Script BMP": {
    "ScriptG": 0x210A,
    "ScriptCapitalH": 0x210B,
    "ScriptCapitalI": 0x2110,
    "ScriptCapitalL": 0x2112,
    "ScriptL": 0x2113,
    "ScriptCapitalR": 0x211B,
    "ScriptCapitalB": 0x212C,
    "ScriptE": 0x212F,
    "ScriptCapitalE": 0x2130,
    "ScriptCapitalF": 0x2131,
    "ScriptCapitalM": 0x2133,
    "ScriptO": 0x2134,
  },
  "DoubleStruck Supplementary": {
    "DoubleStruckCapitalA": 0x1D538, "DoubleStruckCapitalB": 0x1D539,
    "DoubleStruckCapitalD": 0x1D53B, "DoubleStruckCapitalE": 0x1D53C,
    "DoubleStruckCapitalF": 0x1D53D, "DoubleStruckCapitalG": 0x1D53E,
    "DoubleStruckCapitalI": 0x1D540, "DoubleStruckCapitalJ": 0x1D541,
    "DoubleStruckCapitalK": 0x1D542, "DoubleStruckCapitalL": 0x1D543,
    "DoubleStruckCapitalM": 0x1D544, "DoubleStruckCapitalO": 0x1D546,
    "DoubleStruckCapitalS": 0x1D54A, "DoubleStruckCapitalT": 0x1D54B,
    "DoubleStruckCapitalU": 0x1D54C, "DoubleStruckCapitalV": 0x1D54D,
    "DoubleStruckCapitalW": 0x1D54E, "DoubleStruckCapitalX": 0x1D54F,
    "DoubleStruckCapitalY": 0x1D550,
    "DoubleStruckA": 0x1D552, "DoubleStruckB": 0x1D553,
    "DoubleStruckC": 0x1D554, "DoubleStruckD": 0x1D555,
    "DoubleStruckE": 0x1D556, "DoubleStruckF": 0x1D557,
    "DoubleStruckG": 0x1D558, "DoubleStruckH": 0x1D559,
    "DoubleStruckI": 0x1D55A, "DoubleStruckJ": 0x1D55B,
    "DoubleStruckK": 0x1D55C, "DoubleStruckL": 0x1D55D,
    "DoubleStruckM": 0x1D55E, "DoubleStruckN": 0x1D55F,
    "DoubleStruckO": 0x1D560, "DoubleStruckP": 0x1D561,
    "DoubleStruckQ": 0x1D562, "DoubleStruckR": 0x1D563,
    "DoubleStruckS": 0x1D564, "DoubleStruckT": 0x1D565,
    "DoubleStruckU": 0x1D566, "DoubleStruckV": 0x1D567,
    "DoubleStruckW": 0x1D568, "DoubleStruckX": 0x1D569,
    "DoubleStruckY": 0x1D56A, "DoubleStruckZ": 0x1D56B,
  },
  "Gothic Supplementary": {
    "GothicCapitalA": 0x1D504, "GothicCapitalB": 0x1D505,
    "GothicCapitalD": 0x1D507, "GothicCapitalE": 0x1D508,
    "GothicCapitalF": 0x1D509, "GothicCapitalG": 0x1D50A,
    "GothicCapitalJ": 0x1D50D, "GothicCapitalK": 0x1D50E,
    "GothicCapitalL": 0x1D50F, "GothicCapitalM": 0x1D510,
    "GothicCapitalN": 0x1D511, "GothicCapitalO": 0x1D512,
    "GothicCapitalP": 0x1D513, "GothicCapitalQ": 0x1D514,
    "GothicCapitalS": 0x1D516, "GothicCapitalT": 0x1D517,
    "GothicCapitalU": 0x1D518, "GothicCapitalV": 0x1D519,
    "GothicCapitalW": 0x1D51A, "GothicCapitalX": 0x1D51B,
    "GothicCapitalY": 0x1D51C,
    "GothicA": 0x1D51E, "GothicB": 0x1D51F,
    "GothicC": 0x1D520, "GothicD": 0x1D521,
    "GothicE": 0x1D522, "GothicF": 0x1D523,
    "GothicG": 0x1D524, "GothicH": 0x1D525,
    "GothicI": 0x1D526, "GothicJ": 0x1D527,
    "GothicK": 0x1D528, "GothicL": 0x1D529,
    "GothicM": 0x1D52A, "GothicN": 0x1D52B,
    "GothicO": 0x1D52C, "GothicP": 0x1D52D,
    "GothicQ": 0x1D52E, "GothicR": 0x1D52F,
    "GothicS": 0x1D530, "GothicT": 0x1D531,
    "GothicU": 0x1D532, "GothicV": 0x1D533,
    "GothicW": 0x1D534, "GothicX": 0x1D535,
    "GothicY": 0x1D536, "GothicZ": 0x1D537,
  },
  "Script Supplementary": {
    "ScriptCapitalA": 0x1D49C, "ScriptCapitalC": 0x1D49E,
    "ScriptCapitalD": 0x1D49F, "ScriptCapitalG": 0x1D4A2,
    "ScriptCapitalJ": 0x1D4A5, "ScriptCapitalK": 0x1D4A6,
    "ScriptCapitalN": 0x1D4A9, "ScriptCapitalO": 0x1D4AA,
    "ScriptCapitalP": 0x1D4AB, "ScriptCapitalQ": 0x1D4AC,
    "ScriptCapitalS": 0x1D4AE, "ScriptCapitalT": 0x1D4AF,
    "ScriptCapitalU": 0x1D4B0, "ScriptCapitalV": 0x1D4B1,
    "ScriptCapitalW": 0x1D4B2, "ScriptCapitalX": 0x1D4B3,
    "ScriptCapitalY": 0x1D4B4, "ScriptCapitalZ": 0x1D4B5,
    "ScriptA": 0x1D4B6, "ScriptB": 0x1D4B7,
    "ScriptC": 0x1D4B8, "ScriptD": 0x1D4B9,
    "ScriptF": 0x1D4BB, "ScriptH": 0x1D4BD,
    "ScriptI": 0x1D4BE, "ScriptJ": 0x1D4BF,
    "ScriptK": 0x1D4C0, "ScriptM": 0x1D4C2,
    "ScriptN": 0x1D4C3, "ScriptP": 0x1D4C5,
    "ScriptQ": 0x1D4C6, "ScriptR": 0x1D4C7,
    "ScriptS": 0x1D4C8, "ScriptT": 0x1D4C9,
    "ScriptU": 0x1D4CA, "ScriptV": 0x1D4CB,
    "ScriptW": 0x1D4CC, "ScriptX": 0x1D4CD,
    "ScriptY": 0x1D4CE, "ScriptZ": 0x1D4CF,
  },
};

function toJsonEscape(cp) {
  if (cp <= 0xFFFF) {
    return "\\u" + cp.toString(16).padStart(4, "0");
  }
  const hi = 0xD800 + ((cp - 0x10000) >> 10);
  const lo = 0xDC00 + ((cp - 0x10000) & 0x3FF);
  return "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
}

for (const [group, entries] of Object.entries(chars)) {
  console.log("");
  console.log("// === " + group + " (" + Object.keys(entries).length + " chars) ===");
  for (const [name, cp] of Object.entries(entries)) {
    const glyph = String.fromCodePoint(cp);
    const esc = toJsonEscape(cp);
    console.log('"' + esc + '": true,  // ' + glyph + ' \\[' + name + '] U+' + cp.toString(16).toUpperCase());
  }
}

let total = 0;
for (const entries of Object.values(chars)) total += Object.keys(entries).length;
console.log("");
console.log("// TOTAL: " + total + " characters to add");
