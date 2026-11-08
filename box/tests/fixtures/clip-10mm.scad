// The cable clip before its follow-up: a 10 mm hole, standing on its 40 x 20 face.
rotate([0, 90, 0]) difference() {
  cube([60, 40, 20]);
  translate([30, 20, -1]) cylinder(d = 10, h = 22, $fn = 64);
}
