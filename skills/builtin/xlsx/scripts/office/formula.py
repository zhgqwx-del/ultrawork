#!/usr/bin/env python3
"""Reading formulas: which cells does this one depend on, and is that legal?

One parser serves both directions, which is the reason X3/X5/X10 landed together:

    writing  — refuse `=汇总!B5` when there is no sheet called 汇总, because that
               is precisely how a #REF! is born, and it is born SILENTLY: openpyxl
               stores the string happily and the workbook only breaks when Excel
               opens it
    auditing — find the #REF!s already there, name the reference that caused each
               one, and find circular chains nothing else in this stack looks for

This is a REFERENCE parser, not an expression evaluator. It answers "what does this
formula point at"; it does not compute anything. Keeping it to that is deliberate —
the moment it starts evaluating, every wrong answer becomes a confident wrong number.
"""
from __future__ import annotations

import re

# Error tokens carry a `!` of their own and must be removed before anything looks
# for `Sheet!A1`, or `=#REF!*2` reads as a reference to a sheet named "#REF".
ERROR_TOKENS = ("#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NULL!", "#NUM!",
                "#SPILL!", "#CALC!", "#GETTING_DATA")

STRING_LITERAL = re.compile(r'"(?:[^"]|"")*"')

# 'Sheet Name'!A1  |  SheetName!A1  |  A1 — optionally a range, optionally absolute.
# The sheet part accepts anything but a quote inside quotes, and word characters
# (which include CJK under re.UNICODE) outside them.
REFERENCE = re.compile(
    r"(?:(?P<sheet>'(?:[^']|'')+'|[^\s!,+\-*/()^&<>=:;\"]+)!)?"
    r"(?P<col1>\$?[A-Za-z]{1,3})(?P<row1>\$?[1-9][0-9]*)"
    r"(?::(?P<col2>\$?[A-Za-z]{1,3})(?P<row2>\$?[1-9][0-9]*))?"
)

# A cap so one pathological range cannot expand into millions of graph edges. Any
# truncation is REPORTED, never silent — a dependency graph that quietly stopped
# growing would report "no cycles" for a workbook full of them.
MAX_RANGE_CELLS = 20_000


def strip_noise(formula: str) -> str:
    """Remove string literals and error tokens so references can be found safely."""
    probe = STRING_LITERAL.sub(" ", formula)
    for tok in ERROR_TOKENS:
        probe = probe.replace(tok, " ")
    return probe


def error_tokens_in(text: str) -> list[str]:
    """Error tokens present in a formula or a cached value, in first-seen order."""
    found: list[str] = []
    for tok in ERROR_TOKENS:
        if tok in text and tok not in found:
            found.append(tok)
    return found


def col_to_index(letters: str) -> int:
    n = 0
    for ch in letters.replace("$", "").upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def index_to_col(index: int) -> str:
    out = ""
    while index > 0:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def unquote_sheet(name: str | None) -> str | None:
    if name is None:
        return None
    if name.startswith("'") and name.endswith("'"):
        return name[1:-1].replace("''", "'")
    return name


def quote_sheet(name: str) -> str:
    """Formula-safe sheet name: quoted when it has to be.

    A name with a space, or one that starts with a digit, is a syntax error unquoted
    — and the failure shows up as a corrupt workbook, not as an exception here.
    """
    safe = re.fullmatch(r"[A-Za-z_一-鿿][\w一-鿿.]*", name or "")
    if safe and not re.fullmatch(r"[A-Za-z]{1,3}[0-9]+", name):
        return name
    return "'" + (name or "").replace("'", "''") + "'"


class Reference:
    __slots__ = ("sheet", "col1", "row1", "col2", "row2", "text")

    def __init__(self, sheet, col1, row1, col2, row2, text):
        self.sheet = sheet
        self.col1, self.row1 = col1, row1
        self.col2, self.row2 = col2, row2
        self.text = text

    @property
    def is_range(self) -> bool:
        return (self.col1, self.row1) != (self.col2, self.row2)

    @property
    def cell_count(self) -> int:
        return (self.col2 - self.col1 + 1) * (self.row2 - self.row1 + 1)

    def cells(self, limit: int = MAX_RANGE_CELLS):
        for c in range(self.col1, self.col2 + 1):
            for r in range(self.row1, self.row2 + 1):
                if limit <= 0:
                    return
                limit -= 1
                yield f"{index_to_col(c)}{r}"

    def __repr__(self) -> str:
        return f"<Reference {self.text}>"


