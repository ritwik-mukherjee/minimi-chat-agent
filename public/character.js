// The status figure: a small inline SVG whose pose follows the agent's state.
// app.js decides the state from server events; this file only draws it.
// It is optional: deleting it removes the figure and nothing else.

const STATES = ["idle", "recalling", "searching", "comparing", "unsure"];

// Every prop is in the SVG; style.css shows the ones that belong to the current state.
const FIGURE_SVG = `
<svg viewBox="0 0 48 48" width="40" height="40" role="img" data-state="idle">
  <title></title>
  <g class="body">
    <circle class="head" cx="24" cy="24" r="12"/>
    <circle class="eye" cx="20" cy="22" r="1.5"/>
    <circle class="eye" cx="28" cy="22" r="1.5"/>
    <path class="mouth mouth-smile" d="M19 28 Q24 32 29 28"/>
    <path class="mouth mouth-flat" d="M20 29 H28"/>
    <path class="mouth mouth-wavy" d="M19 29 Q21.5 26.5 24 29 T29 29"/>
  </g>
  <g class="prop prop-recalling">
    <rect x="31" y="27" width="13" height="16" rx="2"/>
    <path d="M34 32 H41 M34 36 H41 M34 40 H38"/>
  </g>
  <g class="prop prop-searching">
    <circle cx="36" cy="14" r="6"/>
    <path d="M32 18 L26 24"/>
  </g>
  <g class="prop prop-comparing">
    <path d="M6 10 H42 M24 10 V16"/>
    <rect x="4" y="12" width="10" height="7" rx="1.5"/>
    <rect x="34" y="12" width="10" height="7" rx="1.5"/>
  </g>
  <g class="prop prop-unsure">
    <path d="M20 9 Q20 3 25 3 Q30 3 30 7 Q30 10 25 12 V14"/>
    <circle cx="25" cy="18" r="1"/>
  </g>
</svg>`;

// state is one of STATES; caption is the text shown next to the figure (it is also its accessible name).
export function setState(state, caption) {
  const container = document.getElementById("character");
  if (!container) return;
  if (!container.firstElementChild) container.innerHTML = FIGURE_SVG;

  const svg = container.firstElementChild;
  svg.dataset.state = STATES.includes(state) ? state : "idle";
  svg.querySelector("title").textContent = caption || "Idle";
}

// Draw the resting pose as soon as the module loads.
setState("idle", "");
