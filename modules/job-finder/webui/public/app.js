// AIJobNinja - front end. Plain browser JavaScript, no framework, no build.
// All DOM is built with textContent; only descriptionHtml (sanitized on the
// server, and fenced by the page's CSP) is ever assigned as HTML.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  portals: [],
  enabled: new Set(store.get("enabledPortals", [])),
  params: { q: "", location: "", days: "", remote: "", sort: "relevance" },
  page: 1,
  jobs: [],
  portalStatus: {},
  loading: false,
  selected: null,
  saved: [],
  detailCache: new Map(),
  searchSeq: 0,
};

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};
function icon(name) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name]; // static, trusted markup from the table above
  return s;
}

const PALETTE = ["#3b4fe0", "#0f8b8d", "#7c3aed", "#d9480f", "#2b8a3e", "#c2255c", "#1971c2", "#5f3dc4", "#e67700", "#087f5b"];
function logo(name) {
  const text = (name || "?").replace(/\b(a\/s|aps|ltd|inc|gmbh|the)\b/gi, "").trim() || name || "?";
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const c of text) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const el = h("div", { class: "logo", "aria-hidden": "true" }, initials);
  el.style.background = PALETTE[hash % PALETTE.length];
  return el;
}

const DAY = 86400000;
function daysFromToday(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / DAY);
}
function relPosted(iso) {
  const n = daysFromToday(iso);
  if (n === null) return null;
  if (n >= 0) return "Today";
  if (n === -1) return "Yesterday";
  if (n > -30) return `${-n} days ago`;
  if (n > -365) return `${Math.round(-n / 30)} mo ago`;
  return `${Math.round(-n / 365)} yr ago`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function deadlineBadge(iso) {
  const n = daysFromToday(iso);
  if (n === null) return null;
  if (n < 0) return h("span", { class: "badge danger" }, "Deadline passed");
  if (n === 0) return h("span", { class: "badge danger" }, "Closes today");
  if (n <= 7) return h("span", { class: "badge warn" }, `Closes in ${n} day${n === 1 ? "" : "s"}`);
  return h("span", { class: "badge" }, `Apply by ${fmtDate(iso)}`);
}
const portalName = (id) => state.portals.find((p) => p.id === id)?.name ?? id;

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
  catch { toast("Copy failed - select and copy manually"); }
}

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const btn = $("#themeToggle");
  btn.replaceChildren(icon(dark ? "sun" : "moon"));
}
$("#themeToggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  store.set("theme", next);
  applyTheme(next);
});
applyTheme(store.get("theme", null));

// ------------------------------------------------------------------ portals
function renderChips() {
  const wrap = $("#portalChips");
  wrap.replaceChildren(
    ...state.portals.map((p) => {
      const st = state.portalStatus[p.id];
      const on = state.enabled.has(p.id);
      return h("button", {
        type: "button", class: "chip", "aria-pressed": String(on),
        "data-status": on && st ? st.status : null,
        title: st?.message || (!on && p.offByDefault) || `${p.name} · ${p.region}`,
        onclick: () => {
          if (on && state.enabled.size === 1) return toast("Keep at least one source on");
          on ? state.enabled.delete(p.id) : state.enabled.add(p.id);
          store.set("enabledPortals", [...state.enabled]);
          renderChips();
          if (state.params.q || state.params.location) runSearch();
        },
      }, h("span", { class: "dot" }), p.name,
        on && st?.status === "ok" ? h("span", { class: "count" }, st.total != null ? st.total.toLocaleString() : st.count) : null);
    }),
  );
  renderSources();
}

function renderSources() {
  $("#sourceList").replaceChildren(
    ...state.portals.filter((p) => state.enabled.has(p.id)).map((p) => {
      const st = state.portalStatus[p.id];
      const shown = state.jobs.filter((j) => j.portal === p.id).length;
      return h("li", { title: st?.message || "" },
        h("span", { class: `status-dot ${st?.status ?? ""}` }),
        h("span", { class: "name" }, p.name,
          st?.status === "error" ? h("div", { class: "err" }, shortError(st.message)) : null,
          st?.status === "skipped" ? h("div", { class: "hint" }, st.message) : null),
        h("span", { class: "num" }, st?.status === "ok" ? shown : "–"));
    }),
  );
}
const shortError = (m = "") => /cloudflare|bot/i.test(m) ? "Blocked by the portal" : /timed out/i.test(m) ? "Timed out" : "Unavailable";

