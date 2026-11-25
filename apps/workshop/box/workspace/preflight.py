"""Analyze sealed artifact bytes supplied on stdin by the job runner."""
import base64
import hashlib
import json
import sys
import tempfile
from pathlib import Path

from cantilever import review as review_stl


def analyze(request):
    files = request["files"]
    if not 1 <= len(files) <= 50:
        raise ValueError("Expected 1 to 50 files")
    receipts = {}
    total = 0
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        for file in files:
            name = file["name"]
            if Path(name).name != name or name in ("", ".", "..") or name in receipts:
                raise ValueError("Invalid or repeated filename")
            data = base64.b64decode(file["base64"], validate=True)
            total += len(data)
            if total > 30_000_000:
                raise ValueError("Exceeded project byte limit")
            digest = hashlib.sha256(data).hexdigest()
            if digest != file["sha256"]:
                raise ValueError("Input differs from its saved receipt")
            receipts[name] = digest
            (directory / name).write_bytes(data)
        if request["kind"] == "stl" and len(files) == 1:
            return review_stl(data, digest, request.get("supportPolicy"))
        raise ValueError("Unsupported preflight inputs")


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(41_000_001)
    if len(raw) > 41_000_000:
        raise ValueError("Exceeded request byte limit")
    print(json.dumps(analyze(json.loads(raw))))
