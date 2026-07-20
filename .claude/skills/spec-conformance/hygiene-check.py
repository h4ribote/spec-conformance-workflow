#!/usr/bin/env python3
"""Flag references that a reader with only the repository cannot follow.

Part of the spec-conformance skill; the cross-platform twin of hygiene-check.ps1. Run before committing a conformance batch.

What it looks for, by default:
  * audit/finding numbering ("finding 7", "audit #3", "所見 12") -- meaningful only to whoever ran the audit
  * paths into scratch directories ("tmp/notes.md", "scratch\\plan") -- files that were never committed

Both are fine while working and useless afterwards: a maintainer reading the comment a year later has no way to reach what it points at. Rewrite them as prose that states the reason itself.

NOT flagged by default: bare issue numbers like "#123". Many projects reference their issue tracker that way on purpose. Projects that ban them (e.g. because the host auto-links unrelated issues) enable the check with --ban-bare-hash-numbers.

Scope: prose files (.md, .rst, .txt, .adoc) are scanned in full; source files are scanned on comment and docstring lines only, since executable code legitimately contains paths like "tmp/". Pass --all-lines to scan everything.

Usage:
    python hygiene-check.py
    python hygiene-check.py --config .claude/conformance.json
    python hygiene-check.py --roots src tests doc --ban-bare-hash-numbers
    python hygiene-check.py --patterns 'ticket [0-9]+' --scratch-dirs tmp notes

Exit codes: 0 clean, 1 hits found, 2 bad arguments.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

DEFAULT_ROOTS = ["src", "tests", "test", "lib", "doc", "docs"]
DEFAULT_SCRATCH_DIRS = ["tmp", "scratch", "notes"]
BARE_HASH_PATTERN = r"(?<![A-Za-z0-9.])#\d{1,4}\b"
DEFAULT_PATTERNS = [
    r"(?i:\bfindings?\s*#?\d)",
    r"(?i:\baudit\s*#?\d)",
    r"所見\s*#?\d",
    r"(?i:\bitem\s*#\d)",
]

PROSE_EXTS = {".md", ".rst", ".txt", ".adoc"}
LINE_COMMENT = {
    ".py": "#", ".rb": "#", ".sh": "#", ".bash": "#", ".zsh": "#", ".pl": "#",
    ".yaml": "#", ".yml": "#", ".toml": "#", ".r": "#", ".jl": "#", ".ex": "#", ".exs": "#",
    ".js": "//", ".mjs": "//", ".cjs": "//", ".ts": "//", ".tsx": "//", ".jsx": "//",
    ".go": "//", ".rs": "//", ".java": "//", ".cs": "//", ".c": "//", ".h": "//",
    ".cpp": "//", ".hpp": "//", ".php": "//", ".kt": "//", ".swift": "//", ".scala": "//",
    ".dart": "//", ".sql": "--", ".lua": "--", ".hs": "--", ".sv": "//",
}
EXTS = PROSE_EXTS | set(LINE_COMMENT)
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv", "dist", "build", "target", "vendor", ".mypy_cache", ".pytest_cache"}


def iter_files(roots):
    for root in roots:
        if os.path.isfile(root):
            if os.path.splitext(root)[1].lower() in EXTS:
                yield root
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if os.path.splitext(name)[1].lower() in EXTS:
                    yield os.path.join(dirpath, name)


def _first_index(line, *needles):
    found = [line.index(x) for x in needles if x in line]
    return min(found) if found else -1


def commentish_lines(path, lines):
    """Yield (lineno, line, segment) where segment is the comment or docstring part of the line.

    Only the segment is matched against the patterns, so a trailing comment does not drag the executable part of the line into the scan -- otherwise `TMP_ROOT = "tmp/cache"  # note` would be reported for the code, not the comment. The block tracking (Python triple quotes, C-style /* */) is deliberately approximate; over-reporting a string literal that looks like a comment is cheap, since a human reads the output before rewriting anything.
    """
    ext = os.path.splitext(path)[1].lower()
    marker = LINE_COMMENT.get(ext)
    in_block = False
    block_end = None
    for n, line in enumerate(lines, 1):
        stripped = line.strip()
        if in_block:
            yield n, line, line
            if block_end in line:
                in_block = False
            continue
        if ext == ".py":
            i = _first_index(line, '"""', "'''")
            if i >= 0:
                q = line[i:i + 3]
                if line.count(q) == 1:
                    in_block, block_end = True, q
                yield n, line, line[i:]
                continue
        else:
            i = line.find("/*")
            if i >= 0:
                if "*/" not in line[i:]:
                    in_block, block_end = True, "*/"
                yield n, line, line[i:]
                continue
            if stripped.startswith("*"):
                yield n, line, line
                continue
        if marker:
            i = line.find(marker)
            if i >= 0:
                yield n, line, line[i:]


