"""Measure excess slice area on a bed-oriented STL in millimetres."""
import argparse
import hashlib
import io
import json
import re
import subprocess
from importlib.metadata import version
import tempfile
from pathlib import Path

import manifold3d
import numpy as np
import trimesh


PROFILE = Path(__file__).with_name("fdm-asa.ini")


def slice_model(data):
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "model.stl"
        output = Path(directory) / "toolpath.gcode"
        source.write_bytes(data)
        subprocess.run(["prusa-slicer", "--load", str(PROFILE), "--export-gcode",
                        "--output", str(output), str(source)], check=True,
                       capture_output=True, timeout=180)
        heights = set()
        role, z = "", None
        perimeters = False
        filament_grams, duration_seconds = None, None
        absolute_e, extrusion = True, 0.0
        with output.open() as lines:
            for line in lines:
                if line.startswith("; filament used [g] ="):
                    filament_grams = float(line.partition("=")[2].strip())
                elif line.startswith("; estimated printing time (normal mode) ="):
                    duration = line.partition("=")[2]
                    duration_seconds = sum(int(value) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
                                           for value, unit in re.findall(r"(\d+)([dhms])", duration))
                elif line.startswith(";Z:"):
                    z = float(line[3:])
                elif line.startswith(";TYPE:"):
                    role = line[6:].strip()
                else:
                    command = line.partition(";")[0].split()
                    if not command:
                        continue
                    op = command[0]
                    if op in ("M82", "M83"):
                        absolute_e = op == "M82"
                    elif op in ("G0", "G1", "G92"):
                        coords = {word[0]: float(word[1:]) for word in command[1:]
                                  if word and word[0] in "EXY"}
                        if "E" not in coords:
                            continue
                        if op == "G92":
                            extrusion = coords["E"]
                            continue
                        delta = coords["E"] - extrusion if absolute_e else coords["E"]
                        extrusion += delta
                        if delta <= 0 or z is None or ("X" not in coords and "Y" not in coords):
                            continue
                        if role.startswith("Support material"):
                            heights.add(z)
                        elif role in ("External perimeter", "Perimeter"):
                            perimeters = True
        if not perimeters:
            raise ValueError("Slicer produced no perimeter deposition")
        return sorted(heights), filament_grams, duration_seconds


def review(data, expected_sha256, support_policy):
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256:
        raise ValueError("STL bytes differ from the artifact receipt")
    result = dict(sha256=digest, tool="workshop-cantilever-v2", profile_sha256=hashlib.sha256(PROFILE.read_bytes()).hexdigest(), units="mm",
                  orientation="as supplied, Z up, translated to bed",
                  layer_mm=0.2, max_overhang_degrees=45, min_area_mm2=0.01,
                  support_policy=support_policy)
    if support_policy not in (None, "support-free", "supports-required"):
        raise ValueError("Unknown support policy")
    result["analyzers"] = {tool: version(tool) for tool in ("trimesh", "manifold3d")}
    result["analyzers"]["prusa-slicer"] = subprocess.check_output(
        ["prusa-slicer", "--help"], text=True).splitlines()[0]
    mesh = trimesh.load_mesh(io.BytesIO(data), file_type="stl")
    if not isinstance(mesh, trimesh.Trimesh) or not mesh.is_volume:
        return dict(result, status="fail", solid_valid=False, message="Expected a closed, consistently oriented STL solid")
    mesh.apply_translation([0, 0, -mesh.bounds[0, 2]])
    solid = manifold3d.Manifold(manifold3d.Mesh(mesh.vertices.astype("float32"),
                                                mesh.faces.astype("uint32")))
    if solid.status() != manifold3d.Error.NoError or solid.is_empty():
        return dict(result, status="fail", solid_valid=False, message="Invalid solid")
    previous = solid.slice(0)
    findings = []
    step = result["layer_mm"]
    for index, z in enumerate(np.arange(step / 2, mesh.bounds[1, 2], step)):
        section = solid.slice(z)
        reach = step / 2 if index == 0 else step
        area = (section - previous.offset(reach)).area()
        if area > result["min_area_mm2"]:
            findings.append(dict(z_mm=round(float(z), 3),
                                 unsupported_area_mm2=round(area, 3)))
        previous = section
    heights, grams, seconds = slice_model(data)
    status = "pass"
    if heights and support_policy != "supports-required":
        status = "fail" if support_policy == "support-free" else "warning"
    if grams is not None and seconds:
        result["estimate"] = dict(filamentGrams=grams, durationSeconds=seconds,
                                  slicer=result["analyzers"]["prusa-slicer"],
                                  printer="Generic FDM (0.4 mm nozzle)", material="ASA")
    return dict(result, findings=findings, solid_valid=True, support_heights_mm=heights,
                message=("Expected supports detected" if support_policy == "supports-required" else
                         "Cantilever needs support in this orientation") if heights else "No support extrusion",
                status=status)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--sha256", required=True, help="Digest from the saved artifact receipt")
    parser.add_argument("--policy", choices=["support-free", "supports-required"])
    args = parser.parse_args()
    try:
        report = review(args.artifact.read_bytes(), args.sha256, args.policy)
    except Exception as error:
        parser.exit(2, f"Artifact analysis failed: {error}\n")
    print(json.dumps(report))
    raise SystemExit(report["status"] == "fail")