// ------------------------------------------------------------------ filters
function syncFilterUI() {
  for (const seg of $$(".segmented")) {
    const key = seg.dataset.filter;
    for (const b of $$("button", seg)) b.classList.toggle("active", b.dataset.value === String(state.params[key] ?? ""));
  }
  $("#q").value = state.params.q;
  $("#location").value = state.params.location;
}
for (const seg of $$(".segmented")) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.params[seg.dataset.filter] = b.dataset.value;
    syncFilterUI();
    if (state.params.q || state.params.location) runSearch();
  });
}
$("#resetFilters").addEventListener("click", () => {
  Object.assign(state.params, { days: "", remote: "", sort: "relevance" });
  $("#refine").value = "";
  $("#hideExpired").checked = true;
  $("#onlyDeadline").checked = false;
  syncFilterUI();
  if (state.params.q || state.params.location) runSearch(); else renderResults();
});
for (const id of ["refine", "hideExpired", "onlyDeadline"]) $("#" + id).addEventListener("input", () => renderResults());

function visibleJobs() {
  const words = $("#refine").value.toLowerCase().split(/\s+/).filter(Boolean);
  const hideExpired = $("#hideExpired").checked;
  const onlyDeadline = $("#onlyDeadline").checked;
  return state.jobs.filter((j) => {
    if (hideExpired && j.deadline && daysFromToday(j.deadline) < 0) return false;
    if (onlyDeadline && !j.deadline) return false;
    if (words.length) {
      const hay = [j.title, j.company, j.location, j.snippet, ...(j.tags || [])].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

// ------------------------------------------------------------------ search
$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state.params.q = $("#q").value.trim();
  state.params.location = $("#location").value.trim();
  if (!state.params.q && !state.params.location) { $("#q").focus(); return toast("Type a keyword or location"); }
  runSearch();
});
$("#loadMore").addEventListener("click", () => runSearch(state.page + 1));

function writeHash() {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(state.params)) if (v && !(k === "sort" && v === "relevance")) qs.set(k, v);
  const next = "#/search" + (qs.toString() ? "?" + qs : "");
  if (location.hash !== next) history.replaceState(null, "", next);
}

async function runSearch(page = 1) {
  const seq = ++state.searchSeq;
  state.page = page;
  state.loading = true;
  if (page === 1) {
    state.jobs = [];
    state.selected = null;
    renderDetail($("#detail"), null);
    writeHash();
  }
  for (const id of state.enabled) state.portalStatus[id] = { status: "loading" };
  renderChips();
  renderResults();
  const pageJobs = {};
  // One request per portal, so fast boards render while slow ones still load.
  await Promise.all([...state.enabled].map(async (id) => {
    const qs = new URLSearchParams({ ...state.params, page: String(page), portals: id });
    try {
      const data = await api("/api/search?" + qs);
      if (seq !== state.searchSeq) return; // a newer search superseded this one
      pageJobs[id] = data.jobs;
      state.portalStatus[id] = data.portals[0] ?? { status: "error", message: "No response" };
    } catch (err) {
      if (seq !== state.searchSeq) return;
      state.portalStatus[id] = { status: "error", message: err.message };
    }
    if (seq !== state.searchSeq) return;
    state.jobs = mergeJobs(page, pageJobs);
    renderChips();
    renderResults();
  }));
  if (seq !== state.searchSeq) return;
  state.hasMore = Object.values(state.portalStatus).some((p) => p.status === "ok" && p.count > 0);
  state.loading = false;
  renderChips();
  renderResults();
}

// Earlier pages keep their order; the page being loaded is interleaved across
// portals (each portal's own relevance order preserved) and appended. The
// same posting syndicated to several boards is shown once.
const dedupKey = (j) => `${(j.company || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}|${j.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}`;
function mergeJobs(page, pageJobs) {
  const seen = new Map();
  const out = [];
  const add = (j) => {
    const k = dedupKey(j);
    const prev = seen.get(k);
    if (prev) { if (prev.portal !== j.portal) prev.tags = Array.from(new Set([...(prev.tags || []), `Also on ${portalName(j.portal)}`])); return; }
    const copy = { ...j, tags: [...(j.tags || [])] };
    seen.set(k, copy);
    out.push(copy);
  };
  if (page > 1) state.jobs.forEach(add);
  const lists = state.portals.map((p) => pageJobs[p.id] || []);
  const fresh = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) fresh.push(l[i]);
  if (state.params.sort === "date") fresh.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  fresh.forEach(add);
  return out;
}

