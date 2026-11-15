"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// test-entry.ts
var test_entry_exports = {};
__export(test_entry_exports, {
  differences: () => differences,
  digest: () => digest,
  parseSolveInput: () => parseSolveInput,
  tile: () => tile
});
module.exports = __toCommonJS(test_entry_exports);

// upstream/src/lib/solver/plan/__fixtures__/digest.ts
var port = (p) => ({ nodeId: p.node, portIndex: p.port, input: p.input });
var external = (e) => ({ port: port(e.port), ratePerSecond: e.ratePerSecond });
var key = (k) => ({ gateAnchors: k.gateAnchors.map(port) });
var setSorted = (xs) => [...xs].sort((a, b) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
});
var note = (n) => ({ message: n.message, args: n.args.map(noteArg) });
var noteArg = (a) => typeof a === "object" ? Array.isArray(a) ? a.map(note) : note(a) : a;
var readout = (d) => ({
  rates: d.rates,
  unmet: d.unmet,
  shortfalls: d.shortfalls.map((s) => ({
    drawer: s.drawer,
    rule: s.rule,
    target: s.target,
    reachable: s.reachable,
    limitingNodes: setSorted(s.limitingNodes),
    limitingDrawers: setSorted(s.limitingDrawers),
    limitingGroups: s.limitingGroups
  })),
  ports: Object.fromEntries(Object.entries(d.ports).map(([id, list]) => [id, list.map(external)])),
  // What a buffer banks only when the plan banks (Up to plans): every golden before it reads the same.
  ...d.banked !== void 0 ? { banked: d.banked } : {}
});
var upToReadout = (r) => ({
  node: r.node,
  machines: r.machines,
  capacity: r.capacity,
  reached: r.reached,
  reason: r.reason,
  port: r.port === void 0 ? null : port(r.port),
  tied: (r.tied ?? []).map(port),
  wants: r.wants ?? null,
  upstream: r.upstream ?? []
});
var bearer = (b) => ({
  anchor: port(b.anchor),
  flows: b.flows.map(external),
  max: b.max,
  share: b.share,
  solverPick: b.solverPick
});
var leftover = (l) => ({
  key: l.key,
  importing: l.importing,
  bearers: l.bearers.map(bearer),
  custom: l.custom
});
var alternative = (a) => ({
  key: key(a.key),
  replaces: port(a.replaces),
  opens: port(a.opens),
  externals: a.externals.map(external),
  rank: a.rank
});
function solutionDigest(s) {
  return {
    extentsPerSecond: s.extentsPerSecond,
    machineCounts: s.machineCounts,
    edgeFlowsPerSecond: s.edgeFlowsPerSecond,
    gatedSources: s.gatedSources.map(external),
    gatedSinks: s.gatedSinks.map(external),
    terminalInputs: s.terminalInputs.map(external),
    terminalOutputs: s.terminalOutputs.map(external),
    unneeded: setSorted(s.unneeded),
    openGates: s.openGates,
    externalQuantity: s.externalQuantity,
    totalInternalFlow: s.totalInternalFlow,
    notes: s.notes.map(note),
    key: key(s.key),
    drawers: readout(s.drawers),
    spares: s.spares.map(leftover),
    // The Up to read-out only when the plan has Up to pools: every golden before it reads the same.
    ...s.upTo !== void 0 ? { upTo: s.upTo.map(upToReadout) } : {},
    // Its rings only when there are some: every golden before them reads the same.
    ...s.upToLoops !== void 0 ? {
      upToLoops: s.upToLoops.map((l) => ({
        kind: l.kind,
        nodes: l.nodes,
        ports: l.ports.map(port)
      }))
    } : {}
  };
}
function alternativesDigest(a) {
  return {
    chosen: a.chosen === null ? null : key(a.chosen),
    options: a.options.map(alternative),
    complete: a.complete,
    notes: a.notes.map(note)
  };
}
function digest(answer) {
  if (answer.kind !== "solved") throw new Error(`answer failed: ${JSON.stringify(answer.failure)}`);
  return {
    solution: solutionDigest(answer.solution),
    alternatives: alternativesDigest(answer.alternatives)
  };
}

