#!/usr/bin/env python3
"""Secrets scan of the whole git history (goal 10).

gitleaks/trufflehog binaries cannot be downloaded in the build environment, so this scans every
unique blob reachable from any ref with detect-secrets (PyPI) plus a set of high-signal regexes.
Reviewed findings (dev-only test values) are listed with their reason in
docs/security/secrets-allowlist.json, keyed by the SHA-256 of the matched secret, so the allowlist
itself never contains a secret. Exit code 1 when an unreviewed finding exists.

Usage: python3 scripts/security/secrets-history.py [--json out.json]
Needs: `pip install detect-secrets`.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST = ROOT / "docs/security/secrets-allowlist.json"
SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".xlsx", ".pdf", ".webp")
SKIP_NAMES = ("pnpm-lock.yaml", "secrets-allowlist.json")  # integrity hashes / fingerprints, not secrets

REGEXES = {
    "private_key_pem": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "jwk_private_d": re.compile(r'"d"\s*:\s*"([A-Za-z0-9_-]{40,})"'),
    "anthropic_key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "openai_key": re.compile(r"\bsk-[A-Za-z0-9]{32,}\b"),
    "github_token": re.compile(r"\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}"),
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "slack_token": re.compile(r"\bxox[abpors]-[A-Za-z0-9-]{10,}"),
    "db_url_password": re.compile(r"postgres(?:ql)?://[^:\s/]+:([^@\s]{6,})@"),
}


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True).stdout


def blobs() -> dict[str, str]:
    """sha -> first path seen, for every blob in the history of every ref."""
    out: dict[str, str] = {}
    for line in git("rev-list", "--all", "--objects").decode().splitlines():
        parts = line.split(" ", 1)
        if len(parts) == 2 and parts[0] not in out:
            out[parts[0]] = parts[1]
    proc = subprocess.run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=ROOT, input="\n".join(out).encode(), capture_output=True, check=True,
    )
    kinds = dict(l.split(" ") for l in proc.stdout.decode().splitlines())
    return {s: p for s, p in out.items() if kinds.get(s) == "blob"}


def fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def main() -> int:
    allow = json.loads(ALLOWLIST.read_text()) if ALLOWLIST.exists() else {"entries": []}
    allowed = {e["sha256"]: e for e in allow["entries"]}
    found: list[dict[str, str]] = []
    all_blobs = blobs()
    with tempfile.TemporaryDirectory() as tmp:
        files: dict[str, tuple[str, str]] = {}
        for sha, path in all_blobs.items():
            if path.endswith(SKIP_SUFFIX) or Path(path).name in SKIP_NAMES or path.startswith("design/"):
                continue
            data = git("cat-file", "-p", sha)
            if b"\0" in data[:8000]:
                continue
            f = Path(tmp) / sha
            f.write_bytes(data)
            files[str(f)] = (sha, path)
            text = data.decode("utf-8", "replace")
            for name, rx in REGEXES.items():
                for m in rx.finditer(text):
                    secret = m.group(1) if m.groups() else m.group(0)
                    found.append({"detector": name, "path": path, "blob": sha, "sha256": fingerprint(secret)})
        # detect-secrets with its default plugins (entropy + keyword + vendor patterns)
        proc = subprocess.run(
            [sys.executable, "-m", "detect_secrets", "scan", "--all-files", tmp],
            capture_output=True, check=True, cwd=tmp,
        )
        report = json.loads(proc.stdout)
        for fname, items in report["results"].items():
            sha, path = files.get(str(Path(tmp) / Path(fname).name), ("?", fname))
            for it in items:
                found.append({"detector": "detect-secrets:" + it["type"], "path": path, "blob": sha,
                              "sha256": it["hashed_secret"]})
    # detect-secrets hashes with SHA-1; regex findings with SHA-256: the allowlist accepts either key.
    unreviewed = [f for f in found if f["sha256"] not in allowed]
    summary = {
        "blobs_scanned": len(all_blobs),
        "findings": len(found),
        "reviewed": len(found) - len(unreviewed),
        "unreviewed": unreviewed,
    }
    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps({**summary, "all": found}, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "unreviewed"}))
    for f in unreviewed:
        print(f"UNREVIEWED {f['detector']} {f['path']} blob={f['blob'][:10]} fp={f['sha256'][:16]}")
    return 1 if unreviewed else 0


if __name__ == "__main__":
    sys.exit(main())
