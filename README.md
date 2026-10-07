# Web Tech Report

A progressive web app that shows a student's Canvas course progress. It has a summary table for each category, a "still to do" list, and a lesson-by-lesson grid of reading quizzes, labs, discussion reports and terminal quizzes, with ticks for everything you've finished.

- **Sign in with a Canvas access token** (Account → Settings → Approved Integrations → New Access Token).
- **Personal:** it greets you by name, shows your avatar, and opens Web Technologies by default. You can switch to any of your active courses.
- **Stays signed in until you sign out:** after sign-in, the token is kept in an HttpOnly, Secure, SameSite=Strict cookie. Page scripts can't read it, and Safari's 7-day storage cleanup doesn't remove it. The cookie is renewed on every visit (browsers cap a single cookie at 400 days) and is only removed when you press "Sign out".
- **Installable and works offline:** you can add it to your home screen, and it shows your last saved report when you're offline.
- **Private:** the API only forwards each request to Canvas (Canvas blocks direct browser calls). It never stores or logs tokens, and it only talks to `*.instructure.com`.

## Layout

- `public/` holds the static PWA (HTML, CSS, JS, service worker, manifest, icons).
- `api/` holds the Vercel serverless functions (`/api/login`, `/api/logout`, `/api/me`, `/api/report`, `/api/health`).
- `lib/canvas.js` holds the Canvas proxy and report builder that both use.
- `server.js` is a zero-dependency local dev server that runs the same routes.

## Run locally

```sh
npm start        # http://localhost:3000 (Node 20+)
```

## Deploy

```sh
vercel deploy --prod
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `CANVAS_HOST` | `ashesi.instructure.com` | The Canvas site to read from (internal; students never see it) |
| `TERMINAL_PASS` | `0.8` | Fraction of points a terminal quiz needs to count as passed |
| `READING_PASS` | `0.65` | Fraction of points a reading quiz needs to count as passed |
