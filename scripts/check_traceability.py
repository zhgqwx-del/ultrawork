"""Check requirement and acceptance-scenario IDs in published specs."""

import re
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent
HEADING = re.compile(r"^###\s+((?:REQ|AC)-\S+)")
REQUIREMENT = r"REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]+"
IDENTIFIER = re.compile(r"(?:REQ|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]+")
RELATION = re.compile(r"^关联(?:\s|[：:])")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def spec_lines(path):
    fence = None
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        marker = FENCE.match(line)
        if fence is not None:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            continue
        if marker:
            fence = marker[1]
            continue
        yield number, line


def main() -> int:
    specs = sorted((ROOT / "specs").rglob("spec.md"))
    locations = {}
    scenarios = {}
    errors = []
    for path in specs:
        current = None
        has_headings = False
        for number, line in spec_lines(path):
            if re.match(r"^#{1,3}\s", line):
                current = None
            match = HEADING.match(line)
            if match:
                has_headings = True
                identifier = match[1]
                location = f"{path.relative_to(ROOT)}:{number}"
                if not IDENTIFIER.fullmatch(identifier):
                    errors.append(f"{location}: invalid ID {identifier}")
                elif identifier in locations:
                    errors.append(f"{location}: duplicate {identifier}, first defined at {locations[identifier]}")
                else:
                    locations[identifier] = location
                    if identifier.startswith("AC-"):
                        current = identifier
                        scenarios[current] = set()
            elif current is not None and RELATION.match(line):
                scenarios[current].update(re.findall(rf"(?<![\w-]){REQUIREMENT}(?![\w-])", line))
        if not has_headings:
            errors.append(f"{path.relative_to(ROOT)}: no REQ or AC headings")

    requirements = {identifier for identifier in locations if identifier.startswith("REQ-")}
    covered = set()
    for scenario, related in scenarios.items():
        if not related:
            errors.append(f"{locations[scenario]}: {scenario} needs a 关联 line with a requirement ID")
        for unknown in sorted(related - requirements):
            errors.append(f"{locations[scenario]}: {scenario} references unknown {unknown}")
        covered.update(related & requirements)
    for missing in sorted(requirements - covered):
        errors.append(f"{locations[missing]}: {missing} has no acceptance scenario")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Traceability checked: {len(specs)} specs, {len(requirements)} requirements, {len(scenarios)} scenarios")
    return 0


if __name__ == "__main__":
    sys.exit(main())
