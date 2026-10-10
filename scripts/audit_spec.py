#!/usr/bin/env python3
"""Audit the supplied specification in a temporary copy; never rewrite spec/.

Requires jsonschema and PyYAML. Put tsc on PATH for all 21 upstream checks.
This audits specification artifacts, not Atrium Grove product functionality.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command_version(name):
    executable = shutil.which(name)
    if not executable:
        return {"available": False}
    result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=30)
    realpath = Path(executable).resolve()
    return {"available": True, "path": str(realpath), "sha256": digest(realpath),
            "exitCode": result.returncode, "version": result.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/reports/spec-audit.json")
    args = parser.parse_args()
    spec = ROOT / "spec"
    checksums = []
    for line in (spec / "SHA256SUMS").read_text().splitlines():
        expected, filename = line.split("  ", 1)
        actual = digest(spec / filename)
        checksums.append({"file": filename, "expected": expected, "actual": actual,
                          "status": "PASS" if actual == expected else "FAIL"})
    merged = (spec / "PROJECT_SPEC.md").read_text()
    inclusion = {name: (spec / name).read_text().strip() in merged for name in
                 ["SPEC.md", "PROTOCOLS.md", "RESEARCH.md", "ACCEPTANCE.md", "IMPLEMENTATION_PLAN.md"]}
    schema = json.loads((spec / "contracts/domain.schema.json").read_text())
    tools = json.loads((spec / "contracts/tools.schema.json").read_text())
    api = yaml.safe_load((spec / "contracts/openapi.yaml").read_text())
    with tempfile.TemporaryDirectory(prefix="harbor-spec-audit-") as directory:
        copied = Path(directory) / "spec"
        shutil.copytree(spec, copied)
        result = subprocess.run([sys.executable, str(copied / "scripts/validate.py")],
                                capture_output=True, text=True, timeout=90)
        upstream = json.loads((copied / "validation-report.json").read_text())
        generation = []
        generated = ["contracts/domain.schema.json", "contracts/openapi.yaml", "contracts/tools.schema.json",
                     "examples/domain-fixtures.json", "examples/events.jsonl", "examples/tool-fixtures.json"]
        for script in ["generate_contracts.py", "generate_tools_examples.py"]:
            subprocess.run([sys.executable, str(copied / "scripts" / script)], check=True,
                           capture_output=True, text=True, timeout=30)
        for filename in generated:
            generation.append({"file": filename, "byteIdentical": (copied / filename).read_bytes() == (spec / filename).read_bytes()})
    validate = lambda name, obj: jsonschema.Draft202012Validator(
        {"$ref": "#/$defs/" + name, "$defs": schema["$defs"]}).is_valid(obj)
    # Observations expose behavioral coverage gaps, not product test failures.
    probes = {
        "snapshotHasRetentionFrontier": "retentionFrontier" in schema["$defs"]["Snapshot"]["properties"],
        "resolveApprovalAcceptsArgumentHash": validate("ResolveApproval", {
            "action": "approve", "expectedVersion": 1, "argumentHash": "a" * 64}),
        "schemaAcceptsEmptySteer": validate("RunControl", {"action": "steer", "text": "",
            "clientMessageId": "00000000-0000-0000-0000-000000000001"}),
        "schemaAcceptsInterruptWithText": validate("RunControl", {"action": "interrupt", "text": "unexpected",
            "clientMessageId": "00000000-0000-0000-0000-000000000001"}),
        "schemaAccepts64KChineseCharacters": validate("TextBlock", {"type": "text", "text": "中" * 65536}),
        "utf8BytesFor64KChineseCharacters": len(("中" * 65536).encode("utf-8")),
        "postMessageMaxTotalBlocks": schema["$defs"]["PostMessage"]["properties"]["blocks"]["maxItems"],
        "collabPostFields": list(tools["$defs"]["collab_post"]["properties"]),
        "agentTaskCreateCanSelectReviewer": "reviewerAgentId" in tools["$defs"]["task_create"]["properties"],
    }
    passed = (result.returncode == 0 and all(x["status"] == "PASS" for x in checksums)
              and all(inclusion.values()) and all(x["byteIdentical"] for x in generation)
              and all(x["status"] == "PASS" for x in upstream["checks"]))
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "Specification audit and local executable version discovery only; no native model calls or desktop actions.",
        "overall": "PASS" if passed else "INCOMPLETE_OR_FAILED",
        "environment": {"platform": platform.system(), "architecture": platform.machine(),
                        "python": sys.version.split()[0],
                        "executables": {name: command_version(name) for name in ["node", "pnpm", "tsc", "codex", "claude"]}},
        "checksumVerification": checksums, "mergedDocumentParity": inclusion,
        "upstreamValidation": upstream,
        "validationExecution": {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr},
        "generatorReproducibility": generation, "contractObservations": probes,
        "counts": {"domainDefinitions": len(schema["$defs"]), "httpOperations": sum(len(x) for x in api["paths"].values()),
                   "publicEventTypes": len(schema["$defs"]["Event"]["properties"]["type"]["enum"]), "agentTools": len(tools["$defs"])},
        "qualification": {key: "NOT_RUN" for key in ["Q0", "Q1", "Q2", "Q3", "Q4"]},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"overall": report["overall"], "output": str(args.output), "counts": report["counts"],
                      "observations": probes}, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
