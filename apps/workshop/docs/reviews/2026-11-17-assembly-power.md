# Assembly and power integration review

Scope: Tier 4 Artera prototype builder, saved assembly browsing/motion, supplier
profile extrusions and per-assembly power budgeting, integrated on current main.
The source checkout and PCB-owned work were preserved. Existing main's validated
workspace workflow authority is unchanged.

Claude ran read-only code-review (medium) and Simplify. Simplify used a single
pass because agent fan-out was unavailable under the restricted tool set. The
initial fork could not read the external patch file, so it reviewed touched files;
the targeted follow-up read an in-checkout patch. No review session could write,
commit or execute shell commands. Tests were run separately by the integrating agent.

All nine initial findings were corrected; the follow-up confirmed those fixes.
Its four remaining low-severity findings were then corrected directly: source
fetch status/abort handling, preserving the missing historical assembly notice,
a clear missing-root power message, and preserving geometry provenance in the
revision label after saves. Optional performance/refactoring suggestions remain
deferred.

## Initial review

I've reviewed the change without editing anything: no files changed, nothing committed, merged or deployed.

**What actually ran and what didn't**
- **`/code-review` (medium)** ran in a forked context. It couldn't open `/tmp/workshop-integration-review.patch` because the file tools only reach this checkout, and there's no shell for `git diff`. So it reviewed the staged files whole, and some findings may sit in unchanged lines of touched files. I re-checked its findings myself below.
- **`/simplify`** could only do the review part, in one pass in this context. It has no subagent tool here, so the usual 4-agent version didn't run. It normally applies its fixes; that was skipped because the session is read-only.
- Plan mode wanted a plan file and an approval step, but neither tool is available to me, so this message is the whole review.

The server still blocks page saves from changing build records: `server/projects.ts:142-145` rejects any PUT where `workspace` differs. The page still imports the viewer only on the assembly section and disposes it on abort (`workspace.ts:41-50`).

## Concrete bugs

| # | Sev | Evidence | Problem | Minimal fix |
|---|---|---|---|---|
| 1 | **High (provenance/security)** | `assembly-viewer.ts:178-180`, `assembly.ts:64` | `item.mesh.path` is any string up to 300 characters. It's fetched as `artifactBase + path` with no hash check and no match against the build's artifact list. When there's no build, `artifactBase` is `""` (`workspace.ts:100`), so a saved path can point at another origin or a page-relative URL. Saved motion files get a sha256 check (`workspace.ts:106-110`); meshes don't. | Only load a mesh that matches an artifact in `manifest.artifacts`, and check its sha256 and size the same way motion files are checked. Restrict the path to something like `^[\w.-]+(/[\w.-]+)*$` with no `..`. With no build, show "mesh not built" instead of fetching. |
| 2 | Medium | `assembly-viewer.ts:142` vs `:239` | `highlight()` resets every node's visibility, so any `select()` or `inspectDrive()` cancels an active isolate. | Keep an `isolated` set in the viewer and compute visibility in one function that both `highlight` and `isolate` use. |
| 3 | Medium | `workspace.ts:92` | After saving power values, `showBuild(build)` rebuilds the whole page. The scenario dropdown resets to the first scenario, and the viewer and motion artifact reload for nothing. | After the save, call `renderPowerPanel` again with the current scenario passed in, or have `save` return so the panel re-renders itself. |
| 4 | Medium (provenance) | `workspace.ts:82` | A historical build with no saved assembly falls back to `project.assembly`. The page then shows the current geometry and power under a "Historical" label. The build's assembly is also used without re-parsing. | If the build has no assembly, say so instead of falling back. Parse the build's assembly with `AssemblySchema.safeParse` and show the error on failure. |
| 5 | Medium | `power-panel.ts:15,58`; `power.ts:65,71-72,80` | `powerRollup` can throw (cycle, missing item, missing scenario key), and nothing catches it. A throw at `workspace.ts:89` stops the rest of `showBuild`: viewer, BOM and breadcrumbs. | Wrap `render` in try/catch and show the error inside the panel. Fixing #4 removes most of the ways in. |
| 6 | Medium | `saved-drive-motion.ts:14` vs `workspace.ts:63-65` | Saved motion levels aren't required to be in ascending order, but playback assumes `levels[0]` is low and the last is high. Descending levels make the animation stick at one end. | Add a schema rule that offsets strictly increase, or use min/max of the offsets in `animate`. |
| 7 | Low-Med (unknown vs zero) | `power-panel.ts:18-25`, `power.ts:67,77-85` | With no load rows, the rail table still shows `0 W`, which contradicts the "does not establish zero" text. Placed parts with no power record are also silently counted as zero in the totals. | Hide the rail table when there are no rows. Add a coverage line, e.g. "N placed parts have no load record". |
| 8 | Low | `assembly-viewer.ts:182` | A render that gets superseded returns without disposing the STL geometries it already parsed. | Dispose everything in `external` before the early return. |
| 9 | Low | `workspace.ts:106,153,157` | The motion, source-preview and evidence fetches don't take the page's `signal`. The generation and `build` checks prevent wrong output, but the requests keep running after navigation. | Pass `{signal}` to each. |

I checked power conversion and double counting and found no bug there. Each rail gets its downstream demand, upstream rails get that divided by efficiency, the total comes only from the source rail, an unknown value makes the totals unknown, and part quantities multiply through nested assemblies. One note: "simultaneous running peak" is the sum of each load's peak, so it's conservative. The label could say that.

