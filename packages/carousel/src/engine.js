// The carousel itself — three.js + GSAP, no React. An infinite flat row of
// image panels rendered into an offscreen buffer, then drawn to screen
// through the liquid-glass lens shader. The React component just mounts this
// and listens to the callbacks.
//
//   const carousel = createCarousel(mountEl, {
//     config: { STEPS, CONFIG, LENS, ... },  // merged over the defaults
//     cursorElement,           // optional label that trails the pointer
//     onActiveChange(i) {},    // centered panel changed
//     onFocusChange(open) {},  // focus mode opened / closed
//     onEntryDone(done) {},    // entry animation settled
//   });
//   carousel.closeFocus(); carousel.replayEntry(); carousel.destroy();
//
// Config arrives as a parameter rather than a module import so this package
// carries no product content. The resolved objects are exposed as
// `carousel.config` — the dev GUI mutates those same references live, which
// is why the engine reads through them every frame instead of copying values.

import * as THREE from "three";
import { gsap } from "gsap";
import { createConfig } from "./config";

export function createCarousel(mount, callbacks = {}) {
  const {
    config: userConfig = {},
    cursorElement = null,
    onActiveChange = () => {},
    onFocusChange = () => {},
    onEntryDone = () => {},
    onModeChange = () => {},
  } = callbacks;

  const config = createConfig(userConfig);
  const { STEPS, CONFIG, INTERACT, LENS, FOCUS, ENTRY, PAGE_BG } = config;

  let W = mount.clientWidth;
  let H = mount.clientHeight;

  // ---- renderer / scene / camera (orthographic, 1 unit = 1 px) ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.setClearColor(PAGE_BG, 1); // match page bg so FBO gaps blend
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -W / 2,
    W / 2,
    H / 2,
    -H / 2,
    -100,
    100,
  );
  camera.position.z = 10;

  // ---- load the source images (textures + measured aspect) ----
  const loader = new THREE.TextureLoader();
  const sources = STEPS.map((img) => {
    const s = {
      tex: null,
      aspect: img.aspect || 1,
      locked: img.aspect != null,
    };
    loader.load(img.src, (tex) => {
      // mipmaps + anisotropy keep panels crisp while they render small
      // (the entry animation starts them at ~80px tall)
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.colorSpace = THREE.SRGBColorSpace;
      if (!s.locked && tex.image) s.aspect = tex.image.width / tex.image.height;
      s.tex = tex;
      // aspect is now known -> rebuild slot offsets so spacing matches widths,
      // and re-center the row while the user hasn't scrolled yet
      recomputeTotal();
      if (!userInteracted) {
        scroll = centerForIndex(0);
        target = scroll;
      }
    });
    return s;
  });

  // width of one slot: height is fixed (PANEL_H), so width = aspect * PANEL_H + gap
  function slotWidth(srcIndex) {
    return sources[srcIndex].aspect * CONFIG.PANEL_H + CONFIG.GAP;
  }

  // cumulative x of each source's slot, and the total loop width
  let offsets = [];
  let totalWidth = 0;
  function recomputeTotal() {
    offsets = [];
    let acc = 0;
    for (let i = 0; i < sources.length; i++) {
      offsets.push(acc);
      acc += slotWidth(i);
    }
    totalWidth = acc;
  }
  recomputeTotal();

  // scroll value that puts panel `idx` dead-center. idx is an unbounded
  // integer (loop k, source = idx mod N) so focus / click / entry can aim
  // at an exact panel copy.
  function centerForIndex(idx) {
    const N = sources.length;
    const loop = Math.floor(idx / N);
    const s = ((idx % N) + N) % N;
    return offsets[s] + slotWidth(s) / 2 - CONFIG.GAP / 2 + loop * totalWidth;
  }

  // integer index (including loop) whose center is closest to `value`
  function nearestIndex(value) {
    if (!totalWidth) return 0;
    const N = sources.length;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < N; i++) {
      const center = offsets[i] + slotWidth(i) / 2 - CONFIG.GAP / 2;
      const k = Math.round((value - center) / totalWidth);
      const dist = Math.abs(center + k * totalWidth - value);
      if (dist < bestDist) {
        bestDist = dist;
        best = i + k * N;
      }
    }
    return best;
  }

  // which source index is closest to screen center (for the overlay text)
  function centerIndex(value) {
    if (!totalWidth) return 0;
    let bestI = 0;
    let bestDist = Infinity;
    for (let i = 0; i < sources.length; i++) {
      const center = offsets[i] + slotWidth(i) / 2 - CONFIG.GAP / 2;
      const k = Math.round((value - center) / totalWidth);
      const dist = Math.abs(center + k * totalWidth - value);
      if (dist < bestDist) {
        bestDist = dist;
        bestI = i;
      }
    }
    return bestI;
  }
  let lastCenter = -1;

  // ---- mesh pool ----
  // REPEATS copies of the whole image set so wide screens never run dry.
  const REPEATS = 4;
  const pool = [];
  for (let r = 0; r < REPEATS; r++) {
    for (let i = 0; i < sources.length; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xdddddd,
        transparent: true,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), mat);
      mesh.visible = false;
      scene.add(mesh);
      pool.push({ mesh, mat, srcIndex: i });
    }
  }

  // ---- scroll state ----
  let scroll = centerForIndex(0); // current (image 01 centered)
  let target = scroll; // desired
  let userInteracted = false; // true once the user scrolls (stops auto-recenter)
  let velocity = 0; // flick momentum after a drag release
  let prevScroll = 0;
  let scrollEnergy = 0; // smoothed 0..1 scroll activity, drives panel shrink
  let pendingFocus = null; // {srcIndex} — open focus once a click-to-center settles
  let lastInput = performance.now(); // timestamp of last wheel/drag input
  let snapped = false; // have we already snapped since the last input?

  // ---- liquid-glass lens: FBO + fullscreen pass ----
  // The carousel renders into rt at device resolution (CSS-sized would render
  // at 1x and upscale — blurry on retina); a fullscreen quad then samples it
  // through the lens shader.
  const dpr = renderer.getPixelRatio();
  let rt = new THREE.WebGLRenderTarget(W * dpr, H * dpr);
  const lensScene = new THREE.Scene();
  const lensCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const lensUniforms = {
    uTex: { value: rt.texture },
    uRes: { value: new THREE.Vector2(W * dpr, H * dpr) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uSizeX: { value: LENS.sizeX },
    uSizeY: { value: LENS.sizeY },
    uShape: { value: LENS.shape === "square" ? 1.0 : 0.0 },
    uSquareRound: { value: LENS.squareRound },
    uRotation: { value: 0.0 },
    uAspect: { value: W / H },
    uZoom: { value: LENS.zoom },
    uDispersion: { value: LENS.dispersion },
    uBlur: { value: LENS.blur },
    uGlow: { value: LENS.glow },
    uWhiteGlow: { value: LENS.whiteGlow },
    uNovaSize: { value: LENS.novaSize },
    uBlueRing: { value: LENS.blueRing },
    uRingRadius: { value: LENS.ringRadius },
    uRingWidth: { value: LENS.ringWidth },
    uShimmer: { value: LENS.shimmer ? 1.0 : 0.0 },
    uShimmerFreq: { value: LENS.shimmerFreq },
    uShimmerSpeed: { value: LENS.shimmerSpeed },
    uShimmerDepth: { value: LENS.shimmerDepth },
    uTime: { value: 0.0 },
    uRimStart: { value: LENS.rimStart },
    uRimTangential: { value: LENS.rimTangential },
    uRimInward: { value: LENS.rimInward },
    uRimFreq1: { value: LENS.rimFreq1 },
    uRimFreq2: { value: LENS.rimFreq2 },
    uBlueColor: { value: new THREE.Color(LENS.blueColor) },
    uRimLine: { value: LENS.rimLine },
    uRimLinePos: { value: LENS.rimLinePos },
    uRimLineWidth: { value: LENS.rimLineWidth },
    uVignette: { value: LENS.vignette },
    uVignetteSize: { value: LENS.vignetteSize },
    uSamples: { value: LENS.samples },
  };
  const lensMat = new THREE.ShaderMaterial({
    uniforms: lensUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      #define PI 3.14159265
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      uniform vec2  uRes;
      uniform vec2  uCenter;
      uniform float uSizeX;         // half-width (height-fraction units)
      uniform float uSizeY;         // half-height (height-fraction units)
      uniform float uAspect;        // W/H
      uniform float uZoom;
      uniform float uDispersion;
      uniform float uBlur;
      uniform float uGlow;
      uniform float uWhiteGlow;
      uniform float uNovaSize;
      uniform float uBlueRing;
      uniform float uRingRadius;
      uniform float uRingWidth;
      uniform float uShimmer;
      uniform float uShimmerFreq;
      uniform float uShimmerSpeed;
      uniform float uShimmerDepth;
      uniform float uTime;
      uniform float uRimStart;
      uniform float uRimTangential;
      uniform float uRimInward;
      uniform float uRimFreq1;
      uniform float uRimFreq2;
      uniform vec3  uBlueColor;
      uniform float uRimLine;
      uniform float uRimLinePos;
      uniform float uRimLineWidth;
      uniform float uVignette;     // overall vignette strength (0 = off)
      uniform float uVignetteSize; // radius where vignette begins
      uniform float uShape;        // 0 = circle, 1 = square
      uniform float uSquareRound;  // corner rounding for square (0..1)
      uniform float uRotation;     // lens rotation in radians
      uniform int   uSamples;

      const int MAX_SAMPLES = 16;

      // rounded-box signed distance (negative inside)
      float sdRoundBox(vec2 p, vec2 b, float r){
        vec2 q = abs(p) - b + r;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
      }

      // Evaluate the disc lens centered at 'center' (screen-UV). Returns the
      // lensed color; 'outA' = how opaque this lens is here (0 outside disc).
      vec3 discLens(vec2 center, float aspectCorrect, out float outA) {
        // local coords, aspect-corrected so x/y are in the same screen units
        vec2 p = (vUv - center);
        p.x *= aspectCorrect;
        // rotate local space so the rect + all internals spin together
        float ca = cos(uRotation), sa = sin(uRotation);
        p = mat2(ca, -sa, sa, ca) * p;
        vec2 halfSize = vec2(uSizeX, uSizeY);
        // elliptical distance: 0 center .. 1 boundary
        float dist = length(p / halfSize);
        outA = 0.0;

        // mask shape: ellipse OR rounded rect, drives the cutoff.
        // maskND: 0 inside .. 1 at the shape boundary (>1 outside).
        float maskND;
        if (uShape > 0.5) {
          float corner = min(uSizeX, uSizeY) * clamp(uSquareRound, 0.0, 1.0);
          float sd = sdRoundBox(p, halfSize, corner);
          maskND = 1.0 + sd / min(uSizeX, uSizeY);
        } else {
          maskND = dist;
        }
        if (maskND > 1.0) return vec3(0.0);

        // shapeND: 0 center .. 1 boundary, following the chosen shape. Used by
        // nova / ring / border so they take the SAME shape.
        float shapeND = clamp(maskND, 0.0, 1.0);

        // deflection uses the elliptical radial nd so it bends smoothly from
        // the center even when the boundary is rectangular
        float nd = clamp(dist, 0.0, 1.0);
        vec2  offset = vUv - center;
        vec2  radialDir = normalize(offset + 1e-6);
        vec2  tangentDir = vec2(-radialDir.y, radialDir.x);
        // angle measured in ROTATED local space so the rim wave/shimmer spin too
        float angle = atan(p.y, p.x);

        // inward pull + fluid rim waves
        float pull = uZoom * 0.30 * (nd * nd);
        float rimStrength = smoothstep(uRimStart, 1.0, nd);
        float fluidWave = sin(angle * uRimFreq1) * 0.55 + sin(angle * uRimFreq2) * 0.25;
        float rScreen = (uSizeX + uSizeY) * 0.5;
        vec2  rimOff = tangentDir * fluidWave * rimStrength * rScreen * uRimTangential;
        vec2  rimPull = -radialDir * rimStrength * rScreen * uRimInward;

        vec2 baseUV = center + offset * (1.0 - pull) + rimOff + rimPull;

        // chromatic dispersion (weighted multi-sample, per-channel normalized)
        float rimMask = smoothstep(0.55, 1.0, nd);
        vec2  dispDir = offset * uDispersion * 0.004 * rimMask;
        int N = uSamples;
        if (N < 2) N = 2;
        if (N > MAX_SAMPLES) N = MAX_SAMPLES;
        vec3 col = vec3(0.0);
        vec3 caW = vec3(0.0);
        for (int i = 0; i < MAX_SAMPLES; i++) {
          if (i >= N) break;
          float t = float(i) / float(N - 1);
          vec2 sUV = baseUV + dispDir * (t - 0.5);
          vec3 s = texture2D(uTex, sUV).rgb;
          vec3 w = vec3(
            exp(-pow((t - 0.00) / 0.38, 2.0)),
            exp(-pow((t - 0.50) / 0.38, 2.0)),
            exp(-pow((t - 1.00) / 0.38, 2.0))
          );
          col += s * w;
          caW += w;
        }
        col /= max(caW, vec3(0.001));

        // optional blur near the rim
        float blurFade = 1.0 - smoothstep(0.72, 0.98, nd);
        if (uBlur > 0.01 && blurFade > 0.01) {
          vec2 blurRad = vec2(uBlur) / uRes * blurFade;
          vec3 bcol = vec3(0.0);
          float btw = 0.0;
          for (float a = 0.0; a < PI * 2.0; a += PI * 2.0 / 6.0) {
            for (float rr = 0.4; rr <= 1.001; rr += 0.3) {
              vec2 o = vec2(cos(a), sin(a)) * blurRad * rr;
              float w = 1.0 - rr * 0.38;
              bcol += texture2D(uTex, baseUV + o).rgb * w;
              btw += w;
            }
          }
          col = mix(bcol / btw, col, rimMask);
        }

        // glassy darkening toward center
        col *= mix(0.91, 1.0, smoothstep(0.0, 0.38, shapeND));

        // white nova glow at center
        float r2 = shapeND * shapeND * 0.25;
        float gs = max(uNovaSize * uGlow * 0.003, 0.004);
        float nova = exp(-r2 / gs) + exp(-r2 / (gs * 7.0)) * 0.18;
        nova *= uWhiteGlow * (uGlow / 17.0) * 1.15;
        col += vec3(nova);

        // blue ring + aura
        float dC = shapeND * 0.5;
        float tR = clamp(uRingRadius, 0.1, 0.49);
        float rW = max(uRingWidth, 0.003);
        float ring = exp(-pow((dC - tR) / rW, 2.0));
        ring *= uBlueRing * (uGlow / 17.0) * 1.8;
        if (uShimmer > 0.5) ring *= sin(angle * uShimmerFreq + uTime * uShimmerSpeed) * uShimmerDepth + (1.0 - uShimmerDepth);
        float ringAura = exp(-pow((dC - tR) / (rW * 6.0), 2.0)) * 0.28 * uBlueRing * (uGlow / 17.0);
        col += uBlueColor * (ring + ringAura);
        // bright border line
        col += vec3(exp(-pow((dC - uRimLinePos) / max(uRimLineWidth, 0.0001), 2.0)) * uRimLine);

        // lens alpha: solid inside, soft falloff at the very edge
        outA = smoothstep(1.0, 0.93, maskND);
        return col;
      }

      void main(){
        vec3 base = texture2D(uTex, vUv).rgb;  // carousel, untouched
        vec3 outc = base;

        float a = 0.0;
        vec3 c = discLens(uCenter, uAspect, a);
        outc = mix(outc, c, a);

        // overall vignette: darken toward screen corners (aspect-correct)
        if (uVignette > 0.001) {
          vec2 vc = vUv - 0.5;
          vc.x *= uAspect;
          float d = length(vc) / max(uVignetteSize, 0.0001);
          float vig = 1.0 - uVignette * smoothstep(0.5, 1.0, d);
          outc *= clamp(vig, 0.0, 1.0);
        }

        gl_FragColor = vec4(outc, 1.0);
      }
    `,
  });
  const lensQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lensMat);
  lensScene.add(lensQuad);

  // ---- focus state ----
  // When focused, the lens props fade out (lensFx 1->0) and every panel
  // except the focused one slides down off-screen, staggered center-out.
  const focusState = {
    active: false,
    srcIndex: -1,
    poolIdx: -1,
    lensFx: ENTRY.enabled ? 0 : 1, // 0 during entry; blooms in later
    anim: null,
  };
  const drop = new Array(REPEATS * sources.length).fill(0); // per-panel drop 0..1
  let focusScale = 1; // eased scale-up applied to the focused panel
  const lastCenterX = new Array(REPEATS * sources.length); // per-pool x, undefined if hidden

  // ---- entry state ----
  // pEntry[poolIdx]: 0 = below screen at startH, 1 = settled in the real row.
  const pEntry = new Array(REPEATS * sources.length).fill(
    ENTRY.enabled ? 0 : 1,
  );
  let entryActive = ENTRY.enabled;
  let entrySettled = false; // rise finished but panels held at small size
  const growArr = new Array(REPEATS * sources.length).fill(
    ENTRY.enabled ? 0 : 1,
  );
  let entryAnim = null;

  // lens props that fade out for focus/entry, with their full values
  const LENS_FX_KEYS = [
    "uDispersion",
    "uBlueRing",
    "uRimLine",
    "uVignette",
    "uZoom",
    "uRimTangential",
    "uRimInward",
  ];
  const lensFxFull = {};
  LENS_FX_KEYS.forEach((k) => (lensFxFull[k] = lensUniforms[k].value));

  // ---- layout: place pooled meshes for the current scroll (every frame) ----
  let panelRects = []; // visible panel screen rects for hit-testing
  let centeredPanel = null; // panel nearest screen center
  function layout() {
    panelRects = [];
    centeredPanel = null;
    let centeredDist = Infinity;
    const half = W / 2;
    const buffer = CONFIG.PANEL_H; // generous horizontal buffer
    pool.forEach((p, poolIdx) => {
      const rep = Math.floor(poolIdx / sources.length);
      const i = p.srcIndex;
      const src = sources[i];

      // slot center within one loop, shifted by scroll, wrapped, then pushed
      // out by this pool entry's repetition rung
      const slotCenterInLoop = offsets[i] + slotWidth(i) / 2 - CONFIG.GAP / 2;
      let x = slotCenterInLoop - scroll;
      x = ((x % totalWidth) + totalWidth) % totalWidth;
      x += (rep - Math.floor(REPEATS / 2)) * totalWidth;
      if (x > half + totalWidth) x -= totalWidth * REPEATS;

      const centerX = x;
      const inEntry = entryActive || entrySettled;
      if (!inEntry && (centerX < -half - buffer || centerX > half + buffer)) {
        p.mesh.visible = false;
        lastCenterX[poolIdx] = undefined;
        return;
      }
      lastCenterX[poolIdx] = centerX;

      // fixed size for every panel; shrink up to 25% with scroll speed
      const shrink = 1 - 0.25 * scrollEnergy;
      const h = CONFIG.PANEL_H * shrink;
      const wPx = src.aspect * CONFIG.PANEL_H * shrink;

      // bind texture once available
      if (src.tex && !p.bound) {
        p.mat.map = src.tex;
        p.mat.color.set(0xffffff);
        p.mat.needsUpdate = true;
        p.bound = true;
      }

      let y = 0;

      // focus: the focused panel grows and stays put, others slide down
      const isFocused = focusState.active && focusState.poolIdx === poolIdx;
      const d = drop[poolIdx] || 0;
      let drawW = wPx;
      let drawH = h;
      if (isFocused) {
        drawW = wPx * focusScale;
        drawH = h * focusScale;
      } else if (d > 0) {
        y = -d * H * FOCUS.dropDist;
      }

      p.mesh.visible = true;

      // entry: interpolate from (below screen, startH) up to the real state
      let finalX = centerX;
      let finalY = y;
      let finalW = drawW;
      let finalH = drawH;
      if (entryActive || entrySettled) {
        const pe = pEntry[poolIdx] || 0;
        const g = growArr[poolIdx] || 0;

        const curH = ENTRY.startH + (drawH - ENTRY.startH) * g;
        finalH = curH;
        finalW = curH * src.aspect;

        // constant-gap walk from the centered source, one copy per source.
        // Each slot uses ITS OWN current grow height, so a grown panel takes
        // more space and pushes neighbours outward.
        const cSrc = centerIndex(scroll);
        let di = i - cSrc;
        if (di > sources.length / 2) di -= sources.length;
        if (di < -sources.length / 2) di += sources.length;
        const N = sources.length;
        const midRep = Math.floor(REPEATS / 2);
        if (rep !== midRep) {
          p.mesh.visible = false;
          lastCenterX[poolIdx] = undefined;
          return;
        }
        const slotH = (s) => {
          const gg = growArr[midRep * N + s] || 0;
          return ENTRY.startH + (CONFIG.PANEL_H - ENTRY.startH) * gg;
        };
        let off = 0;
        if (di > 0) {
          for (let k = 0; k < di; k++) {
            const sa = (((cSrc + k) % N) + N) % N;
            const sb = (((cSrc + k + 1) % N) + N) % N;
            off +=
              (sources[sa].aspect * slotH(sa) +
                sources[sb].aspect * slotH(sb)) /
                2 +
              CONFIG.GAP;
          }
        } else if (di < 0) {
          for (let k = 0; k < -di; k++) {
            const sa = (((cSrc - k) % N) + N) % N;
            const sb = (((cSrc - k - 1) % N) + N) % N;
            off -=
              (sources[sa].aspect * slotH(sa) +
                sources[sb].aspect * slotH(sb)) /
                2 +
              CONFIG.GAP;
          }
        }
        finalX = off;
        if (finalX < -half - buffer || finalX > half + buffer) {
          p.mesh.visible = false;
          lastCenterX[poolIdx] = undefined;
          return;
        }

        // vertical: rise from below the screen up to real y
        const below = -H * ENTRY.fromBelow;
        finalY = below + (y - below) * pe;
      }

      p.mesh.position.set(finalX, finalY, 0);
      p.mesh.scale.set(finalW, finalH, 1);

      // screen rect (px, top-left origin) for pointer hit-testing
      const sx = centerX + W / 2;
      const sy = H / 2 - y;
      panelRects.push({
        left: sx - drawW / 2,
        right: sx + drawW / 2,
        top: sy - drawH / 2,
        bottom: sy + drawH / 2,
        poolIdx,
        srcIndex: i,
        centerX,
      });

      if (Math.abs(centerX) < centeredDist) {
        centeredDist = Math.abs(centerX);
        centeredPanel = { srcIndex: i, centerX, wPx, h, poolIdx };
      }
    });
  }

  // which visible panel (if any) is under a viewport point?
  function panelAtPointer(px, py) {
    for (let i = 0; i < panelRects.length; i++) {
      const r = panelRects[i];
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)
        return r;
    }
    return null;
  }

  const el = renderer.domElement;
  // Touch hardening: own the gesture outright so the browser never steals it
  // into a scroll/zoom, and kill the mobile text-select + tap-flash artifacts
  // that otherwise fire on a long press.
  el.style.touchAction = "none";
  el.style.userSelect = "none";
  el.style.setProperty("-webkit-user-select", "none");
  el.style.setProperty("-webkit-touch-callout", "none");
  el.style.setProperty("-webkit-tap-highlight-color", "transparent");

  // ---- drag state ----
  let dragging = false; // a pointer is currently pulling the row
  let dragPointerId = null; // which pointer we captured
  let dragLastX = 0; // last pointer x (px) — per-move delta source
  let dragDist = 0; // total px travelled this press (click vs drag test)
  let dragVel = 0; // smoothed drag speed, handed to `velocity` on release
  let dragMoveT = 0; // timestamp of the last drag move (flick gating)
  let suppressClick = false; // this press ended as a drag -> eat its click
  let dragPointerType = "mouse"; // "mouse" | "touch" | "pen" for this press
  let lastPointerX = NaN; // last known pointer position, so the follower can
  let lastPointerY = NaN; // re-test its hover state when the row moves
  let pointerInside = false; // pointer is within the canvas
  let lastPointerType = "mouse"; // pointer type of the most recent event

  // ---- "View" cursor follower ----
  if (cursorElement)
    gsap.set(cursorElement, {
      xPercent: 20,
      yPercent: 30,
      scale: 0,
      autoAlpha: 0,
    });
  const moveX = cursorElement
    ? gsap.quickTo(cursorElement, "x", { duration: 0.5, ease: "power3.out" })
    : null;
  const moveY = cursorElement
    ? gsap.quickTo(cursorElement, "y", { duration: 0.5, ease: "power3.out" })
    : null;

  let overPanel = false; // the LABEL's state (gated by entry / drag)
  let hoverPanel = false; // raw geometry: is the mouse over a panel right now

  // Cursor writes are deduped — updateCursor runs every frame and there's no
  // reason to touch the CSSOM when nothing changed.
  let cursorNow = "";
  function setCursor(v) {
    if (v === cursorNow) return;
    cursorNow = v;
    el.style.cursor = v;
  }

  // Single source of truth for the canvas cursor. Priority: locked (entry /
  // focus) -> grabbing while a drag is live -> grab/pointer over a panel ->
  // default. Keyed off hoverPanel (raw geometry) rather than overPanel, so the
  // label's own gates never take the cursor down with them.
  function updateCursor() {
    if (focusState.active || entryActive || entrySettled) return setCursor("");
    if (dragging) return setCursor("grabbing");
    if (!hoverPanel) return setCursor(""); // off the carousel, plain arrow
    if (INTERACT.drag) return setCursor("grab");
    return setCursor(INTERACT.noClick ? "" : "pointer");
  }

  // Hover changes drive both the cursor and the label. setView applies the
  // label's own gates on top; the cursor reads hoverPanel directly.
  function setHover(on) {
    hoverPanel = on;
    setView(on); // always ends in an updateCursor()
  }

  // The pointer isn't the only thing that moves — the row slides underneath
  // it. Re-testing only on pointer events left the hover state stale whenever
  // the carousel scrolled beneath a still cursor: a panel arriving under the
  // pointer got no grab hand until you jiggled. Called every frame, right
  // after layout() rebuilds panelRects.
  function refreshHover() {
    if (!pointerInside || lastPointerType !== "mouse") return;
    if (!Number.isFinite(lastPointerX)) return;
    if (focusState.active) {
      setHover(false);
      return;
    }
    setHover(panelAtPointer(lastPointerX, lastPointerY) !== null);
  }

  function setView(on) {
    // never show the follower label during the entry — only in full mode
    if (entryActive || entrySettled) on = false;
    // and never while the row is being pulled — the grabbing hand carries the
    // interaction on its own, the trailing label just fights it
    if (dragging) on = false;
    if (on === overPanel) {
      updateCursor();
      return;
    }
    overPanel = on;
    updateCursor();
    if (!cursorElement) return;
    // Kill any show/hide still in flight before starting the next one.
    // press -> release -> click queues a fade-in (release, still over the
    // panel) immediately followed by a fade-out (click opens focus). Left to
    // GSAP's default non-overwriting behaviour both survive and the label ends
    // up stuck visible. Scoped so the quickTo x/y trailing tweens are untouched.
    gsap.killTweensOf(cursorElement, "scale,autoAlpha,opacity,visibility");
    gsap.to(cursorElement, {
      scale: on ? 1 : 0,
      autoAlpha: on ? 1 : 0,
      duration: on ? 0.35 : 0.25,
      ease: on ? "power3.out" : "power3.in",
    });
  }

  // ---- input ----
  function inputLocked() {
    return focusState.active || entryActive || entrySettled;
  }

  function onWheel(e) {
    e.preventDefault();
    if (inputLocked()) return;
    userInteracted = true;
    pendingFocus = null; // manual scroll cancels a click-to-center in flight
    target += (e.deltaY || e.deltaX) * CONFIG.WHEEL;
    lastInput = performance.now();
    snapped = false; // re-arm the snap on every fresh input
  }

  function onPointerDown(e) {
    suppressClick = false;
    if (!INTERACT.drag || inputLocked()) return;
    if (dragging) return; // a second finger never hijacks a live drag
    if (e.button !== 0 && e.pointerType === "mouse") return; // left button only
    dragging = true;
    dragPointerId = e.pointerId;
    dragPointerType = e.pointerType || "mouse";
    try {
      el.setPointerCapture(e.pointerId); // keep receiving moves off-canvas
    } catch {}
    dragLastX = e.clientX;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    dragDist = 0;
    dragVel = 0;
    dragMoveT = performance.now();
    setView(false); // label out of the way for the pull (also sets the cursor)
    velocity = 0; // grabbing kills any leftover momentum
    pendingFocus = null; // and cancels a click-to-center in flight
    userInteracted = true;
    snapped = false; // re-arm the snap for when the drag ends
    lastInput = dragMoveT;
  }

  function onPointerMove(e) {
    // ---- drag: pull the row with the pointer ----
    // Only the captured pointer drives it, so extra fingers are inert.
    if (dragging && e.pointerId === dragPointerId) {
      const sens =
        dragPointerType === "mouse" ? CONFIG.DRAG : INTERACT.TOUCH_DRAG;
      const dx = e.clientX - dragLastX;
      dragLastX = e.clientX;
      dragDist += Math.abs(dx);
      target -= dx * sens; // pointer right = row travels back
      // smoothed so a single jittery frame can't define the flick
      dragVel = dragVel * 0.6 + -dx * sens * 0.4;
      dragMoveT = performance.now();
      lastInput = dragMoveT;
      snapped = false;
    }
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    lastPointerType = e.pointerType || "mouse";
    pointerInside = true; // in case the enter event was missed
    // Hover affordances are mouse-only: a finger has no hover state to
    // describe, so the label would just park wherever you last tapped.
    if (e.pointerType !== "mouse") return;
    // label: eased trail. Keep tracking even while dragging so it's already
    // under the cursor when it fades back in on release.
    if (moveX) moveX(e.clientX);
    if (moveY) moveY(e.clientY);
    if (focusState.active) {
      setHover(false);
      return;
    }
    setHover(panelAtPointer(e.clientX, e.clientY) !== null);
  }

  function onPointerUp(e) {
    if (!dragging) return;
    // ignore lifts from fingers that were never driving the drag
    if (e && dragPointerId !== null && e.pointerId !== dragPointerId) return;
    dragging = false;
    if (dragPointerId !== null) {
      try {
        el.releasePointerCapture(dragPointerId);
      } catch {}
      dragPointerId = null;
    }
    // Only flick if the pointer was still moving at release — letting go after
    // holding still should stop dead, not launch.
    velocity =
      performance.now() - dragMoveT > INTERACT.FLICK_IDLE_MS ? 0 : dragVel;
    dragVel = 0;
    lastInput = performance.now();
    snapped = false; // the idle timer takes over and snaps to center
    suppressClick =
      dragDist >
      (dragPointerType === "mouse"
        ? INTERACT.CLICK_SLOP
        : INTERACT.TOUCH_CLICK_SLOP);
    // let go -> the label fades back in if we're still over a panel
    if (dragPointerType === "mouse")
      setHover(panelAtPointer(lastPointerX, lastPointerY) !== null);
    else updateCursor();
  }

  function onEnter(e) {
    pointerInside = true;
    lastPointerType = e.pointerType || "mouse";
  }
  function onLeave() {
    pointerInside = false;
    setHover(false);
  }

  function onClick(e) {
    if (INTERACT.noClick) return; // drag-only mode: clicks do nothing
    if (suppressClick) {
      suppressClick = false; // that "click" was the tail of a drag
      return;
    }
    if (inputLocked()) return;
    const hit = panelAtPointer(e.clientX, e.clientY);
    if (!hit) return;
    // centered panel -> open right away; anything else glides to center
    // first and the tick loop opens focus once it arrives
    if (centeredPanel && hit.poolIdx === centeredPanel.poolIdx) {
      pendingFocus = null;
      openFocus();
      return;
    }
    userInteracted = true;
    velocity = 0;
    target = centerForIndex(nearestIndex(scroll + hit.centerX));
    snapped = true; // already aimed at a panel center; don't re-snap
    pendingFocus = { srcIndex: hit.srcIndex };
    setView(false);
  }

  // Toggle drag / click-to-focus at runtime (the GUI drives this). Keeps the
  // invariant that drag-only mode needs drag on, and that turning drag off
  // gives clicking back — otherwise the mouse would do nothing at all.
  function setInteraction(next = {}) {
    if (next.drag !== undefined) {
      INTERACT.drag = next.drag;
      if (!INTERACT.drag) {
        INTERACT.noClick = false;
        if (dragging) onPointerUp();
      }
    }
    if (next.noClick !== undefined) {
      INTERACT.noClick = next.noClick;
      if (INTERACT.noClick) INTERACT.drag = true;
    }
    updateCursor();
    onModeChange({ drag: INTERACT.drag, noClick: INTERACT.noClick });
  }

  // ---- focus open / close ----
  function openFocus() {
    if (focusState.active || !centeredPanel) return;
    const src = sources[centeredPanel.srcIndex];
    if (!src || !src.tex) return;

    focusState.active = true;
    focusState.srcIndex = centeredPanel.srcIndex;
    const focusPoolIdx = centeredPanel.poolIdx;
    focusState.poolIdx = focusPoolIdx;

    // pull scroll precisely to center so the focused panel is dead-centre
    target = centerForIndex(nearestIndex(scroll));

    // order the OTHER panels by distance from the focused card and group
    // near-equal distances, so left/right pairs leave together — a real
    // center-out wave radiating from the clicked card
    const focusX = lastCenterX[focusPoolIdx] || 0;
    const others = pool
      .map((p, idx) => ({ idx, x: lastCenterX[idx] }))
      .filter((o) => o.idx !== focusPoolIdx && o.x !== undefined)
      .map((o) => ({ idx: o.idx, dist: Math.abs(o.x - focusX) }))
      .sort((a, b) => a.dist - b.dist);

    let rank = 0;
    let prevDist = -1;
    const ranked = others.map((o) => {
      if (prevDist >= 0 && o.dist - prevDist > 1) rank++;
      prevDist = o.dist;
      return { idx: o.idx, rank };
    });

    // re-snapshot lens values so the fade/restore tracks live GUI sliders
    LENS_FX_KEYS.forEach((k) => (lensFxFull[k] = lensUniforms[k].value));

    if (focusState.anim) focusState.anim.kill();
    const tl = gsap.timeline();
    tl.to(
      focusState,
      { lensFx: 0, duration: FOCUS.lensFade, ease: "power3.out" },
      0,
    );
    tl.to(
      { v: focusScale },
      {
        v: FOCUS.centerScale,
        duration: FOCUS.focusDuration,
        ease: FOCUS.focusEase,
        onUpdate() {
          focusScale = this.targets()[0].v;
        },
      },
      0,
    );
    ranked.forEach((o) => {
      tl.to(
        drop,
        { [o.idx]: 1, duration: FOCUS.cardDuration, ease: FOCUS.cardEase },
        o.rank * FOCUS.stagger,
      );
    });
    focusState.anim = tl;

    setView(false); // also drops the cursor back to default (focus locks input)
    onFocusChange(true);
  }

  function closeFocus() {
    if (!focusState.active) return;
    if (focusState.anim) focusState.anim.kill();

    // return wave: farthest cards first (edges-in), symmetric pairs together
    const focusX = lastCenterX[focusState.poolIdx] || 0;
    const others = pool
      .map((p, idx) => ({ idx, x: lastCenterX[idx] }))
      .filter((o) => o.x !== undefined && (drop[o.idx] || 0) > 0)
      .map((o) => ({ idx: o.idx, dist: Math.abs(o.x - focusX) }))
      .sort((a, b) => b.dist - a.dist);

    let rank = 0;
    let prevDist = -1;
    const ranked = others.map((o) => {
      if (prevDist >= 0 && prevDist - o.dist > 1) rank++;
      prevDist = o.dist;
      return { idx: o.idx, rank };
    });

    // notify the host NOW so its UI animates in sync with the cards
    // returning; focusState.active stays true until the timeline finishes
    // (it still gates scroll input)
    onFocusChange(false);

    const tl = gsap.timeline({
      onComplete: () => {
        focusState.active = false;
        focusState.srcIndex = -1;
        updateCursor(); // grab / pointer comes back
      },
    });
    tl.to(
      focusState,
      { lensFx: 1, duration: FOCUS.lensFade * 0.8, ease: "power3.inOut" },
      0,
    );
    tl.to(
      { v: focusScale },
      {
        v: 1,
        duration: FOCUS.focusDuration * 0.85,
        ease: FOCUS.focusEase,
        onUpdate() {
          focusScale = this.targets()[0].v;
        },
      },
      0,
    );
    ranked.forEach((o) => {
      tl.to(
        drop,
        {
          [o.idx]: 0,
          duration: FOCUS.cardDuration * 0.85,
          ease: FOCUS.cardEase,
        },
        o.rank * FOCUS.stagger * 0.7,
      );
    });
    focusState.anim = tl;
  }

  // ---- entry animation: rise from below, hold small, grow to full ----
  function playEntry() {
    if (entryAnim) entryAnim.kill();
    for (let k = 0; k < pEntry.length; k++) pEntry[k] = 0;
    entryActive = true;
    entrySettled = false;
    onEntryDone(false);
    for (let k = 0; k < growArr.length; k++) growArr[k] = 0;
    focusState.lensFx = 0; // no lens distortion during entry

    // center a panel cleanly; that panel rises first
    target = centerForIndex(nearestIndex(scroll));
    scroll = target;
    velocity = 0;
    snapped = true;

    layout(); // populate lastCenterX
    const visible = [];
    for (let k = 0; k < lastCenterX.length; k++) {
      if (lastCenterX[k] !== undefined) visible.push(k);
    }

    const tl = gsap.timeline({ delay: ENTRY.delay });
    // each card rises after its own random delay
    const spread = ENTRY.stagger * Math.max(visible.length - 1, 1);
    let lastRiseEnd = 0;
    visible.forEach((idx) => {
      const at = Math.random() * spread;
      lastRiseEnd = Math.max(lastRiseEnd, at + ENTRY.riseDuration);
      tl.to(
        pEntry,
        { [idx]: 1, duration: ENTRY.riseDuration, ease: ENTRY.riseEase },
        at,
      );
    });

    // rise done -> hold at small size, then grow to full (staggered)
    tl.call(
      () => {
        entryActive = false;
        entrySettled = true;
      },
      null,
      lastRiseEnd,
    );

    // grow stagger ranked by slot distance from the centered source, so
    // symmetric left/right pairs grow together. outward = center first,
    // inward = edges first.
    const cSrcG = centerIndex(scroll);
    const Ng = sources.length;
    const midRepG = Math.floor(REPEATS / 2);
    const growList = [];
    let maxRank = 0;
    for (let k = 0; k < lastCenterX.length; k++) {
      if (lastCenterX[k] === undefined) continue;
      if (Math.floor(k / Ng) !== midRepG) continue;
      let di = (k % Ng) - cSrcG;
      if (di > Ng / 2) di -= Ng;
      if (di < -Ng / 2) di += Ng;
      const r = Math.abs(di);
      maxRank = Math.max(maxRank, r);
      growList.push({ idx: k, rank: r });
    }
    const growRanked = growList.map((v) => ({
      idx: v.idx,
      rank: ENTRY.growDir === "outward" ? v.rank : maxRank - v.rank,
    }));

    const growStart = lastRiseEnd + ENTRY.growDelay;
    let growEnd = growStart;

    // lens blooms back in the moment the grow begins
    tl.to(
      focusState,
      { lensFx: 1, duration: ENTRY.lensBloom, ease: ENTRY.lensBloomEase },
      growStart,
    );

    growRanked.forEach((o) => {
      const at = growStart + o.rank * ENTRY.growStagger;
      growEnd = Math.max(growEnd, at + ENTRY.growDuration);
      tl.to(
        growArr,
        { [o.idx]: 1, duration: ENTRY.growDuration, ease: ENTRY.growEase },
        at,
      );
    });
    // hand off to the normal full-size carousel
    tl.call(
      () => {
        entrySettled = false;
        for (let k = 0; k < growArr.length; k++) growArr[k] = 1;
        onEntryDone(true);
        updateCursor(); // input unlocks -> show the grab hand
      },
      null,
      growEnd,
    );
    entryAnim = tl;
  }

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("click", onClick);

  // ---- animation loop ----
  let raf;
  function tick() {
    if (!dragging) {
      // flick momentum from a drag release, decaying to nothing
      target += velocity;
      velocity *= CONFIG.FRICTION;
      if (Math.abs(velocity) < 0.05) velocity = 0;

      // Settle-snap once input has actually stopped (idle time since the last
      // wheel/drag event). Retargets from the CURRENT scroll so it always
      // locks onto whichever panel is truly nearest right now.
      if (
        CONFIG.SNAP &&
        !snapped &&
        !focusState.active &&
        performance.now() - lastInput > CONFIG.SNAP_IDLE_MS
      ) {
        target = centerForIndex(nearestIndex(scroll));
        snapped = true;
      }
    }

    // Once snapped, glide in slower (SNAP_EASE < EASE) so the settle reads as
    // a soft landing rather than a speed-up. A live touch drag overrides both
    // and follows the finger hard — the weighty lerp reads as lag when you're
    // physically touching the row.
    // (a click-to-center travel keeps the normal ease — it's a journey across
    // the row, not a settle, and SNAP_EASE would make it crawl)
    const follow =
      dragging && dragPointerType !== "mouse"
        ? INTERACT.TOUCH_EASE
        : snapped && !pendingFocus
          ? CONFIG.SNAP_EASE
          : CONFIG.EASE;
    scroll += (target - scroll) * follow;

    // tell the host which image is centered (overlay text)
    const ci = centerIndex(scroll);
    if (ci !== lastCenter) {
      lastCenter = ci;
      onActiveChange(ci);
    }

    // scroll speed -> energy 0..1, drives the panel shrink. Attack fast when
    // speeding up, decay slow when settling.
    const rawSpeed = scroll - prevScroll;
    prevScroll = scroll;
    const norm = Math.min(
      1,
      Math.abs(rawSpeed) / Math.max(1, CONFIG.SHRINK_MAX),
    );
    const k = norm > scrollEnergy ? CONFIG.SHRINK_ATTACK : CONFIG.SHRINK_DECAY;
    scrollEnergy += (norm - scrollEnergy) * k;

    layout();
    refreshHover(); // panels just moved — the hover state may be stale

    // click-to-center: once the glide has settled on the clicked panel, focus it
    if (pendingFocus && !focusState.active) {
      if (Math.abs(target - scroll) < 0.5) {
        const pf = pendingFocus;
        pendingFocus = null;
        if (centeredPanel && centeredPanel.srcIndex === pf.srcIndex)
          openFocus();
      }
    }

    // lens uniforms + focus/entry fade of the distortion props
    lensUniforms.uCenter.value.set(LENS.posX, LENS.posY);
    lensUniforms.uAspect.value = W / H;
    lensUniforms.uTime.value = performance.now() * 0.001;
    const rad = (a) => (a * Math.PI) / 180;
    lensUniforms.uRotation.value =
      rad(LENS.rotation) + rad(LENS.spin) * (performance.now() * 0.001);
    const fx = focusState.lensFx;
    LENS_FX_KEYS.forEach((key) => {
      lensUniforms[key].value = lensFxFull[key] * fx;
    });

    // render the carousel into the FBO, then the FBO through the lens
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(lensScene, lensCam);

    raf = requestAnimationFrame(tick);
  }
  tick();

  if (ENTRY.enabled) playEntry();

  // ---- resize / teardown ----
  function onResize() {
    W = mount.clientWidth;
    H = mount.clientHeight;
    renderer.setSize(W, H);
    camera.left = -W / 2;
    camera.right = W / 2;
    camera.top = H / 2;
    camera.bottom = -H / 2;
    camera.updateProjectionMatrix();
    rt.setSize(W * dpr, H * dpr);
    lensUniforms.uRes.value.set(W * dpr, H * dpr);
  }
  window.addEventListener("resize", onResize);

  function destroy() {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerUp);
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("click", onClick);
    if (focusState.anim) focusState.anim.kill();
    if (entryAnim) entryAnim.kill();
    renderer.dispose();
    rt.dispose();
    lensQuad.geometry.dispose();
    lensMat.dispose();
    pool.forEach((p) => {
      p.mesh.geometry.dispose();
      p.mat.dispose();
    });
    sources.forEach((s) => {
      if (s.tex) s.tex.dispose();
    });
    if (renderer.domElement.parentNode)
      renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  return {
    config, // resolved config objects — the dev GUI mutates these in place
    closeFocus,
    replayEntry: playEntry,
    refreshLayout: recomputeTotal, // call after changing PANEL_H / GAP
    setInteraction, // toggle drag / click-to-focus at runtime
    lensUniforms, // exposed for the dev GUI
    destroy,
  };
}