function skeletons(n = 5) {
  return Array.from({ length: n }, () =>
    h("div", { class: "skeleton" }, h("div", { class: "sk logo-sk" }),
      h("div", {}, h("div", { class: "sk w70" }), h("div", { class: "sk w40" }), h("div", { class: "sk w55" }))));
}

function emptyState(iconName, title, text, extra) {
  return h("div", { class: "empty" }, icon(iconName), h("h3", {}, title), h("p", {}, text), extra || null);
}

function renderResults() {
  const list = $("#resultsList");
  const jobs = visibleJobs();
  const searched = state.params.q || state.params.location;
  const title = $("#resultsTitle");
  const meta = $("#resultsMeta");

  if (!searched && !state.loading) {
    title.textContent = "Start a search";
    meta.textContent = "Enter a keyword to search every portal at once.";
    const examples = ["Data scientist", "Python developer", "Project manager", "UX designer", "Data engineer"];
    list.replaceChildren(emptyState("search", "Search across six job boards", "Results are merged, de-duplicated and sorted so you only read each posting once.",
      h("div", { class: "suggestions" }, examples.map((ex) => h("button", { type: "button", class: "btn btn-secondary", onclick: () => { state.params.q = ex; syncFilterUI(); runSearch(); } }, ex)))));
    $("#loadMore").hidden = true;
    renderSources();
    return;
  }

  const what = [state.params.q, state.params.location && `in ${state.params.location}`].filter(Boolean).join(" ");
  title.textContent = state.loading && !state.jobs.length ? "Searching…" : `${jobs.length.toLocaleString()} job${jobs.length === 1 ? "" : "s"}`;
  const okCount = Object.values(state.portalStatus).filter((s) => s.status === "ok").length;
  meta.textContent = state.loading ? `Looking for “${what}” on ${state.enabled.size} portals…` : `for “${what}” · ${okCount} of ${state.enabled.size} portals responded` + (jobs.length < state.jobs.length ? ` · ${state.jobs.length - jobs.length} hidden by filters` : "");

  const cards = jobs.map((j) => jobCard(j, () => select(j, $("#detail"))));
  if (state.loading) cards.push(...skeletons(state.jobs.length ? 2 : 6));
  else if (!jobs.length) cards.push(emptyState("inbox", "No matching jobs", state.jobs.length ? "Every result is hidden by your filters. Try clearing them." : "Try a broader keyword, a different location, or a longer date range."));
  list.replaceChildren(...cards);
  $("#loadMore").hidden = state.loading || !state.hasMore || !state.jobs.length;
  renderSources();
}

const isSaved = (key) => state.saved.some((s) => s.key === key);

function saveButton(job, large = false) {
  const saved = isSaved(job.key);
  if (large) {
    const b = h("button", { type: "button", class: `btn btn-secondary${saved ? " is-on" : ""}`, onclick: () => toggleSave(job) }, icon("bookmark"), saved ? "Saved" : "Save");
    return b;
  }
  return h("button", {
    type: "button", class: `save-btn${saved ? " saved" : ""}`, "aria-label": saved ? "Remove from saved" : "Save job", title: saved ? "Saved" : "Save",
    onclick: (e) => { e.stopPropagation(); toggleSave(job); },
  }, icon("bookmark"));
}

