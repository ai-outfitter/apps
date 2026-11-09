# Workshop examples

Hand-built projects that show a rung of the ambition ladder in
[docs/vision.md](../docs/vision.md) before the design agent can reach it.

| Example | Tier | Persona and project |
| --- | --- | --- |
| `desk-status-button` | 2 | A maker wiring an ESP32 button and LED, then deciding whether it needs a carrier board |
| `spinning-wheel` | 3 | A robotics team's first moving joint: a wheel that turns on a fixed axle and stays on |
| `gear-pair` | 3 | The same team's first drive train: a 2:1 reduction whose teeth never collide while it turns |

Both tier 3 examples carry an `interference` part: the overlap between parts
at rotation `$t`, which must render empty at every step. That check is the
seed of the moving-assembly eval.
