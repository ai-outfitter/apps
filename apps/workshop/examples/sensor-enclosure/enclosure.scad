// Soil sensor node enclosure: the printed base and lid of Workshop's
// starter assembly (src/lib/sensor-node.ts), written out in OpenSCAD so the
// workspace build can slice and simulate it. Same sizes as the CAD plans there;
// change both together. All sizes in mm; origin at the centre of the floor.
//
//   openscad -D 'part="base"' -o base.stl enclosure.scad   (also lid; closed = base and lid together)

part = "closed"; // base | lid | lid-print | closed
W = 140; D = 95; H = 35; T = 2.5;
corners = [[-63, -40.5], [63, -40.5], [-63, 40.5], [63, 40.5]];

module base() difference() {
  union() {
    difference() {
      translate([-W / 2, -D / 2, 0]) cube([W, D, H]);
      translate([-W / 2 + T, -D / 2 + T, T]) cube([W - 2 * T, D - 2 * T, H]);
    }
    for (c = corners) translate([c[0], c[1], T]) cylinder(r = 4, h = H - T, $fn = 48);
  }
  // Probe slot through the floor and an air vent beside the CO2 sensor.
  translate([38, -1.5, -1]) cube([24, 3, T + 2]);
  translate([25, D / 2 - T - 1, 12]) cube([20, T + 2, 10]);
  for (c = corners) translate([c[0], c[1], T]) cylinder(r = 1.25, h = H, $fn = 24);
}

// The lid as assembled, on top of the base; a window over the lux sensor.
module lid() translate([0, 0, H]) difference() {
  translate([-W / 2, -D / 2, 0]) cube([W, D, T]);
  translate([-55, 0, -1]) cylinder(r = 3, h = T + 2, $fn = 32);
  for (c = corners) translate([c[0], c[1], -1]) cylinder(r = 1.6, h = T + 2, $fn = 24);
}

if (part == "base") base();
else if (part == "lid") lid();
else { base(); lid(); }