function jobCard(j, onOpen, extra) {
  const posted = relPosted(j.date);
  const isNew = daysFromToday(j.date) !== null && daysFromToday(j.date) >= -2;
  const card = h("article", {
    class: `job-card${state.selected?.key === j.key ? " selected" : ""}`, tabindex: "0", "data-key": j.key, role: "button", "aria-label": `${j.title} at ${j.company || "unknown company"}`,
    onclick: onOpen,
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } },
  },
    logo(j.company || j.title),
    h("div", {},
      h("h3", {}, j.title),
      h("div", { class: "company" }, j.company || "Company not listed"),
      h("div", { class: "meta" },
        j.location ? h("span", {}, icon("pin"), j.location) : null,
        posted ? h("span", {}, icon("clock"), posted) : null),
      j.snippet ? h("p", { class: "snippet" }, j.snippet) : null,
      h("div", { class: "badges" },
        h("span", { class: "badge source" }, portalName(j.portal)),
        isNew ? h("span", { class: "badge new" }, "New") : null,
        deadlineBadge(j.deadline),
        j.workMode ? h("span", { class: "badge" }, cap(j.workMode)) : null,
        (j.tags || []).slice(0, 4).map((t) => h("span", { class: "badge" }, cap(t)))),
      extra || null),
    saveButton(j));
  return card;
}
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// ------------------------------------------------------------------ detail
function openDrawer(panel) {
  if (!matchMedia("(max-width: 1180px)").matches) return;
  panel.classList.add("open");
  $("#backdrop").hidden = false;
}
function closeDrawers() {
  $$(".detail.open, .filters.open").forEach((el) => el.classList.remove("open"));
  $("#backdrop").hidden = true;
}
$("#backdrop").addEventListener("click", closeDrawers);
$("#showFilters").addEventListener("click", () => { $("#filters").classList.add("open"); $("#backdrop").hidden = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawers(); });

async function select(job, panel) {
  state.selected = job;
  $$(".job-card").forEach((c) => c.classList.toggle("selected", c.dataset.key === job.key));
  renderDetail(panel, job, null);
  openDrawer(panel);
  panel.scrollTop = 0;
  let d = state.detailCache.get(job.key);
  if (!d) {
    try {
      d = await api(`/api/detail?${new URLSearchParams({ portal: job.portal, id: job.id, title: job.title })}`);
      state.detailCache.set(job.key, d);
    } catch (err) {
      d = { error: err.message };
    }
  }
  if (state.selected?.key === job.key) renderDetail(panel, job, d);
}

// Search results carry the reliable list metadata; detail pages fill gaps.
function mergeDetail(job, d) {
  const out = { ...job };
  if (!d || d.error) return out;
  for (const k of ["company", "location", "date", "deadline", "applyUrl", "employmentType", "workMode"]) if (!out[k] && d[k]) out[k] = d[k];
  if (d.tags?.length) out.tags = Array.from(new Set([...(job.tags || []), ...d.tags]));
  return out;
}