// upstream/src/lib/solver/plan/__fixtures__/compare.ts
var TOLERANCE = 1e-6;
function numbersEqual(p, q) {
  if (p === q) return true;
  if (Number.isNaN(p) && Number.isNaN(q)) return true;
  return Math.abs(p - q) <= TOLERANCE * Math.max(1, Math.abs(p), Math.abs(q));
}
function differences(expected, actual, limit = 50) {
  const out = [];
  walk(expected, actual, "$", out, limit);
  return out;
}
function walk(e, a, at, out, limit) {
  if (out.length >= limit) return;
  if (typeof e === "number" && typeof a === "number") {
    if (!numbersEqual(e, a)) out.push(`${at}: expected ${e}, got ${a}`);
    return;
  }
  if (Array.isArray(e) || Array.isArray(a)) {
    if (!Array.isArray(e) || !Array.isArray(a)) {
      out.push(`${at}: array vs non-array`);
      return;
    }
    if (e.length !== a.length) {
      out.push(`${at}: length expected ${e.length}, got ${a.length}`);
      return;
    }
    for (let i = 0; i < e.length; i++) walk(e[i], a[i], `${at}[${i}]`, out, limit);
    return;
  }
  if (e !== null && a !== null && typeof e === "object" && typeof a === "object") {
    const eo = e;
    const ao = a;
    const ek = Object.keys(eo).sort();
    const ak = Object.keys(ao).sort();
    const missing = ek.filter((k) => !(k in ao));
    const extra = ak.filter((k) => !(k in eo));
    if (missing.length || extra.length) {
      out.push(
        `${at}: keys differ (missing ${JSON.stringify(missing.slice(0, 5))}, extra ${JSON.stringify(extra.slice(0, 5))})`
      );
      return;
    }
    for (const k of ek) walk(eo[k], ao[k], `${at}.${k}`, out, limit);
    return;
  }
  if (e !== a) out.push(`${at}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

// upstream/src/lib/solver/plan/__fixtures__/load.ts
var import_node_crypto = require("node:crypto");
var import_node_path = __toESM(require("node:path"), 1);
var CORPUS_DIR = import_node_path.default.join(__dirname, "corpus");
var f32 = Math.fround;
function parseSolveInput(raw) {
  const o = raw;
  if (o.mode !== "AUTO") throw new Error(`unsupported mode ${String(o.mode)}`);
  const port2 = (p) => ({
    amount: p.amount,
    chance: f32(p.chance),
    multiplier: p.multiplier,
    resource: p.resource,
    name: p.name,
    free: p.free
  });
  const machines = o.machines.map(
    (m) => ({
      id: m.id,
      name: m.name,
      durationTicks: m.durationTicks,
      energyPerTick: m.energyPerTick,
      throughputFactor: m.throughputFactor,
      inputs: m.inputs.map(port2),
      outputs: m.outputs.map(port2),
      countFixed: m.countFixed,
      machineCount: m.machineCount,
      targetOutputRates: { ...m.targetOutputRates ?? {} },
      targetInputRates: { ...m.targetInputRates ?? {} }
    })
  );
  return {
    mode: "AUTO",
    choice: o.choice ?? null,
    machines,
    edges: o.edges.map((e) => ({ ...e })),
    pools: (o.pools ?? []).map((p) => ({ ...p, machines: [...p.machines] })),
    drawers: (o.drawers ?? []).map((d) => ({
      ...d,
      links: d.links.map((l) => ({ ...l })),
      ...d.takers ? { takers: d.takers.map((l) => ({ ...l })) } : {}
    })),
    extentPins: { ...o.extentPins ?? {} },
    spares: JSON.parse(JSON.stringify(o.spares ?? {}))
  };
}
function nameUuidFromBytes(bytes) {
  const md5 = (0, import_node_crypto.createHash)("md5").update(bytes).digest();
  md5[6] = md5[6] & 15 | 48;
  md5[8] = md5[8] & 63 | 128;
  const h = md5.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function tile(input, copies) {
  const rename = (c, u) => c === 0 ? u : nameUuidFromBytes(Buffer.from(`${c}:${u}`, "utf8"));
  const machines = [];
  const edges = [];
  const pools = [];
  const drawers = [];
  const extentPins = {};
  const spares = {};
  for (let c = 0; c < copies; c++) {
    const r = (u) => rename(c, u);
    for (const m of input.machines) machines.push({ ...m, id: r(m.id) });
    for (const e of input.edges) edges.push({ ...e, id: r(e.id), source: r(e.source), target: r(e.target) });
    for (const p of input.pools) pools.push({ ...p, machines: p.machines.map(r) });
    for (const d of input.drawers)
      drawers.push({
        ...d,
        id: r(d.id),
        links: d.links.map((l) => ({ ...l, node: r(l.node) })),
        ...d.takers ? { takers: d.takers.map((l) => ({ ...l, node: r(l.node) })) } : {}
      });
    for (const [k, v] of Object.entries(input.extentPins)) extentPins[r(k)] = v;
    const rekey = (key2) => c === 0 ? key2 : key2.replace(UUID_RE, (u) => r(u));
    for (const [lk, bearers] of Object.entries(input.spares)) {
      const out = {};
      for (const [bk, share] of Object.entries(bearers)) out[rekey(bk)] = share;
      spares[rekey(lk)] = out;
    }
  }
  return { mode: "AUTO", choice: null, machines, edges, pools, drawers, extentPins, spares };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  differences,
  digest,
  parseSolveInput,
  tile
});
