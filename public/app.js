// The page draws only from events sent by the server. It never parses answer text to work out state.

const conversationId = crypto.randomUUID(); // a reload starts a new conversation
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const messagesEl = document.getElementById("messages");
const emptyHint = document.getElementById("empty-hint");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
const sendButton = document.getElementById("send");
const statusEl = document.getElementById("status");
const banner = document.getElementById("key-banner");
const toggleSaved = document.getElementById("toggle-saved");
const savedPanel = document.getElementById("saved-panel");
const savedList = document.getElementById("saved-list");
const clearSaved = document.getElementById("clear-saved");

// The status figure is optional: if character.js is missing, the page works without it.
const character = await import("./character.js").catch(() => null);
let figureIsUnsure = false;

function setFigure(state, caption) {
  if (character && typeof character.setState === "function") character.setState(state, caption);
}

function setStatus(text, figureState) {
  statusEl.textContent = text;
  if (figureState) {
    figureIsUnsure = figureState === "unsure";
    setFigure(figureState, text);
  }
}

// ---- Startup ----

async function checkKey() {
  try {
    const status = await (await fetch("/api/status")).json();
    if (!status.apiKey) {
      banner.textContent = "ANTHROPIC_API_KEY is not set. Add it to .env and restart `npm run dev`.";
      banner.hidden = false;
    }
  } catch {
    // The server is unreachable; sending a message will show that.
  }
}

// ---- Rendering one turn ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Only http and https links are shown as links.
function safeUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function sourceList(sources) {
  const list = el("ul", "sources");
  for (const source of sources) {
    const url = safeUrl(source.url);
    if (!url) continue;
    const item = el("li");
    const link = el("a", "", source.title || url.href);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    item.append(link, el("span", "host", ` (${url.hostname})`));
    list.append(item);
  }
  return list;
}

// ---- Answer text: a small, safe markdown renderer ----
// It builds elements with textContent only, so answer text can never become HTML.
// It handles headings, bullet and numbered lists, **bold**, *italic*, `code` and [text](http link).

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function inline(parent, text) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) {
      parent.append(el("code", "", token.slice(1, -1)));
    } else if (match[2]) {
      const strong = el("strong");
      inline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (match[3]) {
      parent.append(el("em", "", token.slice(1, -1)));
    } else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const url = safeUrl(href);
      if (url) {
        const link = el("a", "", label);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else {
        parent.append(label);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(container, text) {
  const blocks = [];
  let paragraph = null;
  let list = null;

  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*\u2022]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);

    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        list = { tag, items: [] };
        blocks.push(list);
      }
      list.items.push((bullet ?? numbered)[1]);
      paragraph = null;
    } else if (heading) {
      blocks.push({ tag: "h4", text: heading[1] });
      paragraph = null;
      list = null;
    } else if (line.trim() === "") {
      paragraph = null;
      list = null;
    } else {
      list = null;
      if (!paragraph) {
        paragraph = { tag: "p", lines: [] };
        blocks.push(paragraph);
      }
      paragraph.lines.push(line.trim());
    }
  }

  const nodes = blocks.map((block) => {
    const node = el(block.tag);
    if (block.items) {
      for (const item of block.items) {
        const li = el("li");
        inline(li, item);
        node.append(li);
      }
    } else if (block.lines) {
      block.lines.forEach((line, i) => {
        if (i > 0) node.append(el("br"));
        inline(node, line);
      });
    } else {
      inline(node, block.text);
    }
    return node;
  });
  container.replaceChildren(...nodes);
}

// The elements of one assistant reply, and what the details area needs to know.
function newReply() {
  const root = el("article", "message assistant");
  root.setAttribute("aria-label", "Answer");
  const recalledSlot = el("div");
  const answer = el("div", "answer");
  const sourcesSlot = el("div");
  const problemsSlot = el("div");
  const details = el("details", "turn-details");
  details.append(el("summary", "", "Details"));
  const detailsList = el("ul");
  details.append(detailsList);
  details.hidden = true;
  root.append(recalledSlot, answer, sourcesSlot, problemsSlot, details);
  return { root, recalledSlot, answer, rawText: "", sourcesSlot, problemsSlot, details, detailsList, queries: [], routed: null };
}

function renderRecalled(reply, event) {
  const card = el("div", "recalled-card");
  const heading = event.kind === "near"
    ? `Nothing on ${event.askedFor}; using ${event.used}`
    : event.askedFor ? `Saved from ${event.askedFor}` : "Saved earlier";
  card.append(el("h3", "", heading));
  const list = el("ul");
  for (const turn of event.turns) {
    const item = el("li");
    item.append(el("strong", "", turn.question));
    item.append(el("div", "excerpt", `${turn.label}: ${turn.answerExcerpt}`));
    list.append(item);
  }
  card.append(list);
  if (event.omitted > 0) card.append(el("div", "excerpt", `${event.omitted} more saved turn(s) not shown.`));
  reply.recalledSlot.replaceChildren(card);
}

