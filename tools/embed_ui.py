#!/usr/bin/env python3
"""Copies ui/app.html into fastcombo.js (between the UI-START / UI-END markers).
Run after editing the website:  python3 tools/embed_ui.py"""
import pathlib, re, sys
root = pathlib.Path(__file__).resolve().parent.parent
ui = (root / "ui" / "app.html").read_text(encoding="utf-8")
for bad in ("`", "${"):
    if bad in ui:
        sys.exit(f"ui/app.html must not contain {bad!r} (it is embedded in a JS template string)")
if ui.rstrip().endswith("\\"):
    sys.exit("ui/app.html must not end with a backslash")
js_path = root / "fastcombo.js"
js = js_path.read_text(encoding="utf-8")
block = ("// ==UI-START== control panel website (generated from ui/app.html by tools/embed_ui.py — edit that file)\n"
         "const APP_HTML = String.raw`" + ui + "`;\n// ==UI-END==")
pat = re.compile(r"// ==UI-START==.*?// ==UI-END==", re.S)
if not pat.search(js):
    sys.exit("markers not found in fastcombo.js")
js = pat.sub(lambda m: block, js, count=1)
js_path.write_text(js, encoding="utf-8")
print(f"embedded {len(ui):,} bytes of UI")
