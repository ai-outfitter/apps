# Assembly power budgets

Tier 4: an Artera prototype builder inspects electrical demand across a rack,
Xylem and a nested manipulator before designing its PCBs.

`Assembly.power` stores versioned scenario definitions and a supply-rail tree.
`Item.power.loads` stores **only that item's own electrical input** per instance,
with a source, evidence class and average/operating/simultaneous-running-peak
watts for each scenario. Parent records must not contain child subtotals.
Unknown measurements are null, not zero. Absence of a power model is shown
explicitly; it does not establish zero load.

`powerRollup` walks usage quantities from the viewed item, sums each placed load
once, and propagates it through the supply tree by dividing by each conversion
efficiency. Rail rows include descendants and are **not additive**. The total is
the single source-boundary row. Daily energy is the defined 24-hour average
multiplied by 24. Current is derived only for DC rails; AC requires power factor.
Converter input is derived, never stored as a duplicate load. A regulator already
included in a board's input estimate is documented, not added as another load.

The Power panel follows the viewed assembly/part. Values are editable per part
instance and saved through the existing revision-checked project API. A shared
part edit applies to all its occurrences. Scenarios, rail efficiencies, sources
and assumptions persist with the assembly and also travel in build manifests.
The graph schema exposes these fields through SaveWorkshopAssembly.

Current project views use the saved project assembly and its geometry build's
artifacts. Explicit build links and revision-history selection inspect immutable
manifest snapshots read-only. Older builds without power data remain without it.
New build producers should include the power model in their assembly manifest;
a new CAD build is not implicitly treated as having a validated previous power
budget. In Artera, `code/plant-pod/power-budget/workshop.py` generates the budget
attachment from Luna's inputs without changing geometry or BOM quantities.

Artera climate entries are fixed scenario estimates, not a dynamic thermal
solver. Editing lighting or motion changes electrical rollups immediately, but
requires regenerating the cooling estimate from the source budget. Peak is a
simultaneous running scenario, not a verified compressor/startup surge rating.
Planning climate appliances remain clearly labeled allowances rather than
silently becoming selected COTS parts.

Validation: `power.unit.test.ts` covers nested/shared quantities, conversion
losses, unknown data, JSON round trips and invalid electrical references.
`power.integration.test.ts` checks actual packaged-app save/read and revision
conflicts. Local browser acceptance includes scenario switching, subtree views,
edit/save/reload/restore, immutable history and mobile overflow.
