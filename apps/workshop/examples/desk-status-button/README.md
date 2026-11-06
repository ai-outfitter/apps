# Desk status button: independent development example

Goal: use a USB-powered ESP32 development board to toggle an LED with one button.

The app's starter supplies the brief and an enclosure study. Select an exact development board, record its pin map and supply requirements, and select a suitable current-limiting resistor for the actual LED. The example deliberately has no guessed pin assignments or fabricated bench results.

1. Compare existing button devices and open designs in Research & sourcing.
2. Record exact COTS parts and their source documents.
3. Wire the chosen board, button and LED on a breadboard and build firmware for that exact board.
4. Use the Device console to observe USB serial output. Record repeated presses, debounce behavior, and the state after restart. Include the firmware commit, wiring description, and operator in a Breadboard observation.
5. After a passing result, compare keeping the breadboard, using perfboard, and designing a carrier.

## Optional KiCad MCP

`catalog/apps/workshop/examples/desk-status-button/mcp.example.json` is an optional, version-pinned local configuration. It is not auto-enabled. Install and verify the server in an isolated project tool environment before connecting an agent. Use it to inspect the exact parts, nets, board outline, and design changes; keep KiCad source files and reports in Git. The MCP is an editing interface, not the acceptance authority.

The first draft does not bundle KiCad or the MCP runtime, and does not claim an MCP integration smoke test. Add KiCad to the declared development environment for PCB work, then run:

```sh
npm run workshop:pcb-check -- project.json electronics/design.kicad_sch electronics/design.kicad_pcb exports/pcb-checks
```

This command requires a recorded breadboard pass and runs ERC/DRC with nonzero exit status on violations. A passed check is followed by independent schematic/layout review, mechanical fit checks, fabrication export, and physical bring-up. No purchasing or manufacturing submission is automated.