def references(formula: str) -> list[Reference]:
    """Every cell or range this formula points at.

    A match immediately followed by `(` is a FUNCTION, not a reference: `LOG10(A1)`
    otherwise reads as a reference to cell LOG10, which pollutes the dependency
    graph and — in a workbook that happens to have a formula in cell LOG10 — can
    invent a circular reference that is not there.
    """
    out: list[Reference] = []
    probe = strip_noise(formula.lstrip("="))
    for m in REFERENCE.finditer(probe):
        if probe[m.end():m.end() + 1] == "(":
            continue
        c1, r1 = col_to_index(m.group("col1")), int(m.group("row1").replace("$", ""))
        if m.group("col2"):
            c2 = col_to_index(m.group("col2"))
            r2 = int(m.group("row2").replace("$", ""))
        else:
            c2, r2 = c1, r1
        out.append(Reference(unquote_sheet(m.group("sheet")),
                             min(c1, c2), min(r1, r2), max(c1, c2), max(r1, r2),
                             m.group(0)))
    return out


def missing_sheets(formula: str, known: set[str]) -> list[str]:
    """Sheet names this formula points at that the workbook does not have.

    Case-insensitive, because Excel's sheet names are.
    """
    lowered = {k.lower() for k in known}
    seen: list[str] = []
    for ref in references(formula):
        if ref.sheet and ref.sheet.lower() not in lowered and ref.sheet not in seen:
            seen.append(ref.sheet)
    return seen


# ── dependency graph ──────────────────────────────────────────────────────────
def build_graph(sheets: dict[str, dict[str, str]]) -> tuple[dict, dict]:
    """`{sheet: {ref: formula}}` -> (graph, stats).

    Nodes are "Sheet!A1". Edges point from a cell to each cell it reads.
    """
    graph: dict[str, set[str]] = {}
    truncated: list[str] = []
    for sheet, cells in sheets.items():
        for ref, formula in cells.items():
            node = f"{sheet}!{ref}"
            deps: set[str] = set()
            for r in references(formula):
                target_sheet = r.sheet or sheet
                if r.cell_count > MAX_RANGE_CELLS:
                    truncated.append(f"{node} reads {r.text} "
                                     f"({r.cell_count} cells, capped at "
                                     f"{MAX_RANGE_CELLS})")
                for cell in r.cells():
                    deps.add(f"{target_sheet}!{cell}")
            graph[node] = deps
    return graph, {"nodes": len(graph), "truncated": truncated}


def find_cycles(graph: dict[str, set[str]], limit: int = 50) -> list[list[str]]:
    """Circular reference chains, as node lists ending back at their start.

    Iterative rather than recursive on purpose: a long dependency chain in a real
    workbook will blow the interpreter's stack, and "the auditor crashed" is a worse
    answer than any finding it could have produced.
    """
    cycles: list[list[str]] = []
    colour: dict[str, int] = {}          # 0 = in progress, 1 = done
    for root in graph:
        if colour.get(root):
            continue
        stack = [(root, iter(graph.get(root, ())))]
        path = [root]
        on_path = {root}
        colour[root] = 0
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                if nxt not in graph:      # a plain value, not a formula: a leaf
                    continue
                if nxt in on_path:
                    cycle = path[path.index(nxt):] + [nxt]
                    if cycle not in cycles:
                        cycles.append(cycle)
                        if len(cycles) >= limit:
                            return cycles
                    continue
                if colour.get(nxt) == 1:
                    continue
                colour[nxt] = 0
                stack.append((nxt, iter(graph.get(nxt, ()))))
                path.append(nxt)
                on_path.add(nxt)
                advanced = True
                break
            if not advanced:
                colour[node] = 1
                stack.pop()
                on_path.discard(path.pop())
    return cycles
