// The status figure: a small cat whose pose follows the agent's state.
// app.js decides the state from server events; this file only draws it.
//
// It is optional. Deleting this file removes the cat and nothing else.
// The cat is a 3D model built from plain shapes with three.js, loaded from a CDN with no build step.
// If three.js cannot load, or WebGL is missing, a flat SVG cat is drawn instead.

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const STATES = ["idle", "recalling", "searching", "comparing", "unsure"];

// ---- The 3D cat ----

const COLORS = { cream: 0xfff1dc, patch: 0xe9a46a, pink: 0xeaa3a8, dark: 0x2b2420 };
const SMOOTHING = 0.08; // how fast the pose moves toward its target, per frame
const TAIL_SEGMENTS = 22;

function createCat(THREE, mount) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 1.0, 7.8);
  camera.lookAt(0, 0.85, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xf0e2d0, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 5, 5);
  scene.add(sun);

  const material = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const ball = (radius, color, scale = [1, 1, 1]) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), material(color));
    mesh.scale.set(...scale);
    return mesh;
  };

  const cat = new THREE.Group();
  scene.add(cat);

  // Body, front paws and tail
  const body = ball(1, COLORS.cream, [0.85, 0.95, 0.78]);
  body.position.set(0, 0.2, 0);
  cat.add(body);
  for (const side of [-1, 1]) {
    const paw = ball(0.3, COLORS.cream, [0.8, 0.9, 1.1]);
    paw.position.set(side * 0.3, -0.6, 0.6);
    cat.add(paw);
  }
  const tail = [];
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const segment = ball(0.15, i > TAIL_SEGMENTS - 6 ? COLORS.patch : COLORS.cream);
    cat.add(segment);
    tail.push(segment);
  }

  // Head with ears, patch, face and whiskers
  const head = new THREE.Group();
  head.position.set(0, 1.5, 0.1);
  cat.add(head);
  head.add(ball(0.85, COLORS.cream, [1.1, 0.95, 1]));

  const patch = new THREE.Mesh(
    new THREE.SphereGeometry(0.86, 24, 16, Math.PI * 0.55, Math.PI * 0.8, 0.25, 1.0),
    material(COLORS.patch),
  );
  patch.scale.set(1.1, 0.95, 1);
  head.add(patch);

  const ears = [];
  for (const side of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(side * 0.58, 0.72, -0.02);
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.6, 4), material(COLORS.cream));
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.38, 4), material(COLORS.pink));
    inner.position.set(0, -0.04, 0.1);
    outer.rotation.y = Math.PI / 4;
    inner.rotation.y = Math.PI / 4;
    ear.add(outer, inner);
    head.add(ear);
    ears.push({ ear, side });
  }

  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = ball(0.1, COLORS.dark, [1, 1.25, 0.6]);
    eye.position.set(side * 0.34, 0.06, 0.78);
    head.add(eye);
    eyes.push(eye);
    const glint = ball(0.025, 0xffffff);
    glint.position.set(side * 0.34 + 0.03, 0.12, 0.835);
    head.add(glint);
  }
  const nose = ball(0.06, COLORS.pink, [1.2, 0.8, 0.8]);
  nose.position.set(0, -0.12, 0.85);
  head.add(nose);
  for (const side of [-1, 1]) {
    for (const tilt of [-0.15, 0, 0.15]) {
      const whisker = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.55, 6), material(COLORS.dark));
      whisker.rotation.z = Math.PI / 2 + tilt * side;
      whisker.position.set(side * 0.7, -0.2 + tilt * 0.4, 0.7);
      head.add(whisker);
    }
  }

  // ---- Poses ----
  // Each state names a target for the head and ears; every frame the pose moves a little toward it.
  const pose = { lookY: 0, nod: 0, tilt: 0, earSplay: 0, tailSpeed: 1, tailAmp: 0.35 };
  const pointer = { x: 0, y: 0 };
  let state = "idle";
  let reduceMotion = false;

  function targetFor(time) {
    switch (state) {
      case "recalling": return { lookY: 0.15, nod: -0.3, tilt: 0.12, earSplay: -0.12, tailSpeed: 1.2, tailAmp: 0.3 };
      case "searching": return { lookY: Math.sin(time * 2.4) * 0.6, nod: 0.05, tilt: 0, earSplay: -0.05, tailSpeed: 3, tailAmp: 0.5 };
      case "comparing": return { lookY: 0, nod: 0, tilt: Math.sin(time * 1.5) * 0.32, earSplay: 0, tailSpeed: 1.5, tailAmp: 0.4 };
      case "unsure": return { lookY: -0.15, nod: 0.12, tilt: 0.38, earSplay: 0.4, tailSpeed: 0.6, tailAmp: 0.12 };
      default: return { lookY: pointer.x * 0.5, nod: -pointer.y * 0.3, tilt: 0, earSplay: 0, tailSpeed: 1, tailAmp: 0.35 };
    }
  }

  function update(time, smoothing) {
    const target = targetFor(time);
    for (const key of Object.keys(pose)) pose[key] += (target[key] - pose[key]) * smoothing;

    const breath = reduceMotion ? 0 : Math.sin(time * 1.8) * 0.015;
    body.scale.set(0.85, 0.95 + breath, 0.78);
    head.position.y = 1.5 + breath * 1.5;
    head.rotation.set(pose.nod, pose.lookY, pose.tilt);
    for (const { ear, side } of ears) ear.rotation.z = -side * (0.25 + pose.earSplay);

    // Blink every few seconds; on a still frame the eyes stay open.
    const blinking = !reduceMotion && time % 4 < 0.12;
    for (const eye of eyes) eye.scale.y = blinking ? 0.12 : 1.25;

    tail.forEach((segment, i) => {
      const t = i / (TAIL_SEGMENTS - 1);
      const sway = reduceMotion ? 0 : Math.sin(time * 1.6 * pose.tailSpeed - t * 1.6) * pose.tailAmp * t;
      segment.position.set(0.7 + 0.6 * Math.sin(t * 2.0) + sway, -0.55 + 1.9 * t, -0.35);
    });
  }

  // ---- Placing and drawing ----
  function resize() {
    const box = renderer.domElement.parentElement;
    if (!box || box.clientWidth === 0 || box.clientHeight === 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(box.clientWidth, box.clientHeight, false);
    camera.aspect = box.clientWidth / box.clientHeight;
    camera.updateProjectionMatrix();
  }

  // The cat sits on the empty page and moves next to the status line once the conversation starts.
  function place() {
    const hero = document.getElementById("hero-cat");
    const home = hero?.isConnected ? hero : mount;
    if (renderer.domElement.parentElement !== home) {
      home.append(renderer.domElement);
      resize();
    }
  }

  const canvas = renderer.domElement;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduceMotion = motion.matches;

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / 400));
    pointer.y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / 400));
  });

  const clock = { start: performance.now() };
  function frame() {
    if (!document.hidden) {
      place();
      update((performance.now() - clock.start) / 1000, reduceMotion ? 1 : SMOOTHING);
      renderer.render(scene, camera);
    }
    if (!reduceMotion) requestAnimationFrame(frame);
  }
  frame();

  return {
    setState(next) {
      state = next;
      if (reduceMotion) frame(); // one still frame per state change
    },
  };
}

// ---- The flat fallback ----

// Every prop is in the SVG; style.css shows the ones that belong to the current state.
const FIGURE_SVG = `
<svg viewBox="0 0 48 48" width="40" height="40" role="img" data-state="idle">
  <title></title>
  <g class="body">
    <path class="ear" d="M13 18 L14 7 L22 13 Z M35 18 L34 7 L26 13 Z"/>
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

function drawFlatFigure(container, state, caption) {
  if (!container.firstElementChild) container.innerHTML = FIGURE_SVG;
  const svg = container.firstElementChild;
  svg.dataset.state = state;
  svg.querySelector("title").textContent = caption || "Idle";
}

// ---- Public: setState(state, caption) ----

const container = document.getElementById("character");
const three = await import(THREE_URL).catch(() => null);

let cat = null;
if (three && container) {
  try {
    cat = createCat(three, container);
  } catch {
    cat = null; // no WebGL: use the flat figure
  }
}

// state is one of STATES; caption is the text shown next to the figure (it is also the flat figure's accessible name).
export function setState(state, caption) {
  const known = STATES.includes(state) ? state : "idle";
  if (cat) cat.setState(known);
  else if (container) drawFlatFigure(container, known, caption);
}

setState("idle", "");
