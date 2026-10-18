/* =========================================================================
   HustleCraft — app.js
   Particle canvas · tabs · SSE streaming typewriter · traces · history ·
   floating deal coach · Hacktoberfest drawer.
   ========================================================================= */
(function () {
"use strict";

/* ------------------------------------------------------------------ utils */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const COLORS = {
  violet: "#a78bfa",
  cyan: "#22d3ee",
  lime: "#a3e635",
  amber: "#fbbf24",
  green: "#4ade80",
  rose: "#fb7185",
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function formatMs(ms) {
  const n = Number(ms) || 0;
  if (n >= 1000) return (n / 1000).toFixed(2) + "s";
  return Math.round(n) + "ms";
}

function formatNum(n) {
  return (Number(n) || 0).toLocaleString("en-US");
}

function uid(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function debounce(fn, wait) {
  let t;
  return function () {
    const args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(ctx, args), wait);
  };
}

/* ------------------------------------------------------------------ toasts */
const toastStack = $("#toast-stack");

function toast(title, message, kind, duration) {
  if (!toastStack) return;
  kind = kind || "info";
  const dur = duration || 3200;
  const icons = { success: "✅", error: "⚠️", info: "💡" };

  const el = document.createElement("div");
  el.className = "toast toast--" + kind;
  el.innerHTML =
    '<span class="toast-ico">' + (icons[kind] || icons.info) + "</span>" +
    '<div class="toast-body"><div class="toast-title">' + escapeHtml(title) + "</div>" +
    (message ? '<div class="toast-msg">' + escapeHtml(message) + "</div>" : "") +
    "</div>" +
    '<span class="toast-bar" style="animation-duration:' + dur + 'ms"></span>';

  toastStack.appendChild(el);
  const kill = () => {
    if (!el.isConnected) return;
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 340);
  };
  const timer = setTimeout(kill, dur);
  el.addEventListener("click", () => { clearTimeout(timer); kill(); });
  while (toastStack.children.length > 4) toastStack.firstElementChild.remove();
}

/* ---------------------------------------------------------- markdown render */
function inlineMd(text) {
  let t = text;
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!/^(https?:|mailto:|\/|#)/i.test(url)) return label;
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
  });
  return t;
}

function renderMarkdown(src, caret) {
  const esc = escapeHtml(src || "");
  const lines = esc.split("\n");
  const out = [];
  let para = [];
  let list = null;
  let code = false;
  let codeBuf = [];

  const flushPara = () => { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };
  const closeList = () => { if (list) { out.push(list === "ul" ? "</ul>" : "</ol>"); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");

    if (/^```/.test(line.trim())) {
      if (code) { out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>"); codeBuf = []; code = false; }
      else { flushPara(); closeList(); code = true; }
      continue;
    }
    if (code) { codeBuf.push(line); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lvl = Math.min(h[1].length, 4);
      out.push("<h" + lvl + ">" + inlineMd(h[2]) + "</h" + lvl + ">");
      continue;
    }
    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }

    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) { flushPara(); closeList(); out.push("<blockquote>" + inlineMd(bq[1]) + "</blockquote>"); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inlineMd(ul[1]) + "</li>");
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inlineMd(ol[1]) + "</li>");
      continue;
    }
    closeList();
    para.push(inlineMd(line));
  }
  if (code && codeBuf.length) out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>");
  flushPara(); closeList();

  let html = out.join("");
  if (caret) html += '<span class="stream-caret"></span>';
  return html;
}

/* -------------------------------------------------------- stream typewriter */
function createPrinter(onRender, baseSpeed) {
  const speed = baseSpeed || 7;
  let queue = "";
  let shown = "";
  let raf = 0;
  let running = false;
  let pace = speed;

  function step() {
    if (queue.length) {
      const n = Math.min(queue.length, Math.max(2, Math.floor(queue.length / 9) + pace));
      shown += queue.slice(0, n);
      queue = queue.slice(n);
      onRender(shown, true);
      raf = requestAnimationFrame(step);
    } else if (running) {
      onRender(shown, true);
      raf = requestAnimationFrame(step);
    } else {
      onRender(shown, false);
      raf = 0;
    }
  }
  function kick() {
    if (raf) return;
    raf = requestAnimationFrame(step);
  }
  return {
    push(chunk) { if (!chunk) return; queue += chunk; kick(); },
    end() { running = false; pace = speed * 2.5; kick(); },
    reset() {
      queue = ""; shown = ""; running = false; pace = speed;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    start() { if (!running) { running = true; kick(); } },
    text() { return shown; },
    idle() { return !queue.length; },
  };
}

/* ------------------------------------------------------------- SSE consumer */
async function streamGenerate(payload, handlers) {
  const h = handlers || {};
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* noop */ }
    throw new Error(msg);
  }
  if (!res.body || !res.body.getReader) throw new Error("Streaming is not supported by this browser.");

  const dispatch = (block) => {
    block.split("\n").forEach((line) => {
      if (line.indexOf("data:") !== 0) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") return;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      if (h.onEvent) h.onEvent(obj);
    });
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let separated = false;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) { separated = true; dispatch(block); }
    }
  }
  if (buf.trim()) dispatch(buf);
  return separated;
}

/* ---------------------------------------------------------------- clipboard */
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function flashCopied(btn) {
  if (!btn) return;
  btn.classList.add("is-copied");
  setTimeout(() => btn.classList.remove("is-copied"), 1500);
}

/* -------------------------------------------------------------- animations */
function animateNumber(el, to, opts) {
  if (!el) return;
  const o = opts || {};
  const from = Number(el.dataset.val || 0);
  const dur = o.dur || 750;
  const prefix = o.prefix || "";
  const suffix = o.suffix || "";
  el.dataset.val = String(to);
  if (reducedMotion) {
    el.textContent = prefix + (o.raw ? to : formatNum(to)) + suffix;
    return;
  }
  el.classList.remove("is-bump");
  void el.offsetWidth;
  el.classList.add("is-bump");
  const start = performance.now();
  const tick = (now) => {
    const p = clamp((now - start) / dur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    const v = from + (to - from) * e;
    el.textContent = prefix + (o.decimals ? v.toFixed(o.decimals) : formatNum(Math.round(v))) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function countUp(el) {
  const target = Number(el.dataset.count || 0);
  const suffix = el.dataset.suffix || "";
  animateNumber(el, target, { suffix: suffix, dur: 1100, raw: suffix === "%" });
}

/* ------------------------------------------------------------ global state */
const state = {
  mode: "proposal",
  provider: "local",
  model: "detecting…",
  history: [],
  traces: [],
  proposalSavedId: null,
  adSavedId: null,
  chatBusy: false,
  lastHealth: null,
};

/* ============================================================= PARTICLES */
function initParticles() {
  const canvas = $("#particle-canvas");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const palette = ["rgba(167,139,250,", "rgba(34,211,238,", "rgba(163,230,53,", "rgba(251,191,36,"];
  let w = 0, h = 0, parts = [], raf = 0;
  const pointer = { x: -9999, y: -9999, tx: -9999, ty: -9999, active: false };

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }

  function make() {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.36,
      vy: (Math.random() - 0.5) * 0.36,
      s: Math.random() < 0.22 ? 3 : Math.random() < 0.55 ? 2 : 1.5,
      c: palette[(Math.random() * palette.length) | 0],
      a: 0.2 + Math.random() * 0.5,
      glow: 0,
    };
  }

  function build() {
    const count = clamp(Math.round((w * h) / 15000), 34, 150);
    parts = [];
    for (let i = 0; i < count; i++) parts.push(make());
  }

  function drawFrame() {
    ctx.clearRect(0, 0, w, h);

    pointer.x += (pointer.tx - pointer.x) * 0.16;
    pointer.y += (pointer.ty - pointer.y) * 0.16;

    const radius = 130;
    const r2 = radius * radius;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx += (Math.random() - 0.5) * 0.014;
      p.vy += (Math.random() - 0.5) * 0.014;
      p.vx *= 0.994;
      p.vy *= 0.994;

      if (pointer.active) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2 && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const force = (1 - d / radius) * 0.75;
          p.vx += (dx / d) * force;
          p.vy += (dy / d) * force;
          p.glow = 1;
        }
      }
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 2.4) { p.vx *= 2.4 / sp; p.vy *= 2.4 / sp; }
      p.glow = p.glow > 0 ? Math.max(0, p.glow - 0.022) : 0;

      if (p.x < -12) p.x = w + 12;
      else if (p.x > w + 12) p.x = -12;
      if (p.y < -12) p.y = h + 12;
      else if (p.y > h + 12) p.y = -12;
    }

    /* connective threads near the cursor */
    if (pointer.active) {
      ctx.lineWidth = 1;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const a = (1 - Math.sqrt(d2) / radius) * 0.32;
        ctx.strokeStyle = "rgba(167,139,250," + a.toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(pointer.x, pointer.y);
        ctx.stroke();
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const alpha = clamp(p.a + p.glow * 0.5, 0, 1);
      ctx.fillStyle = p.c + alpha.toFixed(3) + ")";
      const s = p.s + p.glow * 1.6;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      if (p.glow > 0.35) {
        ctx.fillStyle = "rgba(255,255,255," + (p.glow * 0.35).toFixed(3) + ")";
        ctx.fillRect(p.x - s / 4, p.y - s / 4, s / 2, s / 2);
      }
    }
    raf = requestAnimationFrame(drawFrame);
  }

  function drawStatic() {
    ctx.clearRect(0, 0, w, h);
    parts.forEach((p) => {
      ctx.fillStyle = p.c + p.a.toFixed(3) + ")";
      ctx.fillRect(p.x, p.y, p.s, p.s);
    });
  }

  window.addEventListener("pointermove", (e) => {
    pointer.tx = e.clientX;
    pointer.ty = e.clientY;
    if (!pointer.active) {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
    }
  }, { passive: true });

  document.addEventListener("pointerleave", () => { pointer.active = false; });
  window.addEventListener("blur", () => { pointer.active = false; });
  window.addEventListener("resize", debounce(() => { size(); if (reducedMotion) drawStatic(); }, 180));

  document.addEventListener("visibilitychange", () => {
    if (reducedMotion) return;
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) raf = requestAnimationFrame(drawFrame);
  });

  size();
  if (reducedMotion) drawStatic();
  else raf = requestAnimationFrame(drawFrame);
}

/* ================================================== spotlight / tilt / stats */
function bindSpotlights() {
  $$(".spotlight, .copy-card").forEach((el) => {
    if (el.dataset.spotlight) return;
    el.dataset.spotlight = "1";
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", (((e.clientX - r.left) / r.width) * 100).toFixed(2) + "%");
      el.style.setProperty("--my", (((e.clientY - r.top) / r.height) * 100).toFixed(2) + "%");
    }, { passive: true });
  });
}

function bindTilt() {
  if (reducedMotion) return;
  $$(".tilt").forEach((el) => {
    if (el.dataset.tilt) return;
    el.dataset.tilt = "1";
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform =
        "perspective(1400px) rotateX(" + (-py * 1.6).toFixed(2) + "deg) rotateY(" +
        (px * 1.6).toFixed(2) + "deg) translateY(-2px)";
    }, { passive: true });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
}

function bindCounters() {
  const nodes = $$("[data-count]");
  if (!nodes.length) return;
  if (!("IntersectionObserver" in window)) { nodes.forEach(countUp); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      countUp(entry.target);
      io.unobserve(entry.target);
    });
  }, { threshold: 0.4 });
  nodes.forEach((n) => io.observe(n));
}

/* =================================================================== TABS */
function initTabs() {
  const tabs = $$(".tab");
  const indicator = $(".tab-indicator");

  function move() {
    const active = $(".tab.is-active");
    if (!active || !indicator) return;
    indicator.style.width = active.offsetWidth + "px";
    indicator.style.transform = "translateX(" + active.offsetLeft + "px)";
  }

  function activate(name) {
    state.mode = name;
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $$(".tab-panel").forEach((p) => {
      const on = p.dataset.panel === name;
      p.classList.toggle("is-active", on);
      if (on) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });
    move();
  }

  tabs.forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab)));
  window.addEventListener("resize", debounce(move, 120));
  document.fonts && document.fonts.ready && document.fonts.ready.then(move).catch(() => {});
  requestAnimationFrame(move);
  setTimeout(move, 320);

  return { activate, move };
}

/* ============================================================== SEGMENTED */
function initSegmented() {
  $$(".segmented").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg");
      if (!btn || !group.contains(btn)) return;
      $$(".seg", group).forEach((s) => {
        const on = s === btn;
        s.classList.toggle("is-active", on);
        s.setAttribute("aria-checked", on ? "true" : "false");
      });
    });
  });
}

function segmentedValue(id) {
  const active = $("#" + id + " .seg.is-active");
  return active ? active.dataset.value : "";
}

/* ====================================================== GENERATION ENGINE */
function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle("is-loading", loading);
  btn.disabled = loading;
}

function showSkeleton(el) { if (el) el.hidden = false; }
function hideSkeleton(el) { if (el) el.hidden = true; }

async function runStream(opts) {
  const t0 = performance.now();
  const events = [];
  let firstTokenAt = null;

  await streamGenerate({ mode: opts.mode, inputs: opts.inputs }, {
    onEvent(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === "meta" && ev.resolved) {
        state.provider = ev.provider || state.provider;
        state.model = ev.model || state.model;
        paintModel();
        events.push(ev);
      } else if (ev.type === "token") {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        if (opts.onToken) opts.onToken(ev.text || "");
      } else if (ev.type === "trace") {
        events.push(ev);
        if (opts.onTrace) opts.onTrace(ev, t0, firstTokenAt);
      } else if (ev.type === "error") {
        events.push(ev);
        if (opts.onError) opts.onError(ev);
      } else if (ev.type === "notice") {
        events.push(ev);
        if (opts.onNotice) opts.onNotice(ev);
        else toast("Heads up", ev.message || "", "info", 4200);
      } else if (ev.type === "done") {
        events.push(ev);
        if (opts.onDone) opts.onDone(ev, t0, firstTokenAt);
      }
    },
  });
  return events;
}

/* ======================================================== PROPOSAL TAB */
const proposal = {
  form: $("#proposal-form"),
  desc: $("#pc-desc"),
  descCount: $("#pc-desc-count"),
  budget: $("#pc-budget"),
  deadline: $("#pc-deadline"),
  skills: $("#pc-skills"),
  generate: $("#pc-generate"),
  skeleton: $("#proposal-skeleton"),
  empty: $("#proposal-empty"),
  doc: $("#proposal-output"),
  md: $("#proposal-md"),
  raw: $("#proposal-raw"),
  copy: $("#proposal-copy"),
  save: $("#proposal-save"),
  clear: $("#proposal-clear"),
  printer: null,
  rawText: "",
};

function proposalInputs() {
  return {
    description: proposal.desc ? proposal.desc.value : "",
    budget: proposal.budget ? proposal.budget.value : "",
    deadline: proposal.deadline ? proposal.deadline.value : "",
    skills: proposal.skills ? proposal.skills.value : "",
    experience: segmentedValue("pc-exp") || "intermediate",
  };
}

function proposalTitle(inputs) {
  const first = (inputs.description || "").trim().split("\n")[0].slice(0, 58);
  return first ? "Proposal — " + first : "Untitled proposal";
}

function resetProposalView() {
  proposal.rawText = "";
  if (proposal.printer) proposal.printer.reset();
  if (proposal.md) proposal.md.innerHTML = "";
  if (proposal.raw) proposal.raw.textContent = "";
}

async function generateProposal() {
  const inputs = proposalInputs();
  if (!inputs.description.trim()) {
    toast("Brief required", "Paste the client's job description first.", "error");
    if (proposal.desc) proposal.desc.focus();
    return;
  }

  state.proposalSavedId = null;
  resetProposalView();
  setLoading(proposal.generate, true);
  showSkeleton(proposal.skeleton);
  proposal.empty.hidden = true;
  proposal.doc.hidden = true;
  if (proposal.copy) proposal.copy.disabled = true;
  if (proposal.save) proposal.save.disabled = true;
  if (proposal.clear) proposal.clear.disabled = true;

  proposal.printer = createPrinter((text, streaming) => {
    proposal.rawText = text;
    if (proposal.md) proposal.md.innerHTML = renderMarkdown(text, streaming);
    if (proposal.raw && !proposal.raw.hidden) proposal.raw.textContent = text;
  }, 8);

  try {
    await runStream({
      mode: "proposal",
      inputs,
      onToken: (chunk) => proposal.printer.push(chunk),
      onTrace: (ev) => { pushTrace(ev); },
      onError: (ev) => toast("Model error", ev.message || "Upstream failure", "error"),
      onDone: (ev, t0, firstAt) => {
        proposal.printer.end();
        finishProposal(inputs, ev, t0, firstAt);
      },
    });
  } catch (err) {
    hideSkeleton(proposal.skeleton);
    proposal.empty.hidden = false;
    proposal.doc.hidden = true;
    toast("Generation failed", err && err.message ? err.message : "Is the server running?", "error");
  } finally {
    setLoading(proposal.generate, false);
    hideSkeleton(proposal.skeleton);
  }
}

function finishProposal(inputs, ev, t0, firstAt) {
  ev = ev || { status: "ok" };
  proposal.doc.hidden = false;
  proposal.empty.hidden = true;
  if (proposal.copy) proposal.copy.disabled = false;
  if (proposal.save) proposal.save.disabled = false;
  if (proposal.clear) proposal.clear.disabled = false;

  const clientMs = Math.round(performance.now() - t0);
  toast("Proposal ready", formatNum(clientMs) + "ms · " + (ev.status || "ok"), "success", 2800);

  if (ev.status !== "error") {
    const id = addHistory({
      mode: "proposal",
      title: proposalTitle(inputs),
      inputs,
      output: proposal.rawText,
    });
    state.proposalSavedId = id;
  }
}

function initProposal() {
  if (!proposal.form) return;

  proposal.form.addEventListener("submit", (e) => { e.preventDefault(); generateProposal(); });

  if (proposal.desc) {
    proposal.desc.addEventListener("input", () => {
      const n = proposal.desc.value.length;
      if (proposal.descCount) proposal.descCount.textContent = String(n);
      const meter = proposal.descCount && proposal.descCount.parentElement;
      if (meter) meter.classList.toggle("is-hot", n > 1800);
    });
  }

  $$("#skill-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const skill = chip.dataset.skill;
      const input = proposal.skills;
      if (!input) return;
      const parts = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      const idx = parts.findIndex((s) => s.toLowerCase() === skill.toLowerCase());
      if (idx >= 0) { parts.splice(idx, 1); chip.classList.remove("is-on"); }
      else { parts.push(skill); chip.classList.add("is-on"); }
      input.value = parts.join(", ");
    });
  });

  const demo = $("#proposal-demo");
  if (demo) {
    demo.addEventListener("click", () => {
      proposal.desc.value =
        "We're a 12-person DTC skincare brand. Our Shopify theme is slow (Lighthouse 42 on mobile) " +
        "and we need a senior developer to rebuild the storefront: custom product configurator, " +
        "Recharge subscription integration, Klaviyo flows, and a full speed overhaul. Timeline is 6 " +
        "weeks, budget around $4,000 - 6,000. Must work closely with our marketing lead.";
      if (proposal.budget) proposal.budget.value = "$4,000 – 6,000";
      if (proposal.deadline) proposal.deadline.value = "6 weeks";
      if (proposal.skills) {
        proposal.skills.value = "Shopify, Liquid, Performance, SEO";
        $$("#skill-chips .chip").forEach((c) => {
          c.classList.toggle("is-on", c.dataset.skill === "SEO");
        });
      }
      proposal.desc.dispatchEvent(new Event("input"));
      toast("Sample loaded", "Hit generate to see a full proposal.", "info");
    });
  }

  $$("#panel-proposal .otab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("#panel-proposal .otab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const raw = tab.dataset.view === "raw";
      if (proposal.md) proposal.md.hidden = raw;
      if (proposal.raw) {
        proposal.raw.hidden = !raw;
        if (raw) proposal.raw.textContent = proposal.rawText;
      }
    });
  });

  if (proposal.copy) {
    proposal.copy.addEventListener("click", async () => {
      const ok = await copyText(proposal.rawText);
      if (ok) { flashCopied(proposal.copy); toast("Copied", "Proposal is on your clipboard.", "success", 2200); }
      else toast("Copy failed", "Clipboard access was blocked.", "error");
    });
  }

  if (proposal.save) {
    proposal.save.addEventListener("click", () => {
      if (state.proposalSavedId) { toast("Already saved", "This output is in your history.", "info", 2000); return; }
      const inputs = proposalInputs();
      const id = addHistory({
        mode: "proposal",
        title: proposalTitle(inputs),
        inputs,
        output: proposal.rawText,
      });
      state.proposalSavedId = id;
    });
  }

  if (proposal.clear) {
    proposal.clear.addEventListener("click", () => {
      resetProposalView();
      proposal.doc.hidden = true;
      proposal.empty.hidden = false;
      proposal.copy.disabled = true;
      proposal.save.disabled = true;
      proposal.clear.disabled = true;
      toast("Cleared", "Output removed from view.", "info", 1800);
    });
  }
}

/* ============================================================ AD COPY TAB */
const ad = {
  form: $("#ad-form"),
  offer: $("#ac-offer"),
  audience: $("#ac-audience"),
  generate: $("#ac-generate"),
  skeleton: $("#ad-skeleton"),
  empty: $("#ad-empty"),
  streamDoc: $("#ad-stream-doc"),
  md: $("#ad-md"),
  cards: $("#ad-cards"),
  copyAll: $("#ad-copy-all"),
  printer: null,
  rawText: "",
};

function adInputs() {
  return {
    offer: ad.offer ? ad.offer.value : "",
    audience: ad.audience ? ad.audience.value : "",
    platform: segmentedValue("ac-platform") || "WhatsApp",
    tone: segmentedValue("ac-tone") || "friendly and confident",
  };
}

function splitVariants(text) {
  const lines = String(text || "").split("\n");
  const groups = [];
  let current = null;
  lines.forEach((line) => {
    if (/^##\s+/.test(line)) {
      if (current) groups.push(current);
      current = { title: line.replace(/^##\s+/, "").trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { title: "Variant", lines: [line] };
    }
  });
  if (current) groups.push(current);

  const variants = groups.filter((g) => /variant\s*\d/i.test(g.title));
  const extras = groups.filter((g) => !/variant\s*\d/i.test(g.title));
  if (!variants.length) return groups.map((g) => ({ title: g.title, body: g.lines.join("\n") }));
  return variants.concat(extras.map((g) => ({ title: g.title, body: g.lines.join("\n") })));
}

function renderAdCards(text) {
  if (!ad.cards) return;
  const parts = splitVariants(text);
  ad.cards.innerHTML = "";
  parts.forEach((part, i) => {
    const card = document.createElement("article");
    card.className = "copy-card";
    card.style.animationDelay = (i * 0.09) + "s";
    card.innerHTML =
      '<div class="copy-card-head">' +
        '<span class="copy-card-title">' + escapeHtml(part.title) + "</span>" +
        '<button class="icon-btn" type="button" data-copy="' + i + '" title="Copy this variant">' +
          '<svg class="ico-copy" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '<svg class="ico-check" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
        "</button>" +
      "</div>" +
      '<div class="copy-card-body md">' + renderMarkdown(part.body, false) + "</div>";
    card.dataset.text = part.body;
    ad.cards.appendChild(card);
  });
  ad.cards.hidden = false;
  bindSpotlights();
}

async function generateAdCopy() {
  const inputs = adInputs();
  if (!inputs.offer.trim()) {
    toast("Offer required", "Describe what you're selling first.", "error");
    if (ad.offer) ad.offer.focus();
    return;
  }

  state.adSavedId = null;
  ad.rawText = "";
  if (ad.printer) ad.printer.reset();
  if (ad.md) ad.md.innerHTML = "";
  if (ad.cards) { ad.cards.innerHTML = ""; ad.cards.hidden = true; }
  if (ad.copyAll) ad.copyAll.disabled = true;

  ad.empty.hidden = true;
  ad.streamDoc.hidden = false;
  showSkeleton(ad.skeleton);
  setLoading(ad.generate, true);

  ad.printer = createPrinter((text, streaming) => {
    ad.rawText = text;
    if (ad.md) ad.md.innerHTML = renderMarkdown(text, streaming);
  }, 8);

  try {
    await runStream({
      mode: "adcopy",
      inputs,
      onToken: (chunk) => ad.printer.push(chunk),
      onTrace: (ev) => pushTrace(ev),
      onError: (ev) => toast("Model error", ev.message || "Upstream failure", "error"),
      onDone: (ev, t0) => {
        ev = ev || { status: "ok" };
        ad.printer.end();
        ad.streamDoc.hidden = true;
        renderAdCards(ad.rawText);
        if (ad.copyAll) ad.copyAll.disabled = false;
        toast("3 copies ready", formatNum(Math.round(performance.now() - t0)) + "ms", "success", 2600);
        if (ev.status !== "error") {
          const id = addHistory({
            mode: "adcopy",
            title: "Ads — " + (inputs.offer.trim().split("\n")[0].slice(0, 56) || "offer"),
            inputs,
            output: ad.rawText,
          });
          state.adSavedId = id;
        }
      },
    });
  } catch (err) {
    ad.streamDoc.hidden = true;
    ad.empty.hidden = false;
    toast("Generation failed", err && err.message ? err.message : "Is the server running?", "error");
  } finally {
    setLoading(ad.generate, false);
    hideSkeleton(ad.skeleton);
  }
}

function initAdCopy() {
  if (!ad.form) return;
  ad.form.addEventListener("submit", (e) => { e.preventDefault(); generateAdCopy(); });

  if (ad.cards) {
    ad.cards.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-copy]");
      if (!btn) return;
      const card = btn.closest(".copy-card");
      if (!card) return;
      const ok = await copyText(card.dataset.text || "");
      if (ok) { flashCopied(btn); toast("Copied", "Variant on your clipboard.", "success", 1800); }
    });
  }

  if (ad.copyAll) {
    ad.copyAll.addEventListener("click", async () => {
      const ok = await copyText(ad.rawText);
      if (ok) toast("Copied all", "All variants are on your clipboard.", "success", 2200);
    });
  }

  const demo = $("#ad-demo");
  if (demo) {
    demo.addEventListener("click", () => {
      ad.offer.value =
        "1-hour Instagram growth audit + a 30-day content calendar for local cafés, delivered in " +
        "48 hours for $149. Includes 12 hook templates and a competitor teardown.";
      if (ad.audience) ad.audience.value = "independent café owners who post inconsistently";
      toast("Sample loaded", "Hit generate for 3 converting copies.", "info");
    });
  }
}

/* ==================================================== PRICING ESTIMATOR */
const pricing = {
  hours: $("#pr-hours"),
  rate: $("#pr-rate"),
  rush: $("#pr-rush"),
  hoursVal: $("#pr-hours-val"),
  rateVal: $("#pr-rate-val"),
  total: $("#pr-total"),
  range: $("#pr-range"),
  breakdown: $("#pr-breakdown"),
  ai: $("#pr-ai"),
  out: $("#pr-ai-out"),
  busy: false,
};

function updatePricing(bump) {
  if (!pricing.hours || !pricing.rate) return;
  const h = Number(pricing.hours.value);
  const r = Number(pricing.rate.value);
  const rush = pricing.rush ? pricing.rush.checked : false;
  const base = h * r;
  const total = Math.round(base * (rush ? 1.15 : 1) / 5) * 5;
  const low = Math.round(base * 0.8 / 5) * 5;
  const high = Math.round(base * 1.3 * (rush ? 1.15 : 1) / 5) * 5;

  if (pricing.hoursVal) pricing.hoursVal.textContent = String(h);
  if (pricing.rateVal) pricing.rateVal.textContent = String(r);
  if (pricing.total) {
    pricing.total.textContent = "$" + formatNum(total);
    if (bump && !reducedMotion) {
      pricing.total.classList.remove("is-bump");
      void pricing.total.offsetWidth;
      pricing.total.classList.add("is-bump");
    }
  }
  if (pricing.range) pricing.range.textContent = "$" + formatNum(low) + " – $" + formatNum(high);
  if (pricing.breakdown) {
    pricing.breakdown.textContent =
      h + "h × $" + r + "/hr" + (rush ? " · rush +15%" : "");
  }
}

async function explainPricing() {
  if (pricing.busy || !pricing.ai) return;
  pricing.busy = true;
  pricing.ai.classList.add("is-loading");
  pricing.ai.disabled = true;
  if (pricing.out) { pricing.out.hidden = false; pricing.out.innerHTML = ""; }

  const inputs = {
    hours: Number(pricing.hours ? pricing.hours.value : 40),
    rate: Number(pricing.rate ? pricing.rate.value : 65),
    rush: pricing.rush ? pricing.rush.checked : false,
    scope: proposal.desc ? proposal.desc.value : "",
    experience: segmentedValue("pc-exp") || "intermediate",
    budget: proposal.budget ? proposal.budget.value : "",
  };

  const printer = createPrinter((text, streaming) => {
    if (pricing.out) pricing.out.innerHTML = renderMarkdown(text, streaming);
  }, 8);

  try {
    await runStream({
      mode: "pricing",
      inputs,
      onToken: (c) => printer.push(c),
      onTrace: (ev) => pushTrace(ev),
      onError: (ev) => toast("Model error", ev.message || "Upstream failure", "error"),
      onDone: () => printer.end(),
    });
  } catch (err) {
    if (pricing.out) pricing.out.innerHTML = "<p>Could not reach the model: " +
      escapeHtml(err && err.message ? err.message : "unknown error") + "</p>";
  } finally {
    pricing.busy = false;
    pricing.ai.classList.remove("is-loading");
    pricing.ai.disabled = false;
  }
}

function initPricing() {
  const recalc = () => updatePricing(true);
  if (pricing.hours) pricing.hours.addEventListener("input", recalc);
  if (pricing.rate) pricing.rate.addEventListener("input", recalc);
  if (pricing.rush) pricing.rush.addEventListener("change", recalc);
  if (pricing.ai) pricing.ai.addEventListener("click", explainPricing);
  updatePricing(false);
}

/* ================================================================ TRACES */
const traceEls = {
  list: $("#trace-list"),
  empty: $("#trace-empty"),
  latency: $("#trace-latency"),
  tokens: $("#trace-tokens"),
  model: $("#trace-model"),
  calls: $("#trace-calls"),
  clear: $("#trace-clear"),
};

function pushTrace(ev) {
  if (!ev) return;
  const entry = {
    id: ev.id || uid("trace"),
    mode: ev.mode || state.mode,
    provider: ev.provider || state.provider,
    model: ev.model || state.model,
    status: ev.status || "ok",
    steps: Array.isArray(ev.steps) ? ev.steps : [],
    tokens: ev.tokens || {},
    latency_ms: Number(ev.latency_ms) || 0,
    ts: Date.now(),
  };
  state.traces.unshift(entry);
  if (state.traces.length > 30) state.traces.pop();
  renderTrace(entry, true);
  paintTraceStats(entry);
}

function traceItem(entry) {
  const li = document.createElement("li");
  li.className = "trace-item";

  const steps = entry.steps || [];
  const max = Math.max(1, ...steps.map((s) => Number(s.ms) || 0));
  const tok = entry.tokens || {};
  const total = Number(tok.total) || 0;

  const stepHtml = steps.map((s) => {
    const ms = Number(s.ms) || 0;
    const pct = clamp((ms / max) * 100, 3, 100);
    return (
      '<li class="trace-step">' +
        '<span class="trace-step-name">' + escapeHtml(s.name) + "</span>" +
        '<span class="trace-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
        '<span class="trace-step-ms">' + escapeHtml(formatMs(ms)) + "</span>" +
      "</li>"
    );
  }).join("");

  const time = new Date(entry.ts || Date.now()).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  li.innerHTML =
    '<div class="trace-item-head">' +
      '<span class="trace-name">' + escapeHtml(entry.mode) + " · " + escapeHtml(entry.status) + "</span>" +
      '<span class="trace-time">' + escapeHtml(time) + "</span>" +
    "</div>" +
    '<div class="trace-badges">' +
      '<span class="badge badge--violet">' + escapeHtml(entry.provider || "local") + "</span>" +
      '<span class="badge badge--cyan">' + escapeHtml((entry.model || "").slice(0, 34)) + "</span>" +
      '<span class="badge badge--lime">' + escapeHtml(formatMs(entry.latency_ms)) + "</span>" +
      (total ? '<span class="badge badge--amber">' + formatNum(total) + " tok</span>" : "") +
    "</div>" +
    '<ul class="trace-steps">' + stepHtml + "</ul>";

  return li;
}

function renderTrace(entry, prepend) {
  if (!traceEls.list) return;
  const node = traceItem(entry);
  if (prepend && traceEls.list.firstChild) traceEls.list.insertBefore(node, traceEls.list.firstChild);
  else traceEls.list.appendChild(node);
  if (traceEls.empty) traceEls.empty.hidden = true;
}

function paintTraceStats(entry) {
  if (traceEls.latency) animateNumber(traceEls.latency, Math.round(entry.latency_ms), { suffix: "ms" });
  const tok = entry.tokens || {};
  if (traceEls.tokens) animateNumber(traceEls.tokens, Number(tok.total) || 0);
  if (traceEls.model) traceEls.model.textContent = (entry.model || "—").slice(0, 16);
  if (traceEls.calls) animateNumber(traceEls.calls, state.traces.length);
}

function initTraces() {
  if (traceEls.clear) {
    traceEls.clear.addEventListener("click", () => {
      state.traces = [];
      if (traceEls.list) traceEls.list.innerHTML = "";
      if (traceEls.empty) traceEls.empty.hidden = false;
      if (traceEls.latency) { traceEls.latency.textContent = "—"; traceEls.latency.dataset.val = "0"; }
      if (traceEls.tokens) { traceEls.tokens.textContent = "—"; traceEls.tokens.dataset.val = "0"; }
      if (traceEls.model) traceEls.model.textContent = "—";
      if (traceEls.calls) { traceEls.calls.textContent = "0"; traceEls.calls.dataset.val = "0"; }
      toast("Traces cleared", "Session timeline reset.", "info", 1800);
    });
  }
}

/* =============================================================== HISTORY */
const HISTORY_KEY = "hustlecraft.history.v1";
const historyEls = { list: $("#history-list"), empty: $("#history-empty"), clear: $("#history-clear") };

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function persistHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 24))); }
  catch (e) { /* quota — ignore */ }
}

function addHistory(entry) {
  const record = {
    id: uid("h"),
    ts: Date.now(),
    mode: entry.mode || "proposal",
    title: entry.title || "Untitled",
    inputs: entry.inputs || {},
    output: entry.output || "",
  };
  state.history.unshift(record);
  if (state.history.length > 24) state.history.pop();
  persistHistory();
  renderHistory();
  toast("Saved to history", record.title, "success", 2400);
  return record.id;
}

function snippet(text) {
  return String(text || "").replace(/[#*`>_-]/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
}

function renderHistory() {
  if (!historyEls.list) return;
  historyEls.list.innerHTML = "";
  if (historyEls.empty) historyEls.empty.hidden = state.history.length > 0;

  state.history.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.style.animationDelay = Math.min(index * 0.05, 0.3) + "s";
    li.dataset.id = item.id;

    const when = new Date(item.ts).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

    li.innerHTML =
      '<div class="history-item-head">' +
        '<span class="history-title">' + escapeHtml(item.title) + "</span>" +
        '<span class="history-actions">' +
          '<button class="icon-btn" type="button" data-act="restore" title="Restore">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>' +
          "</button>" +
          '<button class="icon-btn" type="button" data-act="delete" title="Delete">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>' +
          "</button>" +
        "</span>" +
      "</div>" +
      '<div class="history-meta">' +
        '<span class="badge ' + (item.mode === "adcopy" ? "badge--cyan" : "badge--violet") + '">' +
          (item.mode === "adcopy" ? "ad copy" : item.mode === "chat" ? "chat" : item.mode) +
        "</span>" +
        '<span class="badge">' + escapeHtml(when) + "</span>" +
      "</div>" +
      '<p class="history-snippet">' + escapeHtml(snippet(item.output)) + "</p>";

    historyEls.list.appendChild(li);
  });

  updatePreview();
}

function restoreHistory(id) {
  const item = state.history.find((h) => h.id === id);
  if (!item) return;
  const node = historyEls.list && historyEls.list.querySelector('[data-id="' + id + '"]');
  if (node) {
    node.classList.remove("is-restored");
    void node.offsetWidth;
    node.classList.add("is-restored");
  }

  if (item.mode === "adcopy") {
    if (ad.offer && item.inputs.offer != null) ad.offer.value = item.inputs.offer;
    if (ad.audience && item.inputs.audience != null) ad.audience.value = item.inputs.audience;
    ad.rawText = item.output;
    ad.empty.hidden = true;
    ad.streamDoc.hidden = true;
    renderAdCards(item.output);
    if (ad.copyAll) ad.copyAll.disabled = false;
    switchTabs.activate("adcopy");
  } else {
    if (proposal.desc && item.inputs.description != null) proposal.desc.value = item.inputs.description;
    if (proposal.budget) proposal.budget.value = item.inputs.budget || "";
    if (proposal.deadline) proposal.deadline.value = item.inputs.deadline || "";
    if (proposal.skills) proposal.skills.value = item.inputs.skills || "";
    if (proposal.descCount) proposal.descCount.textContent = String((item.inputs.description || "").length);
    proposal.rawText = item.output;
    if (proposal.md) proposal.md.innerHTML = renderMarkdown(item.output, false);
    if (proposal.raw) proposal.raw.textContent = item.output;
    proposal.doc.hidden = false;
    proposal.empty.hidden = true;
    proposal.copy.disabled = false;
    proposal.save.disabled = false;
    proposal.clear.disabled = false;
    state.proposalSavedId = item.id;
    switchTabs.activate("proposal");
  }
  setTimeout(() => {
    const ws = $("#workspace");
    if (ws) ws.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }, 90);
  toast("Restored", item.title, "success", 2400);
}

function deleteHistory(id) {
  const node = historyEls.list && historyEls.list.querySelector('[data-id="' + id + '"]');
  const remove = () => {
    state.history = state.history.filter((h) => h.id !== id);
    persistHistory();
    renderHistory();
    if (state.proposalSavedId === id) state.proposalSavedId = null;
  };
  if (node) {
    node.classList.add("is-leaving");
    setTimeout(remove, 420);
  } else remove();
  toast("Deleted", "Removed from local history.", "info", 1800);
}

function initHistory() {
  state.history = loadHistory();
  renderHistory();

  if (historyEls.list) {
    historyEls.list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const item = btn.closest(".history-item");
      if (!item) return;
      if (btn.dataset.act === "restore") restoreHistory(item.dataset.id);
      else deleteHistory(item.dataset.id);
    });
  }
  if (historyEls.clear) {
    historyEls.clear.addEventListener("click", () => {
      if (!state.history.length) { toast("Nothing to clear", "History is already empty.", "info", 1800); return; }
      state.history = [];
      persistHistory();
      renderHistory();
      state.proposalSavedId = null;
      toast("History cleared", "All local entries removed.", "success", 2200);
    });
  }
}

