# Workshop examples

Hand-built projects that show a rung of the ambition ladder in
[docs/vision.md](../docs/vision.md) before the design agent can reach it.

| Example | Tier | Persona and project |
| --- | --- | --- |
| `mini-itx-case` | 2 | A home-lab builder printing a case around a Mini-ITX board, a cooler and a Flex ATX power supply, with fit checks for the holes and openings |
| `sny-1-enclosure` | 2 | Sunny's soil sensor node: the printed base and lid of the starter assembly, sliced and studied in full sun |
| `desk-status-button` | 2 | A maker wiring an ESP32 button and LED, then deciding whether it needs a carrier board |
| `spinning-wheel` | 3 | A robotics team's first moving joint: a wheel that turns on a fixed axle and stays on |
| `gear-pair` | 3 | The same team's first drive train: a 2:1 reduction whose teeth never collide while it turns |

The case and both tier 3 examples carry an `interference` part: the overlap between parts
at rotation `$t`, which must render empty at every step. Those checks are the
seed of the assembly evals.

`mini-itx-case` and `sny-1-enclosure` also carry a `workspace.json` that the
workspace build runs as quality checks: bed fit and grams from PrusaSlicer,
interference from the assembly, and a CalculiX study each (box/README.md,
"Quality checks and studies").
