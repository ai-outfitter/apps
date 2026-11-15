"""Quality checks and simulation for a workspace build, all with existing tools.

build.py calls these after it renders each target. Each returns test rows in
the BuildManifest shape ({name, status, detail}) plus data worth keeping.

- printability: bed fit from the mesh bounds, then PrusaSlicer for grams and
  print time (PrusaSlicer 2.5 slices a part that overhangs the bed without
  complaint, so the bounds check comes first).
- interference: every pair of placed solids in the assembly, intersected with
  manifold3d. Face contact has no volume, so no 0.01 mm lifts are needed.
- simulate: a steady heat or linear static study. Gmsh meshes the solid
  (STEP natively, STL by reparametrising its surface), CalculiX solves it.

Units: mm, N, MPa, s. Thermal power is in mW, so conductivity W/(m K) and the
mW/(mm K) CalculiX reads are the same number; fluxes and film coefficients are
given per m2 in workspace.json and scaled here.
"""
import math, pathlib, re, subprocess
import numpy as np, trimesh

MIN_FIT = 0.1  # mm3 of overlap that still counts as touching


def _run(args, cwd=None, timeout=600):
  return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


# ---------------------------------------------------------------- printability

def _rotate(mesh, angles):
  m = mesh.copy()
  for axis, deg in zip(np.eye(3), angles or [0, 0, 0]):
    if deg: m.apply_transform(trimesh.transformations.rotation_matrix(math.radians(deg), axis))
  m.apply_translation(-m.bounds[0])
  return m


def printability(name, stl, printer, settings, work):
  """Bed fit, overhang area and PrusaSlicer grams/time for one printed part."""
  mesh = _rotate(trimesh.load_mesh(stl), settings.get("orientation"))
  size = mesh.extents
  bed = printer["bed"]
  fits = [all(s <= b + 1e-6 for s, b in zip(sz, bed)) for sz in (size, [size[1], size[0], size[2]])]
  tests = [dict(name=f"Fits {printer.get('name', 'printer')}: {name}", status="pass" if any(fits) else "fail",
                detail=f"part {size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} mm; bed {bed[0]} x {bed[1]} x {bed[2]} mm"
                       + ("" if any(fits) else "; split the part or use a larger printer"))]
  # Faces facing down more steeply than the overhang angle, above the first layer.
  limit = math.cos(math.radians(90 - settings.get("overhang", 45)))
  centres = mesh.triangles_center[:, 2]
  down = (mesh.face_normals[:, 2] < -limit) & (centres > 0.3)
  overhang = float(mesh.area_faces[down].sum())
  data = dict(part=name, size=[round(float(s), 2) for s in size], overhangMm2=round(overhang, 1), material=settings.get("material"))
  tests.append(dict(name=f"Overhangs: {name}", status="pass" if overhang <= settings.get("maxOverhangMm2", 100) else "unverified",
                    detail=f"{overhang:.0f} mm2 steeper than {settings.get('overhang', 45)} degrees from vertical; supports or a new orientation needed above {settings.get('maxOverhangMm2', 100)} mm2"))
  oriented = pathlib.Path(work) / f"{name}.print.stl"; mesh.export(oriented)
  gcode = pathlib.Path(work) / f"{name}.gcode"
  material = settings.get("materialProperties", {})
  args = ["prusa-slicer", "--export-gcode", "--dont-arrange",
          "--bed-shape", f"0x0,{max(bed[0], size[0]) + 10}x0,{max(bed[0], size[0]) + 10}x{max(bed[1], size[1]) + 10},0x{max(bed[1], size[1]) + 10}",
          "--max-print-height", str(max(bed[2], size[2]) + 10), "--center", f"{size[0] / 2 + 5},{size[1] / 2 + 5}",
          "--filament-diameter", "1.75", "--layer-height", str(settings.get("layerHeight", 0.2)),
          "--perimeters", str(settings.get("walls", 3)), "--fill-density", f"{settings.get('infill', 15)}%",
          "-o", str(gcode), str(oriented)]
  if material.get("density"): args[3:3] = ["--filament-density", str(material["density"])]
  if settings.get("supports"): args[3:3] = ["--support-material"]
  p = _run(args)
  text = gcode.read_text(errors="ignore") if gcode.exists() else ""
  grams = re.search(r"; total filament used \[g\] = ([\d.]+)", text)
  hours = re.search(r"; estimated printing time \(normal mode\) = (.+)", text)
  if p.returncode or not grams:
    tests.append(dict(name=f"Slices: {name}", status="fail", detail=(p.stderr or p.stdout)[-1500:]))
  else:
    data.update(grams=float(grams.group(1)), printTime=hours.group(1).strip() if hours else None)
    budget = settings.get("maxGrams")
    ok = budget is None or data["grams"] <= budget
    tests.append(dict(name=f"Slices: {name}", status="pass" if ok else "fail",
                      detail=f"{data['grams']:.0f} g {settings.get('material', '')}, {data['printTime']} at {settings.get('layerHeight', 0.2)} mm layers, {settings.get('walls', 3)} walls, {settings.get('infill', 15)}% infill"
                             + ("" if budget is None else f"; budget {budget} g")))
  return tests, data


