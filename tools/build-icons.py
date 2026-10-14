"""Rebuild the self-hosted Material Symbols icon subset.

The app renders icons by codepoint (ICON_CP in index.html), not by ligature name, so a
missing font shows an empty box instead of raw text like "bar_chart". To add an icon:
add its name to ICONS, then run

    npm i material-symbols          # anywhere; provides the full 4 MB source font
    pip install fonttools brotli
    python3 tools/build-icons.py path/to/node_modules/material-symbols/material-symbols-outlined.woff2

It writes fonts/material-symbols.woff2 and prints the ICON_CP object to paste into index.html.
Bump CACHE_VERSION in sw.js afterwards so installed apps pick up the new font.
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools import subset

ICONS = sorted(set("""
close person fitness_center bar_chart add_a_photo auto_awesome cloud_off expand_less expand_more
verified_user cloud_done trending_up timer sync sports_gymnastics repeat event_repeat emoji_events
edit delete_sweep delete calendar_month arrow_upward arrow_drop_down chevron_left chevron_right
local_fire_department speed flag monitor_weight photo_camera forum settings
add remove search check arrow_back refresh info warning restaurant barcode_scanner nutrition egg
water_drop history star more_vert schedule bolt flash_on flash_off tune content_copy play_arrow
menu_book psychology
""".split()))

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'fonts', 'material-symbols.woff2')

font = TTFont(src)
cmap = font.getBestCmap()
pua = {}
for cp, g in cmap.items():
    if cp >= 0xE000:
        pua.setdefault(g, cp)
glyph_of = {chr(cp): g for cp, g in cmap.items()}
ligs = {}
for lookup in font['GSUB'].table.LookupList.Lookup:
    for st in lookup.SubTable:
        if st.LookupType == 7:
            st = st.ExtSubTable
        if getattr(st, 'LookupType', None) == 4:
            for first, lst in st.ligatures.items():
                for lig in lst:
                    ligs[(first, *lig.Component)] = lig.LigGlyph

cps = {}
for name in ICONS:
    g = ligs.get(tuple(glyph_of[c] for c in name))
    if g not in pua:
        sys.exit(f'icon not found in font: {name}')
    cps[name] = pua[g]

opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = []  # no ligatures needed: icons are addressed by codepoint
opts.name_IDs = ['*']
opts.notdef_outline = True
sub = subset.Subsetter(opts)
sub.populate(unicodes=list(cps.values()))
sub.subset(font)
subset.save_font(font, out, opts)
print(f'wrote {out} ({os.path.getsize(out)} bytes)')
print('const ICON_CP = ' + json.dumps({k: hex(v)[2:] for k, v in cps.items()}, separators=(',', ':')) + ';')
