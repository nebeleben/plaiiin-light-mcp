// src/preview/preview-worker.mjs
import vm from "node:vm";
var DRIVER = `
var __call = function (j) {
  try {
    var a = JSON.parse(j);
    var info = PLShade.parseAnnotations(a.source);
    if (a.op === 'inspect') return { info: info };
    var r = PLShade.makeRunner(a.source);
    var out = [];
    var start = a.start > 0 ? Math.floor(a.start) : 0;
    for (var f = start; f < start + a.frames; f++) {
      out.push(r.render({ w: a.w, h: a.h, frame: f, time: f * 1000 / a.fps, base: a.base, params: a.params }));
    }
    return { info: info, frames: out };
  } catch (e) {
    var msg;
    try { msg = String((e && e.name ? e.name + ': ' : '') + (e && e.message !== undefined ? e.message : e)); } catch (_) { msg = 'script error'; }
    return { error: msg };
  }
};
`;
var BLOCKED = [
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "WebAssembly",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Buffer",
  "FinalizationRegistry",
  "WeakRef"
];
var LOCKDOWN = `(function (g, names) {
  for (var i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(g, names[i])) delete g[names[i]];
    if (typeof g[names[i]] !== 'undefined') throw new Error('preview sandbox: could not remove ' + names[i]);
  }
})(globalThis, ${JSON.stringify(BLOCKED)});`;
function plain(v) {
  const num = (x) => typeof x === "number" ? x : Number(x);
  const list = (a, f) => Array.isArray(a) ? Array.from(a, f) : [];
  return {
    params: list(v.params, (p) => ({ name: String(p.name), min: num(p.min), max: num(p.max), def: num(p.def), desc: String(p.desc), type: p.type === "switch" ? "switch" : "range" })),
    frameState: list(v.frameState, (s) => ({ name: String(s.name), def: num(s.def) })),
    pixelState: list(v.pixelState, (s) => ({ name: String(s.name), def: num(s.def) })),
    mode: v.mode === "strip" || v.mode === "mirror" ? v.mode : null,
    modeSwitch: v.modeSwitch === true
  };
}
function run(job) {
  const ctx = vm.createContext(/* @__PURE__ */ Object.create(null), { codeGeneration: { strings: true, wasm: false }, microtaskMode: "afterEvaluate" });
  vm.runInContext(LOCKDOWN, ctx);
  vm.runInContext(job.runtime, ctx, { filename: "shade-runtime.js" });
  vm.runInContext(DRIVER, ctx);
  const req = job.req;
  let res;
  try {
    res = vm.runInContext(`__call(${JSON.stringify(JSON.stringify(req))})`, ctx, { timeout: job.timeoutMs });
  } catch (e) {
    let m = "";
    try {
      m = String(e && e.message);
    } catch {
    }
    return { error: /timed out/i.test(m) ? "timeout" : "script error" };
  }
  if (!res || typeof res !== "object") return { error: "script error" };
  if (res.error !== void 0) return { error: String(res.error) };
  const info = plain(res.info || {});
  if (req.op === "inspect") return { ok: { info } };
  const n = req.w * req.h * 3;
  const frames = [];
  for (let f = 0; f < req.frames; f++) {
    const src = res.frames && res.frames[f];
    if (!src || src.length !== n) return { error: "script error: bad frame" };
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = Number(src[i]) | 0;
    frames.push(b.toString("base64"));
  }
  return { ok: { info, frames } };
}
var input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  input += d;
});
process.stdin.on("end", () => {
  let out;
  try {
    out = run(JSON.parse(input));
  } catch (e) {
    out = { error: "preview worker: bad job" };
  }
  process.stdout.write(JSON.stringify(out));
});
