import Lenis from 'lenis';
import * as THREE from 'three';
import './style.css';

/* ============================================================
   GLITCH — The Glitch Edition

   Stage model: NO still images. The pinned stage always shows a
   frame of one continuous filmstrip of morph videos, scrubbed by
   scroll. Each chapter's dark scene-block is split in two halves:
     • first half  → the ARRIVING morph resolves (t 0.45 → 1.0)
     • second half → the DEPARTING morph begins (t 0 → 0.45)
   Video i ends on the exact frame video i+1 starts on, so the
   strip is seamless. The paper blocks cover the stage, so the
   hidden middle of each morph is never wasted under an overlay.
   The hero stays a live 2.5D parallax scene and hard-cuts into
   the detonation under a white flash.
   ============================================================ */

const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 1.0 });

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut2 = (t: number) => 1 - (1 - t) * (1 - t);
const smooth = (t: number) => t * t * (3 - 2 * t);
const sstep = (a: number, b: number, x: number) => smooth(clamp01((x - a) / (b - a)));

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;

const texLoader = new THREE.TextureLoader();
const maxAniso = () => renderer.capabilities.getMaxAnisotropy();

/* ============================================================
   Filmstrip
   ============================================================ */
const chapterIds = ['hero', 'what', 'mission', 'cohort', 'courses', 'partners', 'start'];

const VIDEO_SRC = [
  '/assets/video/t1-blast.mp4',          // 0  detonation → blast ridge
  '/assets/video/t2-blast-tower.mp4',    // 1  blast → banana tower
  '/assets/video/t3-tower-cohort.mp4',   // 2  tower → the gathering
  '/assets/video/t4-cohort-courses.mp4', // 3  gathering → workshop
  '/assets/video/t5-courses-hands.mp4',  // 4  workshop → the hand-off
];

type Seg = [video: number, t0: number, t1: number];
type ChapterPlan = { arr?: Seg; dep?: Seg; mode: number; center: [number, number] };
/** mode: 0 linear torn wipe · 1 radial iris · 2 shred · 3 curtain */
const PLAN: ChapterPlan[] = [
  // departing half = first 20% of the next clip (the scene alive but still
  // recognisable under its headline); arriving half = the transformation
  { dep: [0, 0.0, 0.45],                        mode: 1, center: [0.5, 0.42] }, // hero → flash
  { arr: [0, 0.45, 1.0], dep: [1, 0.0, 0.20],   mode: 1, center: [0.5, 0.42] }, // what
  { arr: [1, 0.20, 1.0], dep: [2, 0.0, 0.20],   mode: 0, center: [0.5, 0.50] }, // mission
  { arr: [2, 0.20, 1.0], dep: [3, 0.0, 0.20],   mode: 2, center: [0.5, 0.45] }, // cohort (shred)
  { arr: [3, 0.20, 1.0], dep: [4, 0.0, 0.12],   mode: 0, center: [0.5, 0.50] }, // courses
  { arr: [4, 0.12, 0.55], dep: [4, 0.55, 1.0],  mode: 1, center: [0.5, 0.48] }, // partners: two hands reaching for each other
  {                                             mode: 1, center: [0.5, 0.48] }, // start: THE REWIND, then the crash
];
/** the rewind: keyframes through every scene, backwards, from the hands to the tree */
const REWIND_KEYS: { strip: number; frac: number }[] = [];
for (let si = VIDEO_SRC.length - 1; si >= 0; si--)
  for (let j = 0; j < 8; j++) REWIND_KEYS.push({ strip: si, frac: 1 - j / 7.5 });
const REWIND_END = 0.6;   // fraction of the finale block spent rewinding
const HERO_HANDOFF = 0.76; // fraction of the hero block where the flash cut happens

type Strip = {
  video: HTMLVideoElement; tex: THREE.VideoTexture;
  ready: boolean; dur: number; pending: number | null; shown: number; idle: number;
};
const strips: Strip[] = VIDEO_SRC.map((src) => {
  const video = document.createElement('video');
  video.src = src;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const s: Strip = { video, tex, ready: false, dur: 5, pending: null, shown: 0, idle: 0 };
  video.addEventListener('loadedmetadata', () => {
    s.dur = video.duration || 5;
    s.ready = true;
    video.currentTime = 0.001; // warm the decoder
  });
  // one seek in flight at a time — issuing seeks while one is pending
  // is what produces scrub jitter
  video.addEventListener('seeked', () => {
    s.shown = video.currentTime;
    s.tex.needsUpdate = true;
    if (s.pending !== null) {
      const t = s.pending;
      s.pending = null;
      video.currentTime = t;
    }
  });
  video.load();
  return s;
});

function seek(s: Strip, t: number) {
  if (!s.ready) return;
  const want = Math.min(Math.max(t, 0), s.dur - 0.04);
  if (s.video.seeking) { s.pending = want; return; }
  if (Math.abs(s.video.currentTime - want) < 1 / 48) return;
  s.video.currentTime = want;
}

/** Chasing playhead: forward scroll PLAYS the video toward the target at a
 *  proportional rate (decode-smooth, no per-frame seeks); reversing or a
 *  large jump falls back to a seek. This is what removes scrub stutter. */
function drive(s: Strip, target: number) {
  if (!s.ready) return;
  const v = s.video;
  const want = Math.min(Math.max(target, 0), s.dur - 0.04);
  const diff = want - v.currentTime;
  if (diff < -0.06 || diff > 0.9) {          // reversed, or far behind: jump
    if (!v.paused) v.pause();
    s.idle = 0;
    seek(s, want);
    return;
  }
  if (diff > 0.006) {                          // ahead: chase it
    s.idle = 0;
    v.playbackRate = Math.min(4, Math.max(0.07, diff * 6.5));
    if (v.paused) v.play().catch(() => {});
  } else if (++s.idle > 24 && !v.paused) {
    v.pause();                                 // park only after a real rest, never between ticks
  }
}
function park(s: Strip) { if (!s.video.paused) s.video.pause(); }
/** keep the decoder hot under the hero so the cut has no start-up hitch */
function warm(s: Strip) {
  if (s.ready && s.video.paused) { s.video.playbackRate = 0.07; s.video.play().catch(() => {}); }
}

