import { type BomRow, bomRows, bomTotals, type Item } from "../lib/assembly";
import type { Project } from "../lib/project";
import type { Unit } from "../server/units";
import { createAssemblyViewer } from "./assembly-viewer";
import { fixtureUnits } from "./fixtures";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => {
  const node = document.querySelector<T>(s);
  if (!node) throw new Error(`Missing element: ${s}`);
  return node;
};
const cell = (text: string, className = "") => {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className;
  return td;
};
// A build-time constant, so the demo bundle carries no API calls.
const readOnly = import.meta.env.OUTFITTER_APP_MODE === "demo";
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const KIND_LABELS: Record<string, string> = {
  assembly: "Assembly",
  printed: "Printed",
  cots: "COTS",
  pcb: "PCB",
  firmware: "Firmware",
};
const firmwareLabel = ({ target, ref, path, repository }: NonNullable<Item["firmware"]>) =>
  [target, ref, path, repository ? "" : "repository not set"].filter(Boolean).join(" · ");
const STATUS_LABELS: Record<string, string> = {
  "in-stock": "In stock",
  allocated: "Allocated",
  installed: "Installed",
  retired: "Retired",
};

/** The Assembly & inventory tab: the indented BOM, the whole assembly in 3D,
 * and the units in stock for each part number. */
export function createAssemblyPanel(notice: (message: string) => void) {
  let viewer: ReturnType<typeof createAssemblyViewer> | undefined;
  let units: Unit[] = [];
  let project: Project | undefined;
  let selected: string | undefined;

  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (readOnly) return (method === "GET" ? fixtureUnits() : undefined) as T;
    const res = await fetch(`/api/apps/workshop/units${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as T;
  }

  function renderBom(p: Project) {
    const rows = bomRows(p.assembly);
    const top = rows[0]?.item;
    $("#assembly-empty").hidden = rows.length > 0;
    $("#assembly-title").textContent = top ? `${top.number} · REV ${top.revision} · ${top.name.toUpperCase()}` : "ASSEMBLY";
    $("#assembly-total").textContent = money(bomTotals(p.assembly).cost);
    $("#bom-list").replaceChildren(...rows.map(bomRow));
  }

  function bomRow({ item, depth, quantity, refdes }: BomRow) {
    const tr = document.createElement("tr");
    tr.dataset.item = item.id;
    tr.tabIndex = 0;
    tr.classList.toggle("selected", item.id === selected);
    const number = cell("");
    const indent = document.createElement("span");
    indent.className = "indent";
    indent.style.width = `${depth * 16}px`;
    number.append(indent, `${item.number} ${item.revision}`);
    const name = cell(item.name);
    const detail = item.firmware ? firmwareLabel(item.firmware) : item.notes;
    if (detail) {
      const small = document.createElement("small");
      small.textContent = detail;
      name.append(small);
    }
    const inStock = units.filter((u) => u.partNumber === item.number && u.status === "in-stock").length;
    tr.append(
      number,
      name,
      cell(KIND_LABELS[item.kind]),
      cell(String(quantity)),
      cell(refdes),
      cell([item.manufacturer, item.mpn].filter(Boolean).join(" · ")),
      cell(item.trackBy === "none" ? "" : `${inStock} · by ${item.trackBy === "mac" ? "MAC" : "serial"}`),
    );
    return tr;
  }

  function renderUnits(p: Project) {
    const tracked = p.assembly.items.filter((item) => item.trackBy !== "none");
    const select = $<HTMLSelectElement>("#unit-part");
    select.replaceChildren(...tracked.map((item) => new Option(`${item.number} · ${item.name}`, item.number)));
    const numbers = new Set(p.assembly.items.map((item) => item.number));
    const list = units.filter((u) => numbers.has(u.partNumber));
    $("#unit-list").replaceChildren(
      ...(list.length
        ? list.map((unit) => {
            const tr = document.createElement("tr");
            const action = cell("");
            if (!readOnly) {
              const remove = document.createElement("button");
              remove.textContent = "Remove";
              remove.className = "remove";
              remove.dataset.unit = unit.id;
              remove.setAttribute("aria-label", `Remove ${unit.mac ?? unit.serial}`);
              action.append(remove);
            }
            tr.append(
              cell(unit.partNumber),
              cell(unit.mac ?? unit.serial ?? ""),
              cell(STATUS_LABELS[unit.status] ?? unit.status),
              cell(unit.location),
              cell(unit.firmware),
              action,
            );
            return tr;
          })
        : [
            (() => {
              const tr = document.createElement("tr");
              const td = cell(tracked.length ? "No units recorded yet." : "No tracked parts in this assembly.");
              td.colSpan = 6;
              tr.append(td);
              return tr;
            })(),
          ]),
    );
  }

  function render() {
    if (!project) return;
    renderBom(project);
    renderUnits(project);
  }

  const form = $<HTMLFormElement>("#unit-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (readOnly || !project) return;
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const item = project.assembly.items.find((i) => i.number === values.partNumber);
    try {
      $("#unit-status").textContent = "Adding…";
      const unit = await request<Unit>("", "POST", {
        partNumber: values.partNumber,
        mpn: item?.mpn ?? "",
        ...(values.mac ? { mac: values.mac } : {}),
        ...(values.serial ? { serial: values.serial } : {}),
        status: values.status,
        location: values.location,
        projectId: values.status === "in-stock" ? null : project.id,
        firmware: values.firmware,
      });
      units.push(unit);
      form.reset();
      $("#unit-status").textContent = `Added ${unit.mac ?? unit.serial}.`;
      render();
    } catch (e) {
      $("#unit-status").textContent = "";
      notice((e as Error).message);
    }
  });
  $("#unit-list").addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-unit]");
    const unit = units.find((u) => u.id === button?.dataset.unit);
    if (!unit || readOnly || !confirm(`Remove ${unit.mac ?? unit.serial} from inventory?`)) return;
    try {
      await request(`/${unit.id}`, "DELETE", { revision: unit.revision });
      units = units.filter((u) => u.id !== unit.id);
      render();
    } catch (e) {
      notice((e as Error).message);
    }
  });
  const choose = (row: HTMLElement | null) => {
    if (!row?.dataset.item || !project) return;
    selected = selected === row.dataset.item ? undefined : row.dataset.item;
    viewer?.select(selected);
    renderBom(project);
  };
  $("#bom-list").addEventListener("click", (event) => choose((event.target as HTMLElement).closest("tr")));
  $("#bom-list").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose((event.target as HTMLElement).closest("tr"));
    }
  });
  $("#assembly-reset").addEventListener("click", () => viewer?.reset());

  return {
    /** Shows a project's assembly; loads the inventory the first time. */
    async show(p: Project) {
      if (project?.id !== p.id) selected = undefined;
      project = p;
      render();
      try {
        viewer ??= createAssemblyViewer($<HTMLCanvasElement>("#assembly-viewer"), (message) => {
          $("#assembly-status").textContent = message;
        });
        viewer.select(selected);
        void viewer.render(p.assembly);
      } catch (e) {
        $("#assembly-status").textContent = (e as Error).message;
      }
      try {
        units = await request<Unit[]>("");
        if (project === p) render();
      } catch (e) {
        notice((e as Error).message);
      }
    },
    dispose() {
      viewer?.dispose();
      viewer = undefined;
    },
  };
}
