-- wbmap.lua — THE ENGINE EMITS THE MAP (GlyphMap), LuaLaTeX only.
--
-- Loaded per compile by compileService through latexmk:
--     -usepretex -pretex='\directlua{dofile([[<this file>]])}'
-- (`[[ ]]`, never quotes — latexmk eats the quotes on the way through; and
-- never `--lua=`: at that point `luatexbase` does not exist yet.)
--
-- For every glyph the engine ships, this records the exact box and the source
-- position that produced it, so the render map in the extension is READ off
-- the engine instead of inferred from SyncTeX records and pdf.js text runs.
-- Design + measurements: Internal Docs/wolfbook-tex/GLYPHMAP_PLAN.md, spike in
-- Experiments/wolfbook-tex/h-glyphmap/.
--
-- HOW THE SOURCE LINE TRAVELS: `process_input_buffer` sets a GLOBAL attribute
-- to the line being read; every node created from that line — glyphs, and the
-- math noads that `mlist_to_hlist` later turns into glyphs — inherits it. So
-- prose is exact per line, display maths is exact per line, and a glyph made by
-- a user macro is filed under the CALL site. What collapses is anything TeX
-- reads ahead as a whole: a multi-line `\caption{}` lands on its closing line,
-- an amsmath `align` body on its `\end` — the extension aligns within those.
--
-- Output, written into the engine's cwd (compileService makes that the out
-- dir; `openout_any=p` forbids anything else):
--   $WB_GLYPHMAP_OUT   one JSON object per line: a header, then one per page
--                      {"p":n,"W":bp,"H":bp,"g":[[x,y,w,h,d,font,char,file,line,row,kind,lv,lig?],...]}
--                      x = left edge, y = BASELINE, in bp from the page's top-left.
--   $WB_GLYPHMAP_META  {"files":{id:path},"fonts":{id:{name,psname,format,size}}}
--                      rewritten after every page (a crash still leaves it valid).
--
-- Units are bp (PDF points): sp / 65536 * 72 / 72.27. The spike's first census
-- was off by exactly one pt because this was left in TeX points.

local OUT  = os.getenv("WB_GLYPHMAP_OUT")  or "wbmap.glyphmap.jsonl"
local META = os.getenv("WB_GLYPHMAP_META") or "wbmap.glyphmap.meta.json"
local DEBUG = os.getenv("WB_GLYPHMAP_DEBUG")

local SP2BP = 72 / 72.27 / 65536

-- Attributes are allocated through luatexbase so they can never collide with
-- another package's registers.
local A_LINE = luatexbase.new_attribute("wbmap_line")
local A_FILE = luatexbase.new_attribute("wbmap_file")

local function log(s) if DEBUG then texio.write_nl("wbmap: " .. s) end end

-- ---------------------------------------------------------------- files ------
local file_ids = {}          -- path -> id
local file_list = {}         -- id -> path
local file_stack = {}        -- names of the files being read, innermost last
local saved = {}             -- per open file: the (fileId, line) of its host
local cur_line = 0
local cur_file = 0

local function abs(p)
    if not p or p == "" then return p end
    if p:sub(1, 1) == "/" or p:match("^%a:[/\\]") then return p end
    local cwd = (lfs and lfs.currentdir()) or "."
    p = p:gsub("^%./", "")
    return cwd .. "/" .. p
end

local function fid(name)
    local p = abs(name)
    local id = file_ids[p]
    if not id then
        id = #file_list + 1
        file_ids[p] = id
        file_list[id] = p
    end
    return id
end

local function set_line(n)
    cur_line = n or 0
    tex.setattribute("global", A_LINE, cur_line)
end
local function set_file(id)
    cur_file = id or 0
    tex.setattribute("global", A_FILE, cur_file)
end

