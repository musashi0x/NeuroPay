"use client";

// React wrapper around the carousel. All the WebGL/animation logic lives in
// @neuro-pay/carousel — this component only owns the DOM overlay: the NeuroPay
// wordmark, the step label, the counter, the cursor label, the focus-mode
// caption and the Close button. Content and theme come from carousel.config.

import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { createCarousel, createCarouselGui } from "@neuro-pay/carousel";
import type { CarouselHandle } from "@neuro-pay/carousel";
import { STEPS, UI_ANIM, carouselConfig } from "@/carousel.config";

const ENTRY_ENABLED = carouselConfig.ENTRY?.enabled ?? true;

// The carousel is a desktop experience (wheel-driven, heavy shader work).
// At this viewport width or below we show a plain holding screen instead.
const MIN_VIEWPORT_WIDTH = 1025; // px

/** Hidden until the entry animation settles; GSAP fades these in. */
const hiddenUntilEntry = ENTRY_ENABLED
  ? ({ opacity: 0, visibility: "hidden" } as const)
  : {};

type ScreenState = "pending" | "ok" | "small";

export function CarouselSection() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const topTextRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const counterRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CarouselHandle | null>(null);
  const revealPlayedRef = useRef(false); // entry reveal fade runs exactly once

  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [entryDone, setEntryDone] = useState(false);
  const [noClick, setNoClick] = useState(false);
  // "pending" until we know the viewport (SSR-safe), then "ok" | "small"
  const [screen, setScreen] = useState<ScreenState>("pending");

  // ---- viewport gate ----
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MIN_VIEWPORT_WIDTH - 1}px)`);
    const update = () => setScreen(mq.matches ? "small" : "ok");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // ---- engine lifecycle ----
  useEffect(() => {
    const mount = mountRef.current;
    if (screen !== "ok" || !mount) return; // never boot WebGL on small screens

    const engine = createCarousel(mount, {
      config: carouselConfig,
      cursorElement: cursorRef.current,
      onActiveChange: setActive,
      onFocusChange: setFocused,
      onEntryDone: setEntryDone,
      onModeChange: (mode) => setNoClick(mode.noClick), // swaps the label text
    });
    engineRef.current = engine;
    const gui = createCarouselGui(engine); // dev panel, hidden until "g"

    return () => {
      gui.destroy();
      engine.destroy();
      engineRef.current = null;
    };
  }, [screen]);

  // ---- overlay text transitions ----
  // GSAP-driven so they share the canvas animations' easing vocabulary.
  useEffect(() => {
    const topText = topTextRef.current;
    const counter = counterRef.current;
    const note = noteRef.current;
    const chrome = chromeRef.current;
    if (!topText || !counter || !note) return;

    if (!entryDone && ENTRY_ENABLED) {
      gsap.set([topText, counter, note, ...(chrome ? [chrome] : [])], {
        autoAlpha: 0,
      });
      revealPlayedRef.current = false;
      return; // stay hidden until the entry settles
    }

    gsap.set(topText, { xPercent: -50 }); // GSAP owns the transform
    gsap.set([counter, note], { xPercent: -50 });

    if (entryDone && !focused && !revealPlayedRef.current) {
      // Premium settle reveal: a slow fade with no movement, the counter
      // trailing the top text slightly. Runs ONCE after the entry — closing
      // focus must not replay it, or the heading blinks out and fades back in.
      revealPlayedRef.current = true;
      gsap.fromTo(
        topText,
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: UI_ANIM.revealDuration,
          ease: UI_ANIM.revealEase,
        },
      );
      gsap.fromTo(
        [counter, ...(chrome ? [chrome] : [])],
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: UI_ANIM.revealDuration,
          ease: UI_ANIM.revealEase,
          delay: UI_ANIM.revealStagger,
        },
      );
      return;
    }

    // Focus toggle: the counter and the caption trade places at the bottom,
    // so neither ever sits on top of the enlarged card.
    gsap.to(topText, {
      autoAlpha: 1,
      duration: UI_ANIM.duration,
      ease: UI_ANIM.ease,
    });
    gsap.to(counter, {
      autoAlpha: focused ? 0 : 1,
      duration: UI_ANIM.duration,
      ease: UI_ANIM.ease,
    });
    gsap.to(note, {
      autoAlpha: focused ? 1 : 0,
      duration: UI_ANIM.duration,
      ease: UI_ANIM.ease,
      delay: focused ? UI_ANIM.revealStagger : 0,
    });
  }, [focused, entryDone]);

  // Small screens get a branded holding screen instead of the carousel.
  // "pending" (first paint, viewport not measured yet) stays dark too, so
  // mobile users never see a flash of the desktop experience booting.
  if (screen !== "ok") {
    return (
      <div className="carousel-root flex h-screen w-screen flex-col items-center justify-center bg-[var(--carousel-ink)] px-8">
        {screen === "small" && (
          <>
            <p className="text-2xl tracking-tight text-white">NeuroPay</p>
            <p className="mt-4 max-w-xs text-center text-sm leading-relaxed text-white/45">
              Agents buy the services they need on BNB Chain.
            </p>
            <p className="mt-8 font-mono text-[11px] tracking-[0.2em] text-[var(--carousel-bnb)]/70 uppercase">
              Desktop only — 1024px+
            </p>
          </>
        )}
      </div>
    );
  }

  const step = STEPS[active];
  if (!step) return null;

  return (
    <div
      ref={mountRef}
      className="carousel-root relative h-screen w-screen overflow-hidden bg-[var(--carousel-ink)]"
    >
      {/* persistent product chrome */}
      <div
        ref={chromeRef}
        className="pointer-events-none"
        style={hiddenUntilEntry}
      >
        <div className="fixed top-[2vh] left-[4vw] z-40 text-[15px] tracking-tight text-white mix-blend-exclusion">
          NeuroPay
        </div>
        <div className="fixed right-[4vw] bottom-[2vh] z-40 font-mono text-[11px] tracking-[0.22em] text-white uppercase mix-blend-exclusion">
          BNB Chain · USDC
        </div>
        <div className="fixed bottom-[2vh] left-[4vw] z-40 font-mono text-[11px] tracking-[0.22em] text-white uppercase mix-blend-exclusion">
          HTTP 402 Gateway
        </div>
      </div>

      {/* Centered step label. The cards carry their own headline, so this
          stays a locator rather than repeating it. */}
      <div
        ref={topTextRef}
        className="pointer-events-none absolute top-[6%] left-1/2 px-4 text-white mix-blend-exclusion"
        style={hiddenUntilEntry}
      >
        <p className="text-center font-mono text-[11px] tracking-[0.3em] uppercase">
          {step.label}
        </p>
      </div>

      {/* Step counter — swaps out for the caption in focus mode. */}
      <div
        ref={counterRef}
        className="pointer-events-none absolute bottom-[6%] left-1/2 px-4 text-white mix-blend-exclusion"
        style={hiddenUntilEntry}
      >
        <p className="text-center font-mono text-[12px] tracking-[0.2em]">
          {String(active + 1).padStart(2, "0")}
          <span className="opacity-40">
            {" / "}
            {String(STEPS.length).padStart(2, "0")}
          </span>
        </p>
      </div>

      {/* Focus-mode caption, in the counter's place. */}
      <div
        ref={noteRef}
        className="pointer-events-none absolute bottom-[6%] left-1/2 w-[min(88vw,520px)] px-4 text-white mix-blend-exclusion"
        style={{ opacity: 0, visibility: "hidden" }}
      >
        <p className="text-center text-[13px] leading-relaxed">{step.note}</p>
      </div>

      {/* Trailing cursor label, moved by the engine. */}
      <div
        ref={cursorRef}
        className="pointer-events-none fixed top-4 left-4 z-50 font-mono text-[11px] tracking-[0.2em] whitespace-nowrap text-white uppercase mix-blend-exclusion"
        style={{ willChange: "transform", opacity: 0, visibility: "hidden" }}
      >
        {noClick ? "Drag" : "Open"}
      </div>

      <button
        type="button"
        onClick={() => engineRef.current?.closeFocus()}
        aria-label="Close"
        className="fixed z-50 cursor-pointer font-mono text-[11px] tracking-[0.2em] whitespace-nowrap text-white uppercase mix-blend-exclusion transition-opacity duration-300"
        style={{
          top: "2vh",
          right: "4vw",
          opacity: focused ? 1 : 0,
          pointerEvents: focused ? "auto" : "none",
        }}
      >
        Close
      </button>
    </div>
  );
}
