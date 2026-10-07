// Canvas proxy + report builder, shared by the local server and Vercel functions.
// Tokens are forwarded per request and never stored or logged.

// The Canvas site is an internal setting; students never see or choose it.
const CANVAS_HOST = (process.env.CANVAS_HOST || "ashesi.instructure.com").trim().toLowerCase();
// Quizzes only count as passed at this fraction of their points.
const PASS = {
  reading: Number(process.env.READING_PASS || 0.65),
  terminal: Number(process.env.TERMINAL_PASS || 0.8),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

class CanvasError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

async function canvasGetAll(host, token, pathAndQuery) {
  let url = `https://${host}/api/v1${pathAndQuery}`;
  let out = [];
  for (let page = 0; url && page < 50; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401) throw new CanvasError(401, "Canvas rejected your token. It may have expired or been deleted. Sign out and enter a new one.", "token_rejected");
    if (res.status === 403) throw new CanvasError(403, "This token doesn't have access to that resource.");
    if (!res.ok) throw new CanvasError(502, `Canvas returned ${res.status}.`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    out = out.concat(data);
    const next = (res.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

// ---- Report building ----

function lessonKey(name) {
  const m = name.match(/(less+on|week|module|unit)[\s_-]*(\d+)/i);
  return m ? Number(m[2]) : null;
}

function category(item) {
  const t = item.title.toLowerCase();
  if (item.type === "Discussion") return "discussion";
  if (/terminal/.test(t)) return "terminal";
  if (/reading/.test(t)) return "reading";
  if (/discussion\s*report/.test(t)) return "report";
  if (/\blabs?\b/.test(t)) return "lab";
  if (item.type === "Assignment" || item.type === "Quiz") return "other";
  return "resource";
}

function itemStatus(item, sub, cat) {
  const req = item.completion_requirement;
  const cd = item.content_details || {};
  const done =
    (req && req.completed) ||
    (sub && (["submitted", "graded", "pending_review"].includes(sub.workflow_state) || sub.excused));
  // Quizzes with a pass mark need the grade, not just a submission.
  // (A quiz worth 0 points can't be measured, so submitting it counts.)
  if (done && PASS[cat] && sub && !sub.excused && cd.points_possible > 0) {
    if (sub.score == null) return "pending";
    if (sub.score / cd.points_possible < PASS[cat]) return "retake";
  }
  if (done) return "done";
  const tracked = req || item.type === "Assignment" || item.type === "Quiz";
  if (!tracked) return "none";
  if (cd.lock_at && new Date(cd.lock_at) < new Date()) return "locked";
  if (sub && sub.missing) return "missing";
  return "todo";
}

const ORDER = { reading: 0, lab: 1, report: 2, terminal: 3, other: 4 };

// Lessons are built from the gradebook (every assignment + your submission),
// not from modules: some graded work is never added to a module.
// Modules are only used for lesson names and the non-lesson resources.
async function buildReport(host, token, courseId) {
  const [course, assignments, modules] = await Promise.all([
    canvasGetAll(host, token, `/courses/${courseId}`),
    canvasGetAll(host, token, `/courses/${courseId}/assignments?include[]=submission&order_by=position&per_page=100`),
    canvasGetAll(host, token, `/courses/${courseId}/modules?include[]=items&include[]=content_details&per_page=100`).catch(() => []),
  ]);

  const lessons = new Map();
  const lessonFor = (n) => {
    if (!lessons.has(n)) lessons.set(n, { id: `lesson-${n}`, name: `Lesson ${n}`, lesson: n, items: [] });
    return lessons.get(n);
  };
  for (const mod of modules) {
    const n = lessonKey(mod.name);
    if (n != null) lessonFor(n);
  }

  for (const a of assignments) {
    const n = lessonKey(a.name);
    if (n == null) continue;
    const title = a.name.replace(/\s+/g, " ").trim();
    const cat = category({ title, type: "Assignment" });
    const sub = a.submission || null;
    const types = a.submission_types || [];
    // Skip placeholders a student can't do (no points, nothing to submit, no grade).
    if (cat === "other" && !a.points_possible && types.every((t) => t === "none" || t === "not_graded") && !(sub && sub.score != null)) continue;
    const item = { type: "Assignment", content_details: { points_possible: a.points_possible, lock_at: a.lock_at, due_at: a.due_at } };
    lessonFor(n).items.push({
      id: a.id,
      title,
      type: "Assignment",
      category: cat,
      status: itemStatus(item, sub, cat),
      url: a.html_url,
      due: a.due_at || null,
      lockAt: a.lock_at || null,
      points: a.points_possible ?? null,
      score: sub && sub.score != null ? sub.score : null,
      late: !!(sub && sub.late),
    });
  }

  const lessonModules = [...lessons.values()].sort((x, y) => x.lesson - y.lesson);
  lessonModules.forEach((m) => m.items.sort((x, y) => ORDER[x.category] - ORDER[y.category]));

  const otherModules = modules
    .filter((mod) => lessonKey(mod.name) == null)
    .map((mod) => ({
      id: mod.id,
      name: mod.name,
      lesson: null,
      items: (mod.items || [])
        .filter((it) => it.type !== "SubHeader")
        .map((it) => ({ id: it.id, title: it.title.replace(/\s+/g, " ").trim(), type: it.type, category: "resource", status: "none", url: it.html_url })),
    }));

  return {
    course: { id: course.id, name: course.name, code: course.course_code },
    pass: PASS,
    modules: [...otherModules, ...lessonModules],
    fetchedAt: new Date().toISOString(),
  };
}

// ---- HTTP ----
// The session (just the token) lives in an HttpOnly cookie, so page scripts never see the token.
// It is renewed on every request and only removed by /api/logout.

const COOKIE = "wtr_session";
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // browsers cap cookie lifetime at 400 days

function sendJSON(res, status, body, cookie) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS };
  if (cookie !== undefined) headers["Set-Cookie"] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sessionCookie(session) {
  const base = `${COOKIE}=%s; Path=/api; HttpOnly; Secure; SameSite=Strict`;
  if (!session) return base.replace("%s", "") + "; Max-Age=0";
  const value = Buffer.from(JSON.stringify({ token: session.token })).toString("base64url");
  return base.replace("%s", value) + `; Max-Age=${COOKIE_MAX_AGE}`;
}

function readSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  try {
    const s = JSON.parse(Buffer.from(raw.slice(COOKIE.length + 1), "base64url").toString());
    return s && s.token ? { host: CANVAS_HOST, token: s.token } : null;
  } catch { return null; }
}

function validate({ token }) {
  token = String(token || "").trim();
  if (!token || token.length > 200) throw new CanvasError(400, "Enter your Canvas token.");
  return { host: CANVAS_HOST, token };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel pre-parses JSON
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 10000) break; }
  try { return JSON.parse(data || "{}"); } catch { return {}; }
}

