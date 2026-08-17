// Default tunables for the carousel, and the merge that turns a caller's
// overrides into the config objects the engine reads.
//
// These are the UPSTREAM defaults — a white page, a blue lens, photo-sized
// panels. Nothing product-specific belongs here; the consuming app supplies
// its own content and theme (see apps/web/carousel.config.js), which keeps
// the diff-from-upstream readable in one place.
//
// `createConfig` returns fresh objects on every call. That matters: the dev
// GUI mutates the resolved objects in place, and defaults must not pick up
// one instance's tuning.

// Panels shown in the row. `src` is a URL the browser can load; panels are
// all PANEL_H tall and take their width from `aspect`, so nothing is cropped
// or stretched. Leave `aspect: null` to measure it from the image instead.
export const DEFAULT_STEPS = [];

// Layout + scroll feel. Wheel and drag both move a target, the scroll lerps
// after it. Once input has been idle for SNAP_IDLE_MS the target is redirected
// onto the nearest panel center, so the row always settles on a panel.
export const DEFAULT_CONFIG = {
  PANEL_H: 450, // px height — same for every panel
  GAP: 12, // px gap between panels
  EASE: 0.09, // lerp toward target (lower = heavier / more glide)
  WHEEL: 1.4, // wheel sensitivity
  DRAG: 1.6, // mouse drag sensitivity
  FRICTION: 0.865, // flick momentum decay after a drag release
  SNAP: true, // settle onto the nearest panel center
  // ms of idle input before snap engages. Distance/velocity gating used to
  // trigger inconsistently (fast flicks vs slow scrolls behaved completely
  // differently) — idle time means the same thing regardless of speed.
  SNAP_IDLE_MS: 120,
  // lerp for the glide onto the snapped panel — slower than EASE so the
  // final settle reads as a soft landing, not a speed-up.
  SNAP_EASE: 0.05,
  SHRINK_MAX: 60, // scroll speed (px/frame) that = full 25% shrink
  SHRINK_ATTACK: 0.25, // how fast panels shrink when speeding up
  SHRINK_DECAY: 0.06, // how fast they grow back when settling
};

// Interaction modes — both toggleable live from the GUI.
//   drag    : click/touch and pull the row sideways. Swaps the cursor to
//             grab / grabbing over the carousel instead of the pointer hand.
//   noClick : kill click-to-focus entirely, for when you only want to browse.
// Invariant: noClick implies drag (there'd be nothing left to do with the
// mouse otherwise), and turning drag off releases noClick.
export const DEFAULT_INTERACT = {
  drag: true, // drag-to-scroll enabled
  noClick: false, // true = clicking a panel no longer opens focus mode
  CLICK_SLOP: 6, // px of movement before a press counts as a drag, not a click
  FLICK_IDLE_MS: 90, // if the pointer sat still this long before release, no flick
  // Touch is held to a different standard than the mouse: a finger expects
  // the row to stick to it, so touch drags run 1:1 and follow much harder
  // than the weighty wheel lerp. Fingers also wobble, so a tap gets more slop.
  TOUCH_DRAG: 1.0, // touch drag sensitivity (mouse uses CONFIG.DRAG)
  TOUCH_EASE: 0.22, // lerp toward the finger while a touch drag is live
  TOUCH_CLICK_SLOP: 12, // px of wobble still counted as a tap, not a drag
};

