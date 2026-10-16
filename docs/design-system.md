# Design system

All three surfaces (desktop, mobile, website) share one visual language. It was
informed by studying reference agent products (dense sidebar + central thread +
pinned approvals), reimplemented originally: no reference code, assets or
strings were copied.

## Palette (Keeper)

| Token | Value | Meaning |
|---|---|---|
| `bg` | `#08090B` | app ground |
| `sidebar` | `#0B0E12` | navigation ground |
| `surface` | `#10151B` | cards, bubbles |
| `surface-2` | `#151C24` | inputs, composer |
| `line` / `line-soft` | `#1E262F` / `#161C23` | borders |
| `text` | `#EEF2F6` | primary text |
| `dim` | `#9AA5B1` | secondary text |
| `faint` | `#626D79` | tertiary, placeholders |
| `mint` | `#67E8A2` | primary action, running, allowed |
| `amber` | `#E0B054` | needs a human (approvals, waiting) |
| `red` | `#E0796A` | danger, errors |
| `blue` | `#8AB4F8` | info, links |

One accent rule: mint means the system is working or an action is safe to
take; amber always means a run is parked on a human. Nothing decorative uses
either color.

## Typography

System stacks only, so every surface works offline and under a strict CSP
with no webfont download:

- UI: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`
- Code: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`

Scale: 10.5 eyebrow / 11 meta / 12.5 secondary / 13.5 body / 14.5 headings /
22 empty-state title. Body line-height 1.55-1.65. Mono is reserved for tool
names, tool payloads, model ids and timestamps.

## Iconography

Inline SVG drawn in this repo (Lucide-like 1.5px stroke geometry), never emoji
as icons and never an external icon font. React Native uses text glyphs and
shape views instead of SVG because no SVG dependency is wanted there. Each
icon is a 16px outline glyph: search, plus, check, x, arrow-up, clock, shield,
phone, gear, dot.

## Shape and elevation

- Radii: 9px small controls, 12-14px cards, 15px chat bubbles, 18px composer,
  999px pills and avatars.
- Borders are 1px soft (`line-soft` on dark grounds). Approvals add a 3px
  amber left edge; errors a red edge.
- Elevation is flat with one soft shadow: composer and floating cards only.
  Headers are glassy (`backdrop-filter: blur`) rather than shadowed.
- Avatars are initial-based gradients (stable hash of the name), so agents are
  distinguishable with no image pipeline.

## Layout

- Desktop: 296px sidebar (brand, connection, search, agent list, host card)
  + flexible thread column capped at 800px + floating composer.
- Thread: user right (filled bubble), agent left (surface card with ✦ mark),
  system full-width dashed, tool calls as collapsible mono blocks.
- Approvals are pinned above the thread, horizontally scrollable, always with
  Approve (mint) + Deny (ghost) side by side.
- Mobile: same information hierarchy in a stacked list; approvals are full
  cards with Grant/Deny; the thread mirrors the desktop bubble alignment.
- Website: same tokens; the product mock in `#can` is a static preview of
  this exact layout.

## Libraries (deliberately few)

- Desktop: React + plain CSS. No component framework, no markdown renderer
  yet: transcript text renders with `pre-wrap` so untrusted model output can
  never become markup. Rich rendering (markdown, tables, canvas) belongs
  behind a sanitizer in a later pass.
- Mobile: React Native core components only. No new native dependencies.
- Website: vanilla HTML/CSS/JS, no build step; the page must stay readable
  as source.

## What is intentionally not in this pass

Light mode, custom fonts, message editing, markdown tables, syntax
highlighting, drag-and-drop attachments and voice UI. Each would widen the
security surface (markup injection, file intake, microphone) and each gets
its own proposal.
