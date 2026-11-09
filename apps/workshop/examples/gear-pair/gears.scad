// Gear pair assembly: a base with two axle posts and two spur gears that mesh,
// so turning one turns the other (2:1 reduction). Each gear is held on by a
// press-fit cap. All sizes in mm.
//
//   openscad -D 'part="base"' -o base.stl gears.scad   (also small, large, cap)
//   openscad -D 'part="assembly"' -D '$t=0.25' -o frame.png gears.scad
//   openscad -D 'part="interference"' -D '$t=0.1' -o check.stl gears.scad
//     (must be empty at every $t: the teeth never collide)
//   animation frames: add -D from_stl=true after rendering the part STLs

part = "assembly"; // base | small | large | cap | assembly | interference
// Draw the assembly from the rendered STLs. OpenSCAD's fast preview draws the
// gear teeth with artifacts; the meshes draw cleanly, so animations use this.
from_stl = false;

module_mm = 2;          // gear module: pitch diameter = module x teeth
pressure_angle = 20;
small_teeth = 12;
large_teeth = 24;
backlash = 0.15;        // thinned off each tooth side so meshing teeth don't bind
center = module_mm * (small_teeth + large_teeth) / 2;   // 36 mm

clearance = 0.3;        // radial gap between post and gear bore
small_x = -center / 2;
large_x = center / 2;
// The base covers both gears with a 4 mm margin.
small_tip = module_mm * (small_teeth / 2 + 1);
large_tip = module_mm * (large_teeth / 2 + 1);
base = [center + small_tip + large_tip + 8, 2 * large_tip + 8, 4];
base_x = small_x - small_tip - 4;
shoulder_d = 10; shoulder_h = 1;
post_d = 6;
gear_h = 6;
gear_z = base[2] + shoulder_h + 0.2;
post_top = gear_z + gear_h + 0.6;
peg_d = 4; peg_h = 3;
cap_d = 10; cap_h = 4;


function polar(r, a) = [r * cos(a), r * sin(a)];
function inv_angle(rb, r) = let(t = acos(rb / r)) tan(t) * 180 / PI - t;

module spur_gear(teeth) {
  rp = module_mm * teeth / 2;
  rb = rp * cos(pressure_angle);
  ra = rp + module_mm;
  rr = rp - 1.25 * module_mm;
  // Half the tooth's angular width at the pitch circle, less backlash.
  half = 90 / teeth - backlash / 2 / rp * 180 / PI;
  steps = 8;
  rstart = max(rb, rr);
  side = [for (i = [0 : steps]) let(r = rstart + (ra - rstart) * i / steps) polar(r, half + inv_angle(rb, rp) - inv_angle(rb, r))];
  linear_extrude(gear_h) union() {
    // Root disc plus one polygon per tooth: centre, lower flank out to the
    // tip, then the upper flank back in.
    circle(r = rr + 0.01, $fn = teeth * 6);
    for (k = [0 : teeth - 1]) rotate(360 * k / teeth)
      polygon(concat([[0, 0]], [for (p = side) [p[0], -p[1]]], [for (i = [len(side) - 1 : -1 : 0]) side[i]]));
  }
}

module gear(teeth) {
  difference() {
    spur_gear(teeth);
    translate([0, 0, -1]) cylinder(d = post_d + 2 * clearance, h = gear_h + 2, $fn = 64);
    // Windows on the large gear so you can see it turn.
    if (teeth >= 20) for (a = [0 : 90 : 270]) rotate(a) translate([module_mm * teeth / 4 + 1, 0, -1]) cylinder(d = 8, h = gear_h + 2, $fn = 48);
    else translate([module_mm * teeth / 4 + 0.6, 0, -1]) cylinder(d = 3, h = gear_h + 2, $fn = 32);
  }
}

module post(x) {
  translate([x, 0, 0]) {
    cylinder(d = shoulder_d, h = base[2] + shoulder_h, $fn = 64);
    cylinder(d = post_d, h = post_top, $fn = 64);
    cylinder(d = peg_d, h = post_top + peg_h, $fn = 48);
  }
}

module base_part() {
  translate([base_x, -base[1] / 2, 0]) cube(base);
  post(small_x);
  post(large_x);
}

module cap() {
  difference() {
    cylinder(d = cap_d, h = cap_h, $fn = 64);
    translate([0, 0, -1]) cylinder(d = peg_d, h = peg_h + 1, $fn = 48);
  }
}

// The small gear drives; the large one turns the other way at half speed.
// The large gear starts half a tooth round so a gap faces the small gear's tooth.
function small_angle(t) = 360 * t;
function large_angle(t) = 180 + 180 / large_teeth - 360 * t * small_teeth / large_teeth;

module placed_small(t) translate([small_x, 0, gear_z]) rotate(small_angle(t)) if (from_stl) import("small.stl"); else gear(small_teeth);
module placed_large(t) translate([large_x, 0, gear_z]) rotate(large_angle(t)) if (from_stl) import("large.stl"); else gear(large_teeth);

module assembly(t) {
  color("SteelBlue") if (from_stl) import("base.stl"); else base_part();
  color("Orange") placed_small(t);
  color("MediumSeaGreen") placed_large(t);
  color("DimGray") for (x = [small_x, large_x]) translate([x, 0, post_top]) cap();
}

if (part == "base") base_part();
else if (part == "small") gear(small_teeth);
else if (part == "large") gear(large_teeth);
else if (part == "cap") translate([0, 0, cap_h]) mirror([0, 0, 1]) cap();
else if (part == "interference") {
  intersection() { placed_small($t); placed_large($t); }
  intersection() { base_part(); placed_small($t); }
  intersection() { base_part(); placed_large($t); }
}
else assembly($t);
