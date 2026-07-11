# City Intuition — UX Ethos

Status: v1, adopted 2026-07-05 · Owner: Sia / City Intuition Lab

The product bet: **people who know their city don't need directions — they need awareness.**
Every UX decision traces back to that. When a feature idea shows up, test it against these.

## 1. Glance, don't operate

The map should answer "where is the city hot right now?" in under three seconds, from across
the room. If a screen needs instructions, tapping-through, or reading a legend to be useful,
it has failed. Color, position, and pulse carry the information; text is confirmation.

## 2. Corridors, not turns

We never say "turn left on Pine." We say "the north corridor is calmer than downtown."
The user is the navigator; we are the sense. Anything that drifts toward turn-by-turn —
lane arrows, ETA countdowns, rerouting prompts — is out of scope by identity, not by budget.

## 3. Human sentences, present tense

Guidance reads like a friend who just walked through: "Stadium letting out", "Brush fire near
Sylvan Way". Never "EVENT_EGRESS_ACTIVE", never jargon, never a severity code. If a sentence
wouldn't be said out loud, it doesn't ship.

## 4. Living things pulse; dead things leave

Async state is communicated by animated color, not words: the status dot pulses green when
feeds are live, amber while connecting, holds red when unreachable. On the map, everything
breathes while it's true and expires when it isn't — `expiresAt` is a UX principle, not just
a schema field. Nothing haunts the map; stale data is worse than no data, except during an
outage, where "last known, aging out" beats a blank map (and says so).

## 5. Honest by construction

The UI never dresses mock data as real. Live sources say live; demo layers say mock; when a
real adapter covers a signal type, the mock version of that type disappears rather than
mingling. Confidence is part of the data model (official feed ≠ social rumor) and will be
part of the rendering: uncertain signals look uncertain.

## 6. The personal layer belongs to the person

Avoid/prefer zones are the user's private read of their own city — stored client-side,
overlaid at scoring time, never uploaded, never inferred, never a "signal". The city layer
is shared truth; the personal layer is theirs. Blurring that line breaks the product's trust
contract.

## 7. The companion asks, never nags

The AI-companion posture is one good question — "Where are we going?" — with an easy dismiss
that's never punished (no re-prompts, no guilt copy; a quiet "Where to?" affordance remains for
when the user changes their mind). Answering focuses the read on the user's actual corridor;
dismissing returns to ambient awareness. The companion never interrupts twice, never asks for
data it doesn't need, and its answers stay deterministic sentences built from the map — a
personality layer over real signals, not an oracle.

## 8. Calm is a feature

This app is anti-doomscroll. No push alerts for every siren, no incident feed to refresh,
no red badges. Severity tiers exist so that minor noise (an aid response) renders faint and
major disruption (a structure fire) renders loud. The default emotional state of the app is
"you're fine — here's the one thing worth knowing."

---

Mechanical corollaries: interaction affordances stay big enough for a glance-and-tap (compact
pins grow labels on hover/focus, never permanent clutter); accessibility mirrors the visual
channel (every zone carries its sentence as an `aria-label`); and rendering stays separated
from domain scoring so the ethos survives the MapLibre migration.
