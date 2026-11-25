"""Run the sealed fabrication analyzer against the committed release controls."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

fixtures = Path(__file__).parent / "fixtures" / "preflight"


def analyze(kind, paths, policy=None):
    files = []
    for path in paths:
        data = path.read_bytes()
        files.append({"name": path.name, "sha256": hashlib.sha256(data).hexdigest(),
                      "base64": base64.b64encode(data).decode("ascii")})
    request = {"kind": kind, "files": files}
    if policy:
        request["supportPolicy"] = policy
    run = subprocess.run([os.environ.get("CONTAINER_ENGINE", "docker"), "run", "--rm", "-i",
                          "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,size=300m",
                          "--cap-drop=ALL", "--security-opt=no-new-privileges", sys.argv[1]],
                         input=json.dumps(request), capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError(run.stderr)
    return json.loads(run.stdout)


for part, status in (("flat", "pass"), ("cantilever", "fail"), ("bridge", "pass")):
    result = analyze("stl", [fixtures / "stl" / (part + ".stl")], "support-free")
    assert result["status"] == status, (part, result)
    assert result["estimate"]["filamentGrams"] > 0, result
    assert result["estimate"]["durationSeconds"] > 0, result
    print(part, result["status"], flush=True)