# ---------------------------------------------------------------- interference

def _euler_xyz(deg):
  """three.js Euler order XYZ: R = Rx * Ry * Rz."""
  x, y, z = (math.radians(v) for v in deg)
  rx = np.array([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
  ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
  rz = np.array([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
  return rx @ ry @ rz


def placements(assembly):
  """Every item with a mesh, placed in world coordinates, as assembly.ts places it."""
  by_id = {i["id"]: i for i in assembly["items"]}
  root = by_id.get(assembly.get("rootId"))
  out = []
  def walk(item, matrix, path):
    if item.get("mesh"): out.append((item, matrix, path))
    for use in item.get("uses", []):
      child = by_id.get(use["itemId"])
      if not child: continue
      local = np.eye(4)
      local[:3, :3] = _euler_xyz(use.get("orientation") or [0, 0, use.get("rotation", 0)])
      local[:3, 3] = use.get("position", [0, 0, 0])
      # assembly.ts draws every copy of a usage at the same place, so one stands for all.
      walk(child, matrix @ local, f"{path}/{use['id']}")
  if root: walk(root, np.eye(4), root["id"])
  return out


def _manifold(stl, matrix):
  import manifold3d
  mesh = trimesh.load_mesh(stl)
  mesh.apply_transform(matrix)
  return manifold3d.Manifold(manifold3d.Mesh(vert_properties=np.asarray(mesh.vertices, np.float32),
                                             tri_verts=np.asarray(mesh.faces, np.uint32)))


def interference(assembly, mesh_file, allow=(), max_volume=MIN_FIT):
  """Pairwise overlap of every placed solid. `allow` lists part-number pairs meant to overlap."""
  placed = placements(assembly)
  solids = [(item, _manifold(mesh_file(item), matrix)) for item, matrix, _ in placed]
  allowed = {frozenset(p) for p in allow}
  clashes = []
  for a in range(len(solids)):
    for b in range(a + 1, len(solids)):
      (ia, ma), (ib, mb) = solids[a], solids[b]
      if frozenset((ia["number"], ib["number"])) in allowed: continue
      volume = (ma ^ mb).volume()
      if volume > max_volume: clashes.append((ia["number"], ib["number"], volume))
  pairs = len(solids) * (len(solids) - 1) // 2
  detail = "; ".join(f"{a} overlaps {b} by {v:.1f} mm3" for a, b, v in clashes) or f"{pairs} pairs of {len(solids)} placed solids, no overlap over {max_volume} mm3"
  return [dict(name="Assembly interference", status="fail" if clashes else "pass", detail=detail)], dict(pairs=pairs, clashes=[dict(a=a, b=b, volumeMm3=round(v, 2)) for a, b, v in clashes])


# ---------------------------------------------------------------- simulation

# Corner nodes of each face of a tetrahedron in CalculiX order (S1..S4 / F1..F4).
TET_FACES = [(0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)]


def _prepare(sources, clip, out):
  """One closed STL: the union of the sources, cut to the clip box when the study looks at one region."""
  import manifold3d
  solids = [_manifold(src, np.eye(4)) for src in sources]
  solid = solids[0]
  for other in solids[1:]: solid = solid + other
  if clip:
    low, high = np.array(clip["min"], float), np.array(clip["max"], float)
    solid = solid ^ manifold3d.Manifold.cube(high - low).translate(low)
  mesh = solid.to_mesh()
  trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts).export(out)
  return out


def _mesh(stl, size, order):
  """Tetrahedral mesh of a closed STL, as (nodes {tag: xyz}, elements [(tag, [nodes])])."""
  import gmsh
  gmsh.initialize(["-nt", "1"]); gmsh.option.setNumber("General.Terminal", 0)
  try:
    gmsh.model.add("study")
    # An STL has no geometry to mesh from: classify its triangles into patches,
    # rebuild surfaces over them and remesh at the study's element size.
    gmsh.merge(str(stl))
    gmsh.model.mesh.classifySurfaces(math.radians(40), True, True, math.pi)
    gmsh.model.mesh.createGeometry()
    loop = gmsh.model.geo.addSurfaceLoop([t for _, t in gmsh.model.getEntities(2)])
    gmsh.model.geo.addVolume([loop])
    gmsh.model.geo.synchronize()
    gmsh.option.setNumber("Mesh.MeshSizeMax", size)
    gmsh.option.setNumber("Mesh.MeshSizeMin", size / 4)
    gmsh.option.setNumber("Mesh.ElementOrder", order)
    gmsh.option.setNumber("Mesh.SecondOrderLinear", 1)
    gmsh.model.mesh.generate(3)
    tags, coords, _ = gmsh.model.mesh.getNodes()
    nodes = dict(zip(tags.astype(int).tolist(), coords.reshape(-1, 3)))
    kind = 4 if order == 1 else 11
    etags, enodes = gmsh.model.mesh.getElementsByType(kind)
    width = 4 if order == 1 else 10
    elements = list(zip(etags.astype(int).tolist(), enodes.astype(int).reshape(-1, width).tolist()))
    if order == 2:  # Gmsh orders the last two mid-edge nodes of a tet10 the other way round from CalculiX.
      elements = [(t, n[:8] + [n[9], n[8]]) for t, n in elements]
    return nodes, elements
  finally:
    gmsh.finalize()


def _boundary(nodes, elements):
  """Exterior faces: (element tag, face number 1-4, corner xyz, outward normal, area)."""
  seen = {}
  for tag, conn in elements:
    for f, idx in enumerate(TET_FACES):
      key = tuple(sorted(conn[i] for i in idx))
      seen[key] = None if key in seen else (tag, f + 1, [conn[i] for i in idx], conn[[k for k in range(4) if k not in idx][0]])
  faces = []
  for value in seen.values():
    if value is None: continue
    tag, face, corner, opposite = value
    p = np.array([nodes[n] for n in corner])
    n = np.cross(p[1] - p[0], p[2] - p[0])
    if np.dot(n, nodes[opposite] - p[0]) > 0: n = -n
    area = np.linalg.norm(n) / 2
    faces.append((tag, face, p, n / (2 * area), area))
  return faces


def _select(faces, region):
  low = np.array(region.get("min", [-1e9] * 3)); high = np.array(region.get("max", [1e9] * 3))
  want = np.array(region["normal"]) / np.linalg.norm(region["normal"]) if region.get("normal") else None
  picked = []
  for face in faces:
    _, _, p, n, _ = face
    if not ((p >= low - 1e-6) & (p <= high + 1e-6)).all(): continue
    if want is not None and np.dot(n, want) < math.cos(math.radians(region.get("angle", 30))): continue
    picked.append(face)
  return picked


def _material(m, thermal):
  lines = [f"*MATERIAL, NAME={m['name'].upper()[:70]}"]
  if thermal: lines += ["*CONDUCTIVITY", f"{m['conductivity']}"]
  else: lines += ["*ELASTIC", f"{m['youngsModulus']}, {m['poissonsRatio']}"]
  return lines


def simulate(study, sources, work):
  """Run one study; returns test rows and the numbers behind them."""
  work = pathlib.Path(work); thermal = study["kind"] == "thermal"
  solid = _prepare([pathlib.Path(s) for s in sources], study.get("clip"), work / f"{study['name']}.solid.stl")
  nodes, elements = _mesh(solid, study.get("meshSize", 3), 1 if thermal else 2)
  used = {n for _, c in elements for n in c}
  nodes = {t: xyz for t, xyz in nodes.items() if t in used}  # Gmsh keeps the STL's own nodes too
  faces = _boundary(nodes, elements)
  m = study["material"]
  model = ["*NODE, NSET=NALL"] + [f"{t}, {x:.6f}, {y:.6f}, {z:.6f}" for t, (x, y, z) in nodes.items()]
  model += [f"*ELEMENT, TYPE={'C3D4' if thermal else 'C3D10'}, ELSET=EALL"] + [f"{t}, " + ", ".join(map(str, c)) for t, c in elements]
  model += _material(m, thermal) + [f"*SOLID SECTION, ELSET=EALL, MATERIAL={m['name'].upper()[:70]}"]
  data = dict(study=study["name"], nodes=len(nodes), elements=len(elements), material=m["name"], materialSource=m.get("source"))
  if thermal:
    tests = _thermal(study, model, faces, elements, work, data)
  else:
    tests = _static(study, model, faces, elements, work, data)
  if tests is None:
    return [dict(name=study["title"], status="fail", detail="CalculiX failed: " + data.pop("error"))], data
  for row in tests: row["detail"] += f"; {len(elements)} elements; {m['name']} from {m.get('source', 'no source')}; estimate, not a physical test"
  return tests, data


def _solve(name, lines, work, data):
  (work / f"{name}.inp").write_text("\n".join(lines) + "\n")
  p = _run(["ccx", "-i", name], cwd=work, timeout=1800)
  dat = work / f"{name}.dat"
  if p.returncode or not dat.exists() or "*ERROR" in p.stdout:
    data["error"] = (p.stdout + p.stderr)[-1500:]
    return None
  return _dat_rows(dat.read_text())


def _thermal(study, model, faces, elements, work, data):
  """Steady heat. Outside faces lose heat to the ambient air through one film
  coefficient (convection and radiation together). Faces inside a closed cavity
  exchange heat with the cavity's air, whose temperature is found by iterating
  until the air takes in as much heat as it gives out."""
  ambient = study["ambient"]
  absorbed, dflux = 0.0, []
  for flux in study.get("fluxes", []):
    picked = _select(faces, flux)
    absorbed += sum(f[4] for f in picked) * flux["wPerM2"] * 1e-6
    dflux += [f"{t}, S{f}, {flux['wPerM2'] * 1e-3:.6g}" for t, f, *_ in picked]
  inside = {(f[0], f[1]): f for r in study.get("inside", []) for f in _select(faces, r)}
  outside = [f"{t}, F{f}, {ambient}, {study['filmWPerM2K'] * 1e-3:.6g}" for t, f, *_ in faces if (t, f) not in inside]
  h_in = study.get("insideFilmWPerM2K", 3) * 1e-3
  table = face_nodes_cache(elements)
  air, temp = ambient, None
  for _ in range(8 if inside else 1):
    lines = model + ["*INITIAL CONDITIONS, TYPE=TEMPERATURE", f"NALL, {ambient}", "*STEP", "*HEAT TRANSFER, STEADY STATE", "1., 1."]
    if dflux: lines += ["*DFLUX"] + dflux
    lines += ["*FILM"] + outside + [f"{t}, F{f}, {air:.4f}, {h_in:.6g}" for (t, f) in inside]
    lines += ["*NODE PRINT, NSET=NALL", "NT", "*END STEP"]
    rows = _solve(study["name"], lines, work, data)
    if rows is None: return None
    temp = {int(r[0]): r[1] for r in rows["temperatures"]}
    if not inside: break
    # With one film coefficient the balance is met at the area-weighted wall temperature.
    area = sum(f[4] for f in inside.values())
    next_air = sum(f[4] * np.mean([temp[n] for n in table[k][:3]]) for k, f in inside.items()) / area
    if abs(next_air - air) < 0.05: air = next_air; break
    air = next_air
  t = np.array(list(temp.values()))
  data.update(maxC=round(float(t.max()), 1), minC=round(float(t.min()), 1), absorbedW=round(absorbed, 2), insideAirC=round(air, 1) if inside else None)
  summary = f"hottest point {t.max():.1f} C, coolest {t.min():.1f} C" + (f", inside air {air:.1f} C" if inside else "") + f", {absorbed:.1f} W absorbed at {ambient} C ambient"
  return [_limit(study["title"], summary, data["insideAirC"] if lim.get("where") == "inside" else data["maxC"], lim, "C") for lim in study["limits"]]


def _static(study, model, faces, elements, work, data):
  """Linear static stress with the selected faces held and loads spread over others by area."""
  fixed = {n for face in _select(faces, study["fixed"]) for n in _face_nodes(face, elements)}
  lines = model + ["*NSET, NSET=FIXED"] + [f"{n}," for n in sorted(fixed)]
  lines += ["*BOUNDARY", "FIXED, 1, 3", "*STEP", "*STATIC", "*CLOAD"]
  for load in study["loads"]:
    picked = _select(faces, load)
    area = sum(f[4] for f in picked)
    share = {}
    for face in picked:  # a third of each face's share to each corner
      for n in _face_nodes(face, elements)[:3]: share[n] = share.get(n, 0) + face[4] / 3 / area
    for n, w in share.items():
      for axis, force in enumerate(load["force"]):
        if force: lines.append(f"{n}, {axis + 1}, {force * w:.6g}")
    data.setdefault("loadAreasMm2", []).append(round(area, 2))
  lines += ["*NODE PRINT, NSET=NALL", "U", "*EL PRINT, ELSET=EALL", "S", "*END STEP"]
  rows = _solve(study["name"], lines, work, data)
  if rows is None: return None
  s = np.array([r[2:8] for r in rows["stresses"]])
  sxx, syy, szz, sxy, sxz, syz = s.T
  mises = np.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy ** 2 + sxz ** 2 + syz ** 2))
  u = np.array([r[1:4] for r in rows["displacements"]])
  data.update(maxMisesMPa=round(float(mises.max()), 2), maxDisplacementMm=round(float(np.linalg.norm(u, axis=1).max()), 4))
  # The peak sits on a sharp corner of the CAD plan and grows as the mesh
  # refines, so the limit is compared with the mean over the probed region
  # (the material that carries the load), not with the peak.
  probe = study.get("probe")
  if probe:
    nodes_xyz = {int(l.split(",")[0]): np.array([float(v) for v in l.split(",")[1:4]]) for l in model[1:model.index(next(x for x in model if x.startswith("*ELEMENT")))]}
    low, high = np.array(probe["min"]), np.array(probe["max"])
    inside = {t for t, c in elements if ((lambda m: (m >= low).all() and (m <= high).all())(np.mean([nodes_xyz[n] for n in c[:4]], axis=0)))}
    pick = np.array([int(r[0]) in inside for r in rows["stresses"]])
    data.update(probeMeanMisesMPa=round(float(mises[pick].mean()), 2), probeP95MisesMPa=round(float(np.percentile(mises[pick], 95)), 2))
    value = data["probeMeanMisesMPa"]
    detail = f"von Mises {value} MPa on average {probe.get('note', 'in the probed region')} (95th percentile {data['probeP95MisesMPa']} MPa), peak {data['maxMisesMPa']} MPa at a sharp corner, largest movement {data['maxDisplacementMm']} mm"
  else:
    value = data["p99MisesMPa"] = round(float(np.percentile(mises, 99)), 2)
    detail = f"von Mises {value} MPa (99th percentile), peak {data['maxMisesMPa']} MPa at a sharp corner, largest movement {data['maxDisplacementMm']} mm"
  return [_limit(study["title"], detail, value, lim, "MPa") for lim in study["limits"]]


def _face_nodes(face, elements):
  return [] if face is None else face_nodes_cache(elements)[(face[0], face[1])]


_FACE_CACHE = {}
def face_nodes_cache(elements):
  key = id(elements)
  if key not in _FACE_CACHE:
    mid = {1: (4, 5, 6), 2: (7, 8, 4), 3: (8, 9, 5), 4: (6, 9, 7)}  # tet10 mid-edge nodes per face
    table = {}
    for tag, c in elements:
      for f, idx in enumerate(TET_FACES):
        table[(tag, f + 1)] = [c[i] for i in idx] + ([c[i] for i in mid[f + 1]] if len(c) == 10 else [])
    _FACE_CACHE.clear(); _FACE_CACHE[key] = table
  return _FACE_CACHE[key]


def _limit(title, detail, value, lim, unit):
  ok = value <= lim["max"]
  return dict(name=f"{title}: {lim['name']}", status="pass" if ok else "fail", detail=f"{detail}; limit {lim['max']} {unit}")


def _dat_rows(text):
  out = dict(temperatures=[], displacements=[], stresses=[]); current = None
  for line in text.splitlines():
    low = line.strip().lower()
    if low.startswith("temperatures"): current = "temperatures"; continue
    if low.startswith("displacements"): current = "displacements"; continue
    if low.startswith("stresses"): current = "stresses"; continue
    parts = line.split()
    if current and parts:
      try: out[current].append([float(v) for v in parts])
      except ValueError: current = None
  return out
