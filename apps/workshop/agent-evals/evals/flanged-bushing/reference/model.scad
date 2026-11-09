// Flanged bushing: a 40 mm diameter flange 6 mm thick with a 20 mm diameter hub
// 14 mm tall on top (20 mm overall), and a 10 mm bore through both.
difference() {
  union() {
    cylinder(d = 40, h = 6, $fn = 160);
    cylinder(d = 20, h = 20, $fn = 128);
  }
  translate([0, 0, -1]) cylinder(d = 10, h = 22, $fn = 96);
}