/* ================================================================ CHATBOT */
const chat = {
  fab: $("#chat-fab"),
  drawer: $("#chat-drawer"),
  close: $("#chat-close"),
  messages: $("#chat-messages"),
  form: $("#chat-form"),
  input: $("#chat-input"),
  chips: $("#chat-chips"),
  dot: $("#chat-dot"),
  open: false,
};

function chatTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addChatMessage(role, html) {
  if (!chat.messages) return null;
  const el = document.createElement("div");
  el.className = "msg msg--" + (role === "user" ? "user" : "bot");
  el.innerHTML = html + '<span class="msg-time">' + chatTime() + "</span>";
  chat.messages.appendChild(el);
  chat.messages.scrollTop = chat.messages.scrollHeight;
  return el;
}

function setChatOpen(open) {
  chat.open = open;
  if (!chat.drawer) return;
  if (open) {
    chat.drawer.classList.remove("is-closing");
    chat.drawer.hidden = false;
    if (chat.fab) {
      chat.fab.classList.add("is-open");
      chat.fab.setAttribute("aria-expanded", "true");
    }
    setTimeout(() => { if (chat.input) chat.input.focus(); }, 340);
    if (!chat.messages.children.length) greetChat();
  } else {
    chat.drawer.classList.add("is-closing");
    if (chat.fab) {
      chat.fab.classList.remove("is-open");
      chat.fab.setAttribute("aria-expanded", "false");
    }
    setTimeout(() => {
      chat.drawer.classList.remove("is-closing");
      chat.drawer.hidden = true;
    }, 320);
  }
}

