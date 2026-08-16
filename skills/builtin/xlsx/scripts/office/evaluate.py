#!/usr/bin/env python3
"""A small, deliberately incomplete Excel formula evaluator.

Its job is NOT to be a spreadsheet engine. It exists for two things (059 §7):

  1. a fallback when LibreOffice is missing, times out, or fails
  2. a SECOND OPINION — two independent engines computing the same formula, and any
     disagreement is reported rather than resolved

The second is the reason it may be small. A cross-check only has value if it can be
wrong loudly, so the one behaviour this module must never have is a confident wrong
answer. Every construct it does not implement raises `Unsupported`, which the caller
turns into "not evaluated, here is the formula text" — never into a number.

    SUPPORTED is not a wish list. Every name in it is measured against LibreOffice
    by scripts/test-xlsx-skill.py on a calibration corpus; a function that has not
    been shown to agree does not belong there, and one that stops agreeing turns
    the gate red.

Known and accepted non-goals, so nobody has to discover them: no array formulas,
no volatile functions (TODAY/NOW/RAND — a cross-check against a moving value is
meaningless), no date arithmetic, no lookup family (VLOOKUP/INDEX/MATCH), no
wildcards in criteria, no defined names, no external workbook links.
"""
from __future__ import annotations

import math
import re

from .formula import index_to_col, references


class Unsupported(Exception):
    """This formula uses something the evaluator does not implement."""


class ExcelError(Exception):
    """An Excel error VALUE (#DIV/0! etc). A result, not a failure of the engine."""

    def __init__(self, token: str):
        super().__init__(token)
        self.token = token