/* ============================================================
   Stage quad — one texture, developed from engraving to colour
   by the threshold field (Shopify Editions technique)
   ============================================================ */
const stageScene = new THREE.Scene();
const stageCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const U = {
  tCur: { value: null as THREE.Texture | null },
  uHas: { value: 0 },
  uAr: { value: 16 / 9 },
  uScreen: { value: 1.79 },
  uZoom: { value: 1 },
  uDev: { value: 1 },        // 0 = pure engraving … 1 = full colour
  uMode: { value: 0 },
  uCenter: { value: new THREE.Vector2(0.5, 0.45) },
  uFlash: { value: 0 },
  uTime: { value: 0 },
  uRes: { value: new THREE.Vector2(2, 2) },
  uMouse: { value: new THREE.Vector2(0, 0) },
  uCrash: { value: 0 },      // the finale: the painting tears into the raw system
  uRewind: { value: 0 },     // the finale: VHS rewind through the whole story
};

stageScene.add(
  new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: U,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tCur;
        uniform float uHas, uAr, uScreen, uZoom, uDev, uMode, uFlash, uTime, uCrash, uRewind;
        uniform vec2 uCenter, uRes, uMouse;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                     mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.5;
          for(int i=0;i<5;i++){ v += a*vnoise(p); p *= 2.03; a *= 0.5; }
          return v;
        }
        float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
        vec2 coverUV(vec2 uv){
          vec2 s = vec2(1.0);
          if (uScreen > uAr) s.y = uAr / uScreen; else s.x = uScreen / uAr;
          return (uv - uCenter) * s / uZoom + uCenter;
        }

        void main(){
          vec2 uv = vUv;
          // depth-weighted mouse parallax: the ground (bottom) shifts more than the sky
          vec2 puv = uv + uMouse * vec2(0.014, 0.010) * mix(1.5, 0.35, uv.y);
          vec3 col = texture2D(tCur, coverUV(puv)).rgb * uHas;
          float p = clamp(uDev, 0.0, 1.0);

          if (p < 0.999) {
            // engraving of the same frame: fwidth(luma) is a free etching
            float l = luma(col);
            // kept luminous: the etching never reads as an empty dark screen
            vec3 etch = vec3(fwidth(l) * 9.0) + col * 0.38;

            // threshold field
            float n   = fbm(uv * 3.2 + vec2(uTime * 0.02, 0.0));
            float mud = (fbm(uv * vec2(9.0, 3.0) + vec2(0.0, uTime * 0.05)) - 0.5)
                        * mix(0.30, 0.62, 0.5 + 0.5 * sin(uTime - uv.x * 10.0));
            float thr;
            if (uMode > 0.5 && uMode < 1.5) {
              float d = length((uv - uCenter) * vec2(uScreen, 1.0)) * 0.8;
              thr = mix(d, uv.x, smoothstep(0.6, -0.4, abs(uv.x - uCenter.x)) * mix(0.0, 0.4, smoothstep(0.05, 0.5, p)));
              thr = mix(thr, 0.0, smoothstep(0.9, 1.0, p));
            } else if (uMode > 1.5 && uMode < 2.5) {
              float row = floor(uv.y * 90.0);
              thr = uv.y + (hash(vec2(row, 3.0)) - 0.5) * 0.34 + sin(uTime * 1.5 + row) * 0.03;
            } else {
              thr = mix(uv.y, uv.x, smoothstep(0.6, -0.4, abs(uv.x - 0.5)) * 0.5);
            }
            thr = thr * 2.0 - 1.0;
            thr = thr / 1.2 + n * 0.30 + mud * 0.22;
            thr = thr * 0.5 + 0.5;

            float edge  = p - thr;
            float aa    = fwidth(edge) * 10.0;
            float blend = smoothstep(-aa, aa, edge);

            if (uMode > 2.5) {
              // curtain: ink sheet sweeps over the etching, then peels to colour
              float cover = smoothstep(-aa, aa, min(p, 0.5) * 2.0 - thr);
              float open  = smoothstep(-aa, aa, max(p - 0.5, 0.0) * 2.0 - (1.0 - thr));
              vec3 c2 = mix(etch, vec3(0.035, 0.032, 0.03), cover);
              col = mix(c2, col, open);
              col += vec3(1.0, 0.93, 0.80) * (1.0 - smoothstep(0.0, 0.004, abs(min(p,0.5)*2.0 - thr))) * 0.5;
            } else {
              col = mix(etch, col, blend);
              float rim = 1.0 - smoothstep(0.0, 0.0035, abs(edge));
              col += vec3(1.0, 0.94, 0.82) * rim * 0.85;
              float spark = smoothstep(0.02, 0.0, abs(edge)) *
                            step(0.86, hash(floor(uv * uRes * 0.35) + floor(uTime * 20.0)));
              col += vec3(1.0, 0.85, 0.6) * spark * 0.5;
            }
          }

          // the rewind: tracking bar, row jitter, washed VHS colour
          if (uRewind > 0.001) {
            float bar = smoothstep(0.07, 0.0, abs(fract(uv.y + uTime * 0.42) - 0.5));
            vec2 ruv = puv;
            ruv.x += (hash(vec2(floor(uv.y * 160.0), floor(uTime * 24.0))) - 0.5) * 0.018 + bar * 0.035;
            vec3 rc = texture2D(tCur, coverUV(ruv)).rgb * uHas;
            float rl = luma(rc);
            rc = mix(vec3(rl), rc, 0.62) * (0.85 + 0.15 * sin(vUv.y * uRes.y * 0.9));
            rc += bar * 0.28 + (hash(gl_FragCoord.xy * 0.5 + uTime * 90.0) - 0.5) * 0.14;
            col = mix(col, rc, uRewind);
          }

          // the crash: the film shreds row by row into a dark scanlined system
          if (uCrash > 0.001) {
            float band = floor(uv.y * 44.0);
            float tear = step(hash(vec2(band, 3.0)) * 0.85 + 0.05, uCrash);
            float shift = (hash(vec2(band, floor(uTime * 9.0))) - 0.5) * 0.25 * uCrash * (1.0 - tear);
            vec3 torn = texture2D(tCur, coverUV(puv + vec2(shift, 0.0))).rgb * uHas;
            float scan = 0.5 + 0.5 * sin(vUv.y * uRes.y * 1.1);
            vec3 sys = vec3(0.012, 0.012, 0.015) + vec3(0.025) * scan
                     + (hash(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.045;
            col = mix(torn, sys, max(tear, smoothstep(0.6, 1.0, uCrash)));
          }

          // soft vignette + grain
          vec2 vp = (vUv - 0.5) * vec2(uScreen / 1.79, 1.0);
          col *= smoothstep(1.25, 0.35, length(vp)) * 0.18 + 0.82;
          col += (hash(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.02;

          // the detonation flash that masks the hero cut
          col = mix(col, vec3(1.0, 0.97, 0.92), uFlash);

          // textures are decoded to linear on sample; encode back for the screen
          col = pow(max(col, 0.0), vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
  )
);

/* full-screen detonation flash, drawn above everything (hero included) */
const flashScene = new THREE.Scene();
const flashMat = new THREE.MeshBasicMaterial({ color: 0xfff7ea, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
flashScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flashMat));

/* per-chapter particle layer — embers, gold dust, motes, sparks — floating
   in front of the film with real camera parallax */
const fxScene = new THREE.Scene();
const FX_N = 420;
const fxPos = new Float32Array(FX_N * 3);
for (let i = 0; i < FX_N; i++) {
  fxPos[i * 3] = (Math.random() - 0.5) * 24;
  fxPos[i * 3 + 1] = (Math.random() - 0.5) * 14;
  fxPos[i * 3 + 2] = -3 + Math.random() * 9;
}
const fxGeo = new THREE.BufferGeometry();
fxGeo.setAttribute('position', new THREE.BufferAttribute(fxPos, 3));
const fxSprite = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const fxMat = new THREE.PointsMaterial({
  color: 0xffd9a0, size: 0.11, map: fxSprite, transparent: true, opacity: 0.55,
  depthWrite: false, blending: THREE.AdditiveBlending,
});
fxScene.add(new THREE.Points(fxGeo, fxMat));
const FX_COLOR = [0xd8d2c0, 0xff9a3c, 0xffd27a, 0xf2e6c8, 0xffc76b, 0xffc76b, 0xffe9a8].map((c) => new THREE.Color(c));
let lastScroll = 0;

/* ============================================================
   Hero — live 2.5D banana-tree scene
   ============================================================ */
const world = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
const CAM = new THREE.Vector3(0, 1.3, 10.5);
const LOOK = new THREE.Vector3(0, 1.3, 0);
const heroGroup = new THREE.Group();
world.add(heroGroup);

type HeroLayer = {
  src: string; ar: number;
  x: number; y: number; z: number; h: number;
  sway?: number; flip?: boolean; drift?: number;
  anchor?: 'tc' | 'tr' | 'tl';   // which top corner hangs from the pivot (default top-centre)
};
const P = '/assets/hero/parts/';
const HERO_LAYERS: HeroLayer[] = [
  { src: '/assets/hero/landscape.png', ar: 1672 / 941, x: 0, y: 1.2, z: -12, h: 22 },
  // sky: the sheet split into its individual clouds, scattered across the
  // whole upper band at mixed depths so each drifts at its own rate
  { src: P + 'cloud-08.png', ar: 579 / 120, x: -12.2, y: 5.4, z: -10.8, h: 1.00, drift: 0.20 },
  { src: P + 'cloud-05.png', ar: 712 / 159, x: 5.8, y: 8.1, z: -10.5, h: 1.20, drift: 0.22 },
  { src: P + 'cloud-07.png', ar: 399 / 179, x: -3.8, y: 7.9, z: -10.0, h: 1.50, drift: 0.26 },
  { src: P + 'cloud-11.png', ar: 126 / 52, x: 1.2, y: 8.2, z: -9.6, h: 0.55, drift: 0.30 },
  { src: P + 'cloud-01.png', ar: 870 / 347, x: -9.5, y: 6.4, z: -9.5, h: 2.40, drift: 0.30 },
  { src: P + 'cloud-06.png', ar: 363 / 187, x: 12.2, y: 7.4, z: -9.2, h: 1.70, drift: 0.34 },
  { src: P + 'cloud-04.png', ar: 578 / 229, x: 8.2, y: 7.0, z: -9.0, h: 2.10, drift: 0.38 },
  { src: P + 'cloud-10.png', ar: 177 / 90, x: -5.4, y: 6.0, z: -8.8, h: 0.80, drift: 0.40 },
  { src: P + 'cloud-09.png', ar: 326 / 125, x: 3.4, y: 5.8, z: -8.6, h: 1.15, drift: 0.42 },
  { src: P + 'cloud-03.png', ar: 787 / 217, x: 10.6, y: 5.1, z: -8.2, h: 1.50, drift: 0.50 },
  { src: P + 'cloud-02.png', ar: 760 / 273, x: -7.8, y: 4.8, z: -8.0, h: 1.90, drift: 0.45 },
  { src: P + 'tree-clean.png', ar: 939 / 936, x: 0.5, y: 0.9, z: -3, h: 11.6 },
  // fronds growing from the crown junction — they hide the tapered sheet edges
  { src: P + 's2-02_x1034_y166_w489_h144.png', ar: 489 / 144, x: -1.35, y: 6.05, z: -2.85, h: 1.44, sway: 0.045, flip: true, anchor: 'tr' },
  { src: P + 's1-05_x1136_y254_w315_h284.png', ar: 315 / 284, x: -1.6, y: 5.3, z: -2.8, h: 3.5, sway: 0.04, flip: true, anchor: 'tr' },
  { src: P + 's2-01_x976_y10_w549_h206.png', ar: 549 / 206, x: 2.6, y: 6.3, z: -2.9, h: 2.78, sway: 0.035 },
  // the bunch hangs from the trunk-top wood — all green: the orange banana is a
  // separate sheet in front of it, so it can detach and fall on its own
  { src: P + 'bunch-noorange.png', ar: 252 / 342, x: -0.85, y: 5.15, z: -2.7, h: 3.2, sway: 0.02 },
  { src: P + 's1-07_x1126_y446_w282_h252.png', ar: 282 / 252, x: 2.7, y: -2.8, z: -2.2, h: 2.8 },
  { src: P + 's1-07_x1126_y446_w282_h252.png', ar: 282 / 252, x: -2.5, y: -2.9, z: -2.3, h: 2.4, flip: true },
  { src: P + 's2-09_x845_y536_w460_h283.png', ar: 460 / 283, x: 0.0, y: -3.9, z: -1.25, h: 2.3 },
  { src: P + 's2-07_x498_y404_w440_h593.png', ar: 440 / 593, x: -0.3, y: -2.5, z: -1, h: 4.4 },
  { src: P + 's1-10_x459_y766_w230_h243.png', ar: 230 / 243, x: -2.9, y: -3.05, z: -0.9, h: 1.55 },
  { src: P + 's1-12_x15_y829_w432_h192.png', ar: 432 / 192, x: -3.5, y: -3.95, z: -0.8, h: 1.5 },
  { src: P + 's1-09_x1140_y698_w381_h163.png', ar: 381 / 163, x: 4.7, y: -4.05, z: -1.5, h: 1.4 },
  { src: P + 's1-11_x670_y801_w498_h203.png', ar: 498 / 203, x: 3.6, y: -4.45, z: -0.5, h: 1.35 },
  { src: P + 's2-10_x13_y844_w358_h173.png', ar: 358 / 173, x: -5.8, y: -4.35, z: -0.4, h: 1.5 },
  { src: P + 's1-13_x1159_y861_w355_h157.png', ar: 355 / 157, x: 1.8, y: -4.5, z: -0.3, h: 1.25 },
  { src: P + 's2-11_x460_y918_w196_h101.png', ar: 196 / 101, x: 5.9, y: -4.4, z: -0.4, h: 1.1 },
  { src: P + 's1-04_x672_y177_w189_h237.png', ar: 189 / 237, x: -5.8, y: 6.2, z: 5.5, h: 4.6, sway: 0.06 },
];

const heroMats: THREE.MeshBasicMaterial[] = [];
const swayers: { g: THREE.Group; amp: number; phase: number }[] = [];
const drifters: { m: THREE.Mesh; speed: number; x0: number }[] = [];
const coverMeshes: { mesh: THREE.Mesh; z: number; baseW: number; baseH: number }[] = [];

function coverFit() {
  const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  for (const c of coverMeshes) {
    const dist = CAM.z - c.z;
    const needW = (halfTan * dist * camera.aspect + 1.6) * 2;
    const needH = (halfTan * dist + 1.6) * 2;
    c.mesh.scale.setScalar(Math.max(needW / c.baseW, needH / c.baseH, 1));
  }
}

for (const l of HERO_LAYERS) {
  texLoader.load(l.src, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    heroMats.push(mat);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(l.h * l.ar, l.h), mat);
    if (l.flip) mesh.scale.x = -1;
    mesh.renderOrder = 100 + l.z * 10;
    if (l.src.endsWith('landscape.png')) {
      coverMeshes.push({ mesh, z: l.z, baseW: l.h * l.ar, baseH: l.h });
      coverFit();
    }
    if (l.sway) {
      const pivot = new THREE.Group();
      pivot.position.set(l.x, l.y, l.z);
      mesh.position.y = -l.h / 2;
      if (l.anchor === 'tr') mesh.position.x = -(l.h * l.ar) / 2;
      if (l.anchor === 'tl') mesh.position.x = (l.h * l.ar) / 2;
      pivot.add(mesh);
      heroGroup.add(pivot);
      swayers.push({ g: pivot, amp: l.sway, phase: Math.random() * Math.PI * 2 });
    } else {
      mesh.position.set(l.x, l.y, l.z);
      heroGroup.add(mesh);
      if (l.drift) drifters.push({ m: mesh, speed: l.drift, x0: l.x });
    }
  });
}

{
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(18,15,10,1)');
  grad.addColorStop(0.45, 'rgba(10,9,7,0.85)');
  grad.addColorStop(1, 'rgba(6,6,5,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
  heroMats.push(mat);
  const earth = new THREE.Mesh(new THREE.PlaneGeometry(34, 3), mat);
  earth.position.set(0, -5.9, -2.0);
  earth.renderOrder = 90;
  heroGroup.add(earth);
}

/** where the orange banana sits in the bunch — the gap cut out of bunch-noorange */
const BANANA_REST = { x: -0.735, y: 3.425, z: -2.6 };
/** its painted twin hung 1.6° further over than this crop does */
const BANANA_TILT = -0.028;
let fallingBanana: THREE.Mesh | null = null;
texLoader.load(P + 's1-08_x1424_y554_w88_h159.png', (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso();
  const h = 1.5;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  heroMats.push(mat);
  fallingBanana = new THREE.Mesh(new THREE.PlaneGeometry(h * (88 / 159), h), mat);
  fallingBanana.position.set(BANANA_REST.x, BANANA_REST.y, BANANA_REST.z);
  fallingBanana.rotation.z = BANANA_TILT;
  fallingBanana.renderOrder = 400;
  heroGroup.add(fallingBanana);
});


/* ============================================================
   Scroll → stage state
   ============================================================ */
const sections = chapterIds
  .map((id) => document.getElementById(id))
  .filter((el): el is HTMLElement => el !== null);
const blocks = sections.map((s) => s.querySelector<HTMLElement>('.scene-block') ?? s);
const papers = sections.map((s) => s.querySelector<HTMLElement>('.paper-block'));
const railLinks = [...document.querySelectorAll<HTMLAnchorElement>('.rail-chapters a')];
const paperBlocks = [...document.querySelectorAll<HTMLElement>('.paper-block')]; // the footer is dark now
const heroSection = document.getElementById('hero');

type StageState = {
  active: number; strip: number; time: number;      // which video frame to show
  dev: number; mode: number; center: [number, number];
  flash: number; heroS: number;
  s: number;                                         // progress through the active block
  rewind: number;                                    // VHS rewind intensity (finale)
};

function stageState(): StageState {
  const vh = window.innerHeight;
  const mid = vh * 0.5;
  let active = 0;
  sections.forEach((sec, i) => { if (sec.getBoundingClientRect().top <= mid) active = i; });

  const b = blocks[active].getBoundingClientRect();
  const s = (mid - b.top) / Math.max(1, b.height); // 0 at block top … 1 at block bottom (paper begins)
  const plan = PLAN[active];

  let strip = -1, time = 0, dev = 1, flash = 0, rewind = 0;
  const heroS = active === 0 ? s : 1;

  if (active === sections.length - 1) {
    // finale: the whole story rewinds, scene by scene, back to the tree
    const u = clamp01(s / REWIND_END);
    const idx = Math.min(REWIND_KEYS.length - 1, Math.floor(u * REWIND_KEYS.length));
    strip = REWIND_KEYS[idx].strip; time = Math.max(0, Math.min(1, REWIND_KEYS[idx].frac));
    rewind = u < 1 ? 1 : 0;
    return { active, strip, time, dev, mode: plan.mode, center: plan.center, flash, heroS, s, rewind };
  }

  if (active === 0) {
    // hero: live scene → white flash ramps up over it → hard cut onto the
    // detonation strip under full white → flash decays over the blast
    const u = clamp01((s - HERO_HANDOFF) / (1 - HERO_HANDOFF));
    if (plan.dep && s >= HERO_HANDOFF - 0.04) {
      const [v, t0, t1] = plan.dep;
      strip = v; time = t0 + (t1 - t0) * u;   // parked on frame 0 under the hero until the cut
    }
    flash = s < HERO_HANDOFF ? sstep(HERO_HANDOFF - 0.035, HERO_HANDOFF, s) : 1 - sstep(0, 0.28, u);
  } else if (s < 0.5 && plan.arr) {
    const u = clamp01(s * 2);
    const [v, t0, t1] = plan.arr;
    strip = v; time = t0 + (t1 - t0) * u;
    dev = sstep(0.0, 0.40, u);                     // engraving develops into colour, quickly
  } else {
    // departing: 60% across the block's lower half, the remaining 40% rolls
    // on beside the paper card so the film never freezes next to content
    const pr = papers[active];
    let sp = 0;
    if (pr) { const r = pr.getBoundingClientRect(); sp = clamp01((mid - r.top) / Math.max(1, r.height)); }
    const u = 0.6 * clamp01((s - 0.5) * 2) + 0.4 * sp;
    const seg = plan.dep ?? plan.arr!;
    const [v, t0, t1] = plan.dep ? seg : [seg[0], seg[2], seg[2]];
    strip = v; time = t0 + (t1 - t0) * u;
  }
  return { active, strip, time, dev, mode: plan.mode, center: plan.center, flash, heroS, s, rewind };
}

const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
const pointer = { x: 0, y: 0, has: false };
window.addEventListener('pointermove', (e) => {
  mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
  mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.has = true;
});

/* ============================================================
   Scroll-scrubbed DOM animation
   ============================================================ */
type Anim = { el: HTMLElement; kind: string; parts?: HTMLElement[]; index?: number };
const anims: Anim[] = [];

function splitChars(el: HTMLElement): HTMLElement[] {
  const text = el.textContent ?? '';
  el.textContent = '';
  return [...text].map((ch) => {
    const s = document.createElement('span');
    s.className = 'ch';
    s.textContent = ch === ' ' ? ' ' : ch;
    el.appendChild(s);
    return s;
  });
}
/** words stay unbreakable; letters animate individually */
function splitWordChars(el: HTMLElement): HTMLElement[] {
  const text = el.textContent ?? '';
  el.textContent = '';
  const chars: HTMLElement[] = [];
  text.split(/\s+/).filter(Boolean).forEach((word, wi, arr) => {
    const w = document.createElement('span');
    w.className = 'wd';
    for (const ch of word) {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = ch;
      w.appendChild(s);
      chars.push(s);
    }
    el.appendChild(w);
    if (wi < arr.length - 1) el.appendChild(document.createTextNode(' '));
  });
  return chars;
}

function splitWords(el: HTMLElement, scriptInitial = false): HTMLElement[] {
  const text = el.textContent ?? '';
  el.textContent = '';
  const parts: HTMLElement[] = [];
  text.split(/\s+/).filter(Boolean).forEach((word, wi) => {
    const s = document.createElement('span');
    s.className = 'wd';
    if (wi === 0 && scriptInitial) {
      const ini = document.createElement('span');
      ini.className = 'ini';
      ini.textContent = word[0];
      s.appendChild(ini);
      s.appendChild(document.createTextNode(word.slice(1)));
    } else s.textContent = word;
    el.appendChild(s);
    el.appendChild(document.createTextNode(' '));
    parts.push(s);
  });
  return parts;
}
function passage(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return clamp01((window.innerHeight - r.top) / (window.innerHeight + r.height));
}
function setupAnims() {
  document.querySelectorAll<HTMLElement>('.chapter-title').forEach((el) => anims.push({ el, kind: 'title', parts: splitChars(el) }));
  document.querySelectorAll<HTMLElement>('.finale-title').forEach((el) => anims.push({ el, kind: 'crash', parts: splitWordChars(el) }));
  document.querySelectorAll<HTMLElement>('.finale-cta').forEach((el) => anims.push({ el, kind: 'crashCta' }));
  document.querySelectorAll<HTMLElement>('.statement').forEach((el) => anims.push({ el, kind: 'statement', parts: splitWords(el, true) }));
  document.querySelectorAll<HTMLElement>('.definition, .lede').forEach((el) => anims.push({ el, kind: 'statement', parts: splitWords(el, false) }));
  document.querySelectorAll<HTMLElement>('.feature, .principles li, .course-list li, .partner-slot, .footer-col, .footer-brand, .start-cta, .paper-figure')
    .forEach((el, i) => anims.push({ el, kind: 'rise', index: i }));
  const plate = document.querySelector<HTMLElement>('.hero-plate');
  if (plate) anims.push({ el: plate, kind: 'heroPlate' });
  const desc = document.querySelector<HTMLElement>('.hero-descriptor');
  if (desc) anims.push({ el: desc, kind: 'heroDesc' });
  document.querySelectorAll<HTMLElement>('.hero-index li').forEach((el, i) => anims.push({ el, kind: 'rise', index: i }));
}
setupAnims();

let finaleS = 0;
function updateAnims(t: number) {
  const heroP = heroSection ? clamp01(-heroSection.getBoundingClientRect().top / (heroSection.offsetHeight * 0.6)) : 0;
  for (const a of anims) {
    if (a.kind === 'crash' && a.parts) {
      // letters materialise out of the crash with RGB tearing, then flicker
      a.parts.forEach((c, i) => {
        const p = clamp01((finaleS - (REWIND_END + 0.08) - i * 0.008) / 0.05);
        const flicker = p >= 1 && hashS(Math.floor(t * 7) * 0.37 + i) > 0.975;
        const tearing = (p > 0 && p < 1) || flicker;
        const jx = tearing ? (hashS(t * 13 + i) - 0.5) * 18 : 0;
        const jy = tearing ? (hashS(t * 17 + i * 3) - 0.5) * 10 : 0;
        c.style.opacity = String(p);
        c.style.transform = `translate(${jx}px, ${jy}px)`;
        c.style.textShadow = tearing ? '-7px 0 rgba(255,40,90,0.9), 7px 0 rgba(40,220,255,0.9)' : 'none';
      });
      continue;
    }
    if (a.kind === 'crashCta') {
      const e = sstep(REWIND_END + 0.26, REWIND_END + 0.36, finaleS);
      a.el.style.opacity = String(e);
      a.el.style.transform = `translateY(${(1 - e) * 18}px)`;
      continue;
    }
    const p = passage(a.el);
    if (a.kind === 'title' && a.parts) {
      const n = a.parts.length;
      a.el.style.transform = `translateY(${(0.5 - p) * 70}px)`;
      a.parts.forEach((c, i) => {
        const st = n > 1 ? i / (n - 1) : 0;
        const e = easeOut2(clamp01(p * 3.2 - st * 0.9 - 0.15));
        const ex = clamp01((p - 0.72) / 0.28);
        c.style.transform = `translateY(${(1 - e) * 90 - ex * 70 * (0.4 + st * 0.6)}px) rotate(${(1 - e) * 6 * (st - 0.5)}deg)`;
        c.style.opacity = String(Math.min(e, 1 - ex * 0.85));
      });
    } else if (a.kind === 'statement' && a.parts) {
      const n = a.parts.length;
      a.parts.forEach((w, i) => {
        const st = n > 1 ? i / (n - 1) : 0;
        const e = easeOut2(clamp01(p * 3.0 - st * 0.8 - 0.25));
        const ex = clamp01((p - 0.78) / 0.22);
        w.style.transform = `translateY(${(1 - e) * 46 - ex * 30}px)`;
        w.style.opacity = String(Math.min(e, 1 - ex * 0.8));
      });
    } else if (a.kind === 'rise') {
      const e = easeOut2(clamp01(p * 3.4 - 0.3 - ((a.index ?? 0) % 6) * 0.12));
      a.el.style.transform = `translateY(${(1 - e) * 56}px)`;
      a.el.style.opacity = String(e);
    } else if (a.kind === 'heroPlate') {
      a.el.style.transform = `translateY(${heroP * -140}px) scale(${1 - heroP * 0.06})`;
      a.el.style.opacity = String(1 - heroP * 1.25);
    } else if (a.kind === 'heroDesc') {
      a.el.style.transform = `translateY(${heroP * 80}px)`;
      a.el.style.opacity = String(1 - heroP * 1.5);
    }
  }
}

/* ============================================================
   The travelling banana — one object carried through the whole
   page. It falls perch to perch (scroll-driven, fully reversible),
   rides each perch with its element, and glitches at every impact.
   ============================================================ */
const traveler = document.getElementById('traveler') as HTMLImageElement | null;
const PERCHES = [
  { sel: '#what .feature:nth-child(3) h4',                       dx: -0.09, dy: 0.5,  rot: -30, scale: 0.85 }, // leaning on "Find"
  { sel: '#mission .principles li:nth-child(3) strong',          dx: -0.10, dy: 0.5,  rot: 28,  scale: 0.75 }, // the bullet of "Bounties,"
  { sel: '#cohort .paper-figure',                                dx: 0.5,  dy: 0.02,  rot: -10, scale: 1.0 },  // on the pedestal picture
  { sel: '#courses .course-list li:nth-child(1) .course-thumb',  dx: 1.15, dy: 0.5,   rot: 42,  scale: 0.8 },  // against Foundations
  { sel: '#partners .partner-slot:nth-child(2)',                 dx: 0.5,  dy: 0.28,  rot: -18, scale: 1.25 }, // the first partner
];
// after the last perch the banana falls out of the page — and YOU catch it
const finaleCta = document.querySelector<HTMLElement>('.finale-cta');
const finaleTitle = document.querySelector<HTMLElement>('.finale-title');
const held = { caught: false, x: 0, y: 0, vx: 0, since: 0 };
const perchEls = PERCHES.map((p) => document.querySelector<HTMLElement>(p.sel));
const FALL_RATE = 1.6; // the banana falls 1.6× faster than the page scrolls
const bump = (d: number, w: number) => Math.max(0, 1 - Math.abs(d) / w);
const hashS = (x: number) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
const _v3 = new THREE.Vector3();
function bananaScreen(): [number, number] | null {
  if (!fallingBanana) return null;
  fallingBanana.getWorldPosition(_v3).project(camera);
  return [(_v3.x * 0.5 + 0.5) * window.innerWidth, (-_v3.y * 0.5 + 0.5) * window.innerHeight];
}

function updateTraveler(st: StageState, t: number) {
  if (!traveler) return;
  const S = window.scrollY, vh = window.innerHeight, vw = window.innerWidth;
  const exitOff = 0.06 * vh;

  const A: { x: number; docY: number; rot: number; scale: number }[] = [];
  for (let i = 0; i < PERCHES.length; i++) {
    const el = perchEls[i];
    if (!el) { traveler.style.opacity = '0'; return; }
    const r = el.getBoundingClientRect();
    A.push({ x: r.left + r.width * PERCHES[i].dx, docY: r.top + S + r.height * PERCHES[i].dy, rot: PERCHES[i].rot, scale: PERCHES[i].scale });
  }
  const last = A.length - 1;
  // a perch is "left" when its anchor passes the top edge
  const exitOf = (i: number) => A[i].docY + exitOff;

  let x = 0, y = 0, rot = 0, scale = 1, alpha = 1, g = 0;
  const startS = A[0].docY - 1.25 * vh; // the first fall: from the sky onto "Find"

  if (S < startS) {
    if (held.caught) { held.caught = false; document.body.style.cursor = ''; }
    // hero: the 3D banana acts; at the flash this one bursts upward into the cloud
    const u = st.active === 0 && st.heroS >= HERO_HANDOFF
      ? clamp01((st.heroS - HERO_HANDOFF) / 0.22)
      : (st.active > 0 ? 1 : -1);
    const bs = bananaScreen();
    if (u < 0 || u >= 1 || !bs) { traveler.style.opacity = '0'; return; }
    x = bs[0]; y = bs[1] - u * 0.95 * vh; rot = u * 540; scale = 1 + u * 3.2; alpha = 1 - smooth(u); g = bump(u, 0.18);
  } else {
    let k = -1;
    for (let i = 0; i < A.length; i++) if (S >= exitOf(i)) k = i;
    const exitS = k < 0 ? startS : exitOf(k);
    const fromX = k < 0 ? A[0].x + vw * 0.08 : A[k].x;
    const fromRot = k < 0 ? -60 : A[k].rot;
    const fromScale = k < 0 ? 0.85 : A[k].scale;
    const next = k + 1;
    if (next > last) {
      // the banana falls out of the page. Your cursor is the hand that catches
      // it; with no pointer it lands in the crashed title.
      const tr = finaleTitle?.getBoundingClientRect();
      const landX = pointer.has ? pointer.x : (tr ? tr.left + tr.width / 2 : vw / 2);
      const landY = pointer.has ? pointer.y : (tr ? tr.top - 40 : vh * 0.4);
      const yFall = -exitOff + (S - exitS) * FALL_RATE;
      if (!held.caught && yFall >= landY - 6) { held.caught = true; held.x = landX; held.y = landY; held.since = t; }
      if (held.caught) {
        const px = held.x, py = held.y;
        held.x += (landX - held.x) * 0.16;
        held.y += (landY - held.y) * 0.16;
        held.vx = held.vx * 0.8 + (held.x - px) * 0.2;
        x = held.x; y = held.y + 6;
        rot = Math.max(-28, Math.min(28, held.vx * 2.2)) + 8;
        scale = fromScale + 0.15;
        g = Math.max(bump(t - held.since, 0.55), hashS(Math.floor(t * 3) * 0.7) > 0.93 ? 0.55 : 0);
        if (finaleCta) {
          const r = finaleCta.getBoundingClientRect();
          const over = x > r.left - 30 && x < r.right + 30 && y > r.top - 30 && y < r.bottom + 30;
          finaleCta.classList.toggle('caught', over);
        }
        document.body.style.cursor = pointer.has ? 'none' : '';
        void py;
      } else {
        const u = clamp01((yFall + exitOff) / Math.max(1, landY + exitOff));
        y = yFall;
        x = fromX + (landX - fromX) * smooth(u) + Math.sin(u * 9.0) * 22 * (1 - u);
        rot = fromRot + u * 640; scale = fromScale;
        g = bump(S - exitS, 60);
      }
    } else {
      if (held.caught) { held.caught = false; document.body.style.cursor = ''; finaleCta?.classList.remove('caught'); }
      // the fall from the top edge meets the perch rising from below at meetS
      const meetS = (A[next].docY + exitOff + FALL_RATE * exitS) / (FALL_RATE + 1);
      if (S >= meetS) {
        x = A[next].x; y = A[next].docY - S; rot = A[next].rot; scale = A[next].scale;
        g = bump(S - meetS, 70);
      } else {
        const u = clamp01((S - exitS) / Math.max(1, meetS - exitS));
        y = -exitOff + (S - exitS) * FALL_RATE;
        x = fromX + (A[next].x - fromX) * smooth(u) + Math.sin(u * 9.0) * 26 * (1 - u);
        rot = fromRot + u * 640; scale = fromScale + (A[next].scale - fromScale) * u;
        g = Math.max(bump(S - exitS, 60), bump(S - meetS, 70));
      }
    }
  }

  const w = traveler.offsetWidth || 64, h = traveler.offsetHeight || 116;
  let jx = 0, jy = 0;
  if (g > 0.02) { jx = (hashS(S * 0.37 + 1) - 0.5) * 22 * g; jy = (hashS(S * 0.53 + 2) - 0.5) * 12 * g; }
  traveler.style.opacity = String(clamp01(alpha));
  traveler.style.transform = `translate(${x - w / 2 + jx}px, ${y - h / 2 + jy}px) rotate(${rot}deg) scale(${scale})`;
  if (g > 0.02) {
    const o = (5 + 9 * g).toFixed(1);
    const a = Math.floor(hashS(S * 0.11) * 60), b = Math.min(96, a + 14 + Math.floor(g * 30));
    const n = (hashS(S) * 30).toFixed(0);
    traveler.style.filter = `drop-shadow(-${o}px 0 rgba(255,40,90,0.85)) drop-shadow(${o}px 0 rgba(40,220,255,0.85)) drop-shadow(0 10px 14px rgba(0,0,0,0.45))`;
    traveler.style.clipPath = hashS(S * 0.29) > 0.45
      ? `polygon(0 0, 100% 0, 100% ${a}%, ${n}% ${a}%, ${n}% ${b}%, 100% ${b}%, 100% 100%, 0 100%)`
      : 'none';
  } else {
    traveler.style.filter = 'drop-shadow(0 10px 14px rgba(0,0,0,0.45))';
    traveler.style.clipPath = 'none';
  }
}

/* ============================================================
   Debug — "d"
   ============================================================ */
const debugEl = document.createElement('div');
debugEl.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:999;font:11px/1.5 monospace;color:#0f0;background:rgba(0,0,0,.7);padding:8px 10px;border-radius:6px;display:none;pointer-events:none;white-space:pre;';
document.body.appendChild(debugEl);
let debugOn = false;
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' && !(e.target instanceof HTMLInputElement)) {
    debugOn = !debugOn;
    debugEl.style.display = debugOn ? 'block' : 'none';
  }
});