function greetChat() {
  addChatMessage("bot",
    "<strong>Hey, I'm your deal coach 🤝</strong><br>Ask me about pricing, negotiation scripts " +
    "or how to close after a call.");
}

async function sendChat(text) {
  const message = String(text || "").trim();
  if (!message || state.chatBusy) return;
  state.chatBusy = true;

  addChatMessage("user", escapeHtml(message));
  if (chat.input) chat.input.value = "";

  const history = [];
  $$(".msg", chat.messages).slice(-6).forEach((m) => {
    if (m.classList.contains("msg--typing")) return;
    const isUser = m.classList.contains("msg--user");
    const clone = m.cloneNode(true);
    const time = clone.querySelector(".msg-time");
    if (time) time.remove();
    const content = clone.textContent.trim();
    if (!content) return;
    history.push({ role: isUser ? "user" : "assistant", content });
  });

  /* live bot bubble — typing dots swap out on the first streamed token */
  const holder = document.createElement("div");
  holder.className = "msg msg--bot";
  const body = document.createElement("div");
  body.className = "md";
  const typing = document.createElement("div");
  typing.className = "msg--typing";
  typing.innerHTML = "<i></i><i></i><i></i>";
  const stamp = document.createElement("span");
  stamp.className = "msg-time";
  stamp.textContent = chatTime();
  stamp.style.visibility = "hidden";
  holder.appendChild(typing);
  holder.appendChild(stamp);
  if (chat.messages) {
    chat.messages.appendChild(holder);
    chat.messages.scrollTop = chat.messages.scrollHeight;
  }

  const swapInBody = () => {
    if (typing.parentNode) {
      holder.insertBefore(body, stamp);
      typing.remove();
      stamp.style.visibility = "";
    }
  };

  const printer = createPrinter((t, streaming) => {
    swapInBody();
    body.innerHTML = renderMarkdown(t, streaming);
    if (chat.messages) chat.messages.scrollTop = chat.messages.scrollHeight;
  }, 7);

  try {
    await runStream({
      mode: "chat",
      inputs: { message, history, offer: "", scope: "" },
      onToken: (c) => printer.push(c),
      onTrace: (ev) => pushTrace(ev),
      onDone: () => printer.end(),
      onError: (ev) => printer.push("\n\n_⚠️ " + (ev.message || "model error") + "_"),
    });
    printer.end();
    swapInBody();
    if (!printer.text().trim()) {
      body.innerHTML = renderMarkdown("_No answer came back — try rephrasing that._", false);
    }
    if (chat.messages) chat.messages.scrollTop = chat.messages.scrollHeight;
  } catch (err) {
    if (holder.parentNode) holder.remove();
    addChatMessage("bot", "⚠️ <strong>Server unreachable.</strong><br>" +
      escapeHtml(err && err.message ? err.message : "start <code>python3 server.py</code>"));
  } finally {
    state.chatBusy = false;
    if (chat.input) chat.input.value = "";
  }
}

