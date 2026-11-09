// Mini-ITX case: three printed parts around three purchased ones. A base with
// standoff bosses, a one-piece shell of four walls, and a top with a lip that
// drops inside the shell. The board, its cooler and a Flex ATX power supply are
// dimensioned envelopes from their specifications, not manufacturer models.
// All sizes in mm; origin at the outside front-left-bottom corner.
//
//   openscad -D 'part="base"' -o base.stl case.scad      (also shell, top)
//   openscad -D 'part="interference"' -o check.stl case.scad   (must be empty)
//   openscad -D 'part="standoff-fit"' -o check.stl case.scad   (must be empty)
//   openscad -D 'part="io-fit"' -o check.stl case.scad         (must be empty)
//   openscad -D 'part="assembly"' -D '$t=0.5' -o frame.png case.scad   ($t explodes it)

part = "assembly"; // base | shell | top | assembly | interference | standoff-fit | io-fit | pair
pair = ["shell", "top"];             // the two parts "pair" intersects

wall = 3;
W = 224; D = 178; H = 89;            // outside

// Mini-ITX board (ATX specification): 170 x 170, holes C, F, H, J measured
// from the rear (I/O) edge and the left edge.
board = [170, 170, 1.6];
bx = wall + 1; by = wall + 1;        // board origin, 1 mm off the left and front walls
board_offset = [0, 0];               // moves the purchased board only; for proving the fit checks fail
board_holes = [[33.02, 170 - 10.16], [165.1, 170 - 10.16], [33.02, 170 - 165.1], [165.1, 170 - 165.1]];
io = [158.75, 44.45];                // I/O aperture, 6.25 x 1.75 in
io_x = bx + (board[0] - io[0]) / 2;  // centred on the board; check against the board's drawing

boss_h = 2.5; boss_d = 7; screw_hole = 3.3;
standoff = [5.5, 6];                 // M3 male-female standoff, 6 mm body
board_z = wall + boss_h + standoff[1];   // underside of the PCB
board_top = board_z + board[2];
io_z = board_top - 1.5;

cooler = [95, 95, 37];               // low-profile cooler footprint and height
cooler_c = [bx + 85, by + 90];

psu = [40, 150, 81.5];               // Flex ATX, standing on its long edge
psu_x = bx + board[0] + 3;
psu_y = D - wall - 3.5 - psu[1];     // rear face 3.5 mm off the back wall for the top lip
c14 = [27, 5, 19.5];                 // IEC inlet protruding from the PSU's rear face

lip = [2, 6, 0.2];                   // top lip: thickness, drop, clearance each side
lip_screw_z = H - wall - 3.5;

module hole(d, h, at) translate([at[0], at[1], at[2]]) cylinder(d = d, h = h, $fn = 48);

// --- printed parts ---------------------------------------------------------

module base() {
  difference() {
    union() {
      cube([W, D, wall]);
      for (p = board_holes) hole(boss_d, wall + boss_h, [bx + p[0], by + p[1], 0]);
      // Stops that locate the power supply, 0.3 mm off it: a rail along its left side and a bar at its front.
      translate([psu_x - 3.3, psu_y, wall]) cube([3, psu[1], 6]);
      translate([psu_x - 3.3, psu_y - 3.3, wall]) cube([psu[0] + 3.3, 3, 6]);
    }
    for (p = board_holes) hole(screw_hole, wall + boss_h + 2, [bx + p[0], by + p[1], -1]);
  }
}

module shell() {
  h = H - 2 * wall;
  difference() {
    translate([0, 0, wall]) cube([W, D, h]);
    translate([wall, wall, wall - 1]) cube([W - 2 * wall, D - 2 * wall, h + 2]);
    // I/O aperture and power supply opening in the back wall.
    translate([io_x, D - wall - 1, io_z]) cube([io[0], wall + 2, io[1]]);
    translate([psu_x + 2, D - wall - 1, wall + 2]) cube([psu[0] - 4, wall + 2, psu[2] - 4]);
    // Vent slots: front wall over the board, left wall along the board.
    for (i = [0 : 11]) translate([bx + 25 + i * 10, -1, 22]) cube([3, wall + 2, 45]);
    for (i = [0 : 11]) translate([-1, by + 25 + i * 10, 22]) cube([wall + 2, 3, 45]);
    // Screw holes for the top's lip, centred on each wall.
    for (at = [[W / 2, -1, lip_screw_z], [W / 2, D - wall - 1, lip_screw_z]])
      translate(at) rotate([-90, 0, 0]) cylinder(d = screw_hole, h = wall + 2, $fn = 32);
    for (at = [[-1, D / 2, lip_screw_z], [W - wall - 1, D / 2, lip_screw_z]])
      translate(at) rotate([0, 90, 0]) cylinder(d = screw_hole, h = wall + 2, $fn = 32);
  }
}

