// Public types for the carousel. The engine itself is vendored JavaScript
// (see README.md) — this file is the typed boundary the workspace consumes it
// through, so nothing outside this package sees untyped code.

/**
 * One panel in the row. The engine reads only these two fields; consumers are
 * expected to extend this with whatever their UI needs (labels, captions) and
 * pass the extended type through.
 */
export interface CarouselStep {
  /** Image URL the browser can load, e.g. "/p01.png". */
  src: string;
  /**
   * Width / height of the image. Panels are all PANEL_H tall and take their
   * width from this, so nothing is cropped. `null` measures it from the image
   * once it loads.
   */
  aspect: number | null;
}

/** Layout and scroll feel. */
export interface CarouselLayoutConfig {
  /** Panel height in px; widths follow each panel's aspect. */
  PANEL_H: number;
  /** Gap between panels in px. */
  GAP: number;
  /** Lerp toward target — lower is heavier, more glide. */
  EASE: number;
  WHEEL: number;
  DRAG: number;
  /** Flick momentum decay after a drag release. */
  FRICTION: number;
  /** Settle onto the nearest panel center. */
  SNAP: boolean;
  /** ms of idle input before the settle-snap engages. */
  SNAP_IDLE_MS: number;
  SNAP_EASE: number;
  SHRINK_MAX: number;
  SHRINK_ATTACK: number;
  SHRINK_DECAY: number;
}

/** Drag / click-to-focus behaviour and thresholds. */
export interface CarouselInteractConfig {
  drag: boolean;
  /** true = clicking a panel no longer opens focus mode. */
  noClick: boolean;
  CLICK_SLOP: number;
  FLICK_IDLE_MS: number;
  TOUCH_DRAG: number;
  TOUCH_EASE: number;
  TOUCH_CLICK_SLOP: number;
}

/** The liquid-glass lens. Every key is mirrored 1:1 as a shader uniform. */
export interface CarouselLensConfig {
  shape: "circle" | "square";
  squareRound: number;
  rotation: number;
  spin: number;
  sizeX: number;
  sizeY: number;
  posX: number;
  posY: number;
  zoom: number;
  dispersion: number;
  blur: number;
  glow: number;
  whiteGlow: number;
  novaSize: number;
  /** Ring intensity. Named for the upstream blue; the color is `blueColor`. */
  blueRing: number;
  ringRadius: number;
  ringWidth: number;
  shimmer: boolean;
  shimmerFreq: number;
  shimmerSpeed: number;
  shimmerDepth: number;
  rimStart: number;
  rimTangential: number;
  rimInward: number;
  rimFreq1: number;
  rimFreq2: number;
  /** Tint / ring color as a CSS hex string. */
  blueColor: string;
  rimLine: number;
  rimLinePos: number;
  rimLineWidth: number;
  vignette: number;
  vignetteSize: number;
  samples: number;
}

/** Focus mode choreography. */
export interface CarouselFocusConfig {
  cardDuration: number;
  focusDuration: number;
  cardEase: string;
  focusEase: string;
  stagger: number;
  dropDist: number;
  centerScale: number;
  lensFade: number;
}

/** Entry animation choreography. */
export interface CarouselEntryConfig {
  enabled: boolean;
  delay: number;
  startH: number;
  riseDuration: number;
  stagger: number;
  riseEase: string;
  fromBelow: number;
  growDelay: number;
  growDuration: number;
  growEase: string;
  growStagger: number;
  growDir: "inward" | "outward";
  lensBloom: number;
  lensBloomEase: string;
}

/** Fully resolved config — defaults with the caller's overrides applied. */
export interface ResolvedCarouselConfig {
  STEPS: CarouselStep[];
  /** Renderer clear color; must match the page background or seams show. */
  PAGE_BG: number;
  CONFIG: CarouselLayoutConfig;
  INTERACT: CarouselInteractConfig;
  LENS: CarouselLensConfig;
  FOCUS: CarouselFocusConfig;
  ENTRY: CarouselEntryConfig;
}

/** What a consumer passes in — any subset of the resolved shape. */
export interface CarouselConfigOverrides {
  STEPS?: CarouselStep[];
  PAGE_BG?: number;
  CONFIG?: Partial<CarouselLayoutConfig>;
  INTERACT?: Partial<CarouselInteractConfig>;
  LENS?: Partial<CarouselLensConfig>;
  FOCUS?: Partial<CarouselFocusConfig>;
  ENTRY?: Partial<CarouselEntryConfig>;
}

export interface CarouselOptions {
  /** Merged over the package defaults. */
  config?: CarouselConfigOverrides;
  /** Optional label element the engine moves to trail the pointer. */
  cursorElement?: HTMLElement | null;
  /** The centered panel changed. */
  onActiveChange?: (index: number) => void;
  /** Focus mode opened or closed. Fires at the START of the close. */
  onFocusChange?: (open: boolean) => void;
  /** The entry animation finished settling. */
  onEntryDone?: (done: boolean) => void;
  /** Interaction mode changed from the dev GUI. */
  onModeChange?: (mode: CarouselInteractConfig) => void;
}

/**
 * The engine's whole contract with its host. Nothing should reach past this
 * into engine internals.
 */
export interface CarouselHandle {
  /**
   * The resolved config. The dev GUI mutates these objects in place and the
   * engine reads through them every frame, which is what makes live tuning
   * work — so treat the references as shared, not as a snapshot.
   */
  config: ResolvedCarouselConfig;
  closeFocus: () => void;
  replayEntry: () => void;
  /** Call after changing PANEL_H or GAP. */
  refreshLayout: () => void;
  setInteraction: (next: Partial<CarouselInteractConfig>) => void;
  /** Exposed for the dev GUI. */
  lensUniforms: Record<string, { value: unknown }>;
  destroy: () => void;
}

export interface CarouselGui {
  destroy: () => void;
}

/** Mount the carousel into `mount`. Returns the handle. */
export function createCarousel(
  mount: HTMLElement,
  options?: CarouselOptions,
): CarouselHandle;

/** Attach the lil-gui dev panel, hidden until the `g` key is pressed. */
export function createCarouselGui(carousel: CarouselHandle): CarouselGui;

/** Merge overrides over the defaults. Returns fresh objects every call. */
export function createConfig(
  overrides?: CarouselConfigOverrides,
): ResolvedCarouselConfig;

export const DEFAULT_CONFIG: CarouselLayoutConfig;
export const DEFAULT_INTERACT: CarouselInteractConfig;
export const DEFAULT_LENS: CarouselLensConfig;
export const DEFAULT_FOCUS: CarouselFocusConfig;
export const DEFAULT_ENTRY: CarouselEntryConfig;
export const DEFAULT_PAGE_BG: number;