async function profile({ host, token }) {
  const [user, courses] = await Promise.all([
    canvasGetAll(host, token, "/users/self"),
    canvasGetAll(host, token, "/courses?enrollment_state=active&enrollment_type=student&per_page=100"),
  ]);
  return {
    user: { id: user.id, name: user.name, shortName: user.short_name, avatar: user.avatar_url },
    courses: courses.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, code: c.course_code })),
  };
}

async function handleApi(req, res, route) {
  const url = new URL(req.url, "http://localhost");
  route = route || url.pathname;
  try {
    if (route === "/api/health") return sendJSON(res, 200, { ok: true });

    if (route === "/api/login") {
      if (req.method !== "POST") throw new CanvasError(405, "Use POST.");
      const session = validate(await readBody(req));
      const me = await profile(session); // only keep tokens Canvas accepts
      return sendJSON(res, 200, me, sessionCookie(session));
    }
    if (route === "/api/logout") {
      if (req.method !== "POST") throw new CanvasError(405, "Use POST.");
      return sendJSON(res, 200, { ok: true }, sessionCookie(null));
    }

    const session = readSession(req);
    if (!session) throw new CanvasError(401, "Please sign in.", "signed_out");
    const renew = sessionCookie(session);

    if (route === "/api/me") return sendJSON(res, 200, await profile(session), renew);
    if (route === "/api/report") {
      const courseId = url.searchParams.get("course");
      if (!/^\d+$/.test(courseId || "")) throw new CanvasError(400, "Bad course id.");
      return sendJSON(res, 200, await buildReport(session.host, session.token, courseId), renew);
    }
    sendJSON(res, 404, { error: "Not found" });
  } catch (e) {
    const known = e instanceof CanvasError;
    if (!known) console.error("api error:", e.message);
    sendJSON(res, known ? e.status : 502, { error: known ? e.message : "Couldn't reach Canvas. Try again.", code: known ? e.code : undefined });
  }
}

module.exports = { handleApi, SECURITY_HEADERS, MIME };
