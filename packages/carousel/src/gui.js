// Optional lil-gui dev panel for tuning the carousel live. Hidden by default —
// press "g" to toggle it. Sliders mutate `carousel.config` in place, which is
// the same object the engine reads each frame, so changes land immediately.
// Copy the numbers you land on back into the consuming app's carousel config.
import GUI from "lil-gui";

// A curated set of GSAP ease strings for the dropdowns.
const GSAP_EASES = [
  "none",
  "power1.out",
  "power2.out",
  "power3.out",
  "power4.out",
  "power1.inOut",
  "power2.inOut",
  "power3.inOut",
  "power4.inOut",
  "sine.out",
  "sine.inOut",
  "expo.out",
  "expo.inOut",
  "circ.out",
  "circ.inOut",
  "back.out(1.7)",
  "back.inOut(1.7)",
  "elastic.out(1,0.3)",
];

// takes the object returned by createCarousel()
export function createCarouselGui(carousel) {
  // Same object references the engine reads every frame, so slider changes
  // land immediately without a rebuild.
  const { CONFIG, INTERACT, LENS, FOCUS, ENTRY } = carousel.config;

  const { lensUniforms, refreshLayout, replayEntry, setInteraction } = carousel;

  const gui = new GUI({ title: "Carousel" });
  gui.hide(); // hidden until "g" (see the keydown handler at the bottom)

  gui
    .add(CONFIG, "PANEL_H", 10, 600, 1)
    .name("panel height")
    .onChange(refreshLayout);
  gui.add(CONFIG, "GAP", 0, 120, 1).name("gap").onChange(refreshLayout);
  gui.add(CONFIG, "EASE", 0.02, 0.2, 0.005).name("glide ease");

  const scrollFolder = gui.addFolder("Scroll & Snap");
  scrollFolder.add(CONFIG, "WHEEL", 0.1, 4, 0.05).name("wheel sensitivity");
  scrollFolder.add(CONFIG, "EASE", 0.02, 0.3, 0.005).name("glide ease");
  scrollFolder
    .add(CONFIG, "FRICTION", 0.8, 0.985, 0.005)
    .name("momentum decay");
  scrollFolder.add(CONFIG, "SNAP").name("settle snap");
  scrollFolder.add(CONFIG, "SNAP_IDLE_MS", 20, 500, 10).name("snap idle (ms)");
  scrollFolder.add(CONFIG, "SNAP_EASE", 0.01, 0.12, 0.005).name("snap ease");

  // drag / noClick are interlocked (see setInteraction in engine.js), so both
  // controllers refresh their display after either one changes
  const interactFolder = gui.addFolder("Interaction");
  const dragCtrl = interactFolder
    .add(INTERACT, "drag")
    .name("draggable")
    .onChange((v) => {
      setInteraction({ drag: v });
      noClickCtrl.updateDisplay();
    });
  interactFolder.add(CONFIG, "DRAG", 0.2, 4, 0.05).name("drag sensitivity");
  interactFolder
    .add(INTERACT, "TOUCH_DRAG", 0.2, 3, 0.05)
    .name("touch sensitivity");
  interactFolder
    .add(INTERACT, "TOUCH_EASE", 0.05, 1, 0.01)
    .name("touch follow");
  const noClickCtrl = interactFolder
    .add(INTERACT, "noClick")
    .name("no click (drag only)")
    .onChange((v) => {
      setInteraction({ noClick: v });
      dragCtrl.updateDisplay();
    });

  const focusFolder = gui.addFolder("Focus Mode");
  focusFolder.add(FOCUS, "cardDuration", 0.2, 2.5, 0.05).name("card duration");
  focusFolder
    .add(FOCUS, "focusDuration", 0.2, 2.5, 0.05)
    .name("focus duration");
  focusFolder.add(FOCUS, "cardEase", GSAP_EASES).name("card ease");
  focusFolder.add(FOCUS, "focusEase", GSAP_EASES).name("focus ease");
  focusFolder.add(FOCUS, "stagger", 0, 0.25, 0.005).name("stagger (s)");
  focusFolder.add(FOCUS, "dropDist", 0.6, 2.5, 0.05).name("drop distance");
  focusFolder.add(FOCUS, "centerScale", 1, 1.8, 0.01).name("focus scale");
  focusFolder.add(FOCUS, "lensFade", 0.2, 2, 0.05).name("lens fade (s)");

  const entryFolder = gui.addFolder("Entry Animation");
  entryFolder.add(ENTRY, "enabled").name("auto on load");
  entryFolder.add(ENTRY, "delay", 0, 2, 0.05).name("start delay (s)");
  entryFolder.add(ENTRY, "startH", 20, 300, 1).name("start height");
  entryFolder.add(ENTRY, "riseDuration", 0.3, 3, 0.05).name("rise dur (s)");
  entryFolder.add(ENTRY, "stagger", 0, 0.3, 0.005).name("stagger (s)");
  entryFolder.add(ENTRY, "riseEase", GSAP_EASES).name("rise ease");
  entryFolder.add(ENTRY, "fromBelow", 0.3, 1.5, 0.05).name("start below");
  entryFolder.add(ENTRY, "growDelay", 0, 1.5, 0.05).name("grow delay (s)");
  entryFolder.add(ENTRY, "growDuration", 0.2, 2.5, 0.05).name("grow dur (s)");
  entryFolder.add(ENTRY, "growEase", GSAP_EASES).name("grow ease");
  entryFolder.add(ENTRY, "growStagger", 0, 0.3, 0.005).name("grow stagger");
  entryFolder.add(ENTRY, "growDir", ["outward", "inward"]).name("grow dir");
  entryFolder.add(ENTRY, "lensBloom", 0.2, 3, 0.05).name("lens bloom (s)");
  entryFolder.add(ENTRY, "lensBloomEase", GSAP_EASES).name("lens bloom ease");
  entryFolder.add({ replay: () => replayEntry() }, "replay").name("▶ replay");

  const lensFolder = gui.addFolder("Lens");
  lensFolder
    .add(LENS, "shape", ["circle", "square"])
    .onChange((v) => (lensUniforms.uShape.value = v === "square" ? 1.0 : 0.0));
  lensFolder
    .add(LENS, "squareRound", 0, 1, 0.01)
    .name("corner round")
    .onChange((v) => (lensUniforms.uSquareRound.value = v));
  lensFolder.add(LENS, "rotation", -180, 180, 1).name("rotation°");
  lensFolder.add(LENS, "spin", -180, 180, 1).name("spin °/s");
  lensFolder
    .add(LENS, "sizeX", 0.03, 0.6, 0.005)
    .name("width")
    .onChange((v) => (lensUniforms.uSizeX.value = v));
  lensFolder
    .add(LENS, "sizeY", 0.03, 0.6, 0.005)
    .name("height")
    .onChange((v) => (lensUniforms.uSizeY.value = v));
  lensFolder
    .add(LENS, "posX", 0, 1, 0.005)
    .name("pos X")
    .onChange((v) => (lensUniforms.uCenter.value.x = v));
  lensFolder
    .add(LENS, "posY", 0, 1, 0.005)
    .name("pos Y")
    .onChange((v) => (lensUniforms.uCenter.value.y = v));
  lensFolder
    .add(LENS, "zoom", 0, 2, 0.01)
    .name("inward pull")
    .onChange((v) => (lensUniforms.uZoom.value = v));
  lensFolder
    .add(LENS, "dispersion", 0, 120, 1)
    .onChange((v) => (lensUniforms.uDispersion.value = v));
  lensFolder
    .add(LENS, "blur", 0, 20, 0.1)
    .onChange((v) => (lensUniforms.uBlur.value = v));
  lensFolder
    .add(LENS, "samples", 2, 16, 1)
    .onChange((v) => (lensUniforms.uSamples.value = v));
  lensFolder
    .add(LENS, "vignette", 0, 1, 0.01)
    .name("vignette")
    .onChange((v) => (lensUniforms.uVignette.value = v));
  lensFolder
    .add(LENS, "vignetteSize", 0.3, 1.5, 0.01)
    .name("vignette size")
    .onChange((v) => (lensUniforms.uVignetteSize.value = v));

  const glowFolder = lensFolder.addFolder("Glow / nova / ring");
  glowFolder
    .add(LENS, "glow", 0, 40, 0.1)
    .onChange((v) => (lensUniforms.uGlow.value = v));
  glowFolder
    .add(LENS, "whiteGlow", 0, 1, 0.005)
    .name("white glow")
    .onChange((v) => (lensUniforms.uWhiteGlow.value = v));
  glowFolder
    .add(LENS, "novaSize", 0.1, 12, 0.1)
    .name("nova size")
    .onChange((v) => (lensUniforms.uNovaSize.value = v));
  glowFolder
    .add(LENS, "blueRing", 0, 6, 0.05)
    .name("blue ring")
    .onChange((v) => (lensUniforms.uBlueRing.value = v));
  glowFolder
    .add(LENS, "ringRadius", 0.1, 0.49, 0.005)
    .name("ring radius")
    .onChange((v) => (lensUniforms.uRingRadius.value = v));
  glowFolder
    .add(LENS, "ringWidth", 0.003, 0.3, 0.001)
    .name("ring width")
    .onChange((v) => (lensUniforms.uRingWidth.value = v));
  glowFolder
    .add(LENS, "shimmer")
    .onChange((v) => (lensUniforms.uShimmer.value = v ? 1.0 : 0.0));
  glowFolder
    .add(LENS, "shimmerFreq", 1, 60, 1)
    .name("shimmer freq")
    .onChange((v) => (lensUniforms.uShimmerFreq.value = v));
  glowFolder
    .add(LENS, "shimmerSpeed", 0, 20, 0.1)
    .name("shimmer speed")
    .onChange((v) => (lensUniforms.uShimmerSpeed.value = v));
  glowFolder
    .add(LENS, "shimmerDepth", 0, 0.5, 0.005)
    .name("shimmer depth")
    .onChange((v) => (lensUniforms.uShimmerDepth.value = v));
  glowFolder
    .add(LENS, "rimLine", 0, 2, 0.01)
    .name("white border")
    .onChange((v) => (lensUniforms.uRimLine.value = v));
  glowFolder
    .add(LENS, "rimLinePos", 0.1, 0.5, 0.001)
    .name("border pos")
    .onChange((v) => (lensUniforms.uRimLinePos.value = v));
  glowFolder
    .add(LENS, "rimLineWidth", 0.001, 0.05, 0.0005)
    .name("border width")
    .onChange((v) => (lensUniforms.uRimLineWidth.value = v));

  const rimFolder = lensFolder.addFolder("Rim fluid wave");
  rimFolder
    .add(LENS, "rimStart", 0, 1, 0.001)
    .onChange((v) => (lensUniforms.uRimStart.value = v));
  rimFolder
    .add(LENS, "rimTangential", 0, 0.6, 0.001)
    .onChange((v) => (lensUniforms.uRimTangential.value = v));
  rimFolder
    .add(LENS, "rimInward", 0, 1, 0.001)
    .onChange((v) => (lensUniforms.uRimInward.value = v));
  rimFolder
    .add(LENS, "rimFreq1", 1, 40, 1)
    .onChange((v) => (lensUniforms.uRimFreq1.value = v));
  rimFolder
    .add(LENS, "rimFreq2", 1, 40, 1)
    .onChange((v) => (lensUniforms.uRimFreq2.value = v));
  lensFolder
    .addColor(LENS, "blueColor")
    .name("blue color")
    .onChange((v) => lensUniforms.uBlueColor.value.set(v));

  // the panel starts hidden, so give it a way back: "g" toggles it (ignored
  // while typing into one of the GUI's own number fields)
  let visible = false;
  function onKeyDown(e) {
    if (e.key !== "g" && e.key !== "G") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.isContentEditable)) return;
    visible = !visible;
    if (visible) gui.show();
    else gui.hide();
  }
  window.addEventListener("keydown", onKeyDown);

  return {
    gui,
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      gui.destroy();
    },
  };
}
