# @neuro-pay/carousel

An infinite, scroll-driven row of panels rendered with three.js, animated with
GSAP, and drawn to screen through a liquid-glass lens shader. Framework-free —
no React import anywhere in this package — and it carries no product content.

Used by `@neuro-pay/web` for the landing page.

## Attribution

The engine is vendored from
[liquid-glass-carousel](https://github.com/Yousuf-developer/liquid-glass-carousel)
by **Yousuf Soomro**, MIT licensed. The upstream license is included verbatim
in [LICENSE](./LICENSE) and applies to `src/engine.js`, `src/gui.js` and the
default values in `src/config.js`.

## Why this package is JavaScript

`src/*.js` is upstream's source, kept deliberately close to it so future fixes
remain easy to pull in. Converting ~1,250 lines of index-heavy WebGL layout
maths to satisfy `strict` + `noUncheckedIndexedAccess` would fork it from
upstream permanently, for no benefit to callers.

Instead the package is typed at its boundary: [`src/index.d.ts`](./src/index.d.ts)
hand-declares the full public API, and `tsconfig.json` sets `checkJs: false`.
Everything outside this package — the whole of `@neuro-pay/web` — consumes it
as fully-typed code. `pnpm typecheck` and `pnpm lint` both run here.

## Usage

```ts
import { createCarousel, createCarouselGui } from "@neuro-pay/carousel";

const carousel = createCarousel(mountElement, {
  config: { STEPS, PAGE_BG, CONFIG: { PANEL_H: 600 } },
  onActiveChange: (i) => setActive(i),
  onFocusChange: (open) => setFocused(open),
  onEntryDone: (done) => setEntryDone(done),
});

carousel.closeFocus();
carousel.destroy();
```

Config arrives as a **parameter**, not a module import — that is what keeps this
package content-free. It ships upstream's defaults (white page, blue lens,
450px panels); the consuming app supplies its own theme, so
`apps/web/src/carousel.config.ts` reads as a diff from upstream.

Two properties the design depends on:

- `createConfig` returns fresh objects on every call, so one instance's live
  tuning can't leak into the defaults.
- The engine holds those objects by reference and reads through them every
  frame. That is what makes the dev GUI's sliders land without a rebuild — and
  why the resolved config is exposed as `carousel.config` rather than copied
  into locals at startup.

Press **`g`** in the browser to open the lil-gui tuning panel, then copy the
numbers you land on back into the app's carousel config.

## Layout

```
src/engine.js    scene, infinite row, scroll model, lens shader (inline GLSL),
                 focus mode, entry animation, render loop
src/config.js    upstream defaults + createConfig()
src/gui.js       lil-gui dev panel, hidden by default
src/index.d.ts   the typed public boundary
```
