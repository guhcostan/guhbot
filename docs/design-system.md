# Guh Bot visual system

The October 17 redesign makes the product feel like a small, approachable team. The reference sites informed the emphasis on character, clear typography and a visible product. All shapes, layouts and characters are independently implemented.

## Tokens and typography

| Token | Value | Role |
|---|---|---|
| Porcelain | `#FAFAFD` | Page and app background |
| Ink | `#202026` | Headings and primary website actions |
| Violet | `#6960E8` | Bot identity and app actions |
| Lilac | `#EEEBFF` | Hero, selected states and hosting band |
| Border | `#E6E4EF` | Quiet structural separation |
| Muted | `#757580` | Secondary text, with darker overrides for small text |

Manrope is served locally as a variable font. Its OFL license ships with both consuming surfaces. Display type uses tight tracking and 700–800 weights; app controls have explicit sizes rather than browser defaults. The app uses rounded, compact controls; the public page uses larger pill actions.

## Character and motion

`website/assets/brand/` owns the original violet, peach and mint clover characters. The SVG paths are editable, resolution-independent and reused in the desktop and native mobile clients. The hero's eyes follow pointer movement. Its entrance runs once; there is no endless decorative animation. Reduced motion disables both. Icons use a consistent rounded outline vocabulary; the app uses Lucide.

## Product surfaces

The landing has a character-led hero, an interactive scripted chat, three workflow choices, local/hosted paths, an accessible FAQ and a working waitlist. Example data is explicitly marked. It never presents a scripted preview as an actual agent run.

The desktop and browser console share the same React UI. It has a persistent bot sidebar, honest connection and authority states, a quiet conversation, Markdown results, task cancellation and modal flows for creation, pairing and connection. Small screens use a dismissible sidebar. Markdown loads only when a transcript needs it.

## Design verification

Concepts were generated for the hero, workflow/hosting, FAQ/waitlist and app screen. Local review artifacts are in `release/evidence/` and are deliberately excluded from Git.

The implementation was compared in the integrated browser at desktop and mobile widths. Comparison points: headline and CTA copy, hero and preview hierarchy, Manrope weight/scale, porcelain/lilac palette, original mascot geometry, control anatomy, and mobile wrapping/overflow. Small supporting text was darkened after review for legibility.

Intentional differences from the generated concepts: the workflow section uses an original vector notebook scene instead of a second full chat mockup; activity examples have disclosure labels; the real app renders available bots and host state instead of fabricated seed transcripts. These preserve the intended identity while keeping product claims accurate.

The web uses native buttons, forms, details/summary and dialog. Keyboard focus remains visible. The UI has semantic labels and live announcements for asynchronous results. No animation library or font service is loaded from an external CDN.