luatexbase.add_to_callback("start_file", function(cat, name)
    if cat ~= 1 then return end            -- 1 = a TeX source read by \input
    saved[#saved + 1] = { cur_file, cur_line }
    file_stack[#file_stack + 1] = name
    set_file(fid(name))
    log("start " .. tostring(name) .. " from line " .. cur_line)
end, "wbmap.start_file")

luatexbase.add_to_callback("stop_file", function(cat)
    if cat ~= 1 then return end
    file_stack[#file_stack] = nil
    local sv = table.remove(saved)
    -- RESTORE THE HOST'S FILE AND LINE. A `.fd`, `.aux` or `.toc` read in the
    -- middle of a line otherwise leaves ITS line numbers on the rest of the
    -- host line (measured: L49's glyphs filed under "93").
    if sv then set_file(sv[1]); set_line(sv[2]) end
end, "wbmap.stop_file")

luatexbase.add_to_callback("process_input_buffer", function(buf)
    -- GLOBAL: a group that closes mid-line must not restore a stale line.
    set_line(status.linenumber or tex.inputlineno)
    return buf
end, "wbmap.process_input_buffer")

-- ---------------------------------------------------------------- fonts ------
local font_seen = {}         -- id -> true once described in the meta
local font_meta = {}         -- id -> {name, psname, format, size}
local function note_font(id)
    if font_seen[id] then return end
    font_seen[id] = true
    local f = font.getfont(id)
    if not f then font_meta[id] = { name = "?" }; return end
    font_meta[id] = {
        name = f.name or "?",
        psname = f.psname,
        format = f.format,             -- "opentype"/"truetype" -> char is Unicode; else a TFM slot
        size = (f.size or 0) / 65536,  -- design size in pt, tells a script font from a body font
    }
end

-- ---------------------------------------------------------------- walk -------
local HLIST, VLIST, GLUE, KERN, RULE, GLYPH, DISC, MATH =
    node.id("hlist"), node.id("vlist"), node.id("glue"), node.id("kern"),
    node.id("rule"), node.id("glyph"), node.id("disc"), node.id("math")
local MKERN = node.id("margin_kern")

-- hlist subtypes that say what a box IS (LuaTeX manual, §8 / node.subtypes):
-- 1 line, 4 alignment, 5 cell, 6 equation, 7 equationnumber, 16 numerator,
-- 17 denominator, 21 sup, 22 sub, 25 over, 26 under. Only these are read; an
-- unknown subtype just inherits its parent's context.
local ST_LINE, ST_ALIGN, ST_CELL, ST_EQ, ST_EQNO = 1, 4, 5, 6, 7
local ST_NUM, ST_DEN, ST_SUP, ST_SUB = 16, 17, 21, 22
local VST_FRACTION = 19
-- MEASURED (Experiments/wolfbook-tex/h-glyphmap): a fraction is a vlist of
-- subtype 19 whose hlist children are numerator, (rule), denominator — and the
-- engine stamps the numerator/denominator subtype on only ONE of the two
-- (inline: numerator 16 + denominator 0; display: numerator 0 + denominator
-- 17). So the level inside a fraction comes from the CHILD ORDER, not the
-- subtype. `\overline`'s nucleus sits in an "over" vlist and is NOT above.

local out = nil
local page = 0
-- The text block's vertical band for this page (sp); see set_body_band below.
local body_top, body_bottom = nil, nil
local FURNITURE_SLACK = 6 * 65536
local row_counter = 0
local glyph_buf = {}

local function open_out()
    if out then return end
    out = io.open(OUT, "w")
    if not out then texio.write_nl("wbmap: cannot open " .. OUT .. " for writing — GlyphMap disabled"); return end
    out:write('{"v":1,"unit":"bp","engine":"luatex"}\n')
end

local function write_meta()
    local f = io.open(META, "w")
    if not f then return end
    local parts = {}
    parts[#parts + 1] = '{"v":1,"files":{'
    local first = true
    for id, p in ipairs(file_list) do
        parts[#parts + 1] = (first and "" or ",") .. '"' .. id .. '":"' .. p:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
        first = false
    end
    parts[#parts + 1] = '},"fonts":{'
    first = true
    for id, m in pairs(font_meta) do
        parts[#parts + 1] = string.format('%s"%d":{"name":"%s","psname":%s,"format":%s,"size":%.3f}',
            first and "" or ",", id,
            tostring(m.name):gsub('\\', '\\\\'):gsub('"', '\\"'),
            m.psname and ('"' .. tostring(m.psname):gsub('"', '\\"') .. '"') or "null",
            m.format and ('"' .. tostring(m.format) .. '"') or "null",
            m.size or 0)
        first = false
    end
    parts[#parts + 1] = '},"pages":' .. page .. '}\n'
    f:write(table.concat(parts))
    f:close()
end

-- The advance of a glyph: its width scaled by microtype's expansion factor.
local function gw(n)
    local w = n.width or 0
    local ef = n.expansion_factor or 0
    if ef ~= 0 then w = w + w * ef / 1000000 end
    return w
end

-- Ligature components as a string of char codes ("102,105" for fi); nil if none.
local function components_of(n)
    local c = n.components
    if not c then return nil end
    local t = {}
    for g in node.traverse_id(GLYPH, c) do
        if g.components then
            for g2 in node.traverse_id(GLYPH, g.components) do t[#t + 1] = g2.char end
        else
            t[#t + 1] = g.char
        end
    end
    if #t == 0 then return nil end
    return table.concat(t, ",")
end

-- ctx = { row, kind, lv, vd } inherited down the box tree.
--   kind: 0 text · 1 inline maths · 2 display equation · 3 equation number · 4 alignment cell
--         5 page furniture — a running head, the page number: an hbox sitting
--           DIRECTLY in the shipout vbox (vlist depth 0). MEASURED: the page
--           number is typeset by the output routine while some unrelated
--           source line is being read, and was filed under that line.
--   lv:   0 base · 1 above (sup/numerator/over) · 2 below (sub/denominator/under)
--   vd:   how many vlists enclose the box (the shipout box is 0)
local function child_ctx(ctx, st)
    if ctx.kind == 5 then return ctx end
    if st == ST_EQ then return { row = ctx.row, kind = 2, lv = ctx.lv, vd = ctx.vd } end
    if st == ST_EQNO then return { row = ctx.row, kind = 3, lv = ctx.lv, vd = ctx.vd } end
    if st == ST_CELL or st == ST_ALIGN then return { row = ctx.row, kind = (ctx.kind == 2 and 2 or 4), lv = ctx.lv, vd = ctx.vd } end
    if st == ST_SUP or st == ST_NUM then return { row = ctx.row, kind = ctx.kind, lv = 1, vd = ctx.vd } end
    if st == ST_SUB or st == ST_DEN then return { row = ctx.row, kind = ctx.kind, lv = 2, vd = ctx.vd } end
    return ctx
end
local function deeper(ctx) return { row = ctx.row, kind = ctx.kind, lv = ctx.lv, vd = (ctx.vd or 0) + 1 } end

local function emit(n, x, base, ctx, inline)
    local fnt = n.font
    note_font(fnt)
    local w = gw(n)
    local kind = ctx.kind
    if kind == 0 and inline then kind = 1 end
    if body_top and (base < body_top - FURNITURE_SLACK or base > body_bottom + FURNITURE_SLACK) then kind = 5 end
    local lig = components_of(n)
    glyph_buf[#glyph_buf + 1] = string.format('[%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%d,%d,%d,%d,%d%s]',
        x * SP2BP, base * SP2BP, w * SP2BP, (n.height or 0) * SP2BP, (n.depth or 0) * SP2BP,
        fnt, n.char or 0,
        node.get_attribute(n, A_FILE) or 0, node.get_attribute(n, A_LINE) or 0,
        ctx.row, kind, ctx.lv,
        lig and (',"' .. lig .. '"') or "")
end

local walkH, walkV

-- TeX's box model: in an hlist the children share the BASELINE and x advances;
-- in a vlist they stack from the TOP and y advances by height + depth.
function walkH(head, x, base, ctx, parent)
    local inline = false
    for n in node.traverse(head) do
        local id = n.id
        if id == HLIST then
            local c = child_ctx(ctx, n.subtype)
            if inline and c.kind == 0 then c = { row = c.row, kind = 1, lv = c.lv, vd = c.vd } end
            if n.head then walkH(n.head, x, base + (n.shift or 0), c, n) end
            x = x + (n.width or 0)
        elseif id == VLIST then
            local c = child_ctx(ctx, n.subtype)
            if inline and c.kind == 0 then c = { row = c.row, kind = 1, lv = c.lv, vd = c.vd } end
            if n.head then walkV(n.head, x, base + (n.shift or 0) - (n.height or 0), deeper(c), n, true) end
            x = x + (n.width or 0)
        elseif id == GLYPH then
            emit(n, x + (n.xoffset or 0), base - (n.yoffset or 0), ctx, inline)
            x = x + gw(n)
        elseif id == DISC then
            -- An unbroken discretionary prints its replace list; a broken one
            -- was flattened by the line breaker and is not a disc any more.
            if n.replace then
                walkH(n.replace, x, base, ctx, parent)
                x = x + node.dimensions(n.replace)
            end
        elseif id == GLUE then
            -- effective_glue, never the natural width: stretched glue is the
            -- whole point of a justified line.
            x = x + ((parent and node.effective_glue(n, parent)) or n.width or 0)
        elseif id == KERN then
            x = x + (n.kern or 0)
        elseif id == MKERN then
            x = x + (n.width or 0)
        elseif id == RULE then
            x = x + (n.width or 0)
        elseif id == MATH then
            -- subtype 0 opens inline maths, 1 closes it; the node itself may
            -- carry glue (mathsurround, or real glue in LuaTeX >= 1.10).
            inline = (n.subtype == 0)
            local ok, g = pcall(node.effective_glue, n, parent)
            x = x + (n.surround or 0) + ((ok and g) or 0)
        end
    end
end

-- `inRow`: are we already inside a printed row? The hlist children of a vlist
-- are the rows of a paragraph / the displays / the align rows — each gets a row
-- id when not already inside one. A numerator's own hlist inside a display
-- stays in the display's row. An alignment row (subtype 4) always starts a row
-- of its own, because amsmath stacks those inside one display.
-- THE ORDER THE SOURCE IS WRITTEN IN, NOT THE ORDER THE BOXES STACK IN.
--
-- MEASURED (sub2.tex in the spike): a script pair is a vlist of subtype 24
-- holding the SUPERSCRIPT box (21) above the SUBSCRIPT box (22); an accent is
-- a vlist of subtype 27 holding the MARK (9) above the NUCLEUS (20). Walking
-- top-down therefore emits `x^a_b` as x a b and `\dot u` as ˙ u, while the
-- projection's canonical order is x b a and u ˙ — and a monotone alignment
-- drops one side of every transposition. Positions are computed in box order;
-- only the EMISSION order is swapped, so every box is still where TeX put it.
local VST_SCRIPTS, VST_ACCENT = 24, 27
local ST_SUPBOX, ST_SUBBOX, ST_MARK, ST_NUCLEUS = 21, 22, 9, 20

function walkV(head, x, top, ctx, parent, inRow)
    local frac = parent and parent.id == VLIST and parent.subtype == VST_FRACTION
    local pst = parent and parent.id == VLIST and parent.subtype or nil
    if pst == VST_SCRIPTS or pst == VST_ACCENT then
        -- Lay the children out first, then emit in canonical order.
        local items = {}
        for n in node.traverse(head) do
            local id = n.id
            if id == HLIST or id == VLIST then
                items[#items + 1] = { n = n, top = top }
                top = top + (n.height or 0) + (n.depth or 0)
            elseif id == RULE then top = top + (n.height or 0) + (n.depth or 0)
            elseif id == GLUE then top = top + ((parent and node.effective_glue(n, parent)) or n.width or 0)
            elseif id == KERN then top = top + (n.kern or 0) end
        end
        local function rank(it)
            if pst == VST_SCRIPTS then return (it.n.id == HLIST and it.n.subtype == ST_SUBBOX) and 1 or 2 end
            return (it.n.id == HLIST and it.n.subtype == ST_NUCLEUS) and 1 or 2
        end
        table.sort(items, function(a, b)
            local ra, rb = rank(a), rank(b)
            if ra ~= rb then return ra < rb end
            return a.top < b.top
        end)
        for _, it in ipairs(items) do
            local n = it.n
            local c = child_ctx(ctx, n.subtype)
            if n.id == HLIST then
                if n.head then walkH(n.head, x + (n.shift or 0), it.top + (n.height or 0), c, n) end
            else
                if n.head then walkV(n.head, x + (n.shift or 0), it.top, deeper(c), n, inRow) end
            end
        end
        return
    end
    local nth = 0
    for n in node.traverse(head) do
        local id = n.id
        if id == HLIST then
            local c = child_ctx(ctx, n.subtype)
            if frac then
                nth = nth + 1
                c = { row = c.row, kind = c.kind, lv = (nth == 1) and 1 or 2, vd = c.vd }
            end
            if not inRow or n.subtype == ST_ALIGN then
                row_counter = row_counter + 1
                c = { row = row_counter, kind = c.kind, lv = c.lv, vd = c.vd }
            end
            if n.head then walkH(n.head, x + (n.shift or 0), top + (n.height or 0), c, n) end
            top = top + (n.height or 0) + (n.depth or 0)
        elseif id == VLIST then
            local c = deeper(child_ctx(ctx, n.subtype))
            if n.head then walkV(n.head, x + (n.shift or 0), top, c, n, inRow) end
            top = top + (n.height or 0) + (n.depth or 0)
        elseif id == RULE then
            top = top + (n.height or 0) + (n.depth or 0)
        elseif id == GLUE then
            -- VERTICAL GLUE STRETCHES TOO (\flushbottom, \maketitle): measured
            -- 10 bp of drift on a title page from using the natural width.
            top = top + ((parent and node.effective_glue(n, parent)) or n.width or 0)
        elseif id == KERN then
            top = top + (n.kern or 0)
        end
    end
end

-- PAGE FURNITURE IS WHAT LIES OUTSIDE THE TEXT BLOCK. LaTeX's own registers
-- say where the block is: its top is 1in + \voffset + \topmargin + \headheight
-- + \headsep and it is \textheight tall. The running head and the page number
-- sit outside that band by construction; a float, a footnote, a marginpar
-- sit inside it. MEASURED before this: a structural pick of "the body vbox"
-- chose a wrapper on the real paper (geometry nests one more vbox than the
-- article fixture) and the page number came through as the text of whatever
-- line was being read when the page shipped.
local function set_body_band()
    local th = tex.dimen.textheight or 0
    if th <= 0 then body_top, body_bottom = nil, nil; return end
    local one_inch = 4736286
    body_top = one_inch + (tex.voffset or 0) + (tex.dimen.topmargin or 0) + (tex.dimen.headheight or 0) + (tex.dimen.headsep or 0)
    body_bottom = body_top + th
    log(string.format("band %.1f..%.1f bp (textheight %.1f)", body_top * SP2BP, body_bottom * SP2BP, th * SP2BP))
end

luatexbase.add_to_callback("pre_shipout_filter", function(box)
    open_out()
    if not out then return true end
    page = page + 1
    glyph_buf = {}
    set_body_band()
    -- TeX's origin is 1in from the paper's top-left, moved by \hoffset/\voffset.
    local one_inch = 4736286
    local ok, err = pcall(walkV, box.head, one_inch + (tex.hoffset or 0), one_inch + (tex.voffset or 0),
        { row = 0, kind = 0, lv = 0, vd = 0 }, box, false)
    if not ok then texio.write_nl("wbmap: walk failed on page " .. page .. ": " .. tostring(err)) end
    out:write(string.format('{"p":%d,"W":%.3f,"H":%.3f,"g":[%s]}\n',
        page, (tex.pagewidth or 0) * SP2BP, (tex.pageheight or 0) * SP2BP, table.concat(glyph_buf, ",")))
    out:flush()
    write_meta()
    return true
end, "wbmap.pre_shipout_filter")

log("loaded; out=" .. OUT)
