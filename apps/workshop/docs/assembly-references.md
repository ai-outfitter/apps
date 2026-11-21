# Shared assemblies

Workshop resolves references within one installation. Each source owns its CAD, part numbers, children and direct loads. A consumer owns the quantity and placement on the usage that mounts the source.

1. Read the source with `graph_query`, document `WorkshopAssembly`, variables `{projectId}`, and `includeIdentifiers: true`. Save its assembly with `UpdateWorkshopAssembly(projectId, expectedRevision, assembly)`.
2. To publish named variants, set `assembly.configurations` on the source. Each configuration selects a saved assembly root. For example, rack and compact roots can both contain usages of the same gripper item. This example binds a numeric parameter to a usage's X position in millimetres. The resulting coordinate is `offset + scale × value`.

   ```json
   {
     "name": "compact",
     "rootId": "<compact root UUID>",
     "parameters": [{
       "name": "jawGap", "min": 0, "max": 22, "defaultValue": 16,
       "placements": [{
         "parentId": "<hand UUID>", "usageId": "<right jaw usage UUID>",
         "axis": "x", "offset": 20, "scale": 0.5
       }]
     }]
   }
   ```

3. In the consumer's saved assembly, mount an assembly item with a `reference`. Use a regular usage of this item for each physical instance. Replace any former local usage of the same hardware to avoid counting two instances. Geometry, loads and children belong to the source.

   ```json
   {
     "id": "<local mount UUID>", "name": "Crop manipulator",
     "number": "ARM-MOUNT", "revision": "A", "kind": "assembly",
     "reference": {
       "projectId": "<manipulator project UUID>",
       "configuration": "compact", "parameters": {"jawGap": 12}
     }
   }
   ```

4. Inspect the expanded view with `graph_query`, document `ResolvedWorkshopAssembly`, variables `{"input":{"projectId":"<consumer UUID>"}}`, and `includeIdentifiers: true`. Its result contains the consumer revision, resolved assembly, source revisions and source mesh locations. Use the original `WorkshopAssembly` result for replacement saves. Models, assembly, BOM and Power resolve the source graph on reopening.

Omitting `configuration` selects the source's ordinary root. Omitting `revision` follows the current source. An integer `reference.revision` pins the source's authored assembly and configuration at that project save. Nested references follow their own revision settings. Current saves and revisions archived since the references migration can be pinned. Earlier edits have no retroactive snapshots.

Direct loads follow physical usage quantities. Powered sources share scenario IDs and the source boundary rail. Rails with the same ID must agree on parent, voltage, kind and efficiency. Imported power inputs are edited in the owning project. Build manifests capture resolved parts for historical playback. Cycles, missing source records or roots, unknown configurations and out-of-range parameters are refused.

Set an item's optional `opacity` from 0 (transparent) to 1 (opaque) alongside its hex `color`. Set color, opacity, and quoted prices on the source item. Consumers inherit them for both authored CAD and imported meshes.

The BOM and the resolved MCP result report the price for one installed assembly. `buildPrice.knownSubtotal` is in USD. `unpricedUnits` counts installed physical units still missing a price. Set `priceKnown: true` to include a unit cost, including an explicit zero. A quoted assembly covers all its contents. Use optional `item.estimatedUnitCost` for a USD estimate, including zero. Known prices take precedence over estimates. Estimates contribute to `buildPrice.estimatedSubtotal`. A priced assembly covers its contents once; an assembly with neither price rolls up its children at installed quantities.

### Saved rack drive motion

Save the optional `driveMotion` object on the owning assembly item in the source project, using `WorkshopAssembly` followed by `UpdateWorkshopAssembly` at the revision read. All identifiers in the authored object belong to that source. For a rack configuration, include the rack root item ID in `viewRootIds`. Containing chambers and vehicles inherit playback automatically. Configurations without that installed root retain their own behavior.

```json
{
  "version": 1,
  "viewRootIds": ["<rack root item UUID>"],
  "z": {
    "levels": [{"label": "Lower", "offset": 0}, {"label": "Upper", "offset": 70}],
    "translationUsageIds": ["<carriage placement UUID>"],
    "rotations": [{
      "usageId": "<shaft placement UUID>",
      "axis": [1, 0, 0],
      "pivot": [0, 0, 0],
      "radiansPerMillimeter": 0.08975979010256552
    }]
  }
}
```