## Optional simplifications (not bugs)
- **Repeated tree walks:** `powerRollup`'s walk (`power.ts:70-76`), the isolate walk (`workspace.ts:182`) and `modelCatalog`'s `modeled` check (`model-catalog.ts:8`) each walk the assembly tree separately, without caching. Quantities could come from `bomTotals(modelView(a, rootId))`, and one cached descendants/quantity helper in `assembly.ts` could serve the rest. This also fixes the exponential cost with deeply shared sub-assemblies.
- **Per-frame allocation:** `savedMotionMatrix` (`saved-drive-motion.ts:45-47`) allocates 3 `Matrix4` and a `Vector3` per rotation every frame. Module-level scratch objects would avoid that.
- **Regex per rotation:** `saved-drive-motion.ts:35` builds a `RegExp` per rotation. A plain `endsWith` check on the path's last segment does the same job.
- **STL copies:** `geometry.clone()` per placement (`assembly-viewer.ts:188`) copies vertex data for every instance. Sharing one geometry per item and disposing it in `clear()` saves memory.
- **Sequential loading:** STL fetches run one after another and only after the worker finishes meshing (`:176-181`). Starting them together with `meshItems` would cut load time.
- **Large spreads:** `assemblyBounds` spreads every corner into `Math.min`/`Math.max`. A loop avoids the argument-count limit when quantities multiply into very large counts.

The tests most relevant to these fixes are `power.unit`/`power.integration` (#3, #5, #7), `saved-drive-motion.unit` (#6), `model-catalog.browser.spec` (#2, #4), and a new unit test for checking mesh artifacts against the build's artifact list (#1).

## Targeted follow-up

I rechecked all 9 findings against the current staged files, and all 9 are resolved. I made no edits, commits, merges or releases. I didn't run any tests, because I only have read-only file tools here.

## Original findings

| # | Status | Evidence |
|---|---|---|
| 1 | Resolved | `lib/artifact.ts:4-16` checks the path against a schema that rejects traversal. The base must match `/files/main/builds/<id>/<id>/`, which is the same form the server produces at `server/workspace.ts:50`. The mesh must be listed in the build's manifest under a path that starts with its own hash, and its size and sha256 must match. The runner already saves files that way (`box/workspace/build.py:31`). With no build the base is `""`, so the mesh is rejected before any fetch. The viewer uses this check at `assembly-viewer.ts:182`. |
| 2 | Resolved | The viewer keeps an `isolated` set (`assembly-viewer.ts:92`). `highlight()` works out visibility from both isolation and drive inspection (`:144`), so `select` and `inspectDrive` no longer cancel isolation. A new render clears it (`:167`). |
| 3 | Resolved | The save callback (`workspace.ts:93-96`) doesn't call `showBuild`. The panel stores the saved values and re-renders itself with the same scenario selected (`power-panel.ts:52`). The browser spec checks that `high` stays selected and that the saved value survives a reload. |
| 4 | Resolved | `workspace.ts:82-85` parses the assembly with `safeParse`. A historical build with no saved assembly shows `{items:[]}` and a notice instead of current project data. It can't fall back to the legacy box model because `legacy` requires `!historical`. |
| 5 | Resolved | The whole `render` is wrapped in try/catch, and errors show inside the panel (`power-panel.ts:14,59`). |
| 6 | Resolved | The schema requires offsets to strictly increase (`saved-drive-motion.ts:14`), and the computed preview sorts its levels (`artera-motion-preview.ts:18`). |
| 7 | Resolved | When there are no load rows, the panel returns before drawing the rail table (`:20`). Otherwise it shows a coverage line counting placed parts with no load record (`:21`; `power.ts:87`). |
| 8 | Resolved | A `finally` block disposes every parsed STL on success, when a newer render supersedes it, and on error (`assembly-viewer.ts:205`). Placed nodes use clones, so they aren't affected. |
| 9 | Resolved | The motion, source-preview and evidence fetches now pass `{signal}` (`workspace.ts:109,156,160`), and so does the STL fetch. |

The authority rule on main is unchanged: page saves still go through the PUT that rejects any change to `workspace`.

## Remaining defects (all low severity, none blocking)

1. **The source-preview button doesn't handle errors.** At `workspace.ts:156`, `await (await fetch(url,{signal})).text()` has no `ok` check and no catch. An error response body is shown as if it were source. Navigating away mid-request also leaves an unhandled AbortError. The fix is to check `response.ok` and wrap it in try/catch the way the evidence fetch does.
2. **The "no saved assembly" notice can be overwritten.** When a historical build has no assembly, the notice at `workspace.ts:85` is replaced if the URL also has `?item=` (`:101`). That item can't be found in an empty assembly, so the more useful provenance message is always lost in that case. The fix is to skip the "item not in this revision" notice when the assembly is missing.
3. **One error case shows a cryptic message.** `powerRollup(...)!` (`power-panel.ts:15`) returns `undefined` when power data exists but there's no root ID to start from. The try/catch then shows "Power budget unavailable: Cannot read properties of undefined…". Nothing crashes, but a check for `!result` with a clear message would read better.
4. **The revision label loses part of its text after a save.** `workspace.ts:95` sets it to `Project save N` and drops the `· geometry build xxxx` suffix that `:97` shows.

Nothing else is wrong. The optional simplifications from the first review are still deferred.