function initChat() {
  if (chat.fab) chat.fab.addEventListener("click", () => setChatOpen(!chat.open));
  if (chat.close) chat.close.addEventListener("click", () => setChatOpen(false));
  if (chat.form) {
    chat.form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendChat(chat.input ? chat.input.value : "");
    });
  }
  if (chat.chips) {
    chat.chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      sendChat(chip.textContent.trim());
    });
  }
  const heroChat = $("#hero-chat");
  if (heroChat) heroChat.addEventListener("click", () => setChatOpen(true));
}

/* ==================================================== HACKTOBERFEST DRAWER */
const hf = {
  open: $("#hf-open"),
  drawer: $("#hf-drawer"),
  close: $("#hf-close"),
  overlay: $("#overlay"),
  preview: $("#hf-preview"),
  exportBtn: $("#hf-export"),
  downloadBtn: $("#hf-download"),
  opening: false,
};

function openDrawer() {
  if (!hf.drawer || !hf.overlay) return;
  hf.drawer.classList.remove("is-closing");
  hf.overlay.classList.remove("is-closing");
  hf.overlay.hidden = false;
  hf.drawer.hidden = false;
  document.body.style.overflow = "hidden";
  updatePreview();
  setTimeout(() => { if (hf.close) hf.close.focus(); }, 300);
}

