# SNY-1 enclosure

Tier 2 of [docs/vision.md](../../docs/vision.md). Persona: Sunny, putting a solar soil-moisture, CO2 and light sensor outside in a Texas summer. The printed base and lid are those of Workshop's starter assembly (`src/lib/sensor-node.ts`), written out in `enclosure.scad` so the workspace build can slice and simulate them. Change both together.

`workspace.json` runs the build's quality checks (box/README.md, "Quality checks and studies"):

| Check | Result |
| --- | --- |
| Bed fit | Base 140 x 95 x 35 mm and lid fit a 220 mm bed |
| Plastic | Base 82 g (6 h 51 min), lid 29 g (2 h 36 min) in PETG at 20% infill |
| Interference | Base and lid touch and do not overlap |
| Full sun | With the sun overhead (1000 W/m2, 90% absorbed under the dark panel, 50% on the tan lid), 40 C air and light wind, the lid reaches about 93 C and the air inside about 55 C. That fails PETG's 68 C heat deflection at the lid, the SCD41's 50 C limit and LiFePO4's 45 C charging limit |

The full-sun study is a first estimate: radiation and wind share one 15 W/(m2 K)
film, the inside air is well mixed at 3 W/(m2 K), and the panel is not modelled
as its own part. It says the enclosure needs shade, a lighter lid, vents or a
gap under the panel before a field test, and the field test is still the evidence.
