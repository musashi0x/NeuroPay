// Generates the NeuroPay carousel panel artwork into public/ as p01..p10.png.
// Each panel is a dark-glass card describing one step of the payment flow.
//
//   npm run panels
//
// Cards are authored as SVG here, then rasterised at 2x with headless Chrome
// (no image dependencies to install). Point CHROME_BIN at your browser if it
// isn't in the default macOS location.
//
// Type scale note: panels render ~600px tall in the carousel (CONFIG.PANEL_H),
// so a 1000px-tall card is shown at ~0.6x. Everything here is sized so the
// smallest text still lands around 13px on screen. If you change PANEL_H,
// re-check the small type before shipping.
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const WORK = join(tmpdir(), "neuropay-panels");
const CHROME =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT, { recursive: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const C = {
  bg0: "#0A0C11",
  bg1: "#05060A",
  gold: "#F0B90B",
  green: "#3FCF8E",
  white: "#F2F5F9",
  grey: "#8892A4",
  dim: "#525C6E",
  panel: "#0F131A",
};
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', 'Menlo', 'Consolas', monospace";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- primitives -------------------------------------------------------------
const t = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : SANS}" font-size="${o.size || 26}" fill="${o.fill || C.grey}" letter-spacing="${o.ls ?? 0}" font-weight="${o.weight || 400}" text-anchor="${o.anchor || "start"}" opacity="${o.op ?? 1}">${esc(s)}</text>`;

const line = (x1, y1, x2, y2, o = {}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke || "#FFFFFF"}" stroke-width="${o.sw || 1}" opacity="${o.op ?? 0.08}"/>`;

// A block of monospace lines inside a slightly-raised surface.
function codeBlock(x, y, w, lines, o = {}) {
  const size = o.size || 24;
  const lh = o.lh || 40;
  const padX = 30;
  const padY = 32;
  const h = padY * 2 + lines.length * lh - (lh - size);
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${C.panel}" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="1"/>`;
  lines.forEach((ln, i) => {
    const [text, fill] = Array.isArray(ln) ? ln : [ln, o.fill || C.grey];
    s += t(x + padX, y + padY + size + i * lh, text, {
      mono: true,
      size,
      fill,
    });
  });
  return { svg: s, h };
}

// Two-column key/value rows with hairline separators.
function rows(x, y, w, items, o = {}) {
  const size = o.size || 25;
  const lh = o.lh || 56;
  let s = "";
  items.forEach((it, i) => {
    const yy = y + i * lh;
    const [k, v, fill] = it;
    s += t(x, yy, k, { mono: true, size, fill: C.dim });
    s += t(x + w, yy, v, {
      mono: true,
      size,
      fill: fill || C.white,
      anchor: "end",
    });
    if (i < items.length - 1)
      s += line(x, yy + 22, x + w, yy + 22, { op: 0.06 });
  });
  return s;
}

