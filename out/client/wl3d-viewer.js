// wl3d-viewer.js — interactive Graphics3D viewer for notebook outputs.
//
// Loaded lazily by index-with-messaging.js via import() (the same mechanism as
// katex.mjs) when an output image carries data-wl-mesh-src. The scene JSON is
// produced by resources/wb3d.wl; the PNG the mesh accompanies stays in the DOM
// as the fallback, so nothing here is load-bearing for correctness.
//
// Kept free of any vscode/renderer API so it can also be driven by the
// standalone harness in Experiments/3d-graphics/.

import * as THREE from './three.module.min.js';
import { OrbitControls } from './OrbitControls.js';
import { LineSegments2 } from './LineSegments2.js';
import { LineSegmentsGeometry } from './LineSegmentsGeometry.js';
import { LineMaterial } from './LineMaterial.js';

const SRGB = THREE.SRGBColorSpace;

// A SURFACE colour is a display colour: Wolfram's RGBColor[0.88,0.61,0.14] is
// sRGB, so it must be decoded to the linear working space.
const col = (rgb, fallback = 0x808080) =>
  Array.isArray(rgb) ? new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], SRGB)
                     : new THREE.Color(fallback);

// A LIGHT colour is not a display colour — it is a multiplier applied to the
// surface, and Wolfram applies it linearly. Decoding it as sRGB (as `col` does)
// darkens every scene by roughly 2x. Measured against Mathematica's own PNG:
// with lights linear, predicted mean RGB 205,121,21 vs its actual 205,120,19;
// decoding them as sRGB predicts 104 for red, which is exactly what the old
// build produced. So light colours go into the working space verbatim.
const lightCol = (rgb, fallback = 0x555555) =>
  Array.isArray(rgb) ? new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2])
                     : new THREE.Color(fallback);

// WebGL clamps LineBasicMaterial.linewidth to one device pixel, which on a
// Retina display is half a CSS pixel — the reason plain lines look far thinner
// than Mathematica's. LineSegments2 draws each segment as a quad instead, so
// `linewidth` is honoured in real pixels.
// `lineMats` collects the materials so resize() can refresh their resolution.
function fatSegments(flat, colour, widthPx, opacity, lineMats) {
  const g = new LineSegmentsGeometry();
  g.setPositions(flat);
  const m = new LineMaterial({ color: colour, linewidth: widthPx, worldUnits: false });
  if (opacity != null && opacity < 1) { m.transparent = true; m.opacity = opacity; }
  m.userData.widthPx = widthPx;
  lineMats.push(m);
  return new LineSegments2(g, m);
}

// Expand an indexed segment list (or a raw point pool) into the flat
// [x1,y1,z1, x2,y2,z2, …] pairs LineSegmentsGeometry wants.
function flatSegmentsFrom(pool, index) {
  if (Array.isArray(index) && index.length) {
    const out = new Float32Array(index.length * 3);
    for (let i = 0; i < index.length; i++) {
      const s = index[i] * 3;
      out[i * 3] = pool.array[s]; out[i * 3 + 1] = pool.array[s + 1]; out[i * 3 + 2] = pool.array[s + 2];
    }
    return out;
  }
  return pool.array;
}

// ---------------------------------------------------------------- parsing

// Pools arrive as nested [[x,y,z],...]; flatten once into a typed array.
function poolToF32(pool) {
  const n = pool.length, w = pool[0].length;
  const a = new Float32Array(n * w);
  for (let i = 0, k = 0; i < n; i++) {
    const row = pool[i];
    for (let j = 0; j < w; j++) a[k++] = row[j];
  }
  return { array: a, count: n, width: w };
}

export function parseScene(json) {
  const scene = typeof json === 'string' ? JSON.parse(json) : json;
  const pools = {};
  for (const [k, v] of Object.entries(scene.pools || {})) {
    if (Array.isArray(v) && Array.isArray(v[0])) pools[k] = poolToF32(v);
  }
  return { meta: scene.meta || {}, objects: scene.objects || [], pools };
}

// ------------------------------------------------------- scene assembly

function materialFor(mat, opts = {}) {
  const m = mat || {};
  const p = {
    // With per-vertex colours the base colour MULTIPLIES them, so anything but
    // white muddies a ColorFunction surface (Plot3D still carries its default
    // orange directive even when ColorFunction paints every vertex).
    color: opts.vertexColors ? 0xffffff : col(m.color, 0x7788bb),
    side: THREE.DoubleSide,
    flatShading: !!opts.flatShading,
  };
  if (m.opacity != null && m.opacity < 1) { p.transparent = true; p.opacity = m.opacity; p.depthWrite = false; }
  if (opts.vertexColors) p.vertexColors = true;
  // Mesh lines sit on the surface at identical depth, which z-fights into
  // speckle and lets far-side lines punch through the front. Nudging filled
  // polygons back in depth leaves the lines a clean margin to draw into.
  p.polygonOffset = true;
  p.polygonOffsetFactor = 1;
  p.polygonOffsetUnits = 1;
  const material = new THREE.MeshPhongMaterial(p);
  if (Array.isArray(m.specular)) material.specular = col(m.specular, 0x111111);
  if (m.shininess != null) material.shininess = m.shininess;
  return material;
}

// Mathematica strokes polygon edges in 3D by default, and WHICH edges it strokes
// falls out of a single rule: only sharp dihedrals. A Cuboid shows all twelve of
// its edges, an explicit Polygon its boundary, a Cylinder its two cap rims —
// while a Sphere shows none, and neither does the smooth side of that same
// cylinder, because those facets meet at a shallow angle. EdgesGeometry with an
// angle threshold reproduces every one of those cases, so the kernel only has to
// say WHETHER a primitive is stroked (o.mat.edge), never which lines to draw.
// Measured against Mathematica's own PNGs in Experiments/3d-graphics/out.
const EDGE_ANGLE = 25;        // degrees — a 48-segment cylinder side is 7.5
const EDGE_TRI_CAP = 20000;   // past this an outline is noise, and slow to derive

function addEdges(mesh, o, pools, ctx) {
  const spec = o.mat && o.mat.edge;
  if (!spec || !mesh || !mesh.geometry) return;
  const colour = col(spec.color, 0x000000);
  const opacity = spec.opacity == null ? 1 : spec.opacity;
  // Thickness is a fraction of the image width in Wolfram, as for Line.
  const wPx = Math.max(1, Math.min(2, (spec.thickness || 0.0015) * (ctx.widthPx || 640)));

  // Whenever the kernel knows the actual polygons it names the segments itself,
  // and they are drawn verbatim. That is what makes `Mesh -> All` — which
  // arrives as EdgeForm[GrayLevel[0.2]] over the surface polygons, not as Line
  // primitives — come out as the full triangulation instead of a silhouette: on
  // a smooth surface every interior edge is a shallow dihedral, so the angle
  // rule below would erase the entire mesh. Only the parametric solids, which
  // have no polygons kernel-side, fall through to it.
  const pool = o.posPool ? pools[o.posPool] : null;
  if (pool && Array.isArray(o.edgeIndex) && o.edgeIndex.length) {
    const flat = flatSegmentsFrom(pool, o.edgeIndex);
    if (ctx.fatLines) {
      mesh.add(fatSegments(flat, colour, wPx, opacity, ctx.lineMats));
    } else {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(flat, 3));
      const m = new THREE.LineBasicMaterial({ color: colour });
      if (opacity < 1) { m.transparent = true; m.opacity = opacity; }
      mesh.add(new THREE.LineSegments(eg, m));
    }
    return;
  }

  const g = mesh.geometry;
  const idx = g.getIndex();
  const pos0 = g.getAttribute('position');
  const tris = (idx ? idx.count : (pos0 ? pos0.count : 0)) / 3;
  if (!tris || tris > EDGE_TRI_CAP) return;
  let eg = null;
  try { eg = new THREE.EdgesGeometry(g, EDGE_ANGLE); } catch { return; }
  const pos = eg.getAttribute('position');
  if (!pos || !pos.count) { eg.dispose(); return; }
  const node = fatSegments(new Float32Array(pos.array), colour, wPx, opacity, ctx.lineMats);
  eg.dispose();
  // A child of the mesh, so it inherits the primitive's own position/rotation
  // and is disposed with it by disposeTree().
  mesh.add(node);
}