# ── tokenizer ─────────────────────────────────────────────────────────────────
TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<string>"(?:[^"]|"")*")
  | (?P<error>\#REF!|\#DIV/0!|\#VALUE!|\#N/A|\#NAME\?|\#NULL!|\#NUM!)
  | (?P<ref>(?:'(?:[^']|'')+'|[A-Za-z_一-鿿][\w.一-鿿]*)!
        \$?[A-Za-z]{1,3}\$?[0-9]+(?::\$?[A-Za-z]{1,3}\$?[0-9]+)?
      | \$?[A-Za-z]{1,3}\$?[0-9]+(?::\$?[A-Za-z]{1,3}\$?[0-9]+)?(?![\w(]))
  | (?P<func>[A-Za-z][A-Za-z0-9_.]*)\s*(?=\()
  | (?P<name>[A-Za-z_一-鿿][\w.一-鿿]*)
  | (?P<number>[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+)
  | (?P<op><=|>=|<>|[-+*/^&%<>=])
  | (?P<lparen>\()
  | (?P<rparen>\))
  | (?P<comma>[,;])
  | (?P<other>.)
""", re.VERBOSE)


def tokenize(src: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    while pos < len(src):
        m = TOKEN.match(src, pos)
        if not m or m.end() == pos:
            raise Unsupported(f"cannot read {src[pos:pos + 12]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "ws":
            continue
        if kind == "other":
            raise Unsupported(f"unexpected {m.group(0)!r}")
        out.append((kind, m.group(0)))
    return out


# ── values ────────────────────────────────────────────────────────────────────
def as_number(v):
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if v is None or v == "":
        return 0.0
    if isinstance(v, ExcelError):
        raise v
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            raise ExcelError("#VALUE!") from None
    raise ExcelError("#VALUE!")


def as_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def truthy(v) -> bool:
    if isinstance(v, bool):
        return v
    if v is None or v == "":
        return False
    if isinstance(v, str):
        if v.upper() == "TRUE":
            return True
        if v.upper() == "FALSE":
            return False
        raise ExcelError("#VALUE!")
    return as_number(v) != 0


def _numbers(args) -> list[float]:
    """Flatten arguments to numbers the way an aggregate does.

    Text inside a RANGE is skipped; text passed DIRECTLY is refused. Those two are
    not the same in Excel and the difference is not intuitive — measured against
    LibreOffice, `AVERAGE(1,"x",2)` is #VALUE! while the same "x" sitting in a range
    is simply ignored, and `COUNT(1,"2","x")` is 2 because a direct numeric-looking
    string counts. Rather than reproduce those rules from memory, this refuses the
    direct-text case outright: an Unsupported is recoverable, a wrong average is not.
    """
    out: list[float] = []
    for a in args:
        if isinstance(a, list):
            for v in a:
                if isinstance(v, ExcelError):
                    raise v
                if v is None or v == "" or isinstance(v, str) or isinstance(v, bool):
                    continue      # ranges skip text and logicals
                out.append(as_number(v))
            continue
        if isinstance(a, ExcelError):
            raise a
        if a is None:
            continue
        if isinstance(a, str):
            raise Unsupported(
                "a text value passed directly to an aggregate — Excel coerces direct "
                "arguments differently from range contents, and those rules are not "
                "implemented here")
        out.append(as_number(a))
    return out


def _flat(args) -> list:
    out = []
    for a in args:
        out.extend(a if isinstance(a, list) else [a])
    return out


def _one(args, name):
    flat = _flat(args)
    if len(flat) != 1:
        raise Unsupported(f"{name} over a range")
    return flat[0]


def _round(x, digits):
    # Excel rounds half AWAY FROM ZERO; Python's round() is banker's rounding, so
    # ROUND(2.5,0) would come out 2 instead of 3 and the cross-check would blame
    # LibreOffice for being right.
    factor = 10 ** int(digits)
    scaled = x * factor
    return math.floor(scaled + 0.5) / factor if scaled >= 0 \
        else math.ceil(scaled - 0.5) / factor


def _div(a, b):
    if b == 0:
        raise ExcelError("#DIV/0!")
    return a / b


FUNCTIONS = {
    "SUM": lambda a: sum(_numbers(a)),
    "PRODUCT": lambda a: math.prod(_numbers(a)) if _numbers(a) else 0.0,
    "AVERAGE": lambda a: (lambda n: sum(n) / len(n) if n else _err("#DIV/0!"))(_numbers(a)),
    "MIN": lambda a: (lambda n: min(n) if n else 0.0)(_numbers(a)),
    "MAX": lambda a: (lambda n: max(n) if n else 0.0)(_numbers(a)),
    "COUNT": lambda a: float(len(_numbers(a))),
    "COUNTA": lambda a: float(sum(1 for v in _flat(a) if v is not None and v != "")),
    "ABS": lambda a: abs(as_number(_one(a, "ABS"))),
    "INT": lambda a: float(math.floor(as_number(_one(a, "INT")))),
    # SQRT of a negative is the one place the two references disagree: Excel answers
    # #NUM!, LibreOffice answers #VALUE!. Measured, not assumed. With no authority to
    # follow, the engine declines rather than asserting a token that half the world
    # calls wrong — an Unsupported is recoverable, a wrong error code is a lie.
    "SQRT": lambda a: (lambda x: math.sqrt(x) if x >= 0 else _unsupported(
        "SQRT of a negative number: Excel says #NUM!, LibreOffice says #VALUE!"))(
        as_number(_one(a, "SQRT"))),
    "ROUND": lambda a: _round(as_number(_flat(a)[0]), as_number(_flat(a)[1])),
    "ROUNDUP": lambda a: (lambda x, d: math.ceil(x * 10 ** int(d)) / 10 ** int(d)
                          if x >= 0 else math.floor(x * 10 ** int(d)) / 10 ** int(d))(
        as_number(_flat(a)[0]), as_number(_flat(a)[1])),
    "ROUNDDOWN": lambda a: (lambda x, d: math.floor(x * 10 ** int(d)) / 10 ** int(d)
                            if x >= 0 else math.ceil(x * 10 ** int(d)) / 10 ** int(d))(
        as_number(_flat(a)[0]), as_number(_flat(a)[1])),
    "POWER": lambda a: as_number(_flat(a)[0]) ** as_number(_flat(a)[1]),
    # Excel's MOD takes the sign of the DIVISOR (MOD(-7,3) is 2, measured against
    # LibreOffice), which is Python's `%` — not math.fmod, which takes the sign of
    # the dividend and would answer -1.
    "MOD": lambda a: (lambda x, y: (x - y * math.floor(x / y)) if y else _err("#DIV/0!"))(
        as_number(_flat(a)[0]), as_number(_flat(a)[1])),
    "IF": lambda a: (_flat(a)[1] if len(_flat(a)) > 1 else True) if truthy(_flat(a)[0])
    else (_flat(a)[2] if len(_flat(a)) > 2 else False),
    "AND": lambda a: all(truthy(v) for v in _flat(a) if v not in (None, "")),
    "OR": lambda a: any(truthy(v) for v in _flat(a) if v not in (None, "")),
    "NOT": lambda a: not truthy(_one(a, "NOT")),
    "LEN": lambda a: float(len(as_text(_one(a, "LEN")))),
    "UPPER": lambda a: as_text(_one(a, "UPPER")).upper(),
    "LOWER": lambda a: as_text(_one(a, "LOWER")).lower(),
    "TRIM": lambda a: " ".join(as_text(_one(a, "TRIM")).split()),
    "LEFT": lambda a: (lambda f: as_text(f[0])[:int(as_number(f[1])) if len(f) > 1 else 1])(
        _flat(a)),
    "RIGHT": lambda a: (lambda f: as_text(f[0])[-(int(as_number(f[1])) if len(f) > 1
                                                  else 1):])(_flat(a)),
    "MID": lambda a: (lambda f: as_text(f[0])[int(as_number(f[1])) - 1:
                                              int(as_number(f[1])) - 1
                                              + int(as_number(f[2]))])(_flat(a)),
    "CONCATENATE": lambda a: "".join(as_text(v) for v in _flat(a)),
}


def _err(token: str):
    raise ExcelError(token)


def _unsupported(why: str):
    raise Unsupported(why)


# IFERROR needs the raw argument thunks, not evaluated values, so it is handled in
# the parser rather than in the table above.
LAZY = {"IFERROR"}
SUPPORTED = frozenset(FUNCTIONS) | LAZY


# ── parser (recursive descent, Excel precedence) ──────────────────────────────
class Parser:
    def __init__(self, tokens, resolve):
        self.t = tokens
        self.i = 0
        self.resolve = resolve

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expect(self, kind):
        k, v = self.take()
        if k != kind:
            raise Unsupported(f"expected {kind}, got {v!r}")
        return v

    def parse(self):
        v = self.comparison()
        if self.i != len(self.t):
            raise Unsupported(f"trailing {self.peek()[1]!r}")
        return v

    def comparison(self):
        left = self.concat()
        while self.peek()[0] == "op" and self.peek()[1] in ("=", "<>", "<", ">", "<=", ">="):
            op = self.take()[1]
            right = self.concat()
            left = self._compare(op, left, right)
        return left

    @staticmethod
    def _compare(op, a, b):
        if isinstance(a, str) or isinstance(b, str):
            x, y = as_text(a).upper(), as_text(b).upper()
        else:
            x, y = as_number(a), as_number(b)
        return {"=": x == y, "<>": x != y, "<": x < y, ">": x > y,
                "<=": x <= y, ">=": x >= y}[op]

    def concat(self):
        left = self.additive()
        while self.peek()[0] == "op" and self.peek()[1] == "&":
            self.take()
            left = as_text(left) + as_text(self.additive())
        return left

    def additive(self):
        left = self.multiplicative()
        while self.peek()[0] == "op" and self.peek()[1] in ("+", "-"):
            op = self.take()[1]
            right = self.multiplicative()
            left = as_number(left) + as_number(right) if op == "+" \
                else as_number(left) - as_number(right)
        return left

    def multiplicative(self):
        left = self.power()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "/"):
            op = self.take()[1]
            right = self.power()
            left = as_number(left) * as_number(right) if op == "*" \
                else _div(as_number(left), as_number(right))
        return left

    # Excel's precedence, highest first: unary minus, then %, then ^. Both halves are
    # counter-intuitive and both were measured against LibreOffice rather than
    # assumed — the first draft of this parser used the usual programming-language
    # rules and answered -4 for `-2^2` (Excel: 4) and 512 for `2^3^2` (Excel: 64).
    # `^` is LEFT-associative here, unlike almost every other language.
    def power(self):
        left = self.percent()
        while self.peek()[0] == "op" and self.peek()[1] == "^":
            self.take()
            left = as_number(left) ** as_number(self.percent())
        return left

    def percent(self):
        v = self.unary()
        while self.peek()[0] == "op" and self.peek()[1] == "%":
            self.take()
            v = as_number(v) / 100.0
        return v

    def unary(self):
        if self.peek()[0] == "op" and self.peek()[1] in ("-", "+"):
            op = self.take()[1]
            v = self.unary()
            return -as_number(v) if op == "-" else as_number(v)
        return self.atom()

    def atom(self):
        kind, value = self.take()
        if kind == "number":
            return float(value)
        if kind == "string":
            return value[1:-1].replace('""', '"')
        if kind == "error":
            raise ExcelError(value)
        if kind == "lparen":
            v = self.comparison()
            self.expect("rparen")
            return v
        if kind == "ref":
            return self.resolve(value)
        if kind == "func":
            return self.call(value.upper())
        if kind == "name":
            upper = value.upper()
            if upper in ("TRUE", "FALSE"):
                return upper == "TRUE"
            # A defined name, a table reference, or a function this tokenizer did
            # not see as a call. Refusing beats guessing which.
            raise Unsupported(f"name {value!r} (defined names are not resolved)")
        if kind == "op" and value == "-":
            return -as_number(self.unary())
        raise Unsupported(f"cannot evaluate {value!r}")

    def call(self, name):
        self.expect("lparen")
        # Argument SPANS are captured before evaluation so IFERROR can decline to
        # evaluate the branch it does not need — and so a #DIV/0! in the guarded
        # expression is caught rather than propagating out of the whole formula.
        spans = []
        depth = 0
        start = self.i
        while True:
            kind, value = self.peek()
            if kind is None:
                raise Unsupported("unbalanced parentheses")
            if kind == "lparen":
                depth += 1
            elif kind == "rparen":
                if depth == 0:
                    spans.append((start, self.i))
                    self.take()
                    break
                depth -= 1
            elif kind == "comma" and depth == 0:
                spans.append((start, self.i))
                self.take()
                start = self.i
                continue
            self.take()
        if name not in SUPPORTED:
            raise Unsupported(f"function {name}")
        # `SUM()` is a call with no arguments; `IF(TRUE,,5)` has three, the middle
        # one blank (LibreOffice answers 0 for it). One empty span means the former,
        # an empty span among several means the latter.
        if len(spans) == 1 and spans[0][0] == spans[0][1]:
            spans = []

        def run(span):
            if span[0] == span[1]:
                return None       # a blank argument, which is Excel's empty cell
            sub = Parser(self.t[span[0]:span[1]], self.resolve)
            return sub.parse()

        if name == "IFERROR":
            if len(spans) != 2:
                raise Unsupported("IFERROR with other than 2 arguments")
            try:
                v = run(spans[0])
                if isinstance(v, ExcelError):
                    raise v
                return v
            except ExcelError:
                return run(spans[1])
        args = [run(s) for s in spans]
        return FUNCTIONS[name](args)


# ── the sheet-aware driver ────────────────────────────────────────────────────
class Evaluator:
    """Evaluates a whole workbook's formulas in dependency order.

    `cells` is {sheet: {ref: value_or_formula}}, exactly what openpyxl hands back.
    """

    def __init__(self, cells: dict[str, dict[str, object]], default_sheet: str):
        self.cells = cells
        self.default = default_sheet
        self.done: dict[str, object] = {}
        self.busy: set[str] = set()

    def _key(self, sheet: str, ref: str) -> str:
        return f"{sheet}!{ref.replace('$', '').upper()}"

    def value_of(self, sheet: str, ref: str):
        key = self._key(sheet, ref)
        if key in self.done:
            return self.done[key]
        if key in self.busy:
            # Excel's own answer to a circular chain is a warning and 0; this
            # refuses instead, because a 0 that means "we gave up" is
            # indistinguishable from a 0 that means zero.
            raise Unsupported(f"circular reference through {key}")
        raw = (self.cells.get(sheet) or {}).get(ref.replace("$", "").upper())
        if not (isinstance(raw, str) and raw.startswith("=")):
            self.done[key] = raw
            return raw
        self.busy.add(key)
        try:
            v = self.evaluate(raw, sheet)
        finally:
            self.busy.discard(key)
        self.done[key] = v
        return v

    def _resolve(self, sheet: str):
        def resolve(text: str):
            refs = references("=" + text)
            if not refs:
                raise Unsupported(f"reference {text!r}")
            r = refs[0]
            target = r.sheet or sheet
            if target not in self.cells:
                raise ExcelError("#REF!")
            if not r.is_range:
                return self.value_of(target, f"{index_to_col(r.col1)}{r.row1}")
            return [self.value_of(target, cell) for cell in r.cells()]
        return resolve

    def evaluate(self, formula: str, sheet: str | None = None):
        sheet = sheet or self.default
        body = formula[1:] if formula.startswith("=") else formula
        value = Parser(tokenize(body), self._resolve(sheet)).parse()
        if isinstance(value, list):
            # A bare range as the whole result is implicit intersection or a spill,
            # neither of which is implemented. Returning the list would hand the
            # caller something no cell can hold.
            raise Unsupported("a range as the whole result (implicit intersection "
                              "or a spilled array)")
        return value
