import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * One market as the field sees it.
 *   weight  0..1  share of deposits, so the ring's particle density
 *   util    0..1  utilization: that share of the ring's particles falls into the core as borrowed liquidity
 *   apy     0..1  lender APY, which drives the core's pulse
 */
export type FieldMarket = { weight: number; util: number; apy: number; name?: string };

type Props = {
  markets: FieldMarket[];
  focus?: number; // index of the selected market; its ring brightens
  className?: string;
};

const MAX = 4; // rings the shader knows about
const DEPTH = 0.45; // how far the near half of an orbit (per unit radius) comes toward the camera
const TRAIL = 4; // samples per particle (head + 3 trail ghosts)
const BG = "#020203";

// Shown while there is no market data yet: three calm rings.
const IDLE: FieldMarket[] = [
  { weight: 0.4, util: 0.35, apy: 0.04 },
  { weight: 0.35, util: 0.2, apy: 0.03 },
  { weight: 0.25, util: 0.1, apy: 0.02 },
];

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uCum[${MAX}];
  uniform float uRadius[${MAX}];
  uniform float uUtil[${MAX}];
  uniform float uPhase[${MAX}];
  uniform float uFlow[${MAX}];
  uniform float uFocus[${MAX}];
  uniform vec2 uMouse;
  uniform float uLens;
  uniform float uSize;

  attribute float aPick;   // which ring (via the cumulative weights)
  attribute float aSel;    // borrowed once utilization passes this
  attribute float aAngle;
  attribute float aBand;   // offset inside the ring, -1..1
  attribute float aSpeed;
  attribute float aRate;   // infall rate
  attribute float aPhase;
  attribute float aSize;
  attribute float aTrail;  // 0 = head, up to ~1 = oldest ghost
  attribute vec3 aColor;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vHead;

  const vec3 CYAN = vec3(0.0362, 0.6939, 1.0);   // #36D9FF (linear)
  const vec3 ICE  = vec3(0.2623, 0.6038, 1.0);   // #8CCBFF (linear)

  void main() {
    // Pick this particle's ring without dynamic indexing.
    float R = 0.0, util = 0.0, phase = 0.0, flow = 0.0, focus = 0.0, prev = 0.0;
    for (int k = 0; k < ${MAX}; k++) {
      float inK = step(prev, aPick) * (1.0 - step(uCum[k], aPick));
      R += inK * uRadius[k];
      util += inK * uUtil[k];
      phase += inK * uPhase[k];
      flow += inK * uFlow[k];
      focus += inK * uFocus[k];
      prev = uCum[k];
    }

    // Trail ghosts sit slightly back along the path.
    float back = aTrail * 0.11;
    float ph = phase - back;
    float fl = flow - back * 0.06;
    float t = uTime - back * 4.0;

    // Supplied liquidity: a Keplerian orbit (inner bands turn faster).
    float rOrbit = R + aBand * 0.24 + sin(t * 0.7 + aPhase) * 0.035;
    float kepler = 1.7 / pow(max(rOrbit, 0.5), 1.5);
    float aOrbit = aAngle + ph * aSpeed * kepler + sin(t * 0.3 + aPhase) * 0.05;

    // Borrowed liquidity: spirals from the ring into the core, then loops.
    float life = fract(aPhase * 0.159 + fl * aRate);
    float rFall = mix(R + aBand * 0.2, 0.47, pow(life, 1.7));
    float aFall = aAngle + ph * aSpeed * 1.7 / pow(max(R, 0.5), 1.5) + life * life * 4.2;

    float b = smoothstep(aSel - 0.025, aSel + 0.025, util);
    float r = mix(rOrbit, rFall, b);
    float ang = mix(aOrbit, aFall, b);

    // tilted disk: the lower half of every orbit is nearer the camera, so it passes in front of the core
    vec3 pos = vec3(cos(ang) * r * 1.32, sin(ang) * r * 0.54, -sin(ang) * r * ${DEPTH.toFixed(2)} + sin(ang * 2.0 + aPhase) * 0.04);

    // The cursor is a small extra mass that bends nearby streams.
    vec2 d = pos.xy - uMouse;
    pos.xy -= d * uLens * 0.16 / (dot(d, d) + 0.3);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float persp = 1.0 / max(1.0, -mv.z * 0.14);
    float trailFade = 1.0 - aTrail;
    gl_PointSize = clamp(aSize * uSize * uPixelRatio * persp * (1.0 - aTrail * 0.45) * (1.0 + b * 0.25), 1.0, 10.0);

    float fallFade = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.86, 1.0, life));
    float twinkle = 0.55 + 0.45 * sin(t * 1.6 + aPhase);
    float alpha = mix(twinkle, fallFade * (0.75 + 0.25 * twinkle), b);
    alpha *= trailFade * trailFade * (0.55 + 0.45 * b);
    alpha *= 1.0 + focus * 0.9;

    vColor = mix(aColor, mix(CYAN, ICE, life * 0.6), b) * (1.0 + focus * 0.5);
    vAlpha = alpha;
    vHead = step(aTrail, 0.01);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uCore;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vHead;

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    if (d > 0.5) discard;
    float core = exp(-d * 25.0) * vHead;
    float glow = exp(-d * 9.0);
    gl_FragColor = vec4(vColor * (1.0 + core * uCore), (core * 0.9 + glow * 0.34) * vAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function particles(count: number) {
  const palette = ["#2E6DB4", "#8CCBFF", "#36D9FF", "#174477", "#2E6DB4"].map((c) => new THREE.Color(c));
  const n = count * TRAIL;
  const f = (k = 1) => new Float32Array(n * k);
  const a = { pick: f(), sel: f(), angle: f(), band: f(), speed: f(), rate: f(), phase: f(), size: f(), trail: f(), color: f(3) };
  for (let i = 0; i < count; i++) {
    const pick = Math.random();
    // more particles sit early in the borrowed range, so the stream reads clearly even at low utilization
    const sel = Math.pow(Math.random(), 1.15);
    const angle = Math.random() * Math.PI * 2;
    const band = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // soft-edged ring
    const speed = (0.6 + Math.random() * 0.9) * (Math.random() > 0.07 ? 1 : -1);
    const rate = 0.5 + Math.random();
    const phase = Math.random() * Math.PI * 2;
    const size = 1 + Math.random() * 2.1;
    const c = palette[Math.floor(Math.random() * palette.length)];
    const br = 0.65 + Math.random() * 0.7;
    for (let k = 0; k < TRAIL; k++) {
      const j = i * TRAIL + k;
      a.pick[j] = pick;
      a.sel[j] = sel;
      a.angle[j] = angle;
      a.band[j] = band;
      a.speed[j] = speed;
      a.rate[j] = rate;
      a.phase[j] = phase;
      a.size[j] = size;
      a.trail[j] = k / TRAIL;
      a.color.set([c.r * br, c.g * br, c.b * br], j * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const set = (name: string, arr: Float32Array, size = 1) => g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  set("aPick", a.pick);
  set("aSel", a.sel);
  set("aAngle", a.angle);
  set("aBand", a.band);
  set("aSpeed", a.speed);
  set("aRate", a.rate);
  set("aPhase", a.phase);
  set("aSize", a.size);
  set("aTrail", a.trail);
  set("aColor", a.color, 3);
  // positions are computed in the shader, so skip CPU-side bounds
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  return g;
}

function ellipse(rx: number, ry: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 240; i++) {
    const a = (i / 240) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * rx, Math.sin(a) * ry, -Math.sin(a) * DEPTH));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/** Ring radii spread across the field, inner to outer. */
const radiusOf = (k: number, count: number) => (count <= 1 ? 1.6 : 1.05 + (k * 1.6) / (count - 1));

export default function GravitationalField({ markets, focus = -1, className = "" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ markets, focus });
  live.current = { markets, focus };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = Math.min(window.innerWidth, window.innerHeight) < 700;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%" });
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 8.5);
    const root = new THREE.Group();
    root.rotation.z = -0.1;
    scene.add(root);

    // one orbit line per ring, plus a faint outer envelope
    const orbitMats = Array.from({ length: MAX + 1 }, () => new THREE.LineBasicMaterial({ color: "#24476F", transparent: true, opacity: 0, depthWrite: false }));
    const orbits = orbitMats.map((m) => {
      const line = new THREE.Line(ellipse(1.32, 0.54), m);
      root.add(line);
      return line;
    });

    const count = small ? 3200 : 6500;
    const geo = particles(count);
    const uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uCum: { value: [1, 1, 1, 1] },
      uRadius: { value: [1.6, 1.6, 1.6, 1.6] },
      uUtil: { value: [0, 0, 0, 0] },
      uPhase: { value: [0, 0, 0, 0] },
      uFlow: { value: [0, 0, 0, 0] },
      uFocus: { value: [0, 0, 0, 0] },
      uMouse: { value: new THREE.Vector2(99, 99) },
      uLens: { value: 0 },
      uSize: { value: 1 },
      uCore: { value: 1.8 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    root.add(new THREE.Points(geo, mat));

    // the dark core, its rim, and a pulsing halo
    const coreGeo = new THREE.CircleGeometry(0.43, 96);
    const coreMat = new THREE.MeshBasicMaterial({ color: "#03060C" });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.z = 0;
    root.add(core);
    const ringGeo = new THREE.RingGeometry(0.435, 0.452, 128);
    const ringMat = new THREE.MeshBasicMaterial({ color: "#398FE8", transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.z = 0.002;
    root.add(ring);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { uPulse: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform float uPulse;
        void main(){
          float d = length(vUv - 0.5) * 2.0;
          float glow = exp(-d * 5.5) * (0.85 + 0.25 * uPulse) * (1.0 - smoothstep(0.7, 0.98, d));
          gl_FragColor = vec4(0.025 * glow, 0.18 * glow, 0.42 * glow, glow * 0.72);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), haloMat);
    halo.position.z = -0.35;
    root.add(halo);

    // one body per market, riding its ring
    const bodyGeo = new THREE.SphereGeometry(0.05, 20, 20);
    const bodyMat = new THREE.MeshStandardMaterial({ color: "#3C83C8", emissive: "#2E6DB4", emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.4 });
    const bodies = Array.from({ length: MAX }, () => {
      const m = new THREE.Mesh(bodyGeo, bodyMat);
      root.add(m);
      return m;
    });
    // a soft round glow behind each planet (drawn, so it stays a circle at any bloom setting)
    const glowTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d")!;
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, "rgba(140,203,255,0.9)");
      grad.addColorStop(0.25, "rgba(54,217,255,0.35)");
      grad.addColorStop(0.6, "rgba(46,109,180,0.08)");
      grad.addColorStop(1, "rgba(46,109,180,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const glows = bodies.map(() => {
      const sp = new THREE.Sprite(glowMat);
      root.add(sp);
      return sp;
    });
    scene.add(new THREE.AmbientLight("#7197C4", 0.7));

    // labels: market name + APY on each planet, share lent out on each ring, and the core
    const labelLayer = document.createElement("div");
    labelLayer.className = "gfield-labels";
    el.appendChild(labelLayer);
    const mk = (cls: string) => {
      const d = document.createElement("div");
      d.className = cls;
      labelLayer.appendChild(d);
      return d;
    };
    const planetLabels = bodies.map(() => mk("gl gl-planet"));
    const ringLabels = bodies.map(() => mk("gl gl-ring"));
    const coreLabel = mk("gl gl-core");
    coreLabel.textContent = "borrowed liquidity";
    const tmp = new THREE.Vector3();
    const toScreen = (v: THREE.Vector3) => {
      v.project(camera);
      return [((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight] as const;
    };
    const place = (d: HTMLDivElement, x: number, y: number, opacity: number) => {
      d.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      d.style.opacity = opacity.toFixed(2);
    };
    const setText = (d: HTMLDivElement, html: string) => {
      if (d.dataset.t !== html) {
        d.dataset.t = html;
        d.innerHTML = html;
      }
    };
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

    // bloom on larger screens only; phones get the plain render
    let composer: EffectComposer | null = null;
    let bloom: UnrealBloomPass | null = null;
    if (!small) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0, 0.12);
      // the two coarsest blur levels (1/16 and 1/32 size) upscale into square halos; keep the fine ones
      (bloom as unknown as { compositeMaterial: THREE.ShaderMaterial }).compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.75, 0.2, 0.0, 0.0];
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
    }

    // eased state per ring
    const s = { cum: [1, 1, 1, 1], radius: [1.6, 1.6, 1.6, 1.6], util: [0, 0, 0, 0], focus: [0, 0, 0, 0], phase: [0, 0, 0, 0], flow: [0, 0, 0, 0], orbit: [0, 0, 0, 0, 0], apy: 0.03, lens: 0, pulse: 0 };
    let half = { w: 1, h: 1 };
    let fit = { x: 0, y: 0, scale: 1 };
    const mouse = new THREE.Vector2(99, 99);
    let hover = false;

    function resize() {
      const w = Math.max(el!.clientWidth, 1);
      const h = Math.max(el!.clientHeight, 1);
      const narrow = w < 760;
      camera.aspect = w / h;
      camera.position.z = narrow ? 10.5 : 8.5;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      composer?.setSize(w, h);
      bloom?.resolution.set(w, h);
      uniforms.uPixelRatio.value = renderer.getPixelRatio();
      const hh = Math.tan(THREE.MathUtils.degToRad(21)) * camera.position.z;
      half = { w: hh * camera.aspect, h: hh };
      // desktop: the field sits right of the copy; phones: across the top
      const cx = 0.5;
      // phones: centre the field 140px from the top, where the hero leaves room for it
      const cy = narrow ? Math.min(0.5, 140 / h) : 0.5;
      // no bloom on phones, so particles draw larger to keep the glow
      // and keep their cores from burning out to white
      uniforms.uSize.value = composer ? 1 : 1.7;
      uniforms.uCore.value = composer ? 1.8 : 0.35;
      renderer.toneMappingExposure = composer ? 1.25 : 1.05;
      // desktop: the rings fill ~80% of the hero's height, as far right as fits; phones: across the top
      const scale = narrow
        ? Math.min(1.2, (half.w * 0.94) / 3.5, Math.min(half.h, (130 / h) * 2 * half.h) / 1.45)
        : Math.min((0.8 * half.h) / 1.45, (half.w * 0.96) / 3.5);
      const halfWidthFrac = (3.5 * scale) / (2 * half.w);
      const x0 = narrow ? cx : Math.max(0.5, Math.min(0.68, 0.985 - halfWidthFrac));
      fit = { x: (x0 * 2 - 1) * half.w, y: (1 - cy * 2) * half.h, scale };
      root.position.set(fit.x, fit.y, 0);
      root.scale.setScalar(scale);
      dirty = true;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
      hover = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
      mouse.set((nx * half.w - fit.x) / fit.scale, (ny * half.h - fit.y) / fit.scale);
    };
    if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(el);

    let dirty = true;
    let elapsed = reduced ? 30 : 0;
    let last = 0;
    let frame = 0;
    resize();

    function step(dt: number) {
      const ms = live.current.markets.length ? live.current.markets.slice(0, MAX) : IDLE;
      const n = ms.length;
      const total = ms.reduce((t, m) => t + Math.max(m.weight, 0), 0) || 1;
      // every ring keeps at least a visible share of particles
      const shares = ms.map((m) => Math.max(m.weight / total, 0.12));
      const st = shares.reduce((a, b) => a + b, 0);
      const ease = reduced ? 1 : 1 - Math.exp(-dt * 1.6);
      let cum = 0;
      for (let k = 0; k < MAX; k++) {
        const on = k < n;
        cum = on ? cum + shares[k] / st : 1;
        const target = {
          cum: k === n - 1 ? 1 : cum,
          radius: on ? radiusOf(k, n) : radiusOf(n - 1, n),
          util: on ? Math.min(Math.max(ms[k].util, 0), 1) : 0,
          focus: on && k === live.current.focus ? 1 : 0,
        };
        s.cum[k] += (target.cum - s.cum[k]) * ease;
        s.radius[k] += (target.radius - s.radius[k]) * ease;
        s.util[k] += (target.util - s.util[k]) * ease;
        s.focus[k] += (target.focus - s.focus[k]) * ease;
        // busier markets turn and drain faster
        s.phase[k] += dt * (0.12 + 0.12 * s.util[k]);
        s.flow[k] += dt * (0.05 + 0.06 * s.util[k]);
        s.orbit[k] += ((on ? 0.22 + 0.4 * s.focus[k] : 0) - s.orbit[k]) * ease;
      }
      s.orbit[MAX] += (0.1 - s.orbit[MAX]) * ease;
      s.apy += (Math.max(...ms.map((m) => m.apy), 0) - s.apy) * ease;
      s.lens += ((hover ? 1 : 0) - s.lens) * (reduced ? 0 : 1 - Math.exp(-dt * 3));

      uniforms.uCum.value = s.cum;
      uniforms.uRadius.value = s.radius;
      uniforms.uUtil.value = s.util;
      uniforms.uFocus.value = s.focus;
      uniforms.uPhase.value = s.phase;
      uniforms.uFlow.value = s.flow;
      uniforms.uTime.value = elapsed;
      uniforms.uMouse.value.copy(mouse);
      uniforms.uLens.value = s.lens;

      orbits.forEach((o, k) => {
        const R = k < MAX ? s.radius[k] : 3.0;
        o.scale.set(R, R, R);
        orbitMats[k].opacity = s.orbit[k];
      });
      bodies.forEach((b, k) => {
        b.visible = k < n;
        if (!b.visible) return;
        const R = s.radius[k];
        const a = k * 2.1 + s.phase[k] * (1.7 / Math.pow(R, 1.5));
        b.position.set(Math.cos(a) * R * 1.32, Math.sin(a) * R * 0.54, -Math.sin(a) * R * DEPTH);
        const w = 0.8 + 1.4 * Math.sqrt(shares[k] / st);
        b.scale.setScalar(w * (1 + s.focus[k] * 0.35) * (1 + Math.sin(elapsed * 1.2 + k) * 0.06));
        glows[k].position.copy(b.position);
        glows[k].scale.setScalar(0.42 * w * (1 + s.focus[k] * 0.6));
      });
      glows.forEach((g, k) => (g.visible = k < n));

      // labels follow the scene; only once real market data is in
      const real = live.current.markets.length > 0;
      const narrow = el!.clientWidth < 760;
      root.updateMatrixWorld();
      bodies.forEach((b, k) => {
        const on = real && k < n;
        if (!on) {
          planetLabels[k].style.opacity = "0";
          ringLabels[k].style.opacity = "0";
          return;
        }
        const mkt = ms[k];
        const name = esc(mkt.name ?? `Market ${k + 1}`);
        setText(planetLabels[k], narrow ? name : `<b>${name}</b><span>${(mkt.apy * 100).toFixed(2)}% APY</span>`);
        // start the label just outside the planet's glow, wherever it is on screen
        const [px, py] = toScreen(b.getWorldPosition(tmp));
        tmp.copy(glows[k].position);
        tmp.x += glows[k].scale.x * 0.3;
        const [ex] = toScreen(root.localToWorld(tmp));
        // on desktop the hero copy sits on the left: fade a label out while its planet passes behind it
        const behindCopy = narrow ? 1 : Math.min(1, Math.max(0, (px - el!.clientWidth * 0.46) / 60));
        place(planetLabels[k], px + Math.max(10, Math.abs(ex - px)), py, (0.85 + 0.15 * s.focus[k]) * behindCopy);
        setText(ringLabels[k], `${Math.round(mkt.util * 100)}% lent out`);
        const R = s.radius[k];
        // lower part of each ring, right of centre, staggered so the labels never stack
        const ang = -0.75 - k * 0.25;
        tmp.set(Math.cos(ang) * R * 1.32, Math.sin(ang) * R * 0.54, -Math.sin(ang) * R * DEPTH);
        const [rx, ry] = toScreen(root.localToWorld(tmp));
        place(ringLabels[k], rx, ry, narrow ? 0 : 0.55 + 0.45 * s.focus[k]);
      });
      const [cx, cy] = toScreen(root.localToWorld(tmp.set(0, -0.62, 0)));
      place(coreLabel, cx, cy, real && !narrow ? 0.6 : 0);

      // the core beats faster when lenders earn more
      s.pulse += dt * (0.35 + Math.min(s.apy * 10, 1.4));
      const beat = Math.pow(Math.max(Math.sin(s.pulse * Math.PI * 2), 0), 3);
      haloMat.uniforms.uPulse.value = beat;
      ringMat.opacity = 0.7 + 0.3 * beat;
      ring.rotation.z = elapsed * 0.045;
      if (!reduced) {
        root.rotation.x = Math.sin(elapsed * 0.12) * 0.03;
        root.rotation.z = -0.1 + Math.sin(elapsed * 0.09) * 0.025;
      }
    }

    function render() {
      if (composer) composer.render();
      else renderer.render(scene, camera);
    }

    function loop(now: number) {
      frame = requestAnimationFrame(loop);
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      last = now;
      if (!visible || document.hidden) return;
      if (reduced) {
        // one still frame, redrawn only when data or size changes
        step(1);
        if (dirty || live.current !== lastSeen) render();
        lastSeen = live.current;
        dirty = false;
        return;
      }
      elapsed += dt;
      step(dt);
      render();
    }
    let lastSeen = live.current;
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      geo.dispose();
      mat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      halo.geometry.dispose();
      haloMat.dispose();
      bodyGeo.dispose();
      bodyMat.dispose();
      glowMat.dispose();
      glowTex.dispose();
      labelLayer.remove();
      orbits.forEach((o) => o.geometry.dispose());
      orbitMats.forEach((m) => m.dispose());
      bloom?.dispose();
      composer?.dispose();
      scene.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={ref} className={`gfield ${failed ? "gfield-static" : ""} ${className}`} aria-hidden="true" />;
}