// Mathematica's points are round; PointsMaterial draws squares unless it is given
// a sprite. One disc, shared by every point cloud in the scene.
function dotTexture(ctx) {
  if (ctx.dotTex) return ctx.dotTex;
  const c = ctx.doc.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  ctx.dotTex = t;
  return t;
}

// One BufferAttribute per pool, shared by every object that references it —
// a default Plot3D has 35 objects over 2 pools, so this is a 17x saving in
// GPU uploads, not a micro-optimisation.
function attrFor(cache, pools, id) {
  if (!id || !pools[id]) return null;
  let a = cache.get(id);
  if (!a) { a = new THREE.BufferAttribute(pools[id].array, 3); cache.set(id, a); }
  return a;
}

function buildObject(o, pools, ctx) {
  const pool = o.posPool ? pools[o.posPool] : null;
  const cache = ctx.attrCache;

  if (o.type === 'mesh') {
    if (!pool) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', attrFor(cache, pools, o.posPool));
    const np = o.normPool && pools[o.normPool];
    if (np) g.setAttribute('normal', attrFor(cache, pools, o.normPool));
    const cp = o.colPool && pools[o.colPool];
    if (cp) {
      // Mathematica vertex colours are sRGB; three wants linear-working space.
      const lin = new Float32Array(cp.array.length);
      const c = new THREE.Color();
      for (let i = 0; i < cp.count; i++) {
        c.setRGB(cp.array[i * 3], cp.array[i * 3 + 1], cp.array[i * 3 + 2], SRGB);
        lin[i * 3] = c.r; lin[i * 3 + 1] = c.g; lin[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(lin, 3));
    }
    if (Array.isArray(o.index) && o.index.length) {
      const Ctor = pool.count > 65535 ? Uint32Array : Uint16Array;
      g.setIndex(new THREE.BufferAttribute(new Ctor(o.index), 1));
    }
    if (!np) g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, materialFor(o.mat, { vertexColors: !!cp, flatShading: !np }));
    addEdges(mesh, o, pools, ctx);
    return mesh;
  }

  if (o.type === 'lines') {
    if (!pool) return null;
    const colour = col(o.mat && o.mat.color, 0x333333);
    const opacity = o.mat ? o.mat.opacity : 1;
    if (ctx.fatLines) {
      // Thickness is a fraction of the image width in Wolfram; turn it into
      // pixels. Capped low — mesh lines are hairlines in Mathematica and a
      // heavy line reads as a defect on a curved surface.
      const w = Math.max(1, Math.min(2.5, (o.thickness || 0.002) * (ctx.widthPx || 640)));
      return fatSegments(flatSegmentsFrom(pool, o.index), colour, w, opacity, ctx.lineMats);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', attrFor(cache, pools, o.posPool));
    if (Array.isArray(o.index) && o.index.length) {
      const Ctor = pool.count > 65535 ? Uint32Array : Uint16Array;
      g.setIndex(new THREE.BufferAttribute(new Ctor(o.index), 1));
    }
    const m = new THREE.LineBasicMaterial({ color: colour });
    if (opacity < 1) { m.transparent = true; m.opacity = opacity; }
    return new THREE.LineSegments(g, m);
  }

  if (o.type === 'points') {
    if (!pool) return null;
    const g = new THREE.BufferGeometry();
    if (Array.isArray(o.index) && o.index.length) {
      // gather the referenced subset so PointsMaterial sizing stays simple
      const sub = new Float32Array(o.index.length * 3);
      for (let i = 0; i < o.index.length; i++) {
        const s = o.index[i] * 3;
        sub[i * 3] = pool.array[s]; sub[i * 3 + 1] = pool.array[s + 1]; sub[i * 3 + 2] = pool.array[s + 2];
      }
      g.setAttribute('position', new THREE.BufferAttribute(sub, 3));
    } else {
      g.setAttribute('position', attrFor(cache, pools, o.posPool));
    }
    // PointSize is a fraction of the IMAGE WIDTH, and Mathematica does not shrink
    // a dot with distance — a point at the back of the box is drawn exactly as
    // big as one at the front. So sizeAttenuation must be OFF, and gl_PointSize
    // is in FRAMEBUFFER pixels, which is why the device pixel ratio belongs in
    // the conversion; resize() refreshes it. Measured on Mathematica's own
    // ListPointPlot3D PNG: size 0.0111 on a 720 px wide image draws a 7-8 px dot,
    // i.e. exactly frac * width, with no fudge factor. The old attenuated form
    // worked out at ~2 px, which is why point plots came back as faint specks.
    const m = new THREE.PointsMaterial({
      color: col(o.mat && o.mat.color, 0x333333),
      size: 4, sizeAttenuation: false,
      map: dotTexture(ctx), alphaTest: 0.5, transparent: true,
    });
    m.userData.sizeFrac = o.size || 0.008;
    ctx.pointMats.push(m);
    return new THREE.Points(g, m);
  }

  if (o.type === 'sphere') {
    const g = new THREE.SphereGeometry(o.r || 1, 48, 32);
    const mesh = new THREE.Mesh(g, materialFor(o.mat));
    mesh.position.set(o.c[0], o.c[1], o.c[2]);
    addEdges(mesh, o, pools, ctx);
    return mesh;
  }

  if (o.type === 'cuboid') {
    const [ax, ay, az] = o.a, [bx, by, bz] = o.b;
    const g = new THREE.BoxGeometry(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az));
    const mesh = new THREE.Mesh(g, materialFor(o.mat));
    mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    addEdges(mesh, o, pools, ctx);
    return mesh;
  }

  if (o.type === 'cylinder') {
    const a = new THREE.Vector3(...o.a), b = new THREE.Vector3(...o.b);
    const h = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(o.r || 1, o.r || 1, h, 48, 1);
    const mesh = new THREE.Mesh(g, materialFor(o.mat));
    mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    addEdges(mesh, o, pools, ctx);
    return mesh;
  }

  if (o.type === 'tube') {
    if (!pool) return null;
    const pts = [];
    if (Array.isArray(o.index) && o.index.length) {
      for (const i of o.index) pts.push(new THREE.Vector3(pool.array[i * 3], pool.array[i * 3 + 1], pool.array[i * 3 + 2]));
    } else {
      for (let i = 0; i < pool.count; i++) pts.push(new THREE.Vector3(pool.array[i * 3], pool.array[i * 3 + 1], pool.array[i * 3 + 2]));
    }
    if (pts.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, Math.min(pts.length * 2, 2000), o.r || 0.02, 12, false);
    const mesh = new THREE.Mesh(g, materialFor(o.mat));
    // TubeGeometry is open, so its two end rings are boundary edges and would be
    // stroked as spurious circles — hence Tube defaults to edges off kernel-side.
    addEdges(mesh, o, pools, ctx);
    return mesh;
  }

  return null;
}