function closeDrawer() {
  if (!hf.drawer || !hf.overlay) return;
  hf.drawer.classList.add("is-closing");
  hf.overlay.classList.add("is-closing");
  document.body.style.overflow = "";
  setTimeout(() => {
    hf.drawer.classList.remove("is-closing");
    hf.overlay.classList.remove("is-closing");
    hf.drawer.hidden = true;
    hf.overlay.hidden = true;
  }, 340);
}

function buildDevtoMarkdown() {
  const proposals = state.history.filter((h) => h.mode === "proposal");
  const ads = state.history.filter((h) => h.mode === "adcopy");
  const lastTrace = state.traces[0];
  const tok = (lastTrace && lastTrace.tokens) || {};
  const selected = $(".prize.is-selected");
  const track = selected ? selected.dataset.prize : "Gemma";

  const frontMatter = [
    "---",
    "title: HustleCraft — an AI Side Hustle Toolkit for freelancers",
    "published: true",
    "description: Proposal writer, WhatsApp/social ad copywriter and pricing estimator running on open-weight models — built for Hacktoberfest 2026.",
    "tags: hacktoberfest2026, ai, opensource, freelancing, python",
    "---",
    "",
  ].join("\n");

  const body = [
    "![HustleCraft](https://media.dev.to/cdn-cgi/image/width=1000/https://dev.to/social_previews/article/1.png)",
    "",
    "## 💡 The idea",
    "",
    "Freelancers lose hours writing proposals, ad copy and quotes. **HustleCraft** turns that into a " +
      "one-tab toolkit: paste a brief, get a structured proposal with selling points, risk assessment " +
      "and a defensible price.",
    "",
    "## ✨ What it does",
    "",
    "- **Proposal & Pitch Generator** — hook, plan, key selling points, risk assessment, pricing.",
    "- **WhatsApp & Social Ad Copywriter** — 3 high-converting variants with emojis and CTAs.",
    "- **Pricing Estimator** — live rate math plus an AI breakdown of packages and anchors.",
    "- **Floating Deal Coach** — negotiation scripts and pricing advice in a chat drawer.",
    "- **Mastra / Sentry Traces** — step latency, model and token counters per generation.",
    "",
    "## 🛠️ Stack",
    "",
    "- Pure **Python standard library** server (`server.py`) — SSE streaming, zero pip deps.",
    "- Open-weight models: **Gemma 2 / Llama 3** via Groq cloud or a local Ollama proxy.",
    "- Vanilla HTML/CSS/JS frontend: particle canvas, glassmorphism, streaming typewriter.",
    "",
    "```bash",
    "cp .env.example .env   # optional: add GROQ_API_KEY",
    "python3 server.py",
    "```",
    "",
    "## 📊 Live session snapshot",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    "| Proposals saved | " + proposals.length + " |",
    "| Ad sets saved | " + ads.length + " |",
    "| Traces recorded | " + state.traces.length + " |",
    lastTrace
      ? "| Last latency | " + formatMs(lastTrace.latency_ms) + " (" + (lastTrace.model || "-") + ") |"
      : "| Last latency | not run yet |",
    lastTrace
      ? "| Last tokens | " + formatNum(tok.total || 0) + " (" + formatNum(tok.prompt || 0) +
        " prompt / " + formatNum(tok.completion || 0) + " completion) |"
      : "| Last tokens | — |",
    "",
    "## 🎁 Hacktoberfest 2026 tracks",
    "",
    "| Track | Prize | Focus |",
    "| --- | --- | --- |",
    "| Gemma | $200 | Best use of Gemma 2 open-weight models |",
    "| Render | $200 | Cleanest deploy + DX |",
    "| Mastra | $100 | Agent traces & observability |",
    "| Atlas | $100 | Docs and contributor onboarding |",
    "",
    "**Track I'm targeting:** " + track,
    "",
    "## 🧰 Try it",
    "",
    "```bash",
    "git clone <this-repo> && cd hustlecraft",
    "python3 server.py",
    "open http://127.0.0.1:8000",
    "```",
    "",
    "Built with ❤️ for freelancers, indie hackers and micro-business owners.",
    "",
    "---",
    "",
    "*Generated with the HustleCraft 1-click DEV.to Markdown Exporter.*",
  ].join("\n");

  return frontMatter + body;
}