// --- card chrome ------------------------------------------------------------
function card(W, H, body, opts = {}) {
  const glowX = opts.glowX ?? W * 0.5;
  const glowY = opts.glowY ?? H * 0.18;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="${opts.glow || C.gold}" stop-opacity="${opts.glowOp ?? 0.13}"/>
    <stop offset="1" stop-color="${opts.glow || C.gold}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.07"/>
    <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <pattern id="dots" width="30" height="30" patternUnits="userSpaceOnUse">
    <circle cx="1" cy="1" r="1.1" fill="#FFFFFF" opacity="0.05"/>
  </pattern>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<ellipse cx="${glowX}" cy="${glowY}" rx="${W * 0.8}" ry="${H * 0.45}" fill="url(#glow)"/>
<rect width="${W}" height="${Math.round(H * 0.4)}" fill="url(#sheen)"/>
${body}
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="1"/>
</svg>`;
}

// Standard header: eyebrow left, step marker right, hairline under.
function header(W, M, eyebrow, marker) {
  const y = 82;
  return (
    t(M, y, eyebrow, {
      size: 22,
      fill: C.gold,
      ls: 4,
      weight: 500,
      mono: true,
    }) +
    t(W - M, y, marker, {
      size: 22,
      fill: C.dim,
      ls: 4,
      anchor: "end",
      mono: true,
    }) +
    line(M, y + 32, W - M, y + 32, { op: 0.1 })
  );
}

// Headline, wrapped by explicit lines.
function title(M, y, lines, size = 52, fill = C.white) {
  return lines
    .map((l, i) =>
      t(M, y + i * Math.round(size * 1.2), l, {
        size,
        fill,
        weight: 500,
        ls: -0.8,
      }),
    )
    .join("");
}

// Body copy block.
function body(M, y, lines, o = {}) {
  const size = o.size || 26;
  const lh = o.lh || 38;
  return lines
    .map((l, i) => {
      const [text, fill] = Array.isArray(l) ? l : [l, o.fill || C.grey];
      return t(M, y + i * lh, text, { size, fill });
    })
    .join("");
}

// Footnote pinned to the bottom of the card.
function foot(M, W, H, lines) {
  const rule = H - 118;
  return (
    line(M, rule, W - M, rule, { op: 0.07 }) +
    lines
      .map((l, i) => t(M, H - 76 + i * 32, l, { size: 22, fill: C.dim }))
      .join("")
  );
}

// --- panels -----------------------------------------------------------------
const P = { w: 760, h: 1000, m: 58 }; // portrait step card
const L = { w: 1040, h: 700, m: 58 }; // landscape terminal card

const panels = [];
const add = (name, svg) => panels.push({ name, svg });

// 01 — hero
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "BNB CHAIN", "x402");
  b += t(M, 268, "NeuroPay", {
    size: 96,
    fill: C.white,
    weight: 600,
    ls: -3.4,
  });
  b += line(M, 312, W - M, 312, { op: 0.12 });
  b += title(M, 396, ["Agents buy the", "services they need."], 52);
  b += body(M, 552, [
    "A catalog of paid APIs, and the",
    "gateway that settles them.",
    "Paid in USDC, before the call runs.",
  ]);
  b += codeBlock(M, 706, W - M * 2, [["402 → grant → USDC → 200", C.gold]], {
    size: 26,
  }).svg;
  b += foot(M, W, H, ["No accounts. No API keys. No invoices."]);
  add("p01", card(W, H, b, { glowY: H * 0.12, glowOp: 0.18 }));
}

// 02 — catalog
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "CATALOG", "02");
  b += title(M, 224, ["Every paid API,", "with a price per call."], 52);
  b += rows(M, 424, W - M * 2, [
    ["vision.describe", "0.0040"],
    ["search.web", "0.0020"],
    ["llm.completion", "0.0110"],
    ["geo.reverse", "0.0010"],
    ["kyc.verify", "0.2500"],
    ["index.embed", "0.0006"],
  ]);
  b += t(M, 790, "1,284 listings", { size: 25, fill: C.gold, mono: true });
  b += t(W - M, 790, "USDC / call", {
    size: 25,
    fill: C.dim,
    mono: true,
    anchor: "end",
  });
  b += foot(M, W, H, [
    "Owners list an endpoint and set a price.",
    "The gateway does the rest.",
  ]);
  add("p02", card(W, H, b));
}

// 03 — discovery
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "DISCOVERY", "03");
  b += title(M, 224, ["The agent finds", "what it needs."], 52);
  b += codeBlock(M, 392, W - M * 2, [
    ["GET /catalog?capability=vision", C.white],
    ["", C.dim],
    ["→ 14 listings", C.gold],
    ["→ ranked by price, latency", C.grey],
    ["→ cheapest: 0.0040 USDC", C.grey],
  ]).svg;
  b += body(M, 740, [
    "It picks one and calls it.",
    ["Nothing has been paid yet.", C.white],
  ]);
  b += foot(M, W, H, ["Discovery is open. Anyone can read the catalog."]);
  add("p03", card(W, H, b));
}

// 04 — the call
{
  const { w: W, h: H, m: M } = L;
  let b = header(W, M, "REQUEST", "04");
  b += title(M, 206, ["It calls the endpoint. Unpaid."], 50);
  b += codeBlock(M, 268, W - M * 2, [
    ["POST /v1/vision.describe", C.white],
    ["host:    gateway.neuropay.io", C.grey],
    ["x-agent: agt_9f3c21", C.grey],
    ["", C.dim],
    ['{ "image_url": "https://…" }', C.grey],
  ]).svg;
  b += foot(M, W, H, ["No key, no card, no session — the agent just asks."]);
  add("p04", card(W, H, b, { glowY: H * 0.2 }));
}

// 05 — HTTP 402
{
  const { w: W, h: H, m: M } = L;
  let b = header(W, M, "GATEWAY", "05");
  b += t(M, 330, "402", { size: 158, fill: C.gold, weight: 600, ls: -6 });
  b += t(M, 392, "Payment Required", { size: 36, fill: C.white, weight: 500 });
  b += t(M, 440, "The gateway answers with a price.", {
    size: 25,
    fill: C.grey,
  });
  b += codeBlock(
    M + 452,
    212,
    W - M * 2 - 452,
    [
      ["HTTP/1.1 402", C.gold],
      ["x-price:  0.0040 USDC", C.white],
      ["x-chain:  bnb", C.white],
      ["x-pay-to: 0x7a3f…c19b", C.white],
      ["x-nonce:  8f21d4", C.grey],
    ],
    { size: 23, lh: 40 },
  ).svg;
  b += foot(M, W, H, ["One status code is the whole handshake."]);
  add("p05", card(W, H, b, { glowX: W * 0.22, glowY: H * 0.42, glowOp: 0.2 }));
}

// 06 — the grant
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "AUTHORIZATION", "06");
  b += title(M, 224, ["Checked against", "the owner's grant."], 52);
  b += rows(M, 424, W - M * 2, [
    ["cap", "50.00 / day"],
    ["spent today", "12.44"],
    ["this call", "0.0040"],
    ["scope", "vision.* search.*"],
    ["expires", "30d"],
  ]);
  b += t(M, 740, "✓  WITHIN GRANT", {
    size: 27,
    fill: C.green,
    mono: true,
    ls: 2,
  });
  b += foot(M, W, H, [
    "Over the cap, the gateway refuses.",
    "The agent never holds the keys.",
  ]);
  add("p06", card(W, H, b, { glow: C.green, glowOp: 0.1 }));
}

// 07 — settlement
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "SETTLEMENT", "07");
  b += title(M, 224, ["Settled in USDC", "on BNB Chain."], 52);
  b += t(M, 428, "0.0040", { size: 94, fill: C.gold, weight: 600, ls: -2 });
  b += t(M + 306, 428, "USDC", { size: 30, fill: C.dim, mono: true });
  b += t(M, 486, "→  0x7a3f…c19b", { size: 26, fill: C.grey, mono: true });
  b += rows(M, 606, W - M * 2, [
    ["block time", "~0.75s"],
    ["gas fee", "< $0.001"],
    ["finality", "1 block"],
  ]);
  b += foot(M, W, H, [
    "The money moves before the call runs.",
    "No escrow, no invoice, no trust.",
  ]);
  add("p07", card(W, H, b, { glowY: H * 0.35, glowOp: 0.16 }));
}

// 08 — execution
{
  const { w: W, h: H, m: M } = L;
  let b = header(W, M, "EXECUTION", "08");
  b += title(M, 206, ["Paid. Now the call runs."], 50);
  b += codeBlock(
    M,
    262,
    W - M * 2,
    [
      ["HTTP/1.1 200 OK", C.green],
      ["x-settled: 0.0040 USDC", C.white],
      ["x-tx:      0x9c2b…4ae7", C.grey],
      ["x-receipt: rcpt_02f9", C.grey],
      ["", C.dim],
      ['{ "description": "a red bicycle…" }', C.grey],
    ],
    { size: 23, lh: 40 },
  ).svg;
  b += foot(M, W, H, [
    "The gateway forwards upstream and hands back the response.",
  ]);
  add("p08", card(W, H, b, { glow: C.green, glowOp: 0.1, glowY: H * 0.2 }));
}

// 09 — receipt
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "RECEIPT", "09");
  b += title(M, 224, ["Every call", "leaves proof."], 52);
  b += rows(M, 424, W - M * 2, [
    ["14:02:11 vision", "0.0040"],
    ["14:02:09 search", "0.0020"],
    ["14:01:58 llm", "0.0110"],
    ["14:01:44 kyc", "0.2500"],
    ["14:01:30 geo", "0.0010"],
  ]);
  b += line(M, 706, W - M, 706, { op: 0.12 });
  b += t(M, 760, "today", { size: 25, fill: C.dim, mono: true });
  b += t(W - M, 760, "12.44 USDC", {
    size: 25,
    fill: C.gold,
    mono: true,
    anchor: "end",
  });
  b += foot(M, W, H, ["Reconcile any agent's spend, on-chain, per call."]);
  add("p09", card(W, H, b));
}

// 10 — integrate
{
  const { w: W, h: H, m: M } = P;
  let b = header(W, M, "INTEGRATE", "10");
  b += title(M, 224, ["Two lines."], 52);
  b += codeBlock(
    M,
    322,
    W - M * 2,
    [
      ["const pay = neuropay(grant)", C.white],
      ["const res = await pay.fetch(url)", C.white],
    ],
    { size: 23 },
  ).svg;
  b += body(M, 536, [
    "402 handled.",
    "Grant enforced.",
    "USDC settled.",
    ["Your code just sees a response.", C.white],
  ]);
  b += t(M, 800, "NeuroPay", {
    size: 56,
    fill: C.white,
    weight: 600,
    ls: -1.8,
  });
  b += foot(M, W, H, ["Start with the catalog."]);
  add("p10", card(W, H, b, { glowY: H * 0.78, glowOp: 0.16 }));
}

// --- rasterise ---------------------------------------------------------------
// Chrome renders the SVG inside a bare HTML shell so the page has no margin
// and the screenshot is exactly the card, at 2x for retina.
for (const p of panels) {
  const [, W, H] = p.svg.match(/width="(\d+)" height="(\d+)"/);
  const html = join(WORK, `${p.name}.html`);
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;overflow:hidden;background:${C.bg1}}svg{display:block}</style>` +
      p.svg,
  );
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=${W},${H}`,
      `--screenshot=${join(OUT, `${p.name}.png`)}`,
      `file://${html}`,
    ],
    { stdio: "ignore" },
  );
  console.log(`  ${p.name}.png  ${W * 2}x${H * 2}`);
}
rmSync(WORK, { recursive: true, force: true });
console.log(`\nwrote ${panels.length} panels to public/`);
