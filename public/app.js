"use strict";

// The Canvas token lives in an HttpOnly cookie set by /api/login; this script
// never stores or reads it. It stays until the student presses "Sign out".
const LEGACY_KEY = "wtr.session"; // older versions kept the token here
const CACHE = "wtr.report.";      // last report per course, for offline viewing
const COURSE = "wtr.course";      // last selected course id

const COLS = [ // [category, full label, short label]
  ["reading", "Reading Quiz", "Reading"],
  ["lab", "Lab", "Lab"],
  ["report", "Discussion", "Discuss."],
  ["terminal", "Terminal Quiz", "Terminal"],
  ["other", "Other", "Other"],
];

// The course is linear. Inside a lesson:
//   Reading Quiz (65%+)  ->  Discussion
//   Discussion + Lab     ->  Terminal Quiz
// Across lessons: you can work up to your latest passed terminal quiz's
// lesson + UNLOCK_AHEAD; everything in later lessons is blocked.
const UNLOCK_AHEAD = 2;
const GATED = ["reading", "lab", "report", "terminal"];

const LABEL = { done: "✓ Done", todo: "To do", missing: "Missing", retake: "Retake", pending: "Awaiting grade", locked: "Closed", blocked: "Blocked", none: "—" };
const OPEN = ["todo", "missing", "retake"]; // still needs work

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Build DOM safely: Canvas content is never injected as HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