// The liquid-glass lens (fullscreen post-process). Ported from a hero
// explosion shader, hence some of the exotic knob names. Every key here is
// mirrored 1:1 as a shader uniform in engine.js.
export const DEFAULT_LENS = {
  shape: "circle", // 'circle' (ellipse) | 'square' (rectangle)
  squareRound: 0, // corner rounding for rectangle (0 sharp .. 1 very round)
  rotation: 65, // static rotation in degrees
  spin: 0, // auto-spin speed (deg/sec, 0 = off)
  sizeX: 0.565, // half-width (fraction of viewport height)
  sizeY: 1, // half-height (fraction of viewport height)
  posX: 0.5, // center x in screen-UV (0 left .. 1 right)
  posY: 0.5, // center y in screen-UV (0 bottom .. 1 top)
  zoom: 0, // inward pull strength
  dispersion: 11, // chromatic dispersion
  blur: 0.0, // blur amount (px)
  glow: 4.2, // overall glow multiplier
  whiteGlow: 0.24, // central white nova intensity
  novaSize: 12, // nova size
  blueRing: 6, // ring intensity
  ringRadius: 0.49, // ring radius (0..0.5)
  ringWidth: 0.014, // ring width
  shimmer: true, // animated ring shimmer
  shimmerFreq: 12, // shimmer wave count around the ring
  shimmerSpeed: 3.5, // shimmer animation speed
  shimmerDepth: 0.12, // shimmer intensity (0 = none .. 0.5 = strong)
  rimStart: 0.578, // where the rim fluid wave begins
  rimTangential: 0.6, // tangential fluid-wave displacement
  rimInward: 0, // extra inward pull at the rim
  rimFreq1: 2, // fluid wave frequency 1
  rimFreq2: 1, // fluid wave frequency 2
  blueColor: "#009dff", // the soul: tint / ring color
  rimLine: 1.4, // bright border line intensity (0 = off)
  rimLinePos: 0.488, // where the border sits (0..0.5)
  rimLineWidth: 0.003, // sharpness of the border
  vignette: 0, // overall screen vignette strength (0 = off)
  vignetteSize: 0.3, // how far in the vignette reaches
  samples: 16, // dispersion samples
};

// Focus mode: click a panel -> it centers and enlarges, everything else
// sweeps down out of view, the lens distortion fades away.
export const DEFAULT_FOCUS = {
  cardDuration: 0.7, // seconds for the OTHER panels to drop
  focusDuration: 0.9, // seconds for the MAIN panel to scale into focus
  cardEase: "power4.out",
  focusEase: "power3.out",
  stagger: 0.06, // seconds between successive panels leaving (center-out)
  dropDist: 1.4, // how far panels drop, as a fraction of viewport height
  centerScale: 1.18, // how much the focused panel grows when alone
  lensFade: 0.85, // seconds for the lens props to ramp to invisible
};

// Entry animation (auto on load): panels rise from below at a small size,
// hold, then grow to full size while the lens blooms back in.
export const DEFAULT_ENTRY = {
  enabled: true,
  delay: 0.5, // seconds before the entry begins
  startH: 80, // px height each panel starts at
  riseDuration: 1.0, // seconds for a panel to rise into place
  stagger: 0.07, // seconds between panels rising
  riseEase: "power3.out",
  fromBelow: 0.9, // start offset below screen, as a fraction of viewport H
  growDelay: 0.25, // seconds to wait after the rise before growing
  growDuration: 2.15, // seconds for each panel to grow to full size
  growEase: "expo.inOut",
  growStagger: 0.085, // seconds between successive panels growing
  growDir: "inward", // "outward" = center grows first, "inward" = edges first
  lensBloom: 1.4, // seconds for the lens effect to fade back in
  lensBloomEase: "power2.inOut",
};

// Renderer clear color. Must match the page background or the gaps between
// panels show as seams against the framebuffer.
export const DEFAULT_PAGE_BG = 0xffffff;

// Merge caller overrides over the defaults, one level deep — each section is
// a flat bag of values, and STEPS is replaced wholesale rather than merged.
export function createConfig(overrides = {}) {
  const section = (base, over) => ({ ...base, ...(over || {}) });
  return {
    STEPS: overrides.STEPS ?? [...DEFAULT_STEPS],
    PAGE_BG: overrides.PAGE_BG ?? DEFAULT_PAGE_BG,
    CONFIG: section(DEFAULT_CONFIG, overrides.CONFIG),
    INTERACT: section(DEFAULT_INTERACT, overrides.INTERACT),
    LENS: section(DEFAULT_LENS, overrides.LENS),
    FOCUS: section(DEFAULT_FOCUS, overrides.FOCUS),
    ENTRY: section(DEFAULT_ENTRY, overrides.ENTRY),
  };
}