Offsets are millimetres along the mounted rack’s Z axis. Supply 2–16 levels in strictly increasing offset order. Each translation usage moves its placed descendants. Each rotation usage must identify one saved leaf solid with geometry or a mesh; axis and pivot are in that solid’s own coordinates (unit vector and millimetres). The nonzero signed rotation rate is radians per millimetre of travel. A shared part on another usage remains stationary. Each referenced usage ID must be unambiguous within the owner. `ResolvedWorkshopAssembly` remaps both root and usage IDs; use the authored source IDs for saves.

### Named operations and installed joints

For a robotics team coordinating a tray and gripper (tier 4), read the authored record with
`WorkshopAssembly(projectId)` and `includeIdentifiers:true`. Save the complete assembly
with `UpdateWorkshopAssembly(projectId, expectedRevision, assembly)`. On a conflict,
reread before retrying. Use the source project's usage IDs for edits across references.

* Put `joint: {kind, axis, pivot?}` on an installed usage in `item.uses`. A prismatic
  joint translates in mm. A revolute joint rotates in degrees by the right-hand rule.
  The unit axis and optional pivot (mm, default origin) are local to the installed
  part at rest, after its configured placement. Nest joints to compose axes.
* Put `operations` on the source assembly item that contains all participants.
  Give each operation a unique name within that item. Each track targets one installed joint.
  The path is relative to the owner, one saved usage UUID and zero-based quantity
  index per segment, separated by slashes. At a project reference, continue with the
  configured source root's usages. Use the same convention for prop and carrier paths.
* Keys start at time zero with value zero, advance strictly in seconds and end at or
  before the positive duration. Values interpolate linearly and hold after the last key.
* At each handoff the prop retains its pose. Its whole subtree follows the new carrier
  from that instant. Omit the carrier to leave the prop in the owner's frame. Events
  for each prop advance strictly. Props cannot contain another prop or a carrier.

For example, replace the placeholders below with actual usage UUIDs. The tool picks up
the tray at 1 s and leaves it in place at 3 s.

```json
{
  "name": "Harvest",
  "durationSeconds": 4,
  "tracks": [
    {"path": "<arm>#0/<slide>#0", "keys": [{"time":0,"value":0},{"time":3,"value":60}]},
    {"path": "<arm>#0/<slide>#0/<wrist>#0", "keys": [{"time":0,"value":0},{"time":2,"value":90}]}
  ],
  "handoffs": [
    {"time":1,"propPath":"<tray>#0","carrierPath":"<arm>#0/<slide>#0/<wrist>#0"},
    {"time":3,"propPath":"<tray>#0"}
  ]
}
```

In the overview, open Motion and select the operation for the installed assembly.
Play advances to the end. Drag Time to inspect an instant or choose Reset operation
to restore the saved pose. Selecting a moving solid still opens its part details.
Legacy drive motion is available in the same selector when both are present.

### Inspecting an installation

Open **Components**, select a lid or cover, and choose **Hide component**. If the
same item is installed several times, choose its instance first. **Show component**
restores that installation. **Restore assembly** restores all hidden components
and closes inspection hinges. Reloading opens the assembled view again.
These controls change only the viewer. The BOM and power tabs show the assembly
being inspected while components are hidden or hinges are open.

For a hinged door, add `openDegrees` to its installed usage's revolute joint,
for example `{"kind":"revolute","axis":[0,0,1],"pivot":[0,0,0],"openDegrees":95}`.
Use a signed, nonzero angle between −360° and 360°. **Open hinge** adds the
inspection angle to the current pose so the door can travel with a playing
assembly. **Close hinge** removes that offset.

**Sizing** shows the assembled CAD extents in mm, numeric configuration inputs,
and build parameters when present. **Preview configuration** opens the resolved
configuration with the entered values. **Request build with parameters** submits
the typed inputs through the existing workspace build request.