function renderDetail(panel, job, d) {
  if (!job) {
    panel.classList.remove("open");
    if (panel.id === "savedDetail") return panel.replaceChildren();
    return panel.replaceChildren(h("div", { class: "detail-empty" }, h("div", {}, icon("briefcase"), h("p", {}, "Select a job to see the full posting."))));
  }
  const j = mergeDetail(job, d);
  const postingUrl = j.url || d?.url;
  const fact = (label, value) => value ? h("div", { class: "fact" }, h("dt", {}, label), h("dd", {}, value)) : null;

  const body = h("div", { class: "detail-body" });
  body.append(h("div", { class: "ai-callout" }, icon("sparkle"),
    h("p", {}, h("strong", {}, "Tailor an application with Claude Code. "), "Run ", h("code", {}, `/apply ${postingUrl}`),
      " in this repo to score your fit and draft a matched CV and cover letter.")));
  if (j.tags?.length) body.append(h("div", { class: "badges" }, j.tags.map((t) => h("span", { class: "badge" }, cap(t)))));
  if (!d) {
    body.append(h("div", {}, h("div", { class: "sk w70" }), h("div", { class: "sk w55" }), h("div", { class: "sk w40" }), h("div", { class: "sk w55" }), h("div", { class: "sk w70" })));
  } else if (d.error) {
    body.append(h("div", { class: "notice" }, `Couldn't load the full posting (${shortError(d.error).toLowerCase()}). Open it on ${portalName(j.portal)} instead.`));
  } else if (d.descriptionHtml) {
    const prose = h("div", { class: "prose" });
    prose.innerHTML = d.descriptionHtml; // sanitized server-side (webui/lib/render.ts), CSP blocks scripts
    body.append(prose);
  } else {
    body.append(h("p", { class: "muted" }, "This portal didn't return a description. Open the posting to read it."));
  }

  panel.replaceChildren(
    h("div", { class: "detail-head" },
      h("div", { class: "detail-top" },
        logo(j.company || j.title),
        h("div", {}, h("h2", {}, j.title), h("div", { class: "company" }, [j.company, j.location].filter(Boolean).join(" · ") || "Company not listed")),
        h("button", { type: "button", class: "icon-btn detail-close", "aria-label": "Close", onclick: closeDrawers }, icon("x"))),
      h("div", { class: "actions" },
        postingUrl ? h("a", { class: "btn btn-primary", href: postingUrl, target: "_blank", rel: "noopener noreferrer" }, icon("external"), `View on ${portalName(j.portal)}`) : null,
        j.applyUrl && j.applyUrl !== postingUrl ? h("a", { class: "btn btn-secondary", href: j.applyUrl, target: "_blank", rel: "noopener noreferrer" }, icon("send"), "Apply") : null,
        saveButton(j, true),
        h("button", { type: "button", class: "btn btn-ghost", title: "Copy the /apply command for Claude Code", onclick: () => copy(`/apply ${postingUrl}`, "/apply command") }, icon("copy"), "Copy /apply"))),
    h("dl", { class: "facts" },
      fact("Posted", j.date ? `${fmtDate(j.date)}` : null),
      fact("Deadline", j.deadline ? fmtDate(j.deadline) : "Not stated"),
      fact("Type", j.employmentType),
      fact("Source", portalName(j.portal))),
    body);
}

// ------------------------------------------------------------------ saved
async function loadSaved() {
  try { state.saved = await api("/api/saved"); } catch { state.saved = []; }
  $("#savedCount").textContent = state.saved.length;
}

async function toggleSave(job) {
  const wasSaved = isSaved(job.key);
  try {
    const merged = mergeDetail(job, state.detailCache.get(job.key));
    state.saved = await api("/api/saved", {
      method: wasSaved ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wasSaved ? { key: job.key } : merged),
    });
    toast(wasSaved ? "Removed from saved" : "Saved to your shortlist");
  } catch (err) { return toast(err.message); }
  $("#savedCount").textContent = state.saved.length;
  refreshSaveButtons(job);
}

function refreshSaveButtons(job) {
  if (currentRoute() === "saved") return renderSaved();
  renderResults();
  if (state.selected?.key === job.key) renderDetail($("#detail"), state.selected, state.detailCache.get(job.key) ?? null);
}

