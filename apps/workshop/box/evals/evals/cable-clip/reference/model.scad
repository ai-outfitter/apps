// 60 x 40 x 20 mm block with a 12 mm hole through its 20 mm height, centred.
difference() {
  cube([60, 40, 20]);
  translate([30, 20, -1]) cylinder(d = 12, h = 22, $fn = 128);
}