function updatePreview() {
  if (!hf.preview) return;
  const md = buildDevtoMarkdown();
  const lines = md.split("\n");
  hf.preview.textContent = lines.slice(0, 22).join("\n") +
    (lines.length > 22 ? "\n… (" + (lines.length - 22) + " more lines)" : "");
}

async function exportDevto() {
  const md = buildDevtoMarkdown();
  const ok = await copyText(md);
  if (ok) toast("Markdown copied", "Paste it straight into the DEV.to editor.", "success", 3000);
  else toast("Export failed", "Clipboard blocked — use Download .md instead.", "error");
}

function downloadDevto() {
  const md = buildDevtoMarkdown();
  try {
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hustlecraft-devto-post.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("Downloaded", "hustlecraft-devto-post.md", "success", 2600);
  } catch (e) {
    toast("Download failed", "Your browser blocked the file download.", "error");
  }
}

function initHacktoberfest() {
  if (hf.open) hf.open.addEventListener("click", openDrawer);
  if (hf.close) hf.close.addEventListener("click", closeDrawer);
  if (hf.overlay) hf.overlay.addEventListener("click", closeDrawer);
  if (hf.exportBtn) hf.exportBtn.addEventListener("click", exportDevto);
  if (hf.downloadBtn) hf.downloadBtn.addEventListener("click", downloadDevto);

  $$(".prize").forEach((prize) => {
    prize.addEventListener("click", () => {
      $$(".prize").forEach((p) => p.classList.remove("is-selected"));
      prize.classList.add("is-selected");
      toast(prize.dataset.prize + " track", "Selected as your target prize.", "success", 2400);
      updatePreview();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (hf.drawer && !hf.drawer.hidden) closeDrawer();
    else if (chat.open) setChatOpen(false);
  });

  updatePreview();
}

/* ================================================================ HEALTH */
function paintModel() {
  const chip = $("#model-chip-text");
  const dot = $("#model-chip .status-dot");
  const healthText = $("#health-text");
  const healthDot = $("#health-dot");
  const chatModel = $("#chat-model");
  const chatDot = $("#chat-dot");

  const label = state.provider + " · " + state.model;
  if (chip) chip.textContent = label;
  if (healthText) healthText.textContent = label;

  const stateName = state.provider === "local" ? "local" : "online";
  if (dot) dot.dataset.state = stateName;
  if (healthDot) healthDot.dataset.state = stateName;
  if (chatDot) chatDot.dataset.state = stateName;
  if (chatModel) chatModel.textContent = state.provider + " · pricing · negotiation";
}

async function checkHealth() {
  const dot = $("#health-dot");
  const text = $("#health-text");
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.lastHealth = data;
    const model = data.model || {};
    state.provider = model.provider || "local";
    state.model = model.name || "unknown";
    paintModel();
    if (text && !data.status) text.textContent = "degraded";
  } catch (err) {
    if (dot) dot.dataset.state = "offline";
    if (text) text.textContent = "server offline";
  }
}

/* =================================================================== BOOT */
let switchTabs = null;

function boot() {
  initParticles();
  bindSpotlights();
  bindTilt();
  bindCounters();
  switchTabs = initTabs();
  initSegmented();
  initProposal();
  initAdCopy();
  initPricing();
  initTraces();
  initHistory();
  initChat();
  initHacktoberfest();
  checkHealth();
  setInterval(checkHealth, 30000);

  window.addEventListener("offline", () => toast("You're offline", "Streaming needs the local server.", "error"));
  window.addEventListener("online", checkHealth);

  const tracesNav = $('.topnav-link[href="#traces"]');
  if (tracesNav) {
    tracesNav.addEventListener("click", () => {
      if (traceEls.list && !traceEls.list.children.length) {
        toast("No traces yet", "Run a generator to populate this panel.", "info", 2400);
      }
    });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
