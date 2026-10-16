#!/usr/bin/env node
/**
 * Mascot generator.
 *
 * The mascot is authored as SVG rather than as a bitmap, for three reasons that
 * matter more than convenience:
 *
 *  - it stays sharp from a 16px favicon to a 400px hero, from one file;
 *  - it lives in the repository as text, so it can be reviewed, diffed and
 *    recoloured by a contributor without a design tool;
 *  - it is ours. Nothing here is traced from, or derived from, another product's
 *    artwork.
 *
 * This script is the single source of truth. Editing an emitted `.svg` by hand
 * means the next run overwrites it, which is the point.
 *
 *   node website/assets/generate.mjs
 *
 * ## The character
 *
 * "Keeper" is a small squarish creature that reads as something living inside
 * your machine: a rounded body with a terminal-like notch along the top, a
 * single antenna, and two eyes.
 *
 * The eyes are not decoration. They encode the thing this project is actually
 * about:
 *
 *   - both eyes open  -> `person`: a human is present
 *   - one eye open    -> `background`: working alone, cannot act outward
 *   - both closed     -> parked
 *
 * That is the whole authorization model, legible at 16 pixels, and it gives the
 * avatar a reason to change state instead of being a static logo. The antenna
 * bulb carries the same signal in colour, so the two never disagree.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

/**
 * The generator writes the same files to two places, because both consume them
 * and neither can reach the other's directory: the site serves them as static
 * assets, and the desktop renderer imports them through its bundler. One script,
 * one source of truth, two outputs, so an edited mascot cannot appear on the site
 * and not in the app.
 */