let report = null;
let filter = "all";

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: "no-store", credentials: "same-origin" }
    : { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Error ${res.status}`);
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  return data;
}

// Signed out on the server, or Canvas rejected the token: back to sign-in.
// The cookie is left alone; only "Sign out" removes it.
function authFailed(err) {
  if (err.status !== 401) return false;
  showLogin(err.code === "signed_out" ? "" : err.message);
  return true;
}

function busy(on) { $("loading").hidden = !on; }

// ---------- Login ----------
async function showLogin(message) {
  $("app").hidden = true;
  $("login").hidden = false;
  const err = $("login-error");
  err.hidden = !message;
  err.textContent = message || "";
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("token").value.trim();
  if (!token) return;
  $("login-btn").disabled = true;
  busy(true);
  try {
    const me = await api("/api/login", { token });
    $("token").value = "";
    await showDashboard(me);
  } catch (err) {
    showLogin(err.code === "token_rejected" ? "Canvas didn't accept that token. Check you copied all of it and that it hasn't been deleted." : err.message);
  } finally {
    $("login-btn").disabled = false;
    busy(false);
  }
});

$("logout").addEventListener("click", async () => {
  busy(true);
  try { await api("/api/logout", {}); } catch {}
  busy(false);
  store.del(COURSE);
  Object.keys(localStorage).filter((k) => k.startsWith(CACHE)).forEach((k) => store.del(k));
  report = null;
  showLogin();
});

// ---------- Dashboard ----------
async function showDashboard(me) {
  renderUser(me);
  $("login").hidden = true;
  $("app").hidden = false;
  await loadReport();
}

function renderUser({ user, courses }) {
  const first = (user.shortName || user.name || "there").split(" ")[0];
  $("hello").textContent = `Hi, ${first} 👋`;
  const av = $("avatar");
  if (user.avatar) av.src = user.avatar; else av.removeAttribute("src");

  const sel = $("course");
  sel.replaceChildren(...courses.map((c) => h("option", { value: c.id, text: c.name })));
  const saved = store.get(COURSE);
  const webTech = courses.find((c) => /web\s*tech/i.test(c.name));
  const pick = courses.find((c) => String(c.id) === String(saved)) || webTech || courses[0];
  if (pick) sel.value = pick.id;
}

$("course").addEventListener("change", () => { store.set(COURSE, $("course").value); loadReport(); });
$("refresh").addEventListener("click", () => loadReport());
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    renderLessons();
  })
);

async function loadReport() {
  const courseId = $("course").value;
  if (!courseId) return;
  $("app-error").hidden = true;
  $("offline").hidden = true;
  const cached = store.get(CACHE + courseId);
  if (cached) { report = gate(cached); render(); }
  busy(!cached);
  try {
    const fresh = await api(`/api/report?course=${encodeURIComponent(courseId)}`);
    store.set(CACHE + courseId, fresh);
    report = gate(fresh);
    render();
  } catch (err) {
    if (authFailed(err)) return;
    if (cached && !navigator.onLine) $("offline").hidden = false;
    else { $("app-error").textContent = err.message; $("app-error").hidden = false; }
  } finally {
    busy(false);
  }
}

function tracked(items) { return items.filter((i) => i.status !== "none"); }

function gate(r) {
  const passed = r.modules
    .filter((m) => m.lesson != null && m.items.some((i) => i.category === "terminal" && i.status === "done"))
    .map((m) => m.lesson);
  const lastPassed = passed.length ? Math.max(...passed) : 0;
  const unlockedThrough = lastPassed + UNLOCK_AHEAD;
  const pct = (k) => Math.round(((r.pass && r.pass[k]) || (k === "reading" ? 0.65 : 0.8)) * 100);
  const allDone = (items, cat) => items.filter((i) => i.category === cat).every((i) => i.status === "done");

  const modules = r.modules.map((m) => {
    if (m.lesson == null) return m;
    const blocked = m.lesson > unlockedThrough;
    const why = {};
    if (blocked) {
      const reason = `Unlocks after you pass the Lesson ${m.lesson - UNLOCK_AHEAD} terminal quiz`;
      GATED.forEach((c) => (why[c] = reason));
    } else {
      if (!allDone(m.items, "reading")) why.report = `Pass the reading quiz (${pct("reading")}%+) first`;
      const needs = [!allDone(m.items, "report") && "discussion", !allDone(m.items, "lab") && "lab"].filter(Boolean);
      if (needs.length) why.terminal = `Finish the ${needs.join(" and ")} first`;
    }
    return {
      ...m,
      blocked,
      // Anything already finished keeps its tick.
      items: m.items.map((i) => (why[i.category] && i.status !== "done" ? { ...i, status: "blocked", blockedBy: why[i.category] } : i)),
    };
  });
  return { ...r, modules, lastPassed, unlockedThrough };
}

function render() {
  const all = tracked(report.modules.flatMap((m) => m.items));
  const count = (s) => all.filter((i) => s.includes(i.status)).length;
  const done = count(["done"]);
  const todo = count(OPEN);
  const locked = count(["locked"]);
  const blocked = count(["blocked"]);
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  $("course-name").textContent = report.course.name;
  $("pct").textContent = `${pct}%`;
  $("ring-fg").style.strokeDashoffset = String(326.7 * (1 - pct / 100));
  $("n-done").textContent = done;
  $("n-todo").textContent = todo;
  $("n-locked").textContent = locked;
  $("n-blocked").textContent = blocked;
  $("updated").textContent = `Updated ${new Date(report.fetchedAt).toLocaleString()}`;

  renderSummary(all);
  renderTodo();
  renderLessons();
}

const SUMMARY_ROWS = [ // [category, full label, short label]
  ["reading", "Reading Quizzes", "Reading"],
  ["lab", "Labs", "Labs"],
  ["report", "Discussion Reports", "Discuss."],
  ["terminal", "Terminal Quizzes", "Terminal"],
  ["other", "Other Assignments", "Other"],
];

function tally(items) {
  const n = (s) => items.filter((i) => s.includes(i.status)).length;
  const graded = items.filter((i) => (i.status === "done" || i.status === "retake") && i.score != null && i.points > 0);
  return {
    total: items.length,
    done: n(["done"]),
    todo: n(OPEN),
    locked: n(["locked"]),
    blocked: n(["blocked"]),
    score: graded.reduce((a, i) => a + i.score, 0),
    points: graded.reduce((a, i) => a + i.points, 0),
  };
}

function summaryRow(label, t, short = label) {
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const num = (v, cls) => h("td", { class: `${cls}${v ? "" : " zero"}`, text: String(v) });
  const score = t.points
    ? [h("span", { class: "frac", text: `${+t.score.toFixed(1)}/${t.points} ` }), h("span", { class: "pct", text: `${Math.round((t.score / t.points) * 100)}%` })]
    : "—";
  const fill = h("i");
  fill.style.width = `${pct}%`; // CSSOM, so the strict CSP allows it
  return h("tr", {},
    h("td", {}, h("span", { class: "full", text: label }), h("span", { class: "short", text: short })),
    h("td", {}, `${t.done}/${t.total}`, h("span", { class: "bar", "aria-hidden": "true" }, fill)),
    num(t.todo, "n-todo"),
    num(t.locked, "n-locked"),
    num(t.blocked, "n-blocked"),
    h("td", {}, score)
  );
}

function renderSummary(all) {
  const rows = SUMMARY_ROWS
    .map(([k, label, short]) => [label, short, all.filter((i) => i.category === k)])
    .filter(([, , items]) => items.length)
    .map(([label, short, items]) => summaryRow(label, tally(items), short));
  $("summary-table").replaceChildren(
    h("thead", {}, h("tr", {}, ["Category", "Done", "To do", "Closed", "Blocked", "Score"].map((t) => h("th", { scope: "col", class: t === "Closed" ? "n-locked" : null, text: t })))),
    h("tbody", {}, rows),
    h("tfoot", {}, summaryRow("Total", tally(all)))
  );
}

function passMark(i) {
  return +(i.points * ((report.pass || {})[i.category] || 0.8)).toFixed(1);
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderTodo() {
  const items = report.modules.flatMap((m) =>
    m.items.filter((i) => OPEN.includes(i.status)).map((i) => ({ ...i, module: m.name }))
  );
  // Most points first, then soonest due.
  items.sort((a, b) => (b.points || 0) - (a.points || 0) || (a.due || "9").localeCompare(b.due || "9"));
  const list = $("todo");
  if (!items.length) {
    list.replaceChildren(h("li", { class: "empty", text: "🎉 Nothing left to do. You're all caught up!" }));
    return;
  }
  list.replaceChildren(
    ...items.map((i) => {
      const meta = [i.module];
      if (i.status === "retake") meta.push(`scored ${i.score}/${i.points}, need ${passMark(i)} to pass`);
      else if (i.points) meta.push(`${i.points} pts`);
      if (i.due) meta.push(`due ${fmtDate(i.due)}`);
      return h("li", {},
        h("a", { href: i.url, target: "_blank", rel: "noopener" },
          h("div", {}, h("div", { class: "t-title", text: i.title }), h("div", { class: "t-meta", text: meta.join(" · ") })),
          h("span", { class: `chip ${i.status}`, text: LABEL[i.status] })
        )
      );
    })
  );
}

function chip(item) {
  let text = LABEL[item.status];
  if ((item.status === "done" || item.status === "retake") && item.score != null && item.points) text += ` ${item.score}/${item.points}`;
  return h("a", { class: `chip ${item.status}`, href: item.url, target: "_blank", rel: "noopener", title: item.title, text });
}

const SVG = "http://www.w3.org/2000/svg";
function lockIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shackle = document.createElementNS(SVG, "path");
  shackle.setAttribute("d", "M8 11V8a4 4 0 0 1 8 0v3");
  const body = document.createElementNS(SVG, "rect");
  Object.entries({ x: 5, y: 11, width: 14, height: 10, rx: 2 }).forEach(([k, v]) => body.setAttribute(k, v));
  svg.append(shackle, body);
  return svg;
}

// One ✓ / ✗ / lock mark per item, linked to Canvas.
function mark(i) {
  const kind = i.status === "done" ? "ok" : i.status === "blocked" ? "lock" : "no";
  const scored = i.score != null && i.points > 1 && (i.status === "done" || i.status === "retake");
  const why = { blocked: i.blockedBy || "Blocked", pending: "Awaiting grade", retake: `Below the ${Math.round(((report.pass || {})[i.category] || 0.8) * 100)}% pass mark, retake`, locked: "Closed", missing: "Missing", todo: "Not done", done: "Done" }[i.status] || "";
  const label = `${i.title}: ${why}${scored ? ` (${i.score}/${i.points})` : ""}`;
  return h("a", { class: `mk ${kind}`, href: i.url, target: "_blank", rel: "noopener", title: label, "aria-label": label },
    kind === "lock" ? lockIcon() : h("b", { text: kind === "ok" ? "✓" : "✗" }),
    scored ? h("small", { text: `${i.score}/${i.points}` }) : null
  );
}

function renderLessons() {
  const lessons = report.modules.filter((m) => m.lesson != null);
  const extra = report.modules.filter((m) => m.lesson == null);
  const visible = lessons.filter((m) => filter === "all" || m.items.some((i) => OPEN.includes(i.status)));
  const cols = COLS.filter(([k]) => lessons.some((m) => m.items.some((i) => i.category === k)));

  const next = lessons.find((m) => m.blocked);
  $("gate-note").textContent = next
    ? `You can work up to Lesson ${report.unlockedThrough} (latest passed terminal quiz: ${report.lastPassed ? `Lesson ${report.lastPassed}` : "none yet"}, plus ${UNLOCK_AHEAD}). In each lesson: reading quiz (65%+) → discussion; discussion + lab → terminal quiz.`
    : `Every lesson is unlocked. In each lesson: reading quiz (65%+) → discussion; discussion + lab → terminal quiz.`;

  const head = h("tr", {},
    h("th", { scope: "col", text: "Lesson" }),
    cols.map(([, full, short]) => h("th", { scope: "col" }, h("span", { class: "full", text: full }), h("span", { class: "short", text: short })))
  );
  const rows = visible.map((m) =>
    h("tr", { class: m.blocked ? "blocked-row" : null },
      h("th", { scope: "row" }, h("span", { class: "full", text: m.name }), h("span", { class: "short", text: m.lesson != null ? `L${m.lesson}` : m.name })),
      cols.map(([k]) => {
        const items = m.items.filter((i) => i.category === k);
        return h("td", {}, items.length ? h("div", { class: "marks" }, items.map(mark)) : h("span", { class: "na", text: "—" }));
      })
    )
  );
  const empty = visible.length ? null : h("tr", {}, h("td", { colspan: cols.length + 1, class: "muted", text: "Nothing unfinished in the open lessons." }));
  $("grid").replaceChildren(h("thead", {}, head), h("tbody", {}, rows, empty));

  $("legend-lock").replaceChildren(lockIcon());
  $("extra-section").hidden = !extra.length;
  $("extra").replaceChildren(...extra.map(moduleCard));
}

function shortTitle(t) {
  return t.replace(/^less+on\s*\d+\s*[-—–:]*\s*/i, "") || t;
}

function moduleCard(m) {
  const items = m.items.filter((i) => i.category !== "resource" || i.url);
  const t = tracked(items);
  const doneCount = t.filter((i) => i.status === "done").length;
  return h("article", { class: "card" },
    h("h4", {}, h("span", { text: m.name }), t.length ? h("small", { text: `${doneCount}/${t.length}` }) : null),
    h("ul", {}, items.map((i) =>
      h("li", {},
        h("a", { class: "title", href: i.url, target: "_blank", rel: "noopener", text: m.lesson != null ? shortTitle(i.title) : i.title }),
        i.status === "none" ? null : chip(i)
      )
    ))
  );
}

// ---------- Boot ----------
window.addEventListener("online", () => { if (!$("app").hidden) loadReport(); });

(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  // Ask the browser not to evict saved reports under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  busy(true);
  try {
    // Move a token saved by an older version into the cookie, then forget it here.
    const legacy = store.get(LEGACY_KEY);
    if (legacy && legacy.token) {
      store.del(LEGACY_KEY);
      try { return await showDashboard(await api("/api/login", { token: legacy.token })); } catch {}
    }
    await showDashboard(await api("/api/me"));
  } catch (err) {
    if (authFailed(err)) return;
    // Offline (or Canvas down) on launch: show the last saved report if there is one.
    const courseId = store.get(COURSE);
    const cached = Object.keys(localStorage).filter((k) => k.startsWith(CACHE)).map((k) => store.get(k))
      .find((r) => r && (!courseId || String(r.course.id) === String(courseId)));
    if (cached) {
      report = gate(cached);
      $("hello").textContent = "Welcome back 👋";
      $("course").replaceChildren(h("option", { value: cached.course.id, text: cached.course.name }));
      $("login").hidden = true;
      $("app").hidden = false;
      if (navigator.onLine) { $("app-error").textContent = err.message; $("app-error").hidden = false; }
      else $("offline").hidden = false;
      render();
    } else {
      showLogin(err.message);
    }
  } finally {
    busy(false);
  }
})();