module top() {
  in = wall + lip[2];
  difference() {
    union() {
      translate([0, 0, H - wall]) cube([W, D, wall]);
      translate([in, in, H - wall - lip[1]]) cube([W - 2 * in, D - 2 * in, lip[1]]);
    }
    translate([in + lip[0], in + lip[0], H - wall - lip[1] - 1]) cube([W - 2 * (in + lip[0]), D - 2 * (in + lip[0]), lip[1] + 1]);
    // Vent grid over the cooler.
    for (i = [-4 : 4], j = [-4 : 4]) hole(6, wall + 2, [cooler_c[0] + i * 10, cooler_c[1] + j * 10, H - wall - 1]);
    // Pilot holes in the lip for the wall screws.
    for (at = [[W / 2, -1, lip_screw_z], [W / 2, D - in - lip[0] - 1, lip_screw_z]])
      translate(at) rotate([-90, 0, 0]) cylinder(d = 2.5, h = in + lip[0] + 2, $fn = 32);
    for (at = [[-1, D / 2, lip_screw_z], [W - in - lip[0] - 1, D / 2, lip_screw_z]])
      translate(at) rotate([0, 90, 0]) cylinder(d = 2.5, h = in + lip[0] + 2, $fn = 32);
  }
}

// --- purchased parts, as envelopes -------------------------------------------

module board_pcb() translate([board_offset[0], board_offset[1], 0]) difference() {
  translate([bx, by, board_z]) cube(board);
  for (p = board_holes) hole(3.2, board[2] + 2, [bx + p[0], by + p[1], board_z - 1]);
}
module board_holes_env(h) translate([board_offset[0], board_offset[1], 0]) for (p = board_holes) hole(3.2, h, [bx + p[0], by + p[1], wall]);
// Rear connectors: a block inside the I/O shield area that reaches through the wall.
module board_io() translate([io_x + 2, by + board[0] - 3, board_top]) cube([io[0] - 4, 3 + 1 + wall, 40]);
module standoffs() for (p = board_holes) hole(standoff[0], standoff[1], [bx + p[0], by + p[1], wall + boss_h]);
module cooler_env() translate([cooler_c[0] - cooler[0] / 2, cooler_c[1] - cooler[1] / 2, board_top]) cube(cooler);
module psu_env() {
  translate([psu_x, psu_y, wall]) cube(psu);
  translate([psu_x + 3.4, psu_y + psu[1], wall + psu[2] - 5 - c14[2]]) cube(c14);
}

// The overlap between one printed part (children) and each purchased envelope.
module against_purchased() {
  intersection() { children(); union() { board_pcb(); board_io(); } }
  intersection() { children(); cooler_env(); }
  intersection() { children(); psu_env(); }
}

// One part by name, for the "pair" check.
module pick(n) { if (n == "base") base(); else if (n == "shell") shell(); else if (n == "top") top(); else if (n == "board") { board_pcb(); board_io(); } else if (n == "cooler") cooler_env(); else psu_env(); }

module printed(explode = 0) {
  color("SteelBlue") base();
  color("LightSteelBlue") translate([0, 0, explode]) shell();
  color("SlateGray") translate([0, 0, 2.2 * explode]) top();
}
module purchased() {
  color("DarkGreen") { board_pcb(); board_io(); }
  color("Gold") standoffs();
  color("DimGray") cooler_env();
  color("DarkOrange") psu_env();
}

if (part == "base") base();
else if (part == "shell") shell();
else if (part == "top") translate([0, 0, H]) mirror([0, 0, 1]) top();   // printed lip up
else if (part == "interference") {
  // Any solid here means a printed part overlaps another part when assembled.
  // Parts that rest on another are lifted 0.01 mm so face contact does not count.
  intersection() { shell(); translate([0, 0, 0.01]) top(); }
  intersection() { base(); translate([0, 0, 0.01]) shell(); }
  against_purchased() translate([0, 0, -0.01]) base();
  against_purchased() shell();
  against_purchased() top();
}
else if (part == "standoff-fit") {
  // The board's holes, less the bosses under them: empty means every hole lands on a boss.
  difference() { board_holes_env(boss_h); for (p = board_holes) hole(boss_d, boss_h, [bx + p[0], by + p[1], wall]); }
}
else if (part == "io-fit") {
  // Rear connectors against the back wall: empty means they pass through its openings.
  intersection() { union() { board_io(); psu_env(); } shell(); }
}
else if (part == "pair") intersection() { pick(pair[0]); pick(pair[1]); }
else { printed(60 * $t); purchased(); }