// Mathematica ImageScaled lighting is specified in view coordinates, so the
// lights ride with the camera — that is why a rotating surface keeps its sheen.
function addLights(camera, lighting) {
  const made = [];
  const specs = Array.isArray(lighting) && lighting.length ? lighting : [
    { type: 'ambient', color: [0.35, 0.35, 0.35] },
    { type: 'directional', color: [0.35, 0.35, 0.35], pos: [0, 2, 2], scaled: true },
    { type: 'directional', color: [0.35, 0.35, 0.35], pos: [2, 2, 2], scaled: true },
    { type: 'directional', color: [0.35, 0.35, 0.35], pos: [2, 0, 2], scaled: true },
  ];
  for (const s of specs) {
    if (s.type === 'ambient') {
      // intensity PI cancels the 1/PI in three's Lambert BRDF, so a light of
      // colour c lands a surface of colour c at exactly c (verified by probe).
      const l = new THREE.AmbientLight(lightCol(s.color), Math.PI);
      camera.add(l);
      made.push(l);
    } else if (s.type === 'directional' || s.type === 'point') {
      const l = new THREE.DirectionalLight(lightCol(s.color), Math.PI);
      const p = s.pos || [1, 1, 1];
      // ImageScaled: box occupies [0,1]^3 in view space, centre {.5,.5,.5}
      const d = s.scaled ? [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5] : p;
      const n = Math.hypot(d[0], d[1], d[2]) || 1;
      l.position.set(d[0] / n * 10, d[1] / n * 10, d[2] / n * 10);
      l.target.position.set(0, 0, 0);
      camera.add(l);          // ride with the view
      camera.add(l.target);
      made.push(l);
    }
  }
  return made;
}

// ---------------------------------------------------------------- axes
//
// Mathematica draws each axis on one edge of the box and re-picks that edge as
// the box turns (AxesEdge -> Automatic). We do the same: every frame, the X and
// Y ticks move to whichever parallel edge currently sits lowest on screen, and
// the Z ticks to the leftmost vertical edge. Labels are canvas sprites held at
// a constant pixel size, so they stay readable at any zoom.

