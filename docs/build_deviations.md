# Build deviations

| Phase | File | What the plan said | What was done | Why |
| --- | --- | --- | --- | --- |
| 8 | `docs/designs/chat_agent_dated_memory_design.md` (file 38) | The local-path check is `grep -rn "/Users/" docs README.md DESIGN.md` and must print nothing | Reworded that line of the design doc to `grep -rn "<local home path>" ...` | The design doc quoted the command itself, so the check matched its own text. No behaviour changed |
| Post-build | `public/character.js` (file 34), `public/index.html`, `public/style.css` | A small inline SVG figure with five poses, no dependencies | A 3D cat built from plain shapes with three.js 0.160.0, imported from the jsDelivr CDN at run time (no npm dependency, no build step). It also appears large on the empty page. The SVG figure is kept as the fallback if three.js or WebGL is unavailable | Requested by the author for a better-looking page. The rule of no other dependencies is kept in `package.json`; the page now needs internet to show the 3D cat, which it already needs to answer |
