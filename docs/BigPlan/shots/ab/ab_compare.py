#!/usr/bin/env python3
"""Compare the FINAL settled frame of before/after A/B captures, scenario by scenario.

Usage: ab_compare.py <before-dir> <after-dir> [--mask REGEX ...]

Rows matching any --mask regex are compared as '<masked>' (documented volatile rows).
Exit 1 on any unmasked difference; prints a row-level diff.
"""
import json
import re
import sys
from pathlib import Path

args = sys.argv[1:]
masks = []
while "--mask" in args:
    i = args.index("--mask")
    masks.append(re.compile(args[i + 1]))
    del args[i : i + 2]
before_dir, after_dir = Path(args[0]), Path(args[1])

def final_frame(path: Path):
    last = None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                last = json.loads(line)
    return last["screen"]

def norm(row: str) -> str:
    for m in masks:
        if m.search(row):
            return "<masked>"
    return row.rstrip()

fail = False
for bf in sorted(before_dir.glob("*.frames.jsonl")):
    af = after_dir / bf.name
    if not af.exists():
        print(f"{bf.name}: MISSING in after dir")
        fail = True
        continue
    b, a = final_frame(bf), final_frame(af)
    diffs = [
        (i, rb, ra)
        for i, (rb, ra) in enumerate(zip(b, a))
        if norm(rb) != norm(ra)
    ]
    if len(b) != len(a):
        print(f"{bf.name}: row count {len(b)} -> {len(a)}")
        fail = True
    if diffs:
        print(f"{bf.name}: {len(diffs)} differing rows")
        for i, rb, ra in diffs:
            print(f"  row {i:2d} before: {rb.rstrip()!r}")
            print(f"  row {i:2d} after : {ra.rstrip()!r}")
        fail = True
    else:
        print(f"{bf.name}: IDENTICAL ({len(b)} rows{', masked' if masks else ''})")

sys.exit(1 if fail else 0)