function labelSprite(text, doc, cssColor) {
  const FONT = 34, PAD = 6;
  const font = `${FONT}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  const meas = doc.createElement('canvas').getContext('2d');
  meas.font = font;
  const w = Math.max(2, Math.ceil(meas.measureText(text).width)) + PAD * 2;
  const h = FONT + PAD * 2;
  const c = doc.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = cssColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
    // sizeAttenuation defaults to TRUE, which scales the label with distance and
    // shrinks a nominal 22 px label to ~8 px at the default camera distance.
    // False makes `scale` a constant screen size, which is what axis text needs.
    sizeAttenuation: false,
  }));
  sp.userData.aspect = w / h;
  sp.renderOrder = 10;
  return sp;
}

function createAxes({ meta, half, toWorld, doc, cssColor, lineColor, lineMats, widthPx }) {
  const ticks = meta.ticks;
  if (!Array.isArray(ticks) || ticks.length !== 3) return null;

  const group = new THREE.Group();
  // Mathematica's 3D tick marks point INWARD, into the box, leaving the whole
  // outside margin to the numbers (measured off its own PNGs: the mark next to a
  // z tick runs from the box edge towards the interior, and nothing at all sits
  // between the label and the edge). Ours used to point outward, which is what
  // pushed the numbers up against the axis.
  const MAJOR = -0.022, MINOR = -0.012;
  // Clearance between the box edge and the NEAR side of a label, as a fraction of
  // the label's own pixel height. Mathematica leaves ~11 px beside a 21 px label.
  const LABEL_GAP_PX = 0.35;
  const maxHalf = Math.max(half[0], half[1], half[2]);

  // one buffer for every tick mark on all three axes
  let nSeg = 0;
  for (const t of ticks) nSeg += (t.major || []).length + (t.minor || []).length;
  const pos = new Float32Array(Math.max(1, nSeg) * 6);
  const geo = new LineSegmentsGeometry();
  const mat = new LineMaterial({ color: lineColor, linewidth: 1.1, worldUnits: false,
                                 transparent: true, opacity: 0.85 });
  mat.userData.widthPx = 1.1;
  lineMats.push(mat);
  const lines = new LineSegments2(geo, mat);
  lines.frustumCulled = false;
  group.add(lines);

  const sprites = [];   // {axis, v, sprite}
  for (let a = 0; a < 3; a++) {
    for (const [v, text] of (ticks[a].major || [])) {
      const sp = labelSprite(text, doc, cssColor);
      sprites.push({ axis: a, v, sprite: sp });
      group.add(sp);
    }
  }
  const axisLabels = [];
  const al = meta.axesLabels;
  if (Array.isArray(al)) {
    for (let a = 0; a < 3; a++) {
      if (typeof al[a] === 'string' && al[a]) {
        const sp = labelSprite(al[a], doc, cssColor);
        axisLabels.push({ axis: a, sprite: sp });
        group.add(sp);
      }
    }
  }

  const v3 = new THREE.Vector3();
  // label clearance scratch
  const sA = new THREE.Vector3(), sB = new THREE.Vector3();
  const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  const screenOf = (x, y, z, camera) => {
    v3.set(x, y, z).project(camera);
    return { x: v3.x, y: -v3.y };   // y down, like the screen
  };

  // Which of the four parallel edges should carry this axis?
  // sign pairs for the two axes perpendicular to `axis`
  const CORNERS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  function pickEdge(axis, camera) {
    const [p, q] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    let best = null, bestScore = -Infinity;
    for (const [sp_, sq] of CORNERS) {
      const mid = [0, 0, 0];
      mid[axis] = 0;
      mid[p] = sp_ * half[p];
      mid[q] = sq * half[q];
      const s = screenOf(mid[0], mid[1], mid[2], camera);
      // vertical axis: prefer the leftmost edge; horizontal axes: the lowest
      const score = axis === 2 ? -s.x : s.y;
      if (score > bestScore) { bestScore = score; best = [sp_, sq, p, q]; }
    }
    return best;
  }

  let lastEdges = '';
  const dbg = {};          // per-axis label-thinning diagnostics, for the harness

  function update(camera, viewportH, fov) {
    // Text height tracks the canvas the way Mathematica's does (its labels are a
    // fixed point size in a fixed-size image), clamped so it stays readable.
    const pxToWorld = 2 * Math.tan((fov / 2) * Math.PI / 180) / Math.max(1, viewportH);
    const labelH = Math.max(13, Math.min(30, viewportH * 0.042)) * pxToWorld;

    let k = 0;
    const place = {};
    const sig = [];
    for (let a = 0; a < 3; a++) {
      const [sp_, sq, p, q] = pickEdge(a, camera);
      sig.push(sp_, sq);
      // outward direction, away from the box, in the plane normal to the axis
      const out = [0, 0, 0];
      out[p] = sp_; out[q] = sq;
      const n = Math.hypot(out[0], out[1], out[2]) || 1;
      out[0] /= n; out[1] /= n; out[2] /= n;
      place[a] = { sp_, sq, p, q, out };

      const put = (v, len) => {
        const base = [0, 0, 0];
        base[a] = toWorld(a, v);
        base[p] = sp_ * half[p];
        base[q] = sq * half[q];
        const L = len * maxHalf;
        pos[k++] = base[0]; pos[k++] = base[1]; pos[k++] = base[2];
        pos[k++] = base[0] + out[0] * L;
        pos[k++] = base[1] + out[1] * L;
        pos[k++] = base[2] + out[2] * L;
      };
      for (const [v] of (ticks[a].major || [])) put(v, MAJOR);
      for (const v of (ticks[a].minor || [])) put(v, MINOR);
    }
    // Tick positions depend only on WHICH edges are chosen, so rebuild the
    // (relatively costly) fat-line geometry only when that selection changes,
    // not on every frame of a drag.
    const sigStr = sig.join(',');
    if (sigStr !== lastEdges) {
      lastEdges = sigStr;
      geo.setPositions(k === pos.length ? pos : pos.subarray(0, k));
      lines.computeLineDistances();
    }

    const labelPx = Math.max(13, Math.min(30, viewportH * 0.042));
    const vpW = viewportH * (camera.aspect || 1);

    // Push each number outward until its NEAR side clears the box edge by a
    // constant number of pixels. The sprites are screen-sized (sizeAttenuation
    // off), so a fixed WORLD gap made the clearance depend on zoom and on how
    // steeply the axis is foreshortened; at the default view it worked out
    // smaller than the label's own half-width, which is why the numbers sat on
    // top of the axis. Measure the outward direction in screen space instead and
    // convert the pixel offset we actually want back into world units.
    const eps = 0.02 * maxHalf;
    for (const { axis, v, sprite } of sprites) {
      const { sp_, sq, p, q, out } = place[axis];
      const b = [0, 0, 0];
      b[axis] = toWorld(axis, v);
      b[p] = sp_ * half[p];
      b[q] = sq * half[q];
      sprite.scale.set(labelH * sprite.userData.aspect, labelH, 1);
      sprite.visible = true;

      sA.set(b[0], b[1], b[2]).project(camera);
      sB.set(b[0] + out[0] * eps, b[1] + out[1] * eps, b[2] + out[2] * eps).project(camera);
      const dx = (sB.x - sA.x) * 0.5 * vpW, dy = (sB.y - sA.y) * 0.5 * viewportH;
      const len = Math.hypot(dx, dy);
      let g = 0.06 * maxHalf;          // axis pointing at the camera: nothing to clear
      if (len > 1e-6) {
        // How far the label's own rectangle reaches along that direction (the
        // support function of a box), plus the gap. The sprite canvas carries a
        // little padding of its own, which is part of the clearance too.
        const ux = Math.abs(dx / len), uy = Math.abs(dy / len);
        const need = ux * labelPx * sprite.userData.aspect * 0.5 +
                     uy * labelPx * 0.5 + labelPx * LABEL_GAP_PX;
        g = eps * need / len;
      }
      sprite.position.set(b[0] + out[0] * g, b[1] + out[1] * g, b[2] + out[2] * g);

      // …then keep it inside the canvas. The camera fit sizes the BOX, so on a
      // foreshortened axis the outward push can carry a number past the frame
      // edge, where it is simply cut in half. Slide it back along the camera's
      // own screen axes — that keeps it beside its tick, which reads better than
      // either clipping it or pulling every label in.
      sA.copy(sprite.position).project(camera);
      const cx = (sA.x * 0.5 + 0.5) * vpW, cy = (-sA.y * 0.5 + 0.5) * viewportH;
      const hw = labelPx * sprite.userData.aspect * 0.5, hh = labelPx * 0.5;
      const ox = Math.min(0, cx - hw) + Math.max(0, cx + hw - vpW);
      const oy = Math.min(0, cy - hh) + Math.max(0, cy + hh - viewportH);
      if (ox || oy) {
        camRight.setFromMatrixColumn(camera.matrixWorld, 0);
        camUp.setFromMatrixColumn(camera.matrixWorld, 1);
        const wpp = pxToWorld * camera.position.distanceTo(sprite.position);
        sprite.position.addScaledVector(camRight, -ox * wpp);
        sprite.position.addScaledVector(camUp, oy * wpp);
      }
    }

    // Thin the labels out so they read like Mathematica's rather than crowding
    // the box. Two passes: within an axis (keep every n-th until neighbours
    // clear), then across ALL axes, because the worst collisions are where two
    // axes meet at a shared corner and no per-axis pass can see them.
    const screenOfSprite = (s) => {
      v3.copy(s.sprite.position).project(camera);
      return { x: (v3.x * 0.5 + 0.5) * vpW, y: (-v3.y * 0.5 + 0.5) * viewportH };
    };
    // GAP > 1 asks for clear air between labels, not merely non-overlap.
    const GAP = 1.35;
    const halfW = (s) => labelPx * s.sprite.userData.aspect * 0.5 * GAP;
    const halfH = labelPx * 0.5 * GAP;

    for (let a = 0; a < 3; a++) {
      const row = sprites.filter(s => s.axis === a);
      if (row.length < 2) continue;
      const pts = row.map(screenOfSprite);

      // Mathematica thins axis labels by the room available, not merely by
      // collision — a foreshortened axis gets fewer numbers even though they
      // would technically fit. Aim for one label per ~3.5 label-heights of
      // projected axis, then let the overlap check tighten it further.
      const len = Math.hypot(pts[pts.length - 1].x - pts[0].x,
                             pts[pts.length - 1].y - pts[0].y);
      const want = Math.max(2, Math.round(len / (labelPx * 3.5)));
      let step = Math.max(1, Math.ceil((row.length - 1) / want));
      dbg[a] = { n: row.length, len: Math.round(len), labelPx: Math.round(labelPx), want, step };

      for (let guard = 0; guard < 6; guard++) {
        let clash = false;
        for (let i = 0; i + step < row.length; i += step) {
          const dx = Math.abs(pts[i + step].x - pts[i].x);
          const dy = Math.abs(pts[i + step].y - pts[i].y);
          if (dx < halfW(row[i]) + halfW(row[i + step]) && dy < 2 * halfH) { clash = true; break; }
        }
        if (!clash) break;
        step++;
      }
      if (step > 1) {
        // Anchor the kept run on the tick nearest zero, so a symmetric axis
        // reads -2, 0, 2 rather than -3, -1, 1, 3.
        let anchor = 0, best = Infinity;
        row.forEach((s, i) => { const d = Math.abs(s.v); if (d < best) { best = d; anchor = i; } });
        row.forEach((s, i) => {
          s.sprite.visible = ((((i - anchor) % step) + step) % step) === 0;
        });
      }
    }

    // Greedy cross-axis pass: first label wins, later ones yield.
    const kept = [];
    for (const s of sprites) {
      if (!s.sprite.visible) continue;
      const p = screenOfSprite(s), hw = halfW(s);
      let clash = false;
      for (const k of kept) {
        if (Math.abs(p.x - k.p.x) < hw + k.hw && Math.abs(p.y - k.p.y) < 2 * halfH) { clash = true; break; }
      }
      if (clash) s.sprite.visible = false; else kept.push({ p, hw });
    }
    for (const { axis, sprite } of axisLabels) {
      const { sp_, sq, p, q, out } = place[axis];
      const g = 0.151 * maxHalf;      // clear of the numbers, which sit closer in
      const b = [0, 0, 0];
      b[axis] = 0;
      b[p] = sp_ * half[p] + out[p] * g;
      b[q] = sq * half[q] + out[q] * g;
      sprite.position.set(b[0], b[1], b[2]);
      sprite.scale.set(labelH * 1.15 * sprite.userData.aspect, labelH * 1.15, 1);
    }
  }

  return {
    group, update, debug: dbg,
    setVisible(v) { group.visible = v; },
    dispose() {
      geo.dispose(); lines.material.dispose();
      for (const { sprite } of sprites.concat(axisLabels)) {
        if (sprite.material.map) sprite.material.map.dispose();
        sprite.material.dispose();
      }
    },
  };
}

function boxEdges(dims, color, lineMats) {
  const [x, y, z] = dims.map(v => v / 2);
  const pts = [
    [-x,-y,-z],[ x,-y,-z], [ x,-y,-z],[ x, y,-z], [ x, y,-z],[-x, y,-z], [-x, y,-z],[-x,-y,-z],
    [-x,-y, z],[ x,-y, z], [ x,-y, z],[ x, y, z], [ x, y, z],[-x, y, z], [-x, y, z],[-x,-y, z],
    [-x,-y,-z],[-x,-y, z], [ x,-y,-z],[ x,-y, z], [ x, y,-z],[ x, y, z], [-x, y,-z],[-x, y, z],
  ];
  const node = fatSegments(new Float32Array(pts.flat()), color, 1.1, 0.8, lineMats);
  node.frustumCulled = false;
  return node;
}

// ---------------------------------------------------------------- viewer

export function createViewer({ container, scene: parsed, background = null,
                               boxColor = 0x888888, textColor = null, dark = true }) {
  const opts = { textColor, dark };
  // `meta` is declared with buildScene() below — it is reassigned on every
  // geometry swap, so it cannot be a const captured at construction time.
  const width = container.clientWidth || 480;
  const height = container.clientHeight || 360;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: background === null });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (background !== null) renderer.setClearColor(background, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();

  // --- data space -> display box ---------------------------------------
  // Everything below is rebuildable: updateGeometry() re-runs buildScene() with
  // a new mesh while the camera, controls and WebGL context stay untouched, so
  // a Manipulate slider can change the surface without losing the view.
  let meta = parsed.meta || {};
  let group = null, boxNode = null, axes = null;
  let brN = [1, 1, 0.4], centre = [0, 0, 0], scaleV = [1, 1, 1], half = [0.5, 0.5, 0.2];
  let built = 0, tris = 0;
  const lineMats = [];
  const pointMats = [];

  const disposeTree = (node) => {
    node.traverse(n => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => {
        // The round-point sprite is a canvas texture built per rebuild, and
        // Material.dispose() does not release it — a Manipulate scrub rebuilds
        // the scene on every slider tick.
        if (m.map) m.map.dispose();
        m.dispose();
      });
    });
  };

  function buildScene(p) {
    meta = p.meta || {};
    if (group)   { scene.remove(group);        disposeTree(group);   group = null; }
    if (boxNode) { scene.remove(boxNode);      disposeTree(boxNode); boxNode = null; }
    if (axes)    { scene.remove(axes.group);   axes.dispose();       axes = null; }
    lineMats.length = 0;
    pointMats.length = 0;

    const pr = meta.plotRange;
    const br = Array.isArray(meta.boxRatios) ? meta.boxRatios.slice() : [1, 1, 0.4];
    const brMax = Math.max(...br) || 1;
    brN = br.map(v => v / brMax);                       // longest side = 1

    centre = [0, 0, 0]; scaleV = [1, 1, 1];
    if (Array.isArray(pr) && pr.length === 3) {
      centre = pr.map(r => (r[0] + r[1]) / 2);
      scaleV = pr.map((r, i) => {
        const span = r[1] - r[0];
        return span > 0 ? brN[i] / span : 1;
      });
    }

    group = new THREE.Group();
    group.scale.set(scaleV[0], scaleV[1], scaleV[2]);
    group.position.set(-centre[0] * scaleV[0], -centre[1] * scaleV[1], -centre[2] * scaleV[2]);

    // Fat lines cost 4 vertices per segment; past a certain size the plain
    // 1-pixel lines are the better trade, so fall back rather than stall.
    let segTotal = 0;
    for (const o of p.objects) {
      if (o.type === 'lines') segTotal += (o.index ? o.index.length : (p.pools[o.posPool] || { count: 0 }).count) / 2;
      // Kernel-named polygon edges are fat lines too, and `Mesh -> All` on a
      // dense surface can be far more of them than the mesh Lines ever were.
      if (Array.isArray(o.edgeIndex)) segTotal += o.edgeIndex.length / 2;
    }
    const ctx = {
      attrCache: new Map(), lineMats, pointMats,
      doc: container.ownerDocument || document,
      fatLines: segTotal <= 40000, widthPx: width,
    };
    built = 0; tris = 0;
    for (const o of p.objects) {
      const node = buildObject(o, p.pools, ctx);
      if (node) {
        group.add(node); built++;
        const idx = node.geometry && node.geometry.getIndex();
        if (node.isMesh && idx) tris += idx.count / 3;
        else if (node.isMesh && node.geometry) tris += node.geometry.getAttribute('position').count / 3;
      }
    }
    scene.add(group);

    boxNode = meta.boxed === false ? null : boxEdges(brN, boxColor, lineMats);
    if (boxNode) scene.add(boxNode);

    // --- axes: ticks + numbers, in the same world space as the box ---
    half = brN.map(v => v / 2);
    const toWorld = (a, v) => (v - centre[a]) * scaleV[a];
    axes = (meta.axes === false) ? null : createAxes({
      meta, half, toWorld, lineMats, widthPx: width,
      doc: container.ownerDocument || document,
      cssColor: opts.textColor || (opts.dark === false ? '#2b2b2b' : '#d0d0d0'),
      lineColor: boxColor,
    });
    if (axes) scene.add(axes.group);
  }

  buildScene(parsed);

  // --- camera ----------------------------------------------------------
  const vp = Array.isArray(meta.viewPoint) ? meta.viewPoint : [1.3, -2.4, 2];
  const vv = Array.isArray(meta.viewVertical) ? meta.viewVertical : [0, 0, 1];
  const fov = 25;
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, 1000);
  camera.up.set(vv[0], vv[1], vv[2]);

  const vpn = Math.hypot(vp[0], vp[1], vp[2]) || 1;
  const viewDir = new THREE.Vector3(vp[0] / vpn, vp[1] / vpn, vp[2] / vpn);

  // Fitting the bounding SPHERE leaves the plot floating in white space: it
  // circumscribes the box, so the box itself never reaches the frame. Measured
  // against Mathematica's own PNG (harness/compare.mjs "ink" rows) that render
  // covered only ~75% of the width Mathematica uses. Fit the projected BOX
  // instead and re-centre on it — iterated, because moving the camera changes
  // the projection. FIT is below 1 to leave room for the tick labels, which sit
  // outside the box and are what Mathematica's own margin is really made of.
  const FIT = 0.96;
  const fitTarget = new THREE.Vector3(0, 0, 0);
  let dist = Math.hypot(brN[0], brN[1], brN[2]) / 2 /
             Math.sin((fov / 2) * Math.PI / 180) * 1.06;

  function fitView(rounds = 4) {
    const tanH = Math.tan((fov / 2) * Math.PI / 180);
    const corner = new THREE.Vector3();
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    for (let r = 0; r < rounds; r++) {
      camera.position.copy(viewDir).multiplyScalar(dist).add(fitTarget);
      camera.lookAt(fitTarget);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        corner.set((i & 1 ? 1 : -1) * half[0],
                   (i & 2 ? 1 : -1) * half[1],
                   (i & 4 ? 1 : -1) * half[2]).project(camera);
        if (corner.x < x0) x0 = corner.x;
        if (corner.x > x1) x1 = corner.x;
        if (corner.y < y0) y0 = corner.y;
        if (corner.y > y1) y1 = corner.y;
      }
      const spread = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
      if (!isFinite(spread) || spread <= 0) break;
      // Re-centre first, in the frame we just measured...
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      fitTarget.addScaledVector(right, cx * tanH * dist * camera.aspect)
               .addScaledVector(up, cy * tanH * dist);
      // ...then dolly so the box spans FIT of the frame.
      dist *= spread / FIT;
    }
    camera.position.copy(viewDir).multiplyScalar(dist).add(fitTarget);
    camera.lookAt(fitTarget);
    camera.updateMatrixWorld(true);
  }
  fitView();
  // The old bounding-sphere framing, kept as the "wide" option in the toolbar.
  const wideDist = Math.hypot(brN[0], brN[1], brN[2]) / 2 /
                   Math.sin((fov / 2) * Math.PI / 180) * 1.06;
  const ORIGIN = new THREE.Vector3(0, 0, 0);
  let fitMode = 'tight';
  scene.add(camera);

  const lights = addLights(camera, meta.lighting);

  // --- controls --------------------------------------------------------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.rotateSpeed = 0.9;
  controls.target.copy(fitTarget);
  controls.update();

  // --- deterministic drag semantics -------------------------------------
  // OrbitControls does not SET an action from a modifier, it INVERTS one:
  // ROTATE + (ctrl|meta|shift) -> pan, and PAN + (ctrl|meta|shift) -> rotate.
  // Two consequences we have to correct:
  //   * macOS delivers Ctrl+click as a RIGHT click, so ctrl-drag lands on the
  //     PAN branch and gets inverted back into a rotation — ctrl appeared to do
  //     nothing at all.
  //   * shift is treated exactly like ctrl, so a stray shift turned a rotate
  //     into a pan, which is the "sometimes it moves the centre" mystery.
  // Rewriting the mapping per gesture (in the capture phase, so it lands before
  // OrbitControls' own handler) makes it exact: ctrl/cmd pans, shift does not,
  // right-drag pans, everything else rotates.
  const normaliseButtons = (e) => {
    const wantPan = e.ctrlKey || e.metaKey;
    const shiftOnly = e.shiftKey && !wantPan;
    controls.mouseButtons.LEFT  = shiftOnly ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = wantPan ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  };
  renderer.domElement.addEventListener('pointerdown', normaliseButtons, { capture: true });

  // --- wheel zoom is opt-in, per viewer ----------------------------------
  // An always-live viewer eats the wheel, so scrolling the notebook stops dead
  // at the first 3D output. Zoom therefore only switches on once this viewer has
  // been engaged (clicked or dragged) and switches off again as soon as the user
  // clicks anywhere else. With enableZoom false OrbitControls bails out of its
  // wheel handler BEFORE preventDefault, so the notebook scrolls normally.
  const ownerDoc = container.ownerDocument || document;
  let engaged = false;
  const setEngaged = (on) => {
    if (engaged === on) return;
    engaged = on;
    controls.enableZoom = on;
    // enableZoom alone is NOT enough. OrbitControls.connect() sets
    // `touch-action: none` on the canvas, which stops the browser scrolling the
    // page from a trackpad gesture over it — the wheel handler never even runs,
    // so the notebook stayed stuck at the first 3D output. Hand touch-action
    // back while disengaged, and only claim it once the user opts in.
    renderer.domElement.style.touchAction = on ? 'none' : 'auto';
    renderer.domElement.style.cursor = 'grab';
    renderer.domElement.title = on
      ? 'Drag to rotate · ctrl-drag to pan · scroll to zoom'
      : 'Drag to rotate · ctrl-drag to pan · click to enable scroll-zoom';
  };
  controls.enableZoom = false;
  engaged = true;          // force setEngaged(false) to run its body once
  setEngaged(false);
  const onSelfDown = () => setEngaged(true);
  // Disengaging on a document-level click does NOT work here: every notebook
  // output lives in its own renderer context, so a click on another cell — or
  // anywhere in the editor outside the webview — never reaches this document.
  // Losing the pointer is the signal that actually arrives, and it matches the
  // intent: the plot only owns the wheel while the cursor is on it.
  const onLeave = () => setEngaged(false);
  renderer.domElement.addEventListener('pointerdown', onSelfDown, { capture: true });
  container.addEventListener('pointerleave', onLeave);
  // Kept as a belt-and-braces disengage for clicks that DO share this document.
  const onDocDown = (e) => { if (!container.contains(e.target)) setEngaged(false); };
  ownerDoc.addEventListener('pointerdown', onDocDown, true);

  let disposed = false;
  const render = () => {
    if (disposed) return;
    if (axes && axes.group.visible) {
      // axes re-pick their edges from the current camera, so update before drawing
      camera.updateMatrixWorld();
      axes.update(camera, renderer.domElement.clientHeight || height, fov);
    }
    renderer.render(scene, camera);
  };
  controls.addEventListener('change', render);
  render();

  // Both line width and point size are specified against the IMAGE, so they have
  // to be re-derived whenever the canvas changes size. LineMaterial wants the
  // viewport in CSS pixels; gl_PointSize is in framebuffer pixels, so points also
  // carry the device pixel ratio.
  const syncLineRes = (w, h) => {
    for (const m of lineMats) { m.resolution.set(w, h); m.needsUpdate = true; }
    const dpr = renderer.getPixelRatio();
    for (const m of pointMats) {
      m.size = Math.max(1, (m.userData.sizeFrac || 0.008) * w * dpr);
      m.needsUpdate = true;
    }
  };
  syncLineRes(width, height);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    syncLineRes(w, h);
    render();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  return {
    stats: { objects: built, triangles: Math.round(tris), lights: lights.length,
             drawCalls: renderer.info.render.calls },
    render, resize, camera, controls, renderer,
    // Two framings: 'tight' reproduces Mathematica's (measured to within a few
    // percent of its own PNG by harness/compare.mjs), 'wide' is the old
    // bounding-sphere fit, which pulls back far enough that the plot can be
    // rotated to any angle without a corner ever leaving the frame.
    getFitMode() { return fitMode; },
    applyFit(mode) {
      fitMode = mode === 'wide' ? 'wide' : 'tight';
      const d = fitMode === 'wide' ? wideDist : dist;
      const t = fitMode === 'wide' ? ORIGIN : fitTarget;
      camera.up.set(vv[0], vv[1], vv[2]);
      camera.position.copy(viewDir).multiplyScalar(d).add(t);
      camera.lookAt(t);
      controls.target.copy(t); controls.update(); render();
    },
    resetView() { this.applyFit(fitMode); },
    // --- manual orbit, for continuing a drag that began on the static image ---
    // OrbitControls exposes getters but no setters, so we move the camera using
    // its own convention: rotate into a Y-up frame, adjust spherical angles by
    // the same 2*PI*px/height*rotateSpeed it uses, rotate back.
    captureOrbit() {
      const q = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
      const off = camera.position.clone().sub(controls.target).applyQuaternion(q);
      const sph = new THREE.Spherical().setFromVector3(off);
      return { theta: sph.theta, phi: sph.phi, radius: sph.radius, q };
    },
    applyOrbit(base, dxPx, dyPx) {
      const hpx = renderer.domElement.clientHeight || height;
      const sp = controls.rotateSpeed == null ? 1 : controls.rotateSpeed;
      const EPS = 1e-6;
      const sph = new THREE.Spherical(
        base.radius,
        Math.min(Math.PI - EPS, Math.max(EPS, base.phi - 2 * Math.PI * dyPx / hpx * sp)),
        base.theta - 2 * Math.PI * dxPx / hpx * sp);
      const off = new THREE.Vector3().setFromSpherical(sph)
        .applyQuaternion(base.q.clone().invert());
      camera.position.copy(controls.target).add(off);
      camera.lookAt(controls.target);
      controls.update();
      render();
    },
    engage(on) { setEngaged(on); },
    /** Swap in a new scene, keeping camera, controls and the GL context.
     *  This is what lets a Manipulate slider change the surface without the
     *  view snapping back to the default angle (or falling back to the PNG). */
    updateGeometry(nextParsed) {
      buildScene(nextParsed);
      syncLineRes(renderer.domElement.clientWidth || width,
                  renderer.domElement.clientHeight || height);
      render();
      return { objects: built, triangles: Math.round(tris) };
    },
    capturePan() {
      return { target: controls.target.clone(), pos: camera.position.clone() };
    },
    applyPan(base, dxPx, dyPx) {
      // Same geometry OrbitControls uses: screen pixels -> world offset along
      // the camera's own x/y axes, scaled by the distance to the target.
      const hpx = renderer.domElement.clientHeight || height;
      camera.updateMatrix();
      const dist = base.pos.clone().sub(base.target).length() *
                   Math.tan((camera.fov / 2) * Math.PI / 180);
      const ax = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0)
        .multiplyScalar(-2 * dxPx * dist / hpx);
      const ay = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1)
        .multiplyScalar(2 * dyPx * dist / hpx);
      const off = ax.add(ay);
      controls.target.copy(base.target).add(off);
      camera.position.copy(base.pos).add(off);
      controls.update();
      render();
    },
    setBoxVisible(v) { if (boxNode) { boxNode.visible = v; render(); } },
    setAxesVisible(v) { if (axes) { axes.setVisible(v); render(); } },
    axesDebug() { return axes ? axes.debug : null; },
    setLinesVisible(v) {
      group.traverse(n => { if (n.isLineSegments) n.visible = v; });
      render();
    },
    setWireframe(v) {
      group.traverse(n => { if (n.isMesh && n.material) n.material.wireframe = v; });
      render();
    },
    toPosterDataUrl() { render(); return renderer.domElement.toDataURL('image/png'); },
    dispose() {
      disposed = true;
      ro.disconnect();
      ownerDoc.removeEventListener('pointerdown', onDocDown, true);
      controls.dispose();
      if (axes) axes.dispose();
      scene.traverse(n => {
        if (n.geometry) n.geometry.dispose();
        if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m.dispose());
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}

// ------------------------------------------------------------------ mounting
//
// Browsers cap live WebGL contexts (~16) and silently kill the oldest when the
// cap is passed. A notebook can easily hold more 3D outputs than that, so we
// keep at most POOL_LIMIT alive and suspend the rest to a still image OF THEIR
// CURRENT VIEW — a suspended plot keeps the angle the user rotated it to.

const POOL_LIMIT = 6;
const live = [];   // least-recently-activated first

function trimPool() {
  while (live.length > POOL_LIMIT) {
    const entry = live.shift();
    try { entry.suspend(); } catch (_) {}
  }
}

const BAR_BTN = 'font:11px var(--vscode-font-family,sans-serif);padding:1px 6px;' +
  'background:var(--vscode-button-secondaryBackground,rgba(128,128,128,0.18));' +
  'color:var(--vscode-button-secondaryForeground,inherit);border:1px solid rgba(128,128,128,0.35);' +
  'border-radius:3px;cursor:pointer;opacity:0.75;';

/**
 * Turn an <img data-wl-mesh-src> into an interactive canvas in place.
 * The <img> stays in the DOM (hidden) and is restored on any failure, so a
 * broken mesh can never lose the picture the user already had.
 */
export async function mountViewer(img, opts = {}) {
  const meshSrc = img.getAttribute('data-wl-mesh-src');
  if (!meshSrc || img.getAttribute('data-wl3d-mounted') === '1') return null;
  img.setAttribute('data-wl3d-mounted', '1');

  const doc = img.ownerDocument || document;
  const w = parseInt(img.getAttribute('width'), 10) || img.naturalWidth || 640;
  const h = parseInt(img.getAttribute('height'), 10) || img.naturalHeight || 480;

  const host = doc.createElement('div');
  host.className = 'wl3d-host';
  host.style.cssText = `position:relative;display:inline-block;max-width:100%;width:${w}px;`;
  const stage = doc.createElement('div');
  stage.className = 'wl3d-stage';
  stage.style.cssText = `width:100%;aspect-ratio:${w} / ${h};cursor:grab;`;
  const bar = doc.createElement('div');
  // z-index keeps the toolbar clickable above the PNG overlay (which itself
  // sits above the canvas but ignores the pointer).
  bar.style.cssText = 'position:absolute;top:4px;right:4px;display:flex;gap:4px;' +
                      'opacity:0;transition:opacity .12s;z-index:2;';
  host.addEventListener('mouseenter', () => { bar.style.opacity = '1'; });
  host.addEventListener('mouseleave', () => { bar.style.opacity = '0'; });

  img.parentNode.insertBefore(host, img);
  host.appendChild(stage);
  host.appendChild(bar);
  host.appendChild(img);
  img.style.display = 'none';

  const fail = (why) => {
    stage.remove(); bar.remove();
    img.style.display = '';
    img.removeAttribute('data-wl3d-mounted');
    if (host.parentNode) { host.parentNode.insertBefore(img, host); host.remove(); }
    console.warn('[wl3d] falling back to PNG:', why);
    return null;
  };

  let raw;
  try {
    const resp = await fetch(meshSrc);
    if (!resp.ok) return fail('mesh fetch ' + resp.status);
    raw = await resp.json();
  } catch (e) { return fail(e.message); }

  const dark = !!opts.dark;
  let viewer = null;
  const build = () => {
    stage.textContent = '';
    stage.style.cursor = 'grab';
    viewer = createViewer({
      container: stage, scene: parseScene(raw), background: null, dark,
      boxColor: dark ? 0x8a8a8a : 0x707070,
      textColor: dark ? '#cccccc' : '#2b2b2b',
    });
    if (opts.onReady) { try { opts.onReady(viewer); } catch (_) {} }
  };
  try { build(); } catch (e) { return fail(e.message); }

  const entry = {
    host,
    get viewer() { return viewer; },
    dispose() { if (viewer) { viewer.dispose(); viewer = null; } },
    suspend() {
      if (!viewer) return;
      let poster = null;
      try { poster = viewer.toPosterDataUrl(); } catch (_) {}
      viewer.dispose(); viewer = null;
      stage.textContent = '';
      stage.style.cursor = 'pointer';
      if (poster) {
        const p = doc.createElement('img');
        p.src = poster;
        p.style.cssText = 'width:100%;height:100%;display:block;';
        p.title = 'Click or drag to resume rotating';
        stage.appendChild(p);
      }
      // pointerdown, not click: a drag attempt should revive it too, and a drag
      // that moves off the element never fires a click at all.
      stage.onpointerdown = () => {
        stage.onpointerdown = null;
        try { build(); live.push(entry); trimPool(); } catch (e) { fail(e.message); }
      };
    },
  };

  // When the caller hands us the output header's button row, the 3D controls
  // live there beside WL / SVG / 3D / TikZ instead of floating over the picture.
  const inHeader = !!opts.toolbar;
  if (inHeader) bar.style.display = 'none';
  const mkBtn = (label, title, fn) => {
    const b = doc.createElement('button');
    b.textContent = label; b.title = title;
    b.style.cssText = inHeader ? (opts.toolbarBtnCss || BAR_BTN) : BAR_BTN;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
    (inHeader ? opts.toolbar : bar).appendChild(b);
    b.setAttribute('data-wl3d-btn', '1');
    return b;
  };
  mkBtn('⟲', 'Reset the view', () => viewer && viewer.resetView());

  // Framing toggle. The default 'tight' fit reproduces what Mathematica draws;
  // 'wide' pulls back to the bounding sphere, so the plot can be spun to any
  // angle without a corner ever swinging out of frame.
  //
  // (This replaced a PNG toggle that overlaid the static image on the live
  // canvas. The two framings no longer agree — deliberately — so the overlay
  // showed the picture doubled and misaligned. The <img> is still in the DOM,
  // hidden, as the fallback if the mesh ever fails to load.)
  const TIGHT_TITLE = 'Zoom out so rotation never clips the corners';
  const WIDE_TITLE  = 'Back to the framing Mathematica uses';
  mkBtn('⤢', TIGHT_TITLE, (b) => {
    if (!viewer) return;
    const next = viewer.getFitMode() === 'wide' ? 'tight' : 'wide';
    viewer.applyFit(next);
    b.style.opacity = next === 'wide' ? '1' : '0.75';
    b.title = next === 'wide' ? WIDE_TITLE : TIGHT_TITLE;
  });

  live.push(entry);
  trimPool();
  return entry;
}

/**
 * Make a STATIC 3D image drag-activatable.
 *
 * The picture stays exactly as it renders today until someone grabs it — which
 * people do, because it looks like Mathematica. On the first few pixels of drag
 * we mount the viewer and then drive the orbit ourselves for the remainder of
 * that gesture, so the rotation follows the hand that started it instead of
 * making the user let go and try again.
 */
export function attachLazy3D(img, opts = {}) {
  if (!img.getAttribute('data-wl-mesh-src')) return;
  if (img.getAttribute('data-wl3d-lazy') === '1') return;
  img.setAttribute('data-wl3d-lazy', '1');
  img.style.cursor = 'grab';
  if (!img.title) img.title = 'Drag to rotate in 3D';

  // An <img> is natively draggable: the browser starts its own drag-and-drop on
  // press-and-move, which cancels the pointer stream, so our pointermove never
  // arrived and the drag appeared to do nothing at all. Turn that off, and take
  // touch-action so a trackpad drag reaches us as pointer events.
  img.draggable = false;
  img.addEventListener('dragstart', (e) => e.preventDefault());
  img.style.webkitUserDrag = 'none';
  img.style.userSelect = 'none';

  const THRESHOLD = 4;      // px of movement before we treat it as a drag
  let start = null;

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', cleanup);
    start = null;
  };

  const onMove = async (e) => {
    if (!start || start.busy) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return;
    start.busy = true;
    window.removeEventListener('pointermove', onMove);

    let entry = null;
    try { entry = await mountViewer(img, opts); } catch (_) { /* falls back below */ }
    const viewer = entry && entry.viewer;
    if (!viewer) { cleanup(); return; }

    // Hand the rest of this gesture to a manual orbit (or pan, if the drag
    // started with ctrl/cmd held), then let OrbitControls take over for every
    // gesture after it.
    const panning = start.pan;
    // dragging it counts as engaging it, so scroll-zoom works straight away
    if (viewer.engage) viewer.engage(true);
    const base = panning ? viewer.capturePan() : viewer.captureOrbit();
    const drive = (ev) => panning
      ? viewer.applyPan(base, ev.clientX - start.x, ev.clientY - start.y)
      : viewer.applyOrbit(base, ev.clientX - start.x, ev.clientY - start.y);
    const done = () => {
      window.removeEventListener('pointermove', drive);
      window.removeEventListener('pointerup', done);
      start = null;
    };
    window.addEventListener('pointermove', drive);
    window.addEventListener('pointerup', done);
    window.removeEventListener('pointerup', cleanup);
    drive(e);
  };

  img.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // ctrl/cmd at press time means "move the centre", matching the viewer
    start = { x: e.clientX, y: e.clientY, busy: false, pan: e.ctrlKey || e.metaKey };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
  });
}

/** The live viewer mounted inside `root`, if any (used to update in place). */
export function findViewerIn(root) {
  for (const e of live) {
    if (root.contains(e.host) && e.viewer) return e;
  }
  return null;
}

/** Dispose every viewer mounted inside `root` (called from disposeOutputItem). */
export function disposeViewersIn(root) {
  for (let i = live.length - 1; i >= 0; i--) {
    if (root.contains(live[i].host)) {
      try { live[i].dispose(); } catch (_) {}
      live.splice(i, 1);
    }
  }
}
