// L bracket, 30 mm wide: a 50 x 30 x 5 mm base and a 5 mm thick upright 40 mm
// tall at one end. A 6 mm hole through the base, centred 30 mm from the
// upright's outer face, and one through the upright, centred 25 mm up.
difference() {
  union() {
    cube([50, 30, 5]);
    cube([5, 30, 40]);
  }
  translate([30, 15, -1]) cylinder(d = 6, h = 7, $fn = 96);
  translate([-1, 15, 25]) rotate([0, 90, 0]) cylinder(d = 6, h = 7, $fn = 96);
}
