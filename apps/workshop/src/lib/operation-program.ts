import type { Assembly, AssemblyReference, Item } from "./assembly";
import type { Operation } from "./operation-schema";

type Keys = { time: number; value: number }[];
type Segment = { start: number; end: number; keys: Keys };
type Event = { time: number; propPath: string; carrierPath: string };
type Check = NonNullable<Operation["expectations"]>[number] & { frame: string };
type Coupling = NonNullable<Item["couplings"]>[number];
const join = (a: string, b: string) => (a && b ? a + "/" + b : a + b);

export function resolveMotionParameters(
  item: Item,
  configs: Assembly["configurations"],
  installed?: AssemblyReference,
): Item {
  if (
    !item.operations?.some((op) =>
      op.tracks.some((t) => t.keys.some((k) => k.parameter !== undefined)),
    )
  )
    return item;
  const selected = configs?.find((c) => c.name === installed?.configuration);
  function parameter(name: string) {
    const defaults = new Set(
      (selected ? [selected] : (configs ?? [])).flatMap((c) =>
        (c.parameters ?? [])
          .filter((p) => p.name === name)
          .map((p) => p.defaultValue),
      ),
    );
    if (defaults.size !== 1)
      throw Error("Missing or ambiguous operation parameter " + name);
    return installed?.parameters?.[name] ?? [...defaults][0];
  }
  return {
    ...item,
    operations: item.operations.map((op) => ({
      ...op,
      tracks: op.tracks.map((track) => ({
        ...track,
        keys: track.keys.map((k) =>
          k.parameter === undefined
            ? k
            : {
                time: k.time,
                value: k.value + k.scale! * parameter(k.parameter),
              },
        ),
      })),
    })),
  };
}

