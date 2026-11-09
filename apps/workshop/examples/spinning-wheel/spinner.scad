// Spinning wheel assembly: a stand with an axle post, a wheel that spins on
// it, and a cap that keeps the wheel on. All sizes in mm.
//
//   openscad -D 'part="stand"' -o stand.stl spinner.scad   (also wheel, cap)
//   openscad -D 'part="assembly"' --animate 36 ... spinner.scad   (spins via $t)
//   openscad -D 'part="interference"' -o check.stl spinner.scad   (must be empty)

part = "assembly"; // stand | wheel | cap | assembly | interference

clearance = 0.3;   // radial gap between axle and wheel bore

base = [50, 50, 4];
shoulder_d = 12; shoulder_h = 1;  // keeps the wheel off the base
axle_d = 8;
wheel_d = 40; wheel_h = 8;
wheel_z = base[2] + shoulder_h + 0.2;          // wheel resting height
axle_top = wheel_z + wheel_h + 0.6;            // axle ends just above the wheel
peg_d = 5; peg_h = 4;                          // cap presses onto this
cap_d = 14; cap_h = 5;

module stand() {
  translate([-base[0] / 2, -base[1] / 2, 0]) cube(base);
  cylinder(d = shoulder_d, h = base[2] + shoulder_h, $fn = 96);
  cylinder(d = axle_d, h = axle_top, $fn = 96);
  cylinder(d = peg_d, h = axle_top + peg_h, $fn = 64);
}

module wheel() {
  difference() {
    cylinder(d = wheel_d, h = wheel_h, $fn = 160);
    translate([0, 0, -1]) cylinder(d = axle_d + 2 * clearance, h = wheel_h + 2, $fn = 96);
    // Four windows so you can see it spin.
    for (a = [0 : 90 : 270]) rotate([0, 0, a]) translate([12, 0, -1]) cylinder(d = 9, h = wheel_h + 2, $fn = 64);
    // A notch on the rim marks one position.
    translate([wheel_d / 2 - 2, -1.5, -1]) cube([4, 3, wheel_h + 2]);
  }
}

// Printed upside down (flat face on the bed). Hole is nominal size: FDM holes
// print a little small, which gives a press fit; add a drop of glue if loose.
module cap() {
  difference() {
    cylinder(d = cap_d, h = cap_h, $fn = 96);
    translate([0, 0, -1]) cylinder(d = peg_d, h = peg_h + 1, $fn = 64);
  }
}

module assembly(angle = 0) {
  color("SteelBlue") stand();
  color("Orange") translate([0, 0, wheel_z]) rotate([0, 0, angle]) wheel();
  color("DimGray") translate([0, 0, axle_top]) cap();
}

if (part == "stand") stand();
else if (part == "wheel") wheel();
else if (part == "cap") translate([0, 0, cap_h]) mirror([0, 0, 1]) cap();
else if (part == "interference") {
  // Any solid here means two parts overlap when assembled.
  intersection() { stand(); translate([0, 0, wheel_z]) wheel(); }
  intersection() { translate([0, 0, wheel_z]) wheel(); translate([0, 0, axle_top]) cap(); }
}
else assembly(360 * $t);