function renderDetails(reply, done) {
  const lines = [];
  if (reply.routed) {
    lines.push(`Model: ${reply.routed.displayName ?? "none (written by code)"}`);
    lines.push(`Reason: ${reply.routed.reason}`);
  }
  lines.push(`Searches: ${done.searchCount}`);
  for (const query of reply.queries) lines.push(`  searched: ${query}`);
  const ms = (value) => (value === null ? "none" : `${value} ms`);
  lines.push(`Time to first event: ${ms(done.msFirstEvent)}`);
  lines.push(`Time to first text: ${ms(done.msFirstText)}`);
  lines.push(`Total time: ${ms(done.msTotal)}`);
  reply.detailsList.replaceChildren(...lines.map((line) => el("li", "", line)));
  reply.details.hidden = false;
}

// One function turns an event into a page change.
function render(reply, event) {
  switch (event.type) {
    case "recalled":
      renderRecalled(reply, event);
      if (event.kind === "near") {
        setStatus(`Nothing on ${event.askedFor}; found your question from ${event.used}`, "recalling");
      } else {
        setStatus(event.askedFor ? `Found your question from ${event.askedFor}` : "Found your earlier questions", "recalling");
      }
      break;
    case "no_record":
      setStatus(event.askedFor ? `Nothing saved for ${event.askedFor}` : "Nothing saved that matches", "unsure");
      break;
    case "routed":
      reply.routed = event;
      setStatus(
        event.model ? `Answering with ${event.displayName}` : "Nothing to search",
        event.reason === "compare" ? "comparing" : undefined,
      );
      break;
    case "searching":
      reply.queries.push(event.query);
      setStatus(`Searching: ${event.query}`, "searching");
      break;
    case "text":
      reply.rawText += event.delta;
      renderMarkdown(reply.answer, reply.rawText);
      break;
    case "sources":
      reply.sourcesSlot.replaceChildren(sourceList(event.sources));
      break;
    case "problem": {
      const box = el("div", event.code === "incomplete" ? "problem" : "problem fatal");
      box.append(el("strong", "", event.message));
      if (event.fix) box.append(el("span", "", ` ${event.fix}`));
      reply.problemsSlot.append(box);
      setStatus(event.message, "unsure");
      break;
    }
    case "done":
      renderDetails(reply, event);
      setStatus("");
      setFigure(figureIsUnsure ? "unsure" : "idle", "");
      if (!savedPanel.hidden) loadSaved();
      break;
  }
}

// ---- Sending ----

function scrollToEnd() {
  window.scrollTo({ top: document.body.scrollHeight });
}

// Reads the response as a stream of blank-line-separated "data:" frames.
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
      }
    }
  }
}

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
  if (!busy) input.focus();
}

async function send(message) {
  emptyHint?.remove();
  setBusy(true);
  figureIsUnsure = false;
  setFigure("idle", "");

  messagesEl.append(el("div", "message user", message));
  const reply = newReply();
  messagesEl.append(reply.root);
  scrollToEnd();

  let finished = false;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId, timeZone }),
    });
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    await readEvents(response, (event) => {
      if (event.type === "done") finished = true;
      render(reply, event);
      scrollToEnd();
    });
  } catch (error) {
    const box = el("div", "problem fatal");
    box.append(el("strong", "", "The request failed."), el("span", "", ` ${error.message} Try again.`));
    reply.problemsSlot.append(box);
  }
  if (!finished) setStatus("");
  setBusy(false);
}

form.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const message = input.value.trim();
  if (message === "" || input.disabled) return;
  input.value = "";
  input.style.height = "";
  send(message);
});

// The example questions on the empty page send themselves.
for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    if (input.disabled) return;
    input.value = chip.textContent;
    form.requestSubmit();
  });
}

// Enter sends; Shift+Enter adds a line.
input.addEventListener("keydown", (keyEvent) => {
  if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
    keyEvent.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
});

// ---- Saved-turns panel ----

async function loadSaved() {
  let data;
  try {
    data = await (await fetch("/api/turns")).json();
  } catch {
    savedList.replaceChildren(el("p", "hint", "Could not load saved turns."));
    return;
  }
  if (data.days.length === 0) {
    savedList.replaceChildren(el("p", "hint", "Nothing is saved yet."));
    return;
  }
  const days = data.days.map((day) => {
    const section = el("section", "saved-day");
    section.append(el("h3", "", day.label));
    for (const turn of day.turns) {
      const item = el("div", "saved-turn");
      item.append(el("div", "q", turn.question));
      if (turn.status !== "complete") item.append(el("span", "incomplete", "incomplete "));
      if (turn.answer) item.append(el("div", "a", turn.answer));
      const sources = sourceList(turn.sources);
      if (sources.children.length > 0) item.append(sources);
      const time = new Date(turn.createdAtUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      item.append(el("div", "meta", `${time}${turn.model ? ` · ${turn.model}` : " · written by code"}`));
      section.append(item);
    }
    return section;
  });
  savedList.replaceChildren(...days);
}

toggleSaved.addEventListener("click", () => {
  const opening = savedPanel.hidden;
  savedPanel.hidden = !opening;
  toggleSaved.setAttribute("aria-expanded", String(opening));
  if (opening) loadSaved();
});

clearSaved.addEventListener("click", async () => {
  if (!confirm("Delete every saved turn? This cannot be undone.")) return;
  await fetch("/api/turns", { method: "DELETE" });
  loadSaved();
});

checkKey();