function renderSaved() {
  const list = $("#savedList");
  if (!state.saved.length) {
    renderDetail($("#savedDetail"), null);
    return list.replaceChildren(emptyState("bookmark", "Nothing saved yet", "Bookmark jobs from your search results to build a shortlist you can come back to.",
      h("div", { class: "suggestions" }, h("a", { class: "btn btn-primary", href: "#/search" }, "Find jobs"))));
  }
  list.replaceChildren(...state.saved.map((j) => {
    const note = h("textarea", { class: "note-box", rows: "1", placeholder: "Add a note…", "aria-label": `Note for ${j.title}`, onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() });
    note.value = j.note || "";
    note.addEventListener("change", async () => {
      try {
        state.saved = await api("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...j, note: note.value }) });
        toast("Note saved");
      } catch (err) { toast(err.message); }
    });
    return jobCard(j, () => select(j, $("#savedDetail")), note);
  }));
  if (state.selected && isSaved(state.selected.key)) $$("#savedList .job-card").forEach((c) => c.classList.toggle("selected", c.dataset.key === state.selected.key));
}

$("#exportSaved").addEventListener("click", () => {
  if (!state.saved.length) return toast("Nothing to export");
  const cols = ["title", "company", "location", "date", "deadline", "portal", "url", "applyUrl", "note", "savedAt"];
  // Prefix formula-leading cells so a spreadsheet never evaluates them.
  const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = [cols.join(","), ...state.saved.map((j) => cols.map((c) => cell(j[c])).join(","))].join("\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `saved_jobs_${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------ applications
const STAGES = [
  { label: "Drafted", match: ["drafted"] },
  { label: "Applied", match: ["applied", "submitted"] },
  { label: "Interviewing", match: ["screening", "interview", "interviewing", "second_interview", "final_interview"] },
  { label: "Offers", match: ["offer", "accepted"] },
  { label: "Closed", match: ["rejected", "withdrawn", "no_response", "no response", "ghosted", "offer_declined", "offer declined"] },
];

async function renderApplications() {
  const pipe = $("#pipeline");
  const table = $("#trackerTable");
  let data;
  try { data = await api("/api/tracker"); } catch (err) { return table.replaceChildren(emptyState("inbox", "Couldn't read the tracker", err.message)); }
  if (!data.exists || !data.rows.length) {
    pipe.replaceChildren();
    return table.replaceChildren(emptyState("briefcase", "No applications yet",
      "When you run /apply in Claude Code, each application is recorded in job_search_tracker.csv and appears here."));
  }
  const rows = [...data.rows].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const status = (r) => (r.status || "").trim().toLowerCase();
  pipe.replaceChildren(
    h("div", { class: "stage" }, h("div", { class: "label" }, "Total"), h("div", { class: "value" }, rows.length)),
    ...STAGES.map((s) => {
      const n = rows.filter((r) => s.match.includes(status(r))).length;
      const bar = h("i");
      bar.style.width = `${Math.round((n / rows.length) * 100)}%`;
      return h("div", { class: "stage" }, h("div", { class: "label" }, s.label), h("div", { class: "value" }, n), h("div", { class: "bar" }, bar));
    }),
  );
  const cols = [["date", "Date"], ["company", "Company"], ["role", "Role"], ["status", "Status"], ["fit_rating", "Fit"], ["deadline", "Deadline"], ["source", "Posting"]];
  table.replaceChildren(h("table", {},
    h("thead", {}, h("tr", {}, cols.map(([, l]) => h("th", {}, l)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, cols.map(([k]) => {
      const v = r[k] || "";
      if (k === "company") return h("td", {}, h("strong", {}, v || "—"));
      if (k === "status") return h("td", {}, v ? h("span", { class: `status s-${status(r).replace(/\s+/g, "_")}` }, v) : "—");
      if (k === "fit_rating") return h("td", {}, v ? `${v}/100` : "—");
      if (k === "deadline" || k === "date") return h("td", {}, v ? fmtDate(v) : "—");
      if (k === "source") return h("td", {}, /^https?:\/\//.test(v) ? h("a", { href: v, target: "_blank", rel: "noopener noreferrer" }, "Open") : "—");
      return h("td", {}, v || "—");
    }))))));
}

// ------------------------------------------------------------------ routing
function currentRoute() { return (location.hash.match(/^#\/(\w+)/) || [, "search"])[1]; }

function route() {
  const r = ["search", "saved", "applications"].includes(currentRoute()) ? currentRoute() : "search";
  for (const v of ["search", "saved", "applications"]) $(`#view-${v}`).hidden = v !== r;
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.route === r));
  closeDrawers();
  state.selected = null;
  if (r === "saved") { renderDetail($("#savedDetail"), null); renderSaved(); }
  if (r === "applications") renderApplications();
  if (r === "search") { renderDetail($("#detail"), null); renderResults(); }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ boot
(async function boot() {
  try { state.portals = await api("/api/portals"); } catch (err) { toast(err.message); }
  const ids = state.portals.map((p) => p.id);
  state.enabled = new Set([...state.enabled].filter((id) => ids.includes(id)));
  if (!state.enabled.size) state.enabled = new Set(state.portals.filter((p) => !p.offByDefault).map((p) => p.id));
  const initial = new URLSearchParams((location.hash.split("?")[1]) || "");
  for (const k of Object.keys(state.params)) if (initial.get(k)) state.params[k] = initial.get(k);
  syncFilterUI();
  renderChips();
  await loadSaved();
  route();
  if (currentRoute() === "search" && (state.params.q || state.params.location)) runSearch();
})();