const OUTPUT_DIRS = [here, join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer', 'assets', 'mascot')];
for (const dir of OUTPUT_DIRS) mkdirSync(dir, { recursive: true });

/**
 * Palette. Deliberately narrow: one accent doing all the work, on a near-black
 * ground. Both closest products are light-themed, so the dark ground is part of
 * how this is recognised rather than a preference.
 */
const PALETTE = {
  ink: '#08090b',
  body: '#141a1f',
  bodyEdge: '#2b3540',
  mint: '#67e8a2',
  mintDim: '#2f7a55',
  amber: '#e0b054',
  text: '#e8ebee',
  dim: '#6b7580',
};

/** Eye states, which are states of the authorization model. */
const EYES = {
  /** A person is present. */
  person: 'person',
  /** Working alone. This is what a paired phone sees. */
  background: 'background',
  /** Parked. */
  asleep: 'asleep',
};

/** The bulb colour follows the eyes, so the two signals cannot drift apart. */
const BULB = {
  person: PALETTE.mint,
  background: PALETTE.mintDim,
  asleep: PALETTE.dim,
};

const eye = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" />`;
const closedEye = (x, y, w, stroke) =>
  `<path d="M${x} ${y} q${w / 2} ${w * 0.42} ${w} 0" stroke="${stroke}" stroke-width="2.4" fill="none" stroke-linecap="round" />`;

/**
 * Render the mascot.
 *
 * `size` is the viewBox edge; everything else scales from it, so a caller never
 * has to reason about units.
 */
function keeper({ size = 128, state = EYES.person, hue = null, glow = true, background = false } = {}) {
  const s = size / 128;
  const accent = hue ?? BULB[state];
  // A per-avatar hue keeps every agent recognisable while all of them are
  // obviously the same character.
  const body = hue !== null ? shade(hue, 0.16) : PALETTE.body;
  const edge = hue !== null ? shade(hue, 0.42) : PALETTE.bodyEdge;
  const bulb = hue !== null ? hue : BULB[state];

  const glowDefs = glow
    ? `<filter id="g" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="${6 * s}" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>`
    : '';

  // Sparkle off the bulb, so a lit antenna reads as lit rather than painted.
  const aura = glow
    ? `<circle cx="64" cy="22" r="${9 * s}" fill="${bulb}" opacity="0.18" filter="url(#g)" />`
    : '';

  const openEyes = `
    <g filter="${glow ? 'url(#g)' : 'none'}">
      ${eye(40, 56, 15, 19, accent)}
      ${eye(73, 56, 15, 19, accent)}
    </g>`;
  const oneEye = `
    <g filter="${glow ? 'url(#g)' : 'none'}">
      ${eye(40, 56, 15, 19, accent)}
      ${closedEye(73, 65, 15, PALETTE.dim)}
    </g>`;
  const shutEyes = `
    <g>
      ${closedEye(40, 65, 15, PALETTE.dim)}
      ${closedEye(73, 65, 15, PALETTE.dim)}
    </g>`;

  const eyes = state === EYES.person ? openEyes : state === EYES.background ? oneEye : shutEyes;

  // A mouth that only appears when the character is idle. Absent while working,
  // because a working agent should look busy, not cheerful.
  const mouth =
    state === EYES.asleep
      ? `<path d="M54 88 q10 6 20 0" stroke="${PALETTE.dim}" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.7" />`
      : '';

  // The plate is drawn in the 128-unit viewBox, not at `size`, or a non-128
  // `size` would make it overflow the viewBox it is supposed to sit behind.
  const plate = background ? `<rect width="128" height="128" rx="28" fill="${PALETTE.ink}" />` : '';

  // No width/height on the root: the viewBox plus CSS is what makes one file
  // work at 16px in a tab strip and at 400px in a hero. An authored size would
  // pin it and force a second file.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="guhbot">
  <defs>${glowDefs}</defs>
  ${plate}
  <!-- antenna -->
  <path d="M64 30 V16" stroke="${edge}" stroke-width="${5 * s}" stroke-linecap="round" />
  ${aura}
  <circle cx="64" cy="${state === EYES.asleep ? 15 : 13}" r="${7 * s}" fill="${bulb}" />
  <!-- body -->
  <rect x="18" y="30" width="92" height="82" rx="${24 * s}" fill="${body}" stroke="${edge}" stroke-width="${3 * s}" />
  <!-- the terminal notch: this is what makes it read as a machine, not a face -->
  <path d="M34 44 H94" stroke="${edge}" stroke-width="${3 * s}" stroke-linecap="round" opacity="0.55" />
  ${eyes}
  ${mouth}
  <!-- two short strokes suggesting a screen edge, echoing the notch -->
  <path d="M40 96 H60" stroke="${edge}" stroke-width="3.2" stroke-linecap="round" opacity="0.4" />
  <path d="M68 96 H88" stroke="${edge}" stroke-width="3.2" stroke-linecap="round" opacity="0.22" />
</svg>
`;
}

/**
 * Darken or lighten a hex colour toward the ink ground.
 *
 * `amount` is how far toward the accent's own fuller saturation to go, so a hue
 * given as a mid-tone still yields a body that is darker than its edge.
 */
function shade(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c) => Math.round(c * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The mascot's inner geometry, without the root `<svg>` element.
 *
 * Needed when embedding the character in a larger drawing, where a nested
 * `<svg>` would establish its own viewport and ignore the parent's transform.
 */
function inner(svg) {
  return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

// -- Emitted files ----------------------------------------------------------

const written = [];

function emit(name, contents) {
  for (const dir of OUTPUT_DIRS) writeFileSync(join(dir, name), contents);
  written.push(name);
}

// The three states, which are the three states of the authorization model.
emit('keeper-person.svg', keeper({ state: EYES.person }));
emit('keeper-background.svg', keeper({ state: EYES.background }));
emit('keeper-asleep.svg', keeper({ state: EYES.asleep }));

// The app icon and favicon: a plate behind the character so it survives on a
// light desktop or a busy tab strip.
// No glow on the icon: at small sizes the aura reads as a smudge around the
// plate, and an app icon has to survive being scaled to 32px in a dock.
emit('icon.svg', keeper({ size: 256, state: EYES.person, background: true, glow: false }));

// Wordmark lockup, for the site header and anywhere a horizontal mark is needed.
// The mascot is scaled into a 56-unit square and the wordmark is placed against
// it, so the two cannot drift apart.
emit(
  'logo.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 236 64" role="img" aria-label="guhbot">
  <g transform="translate(4 4) scale(0.4375)">${inner(keeper({ state: EYES.person }))}</g>
  <text x="70" y="42" fill="${PALETTE.text}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="28" font-weight="650" letter-spacing="-0.7">guhbot</text>
</svg>
`,
);

/**
 * Agent avatars.
 *
 * Six hues, all the same character with both eyes open, because an agent in a
 * sidebar should be recognisable at a glance and obviously one of ours. The hues
 * are spaced around the wheel and all sit in the same lightness band, so no
 * avatar shouts louder than another.
 */
const AVATAR_HUES = ['#67e8a2', '#7cc4f0', '#b79bf0', '#f0a3c0', '#f0c674', '#7fe0d0'];
AVATAR_HUES.forEach((hue, index) => {
  emit(
    `avatar-${index + 1}.svg`,
    keeper({ size: 96, state: EYES.person, hue, glow: false, background: true }),
  );
});

// Sleeping and working avatars, for an agent that is parked or busy.
emit('avatar-asleep.svg', keeper({ size: 96, state: EYES.asleep, hue: '#7a8896', glow: false, background: true }));

for (const dir of OUTPUT_DIRS) {
  process.stdout.write(`wrote ${written.length} files to ${dir}\n`);
}
process.stdout.write(`${written.map((f) => `  ${f}`).join('\n')}\n`);
