// 80 x 60 x 5 mm plate with four 5 mm holes centred 8 mm in from both edges at each corner.
difference() {
  cube([80, 60, 5]);
  for (x = [8, 72], y = [8, 52]) translate([x, y, -1]) cylinder(d = 5, h = 7, $fn = 96);
}