export function operationPrograms(items: Item[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  function walk(
    owner: Item,
    path: string,
    visit?: (item: Item, prefix: string, suffix: string) => void,
  ) {
    let item = owner,
      prefix = "";
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      visit?.(item, prefix, segments.slice(i).join("/"));
      const [id, copy] = segments[i].split("#");
      const usage = item.uses.find((u) => u.id === id);
      const child = usage && byId.get(usage.itemId);
      if (!usage || !child || Number(copy) >= usage.quantity)
        throw Error("Missing installed operation target " + path);
      item = child;
      prefix = join(prefix, segments[i]);
    }
    return item;
  }
  // A relationship can be declared on any common ancestor of its two installed endpoints.
  function links(
    owner: Item,
    path: string,
    match: "driverPath" | "followerPath",
  ) {
    const hits: Coupling[] = [];
    walk(owner, path, (item, prefix, suffix) => {
      for (const c of item.couplings ?? [])
        if (c[match] === suffix) {
          hits.push({
            ...c,
            driverPath: join(prefix, c.driverPath),
            followerPath: join(prefix, c.followerPath),
          });
        }
    });
    return hits;
  }
  function validateCouplings(owner: Item) {
    for (const c of owner.couplings ?? []) {
      let current: string | undefined = c.followerPath;
      const seen = new Set<string>();
      while (current) {
        if (seen.has(current))
          throw Error("Cyclic joint coupling on " + owner.number);
        seen.add(current);
        const sources = links(owner, current, "followerPath");
        if (sources.length > 1)
          throw Error("Several drivers for joint " + current);
        current = sources[0]?.driverPath;
      }
    }
  }

  function compile(owner: Item, operation: Operation) {
    const curves = new Map<string, Segment[]>(),
      events: Event[] = [],
      checks: Check[] = [];
    let work = 0;
    function charge(count: number) {
      work += count;
      if (work > 100000)
        throw Error("Expanded operation exceeds 100000 motion entries");
    }
    function visit(
      item: Item,
      op: Operation,
      prefix: string,
      start: number,
      scale: number,
    ) {
      // scale is signed; reverse calls use the parent's end as their local zero.
      charge(1);
      const when = (t: number) => start + t * scale;
      if (scale < 0 && op.handoffs?.length)
        throw Error("Cannot reverse a prop handoff");
      for (const t of op.tracks) {
        const path = join(prefix, t.path);
        const segments = curves.get(path) ?? [];
        charge(t.keys.length);
        const keys = t.keys.map((k) => ({
          time: when(k.time),
          value: k.value,
        }));
        if (keys.at(-1)!.time !== when(op.durationSeconds))
          keys.push({
            time: when(op.durationSeconds),
            value: keys.at(-1)!.value,
          });
        if (scale < 0) keys.reverse();
        segments.push({ start: keys[0].time, end: keys.at(-1)!.time, keys });
        curves.set(path, segments);
      }
      for (const e of op.handoffs ?? [])
        events.push({
          time: when(e.time),
          propPath: join(prefix, e.propPath),
          carrierPath: join(prefix, e.carrierPath ?? ""),
        });
      for (const e of op.expectations ?? [])
        checks.push({
          ...e,
          time: when(e.time),
          path: join(prefix, e.path),
          ...(e.kind === "distance" && {
            otherPath: join(prefix, e.otherPath),
          }),
          frame: prefix,
        });
      charge((op.handoffs?.length ?? 0) + (op.expectations?.length ?? 0));
      for (const call of op.calls ?? []) {
        const child = walk(item, call.path);
        const clip = child.operations?.find(
          (candidate) => candidate.name === call.operation,
        );
        if (!clip)
          throw Error(
            "Missing operation " + call.operation + " on " + child.number,
          );
        const duration = call.durationSeconds ?? clip.durationSeconds;
        if (call.startSeconds + duration > op.durationSeconds + 1e-9)
          throw Error("Child call exceeds parent duration");
        const origin = call.startSeconds + (call.reverse ? duration : 0);
        visit(
          child,
          clip,
          join(prefix, call.path),
          when(origin),
          (scale * (call.reverse ? -1 : 1) * duration) / clip.durationSeconds,
        );
      }
    }
    visit(owner, operation, "", 0, 1);
    const tracks = new Map<string, Keys>();
    for (const [path, segments] of curves) {
      if (links(owner, path, "followerPath").length)
        throw Error("Direct track conflicts with coupled joint " + path);
      const keys: Keys = [{ time: 0, value: 0 }];
      for (const s of segments.sort((a, b) => a.start - b.start)) {
        const last = keys.at(-1)!;
        if (s.start < last.time - 1e-9)
          throw Error("Overlapping operation tracks on " + path);
        if (Math.abs(last.value - s.keys[0].value) > 1e-9)
          throw Error("Discontinuous operation call on " + path);
        if (s.start > last.time + 1e-9) keys.push(s.keys[0]);
        for (const k of s.keys.slice(1)) keys.push(k);
      }
      tracks.set(path, keys);
    }
    // Map iteration visits newly appended followers, including multi-stage transmissions.
    for (const [path, keys] of tracks)
      for (const c of links(owner, path, "driverPath")) {
        if (tracks.has(c.followerPath))
          throw Error("Conflicting joint coupling on " + c.followerPath);
        charge(keys.length);
        tracks.set(
          c.followerPath,
          keys.map((k) => ({ time: k.time, value: k.value * c.ratio })),
        );
      }
    events.sort((a, b) => a.time - b.time);
    const previous = new Map<string, number>(),
      props = new Set(events.map((e) => e.propPath));
    for (const event of events) {
      if (event.time === previous.get(event.propPath))
        throw Error("Simultaneous handoffs for " + event.propPath);
      previous.set(event.propPath, event.time);
      for (const p of props)
        if (
          event.carrierPath === p ||
          event.carrierPath.startsWith(p + "/") ||
          event.propPath.startsWith(p + "/")
        )
          throw Error("Props cannot contain another prop or carrier");
    }
    return { tracks, events, checks };
  }
  return { compile, validateCouplings };
}