/* ============================================================
   Resize + loop
   ============================================================ */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  U.uRes.value.set(w * pr, h * pr);
  U.uScreen.value = w / h;
  coverFit();
}
window.addEventListener('resize', resize);
resize();

// damped scrub target — smooths scroll steps into continuous motion
let curStrip = -1;
let curTime = 0;
let devS = 1;

function raf(time: number) {
  lenis.raf(time);
  const t = time / 1000;
  U.uTime.value = t;

  const st = stageState();

  /* ---- filmstrip ---- */
  if (st.strip >= 0) {
    const s = strips[st.strip];
    const target = st.time * s.dur;
    if (curStrip !== st.strip) {
      if (curStrip >= 0) park(strips[curStrip]);
      curStrip = st.strip;
      seek(s, target);                         // land exactly on the join frame
    }
    curTime = target;
    if (st.rewind > 0) { park(s); seek(s, target); }                                  // rewind: stepped seeks, VHS-masked
    else if (st.active === 0 && st.heroS < HERO_HANDOFF) warm(s);
    else drive(s, st.active === 0 ? Math.max(target, s.video.currentTime) : target); // never step back across the cut
    U.tCur.value = s.tex;
    U.uHas.value = s.ready ? 1 : 0;
    U.uAr.value = s.video.videoWidth ? s.video.videoWidth / s.video.videoHeight : 16 / 9;
  } else {
    U.uHas.value = 0;
  }
  devS += (st.dev - devS) * 0.2;
  U.uDev.value = devS;
  U.uMode.value = st.mode;
  U.uCenter.value.set(st.center[0], st.center[1]);
  U.uFlash.value = st.flash;
  finaleS = st.active === 6 ? st.s : 0;
  U.uRewind.value = st.rewind;
  U.uCrash.value = sstep(REWIND_END - 0.04, REWIND_END + 0.22, finaleS);

  // slow push-in through each chapter block
  const b = blocks[st.active].getBoundingClientRect();
  const sp = clamp01((window.innerHeight * 0.5 - b.top) / Math.max(1, b.height));
  U.uZoom.value = 1 + sp * 0.06 + mouse.x * 0.003;

  /* ---- hero: live parallax, hard cut exactly under the flash peak ---- */
  heroGroup.visible = st.active === 0 && st.heroS < HERO_HANDOFF;
  for (const m of heroMats) m.opacity = 1;
  flashMat.opacity = st.flash;

  mouse.x += (mouse.tx - mouse.x) * 0.045;
  mouse.y += (mouse.ty - mouse.y) * 0.045;
  camera.position.set(CAM.x + mouse.x * 0.35, CAM.y - mouse.y * 0.25, CAM.z);
  camera.lookAt(LOOK);

  if (heroGroup.visible) {
    for (const sw of swayers) sw.g.rotation.z = Math.sin(t * 0.6 + sw.phase) * sw.amp;
    for (const d of drifters) d.m.position.x = d.x0 + Math.sin(t * 0.05) * 6 * d.speed;
    if (fallingBanana) {
      // hangs in the bunch, then drops onto the open book exactly as the flash
      // ramps — the impact IS the detonation
      // the hero block is 140vh, so at scroll 0 heroS already reads 0.357 —
      // start the fall just past that or the banana is mid-drop on load
      const from = 0.36;
      const fall = clamp01((st.heroS - from) / (HERO_HANDOFF - 0.015 - from));
      const g = fall * fall;
      fallingBanana.position.set(
        BANANA_REST.x + fall * 0.69,
        BANANA_REST.y - g * 5.94,
        BANANA_REST.z + fall * 1.62,
      );
      fallingBanana.rotation.z = BANANA_TILT + fall * 2.5 + Math.sin(t * 1.4) * 0.03 * (1 - fall);
    }
  }

  // parallax + particles
  U.uMouse.value.set(mouse.x, mouse.y);
  {
    const pa = fxGeo.getAttribute('position') as THREE.BufferAttribute;
    const dS = (window.scrollY - lastScroll) * 0.0025;
    lastScroll = window.scrollY;
    for (let i = 0; i < FX_N; i++) {
      let y = pa.getY(i) + 0.006 + dS + Math.sin(t * 0.7 + i) * 0.0015;
      if (y > 7.5) y -= 15; else if (y < -7.5) y += 15;
      pa.setY(i, y);
    }
    pa.needsUpdate = true;
    fxMat.color.lerp(FX_COLOR[st.active], 0.04);
    fxMat.opacity = st.active === 0 ? 0.35 : 0.55;
  }

  updateAnims(t);
  updateTraveler(st, t);

  /* ---- chrome ---- */
  const activeId = chapterIds[st.active];
  railLinks.forEach((a) => a.classList.toggle('active', a.dataset.chapter === activeId));
  const paperAt = (y: number) => paperBlocks.some((pb) => { const r = pb.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
  document.body.dataset.surfaceTop = paperAt(window.innerHeight * 0.06) ? 'paper' : 'dark';
  document.body.dataset.surface = paperAt(window.innerHeight * 0.55) ? 'paper' : 'dark';
  document.body.dataset.surfaceBottom = paperAt(window.innerHeight * 0.94) ? 'paper' : 'dark';

  if (debugOn) {
    const s = st.strip >= 0 ? strips[st.strip] : null;
    debugEl.textContent =
      `chapter ${activeId}  heroS=${st.heroS.toFixed(2)}\n` +
      `strip ${st.strip}  t=${curTime.toFixed(2)}${s ? '/' + s.dur.toFixed(2) : ''}  shown=${s ? s.shown.toFixed(2) : '-'}\n` +
      `dev=${devS.toFixed(2)} mode=${st.mode} flash=${st.flash.toFixed(2)}`;
  }

  renderer.clear();
  renderer.render(stageScene, stageCam);
  renderer.clearDepth();
  if (heroGroup.visible) renderer.render(world, camera);
  renderer.clearDepth();
  renderer.render(fxScene, camera);
  if (flashMat.opacity > 0.002) { renderer.clearDepth(); renderer.render(flashScene, stageCam); }
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

(window as unknown as Record<string, unknown>).__glitch = { strips, U, stageState };

document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href')!;
    if (id.length > 1 && document.querySelector(id)) {
      e.preventDefault();
      lenis.scrollTo(id, { offset: 0 });
    }
  });
});
