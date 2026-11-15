"""Checks for quality.py. Run inside the Workshop box image (it has the tools):
  python3 -m unittest discover -s /opt/workshop -p 'test_*.py'
"""
import json, pathlib, tempfile, unittest
import numpy as np, trimesh
import quality


def cube(path, size, at=(0, 0, 0)):
  mesh = trimesh.creation.box(extents=size); mesh.apply_translation(np.array(at) + np.array(size) / 2); mesh.export(path)
  return path


class Quality(unittest.TestCase):
  def setUp(self):
    self.dir = pathlib.Path(tempfile.mkdtemp())

  def test_placements_follow_assembly_ts(self):
    # Turning 90 degrees about Z then moving 10 mm in X puts the child's +X axis on world +Y.
    assembly = {"rootId": "r", "items": [
      {"id": "r", "number": "A", "uses": [{"id": "u", "itemId": "c", "quantity": 1, "position": [10, 0, 0], "rotation": 90}]},
      {"id": "c", "number": "C", "mesh": {"path": "c.stl"}}]}
    [(item, matrix, path)] = quality.placements(assembly)
    self.assertEqual(item["id"], "c")
    np.testing.assert_allclose(matrix @ [1, 0, 0, 1], [10, 1, 0, 1], atol=1e-9)

  def test_interference_counts_overlap_not_contact(self):
    a = cube(self.dir / "a.stl", (10, 10, 10)); b = cube(self.dir / "b.stl", (10, 10, 10))
    def assembly(x):
      return {"rootId": "r", "items": [
        {"id": "r", "number": "A", "uses": [{"id": "1", "itemId": "a", "quantity": 1}, {"id": "2", "itemId": "b", "quantity": 1, "position": [x, 0, 0]}]},
        {"id": "a", "number": "P1", "mesh": {"path": "a.stl"}}, {"id": "b", "number": "P2", "mesh": {"path": "b.stl"}}]}
    files = {"a": a, "b": b}
    touching, _ = quality.interference(assembly(10), lambda item: files[item["id"]])
    self.assertEqual(touching[0]["status"], "pass")
    clash, data = quality.interference(assembly(8), lambda item: files[item["id"]])
    self.assertEqual(clash[0]["status"], "fail")
    self.assertAlmostEqual(data["clashes"][0]["volumeMm3"], 200, places=1)
    allowed, _ = quality.interference(assembly(8), lambda item: files[item["id"]], allow=[["P1", "P2"]])
    self.assertEqual(allowed[0]["status"], "pass")

  def test_bed_fit_tries_both_footprints(self):
    part = cube(self.dir / "p.stl", (200, 100, 20))
    rows, data = quality.printability("p", part, {"name": "small", "bed": [120, 210, 100]}, {"material": "PETG", "materialProperties": {"density": 1.27}}, self.dir)
    self.assertEqual(rows[0]["status"], "pass")
    rows, _ = quality.printability("q", part, {"name": "tiny", "bed": [150, 150, 100]}, {"material": "PETG"}, self.dir)
    self.assertEqual(rows[0]["status"], "fail")
    # 200 x 100 x 20 mm at 3 walls and 15% infill: well under the solid 508 g, well over nothing.
    self.assertTrue(50 < data["grams"] < 508, data)

  def test_slab_conducts_as_fourier_says(self):
    # A 10 mm PETG slab, 1000 W/m2 into the top, film on every face: the
    # top runs hotter than the bottom by about q*L/k once the edges are small.
    slab = cube(self.dir / "s.stl", (100, 100, 10))
    study = {"name": "slab", "title": "Slab", "kind": "thermal", "meshSize": 4, "ambient": 20, "filmWPerM2K": 10,
             "material": {"name": "PETG", "conductivity": 0.2},
             "fluxes": [{"min": [-1, -1, 9.9], "max": [101, 101, 10.1], "normal": [0, 0, 1], "wPerM2": 1000}],
             "limits": [{"name": "anything", "max": 1000}]}
    rows, data = quality.simulate(study, [slab], self.dir)
    self.assertEqual(rows[0]["status"], "pass", rows)
    self.assertAlmostEqual(data["absorbedW"], 10, places=1)
    # One-dimensional answer for the top face: about 20 + 1000 * (1/10 + 0.01/0.2) / 2 = 95 C at most.
    self.assertTrue(60 < data["maxC"] < 100, data)

  def test_column_stress_is_force_over_area(self):
    column = cube(self.dir / "c.stl", (10, 10, 20))
    study = {"name": "col", "title": "Column", "kind": "static", "meshSize": 2.5,
             "material": {"name": "PETG", "youngsModulus": 1500, "poissonsRatio": 0.38},
             "fixed": {"min": [-1, -1, -0.1], "max": [11, 11, 0.1], "normal": [0, 0, -1]},
             "loads": [{"min": [-1, -1, 19.9], "max": [11, 11, 20.1], "normal": [0, 0, 1], "force": [0, 0, -1000]}],
             "probe": {"min": [0, 0, 8], "max": [10, 10, 12]},
             "limits": [{"name": "ten", "max": 10.5}, {"name": "nine", "max": 9.5}]}
    rows, data = quality.simulate(study, [column], self.dir)
    # 1000 N over 100 mm2 is 10 MPa in the middle of the column.
    self.assertAlmostEqual(data["probeMeanMisesMPa"], 10, delta=0.5)
    self.assertEqual([r["status"] for r in rows], ["pass", "fail"])


if __name__ == "__main__":
  unittest.main()