def load_config(path):
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    return {
        "roots": cfg.get("hygieneRoots"),
        "patterns": cfg.get("hygienePatterns"),
        "scratch_dirs": cfg.get("scratchDirs"),
        "ban_bare_hash_numbers": cfg.get("banBareHashNumbers"),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Flag references that only the author can follow.")
    ap.add_argument("--config", help="path to .claude/conformance.json; supplies roots/patterns/scratchDirs/banBareHashNumbers unless overridden by explicit flags")
    ap.add_argument("--roots", nargs="*", help="directories or files to scan (default: %s)" % " ".join(DEFAULT_ROOTS))
    ap.add_argument("--patterns", nargs="*", help="extra regex patterns to flag, ADDED to the defaults")
    ap.add_argument("--scratch-dirs", nargs="*", help="scratch directory names whose paths must not be referenced (default: %s)" % " ".join(DEFAULT_SCRATCH_DIRS))
    ap.add_argument("--ban-bare-hash-numbers", action="store_true", help='also flag bare "#123" references (for projects whose policy forbids them)')
    ap.add_argument("--all-lines", action="store_true", help="scan every line of source files, not just comments and docstrings")
    args = ap.parse_args(argv)

    cfg = {}
    if args.config:
        try:
            cfg = load_config(args.config)
        except (OSError, ValueError) as exc:
            print("Cannot read config %s: %s" % (args.config, exc), file=sys.stderr)
            return 2

    roots = args.roots or cfg.get("roots") or DEFAULT_ROOTS
    scratch = args.scratch_dirs or cfg.get("scratch_dirs") or DEFAULT_SCRATCH_DIRS
    ban_hash = args.ban_bare_hash_numbers or bool(cfg.get("ban_bare_hash_numbers"))

    patterns = list(DEFAULT_PATTERNS)
    patterns += [r"(?<![A-Za-z0-9_.-])%s[\\/][\w.-]" % re.escape(d) for d in scratch]
    patterns += list(args.patterns or cfg.get("patterns") or [])
    if ban_hash:
        patterns.append(BARE_HASH_PATTERN)

    existing = [r for r in roots if os.path.exists(r)]
    if not existing:
        print("No roots to scan (looked for: %s)." % ", ".join(roots))
        return 0

    # Compiled one by one rather than joined with "|": a caller-supplied pattern may carry a
    # leading global flag such as (?i), which is only legal at the start of its own expression.
    compiled = []
    for p in patterns:
        try:
            compiled.append(re.compile(p))
        except re.error as exc:
            print("Invalid pattern %r: %s" % (p, exc), file=sys.stderr)
            return 2

    def matches(line):
        return any(rx.search(line) for rx in compiled)

    hits = []
    for path in iter_files(existing):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        prose = os.path.splitext(path)[1].lower() in PROSE_EXTS
        if prose or args.all_lines:
            candidates = ((n, line, line) for n, line in enumerate(lines, 1))
        else:
            candidates = commentish_lines(path, lines)
        for n, line, segment in candidates:
            if matches(segment):
                hits.append((os.path.relpath(path), n, line.rstrip("\n")))

    if not hits:
        print("OK: no unfollowable references found in %s." % ", ".join(existing))
        return 0

    print("FOUND %d unfollowable reference(s) -- rewrite each as prose that states the reason itself:\n" % len(hits))
    for rel, n, text in hits:
        text = text.strip()
        if len(text) > 160:
            text = text[:160] + "..."
        print("%s:%d: %s" % (rel, n, text))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
