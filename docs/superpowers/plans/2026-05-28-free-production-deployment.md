# Free Production Deployment (Hardened) — Implementation Plan

> **For agentic workers:** This plan is decomposed into **independent work units (U1–U11)** designed for parallel execution on the taskboard. Each unit lists its **dependencies**, the **files it owns**, and which units it is **parallel-safe** with. **Rule: no two units that can run concurrently ever edit the same file** — so parallel agents never conflict. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Pollit live-polling app and deploy it to the public internet for $0/month — frontend on Vercel, backend (Express + Socket.IO) on Koyeb's free tier, MongoDB Atlas M0, Google Gemini — meeting production security standards for a portfolio/demo.

**Architecture:** Static Angular SPA on Vercel talks over HTTPS/WSS to a single always-on Node container on Koyeb that holds Socket.IO room state in memory. The backend is split into a testable `app.js` (Express + middleware + routes) and a `server.js` bootstrap (DB connect + HTTP/Socket.IO). Security middleware (helmet, CORS allowlist, rate limiting, mongo-sanitize, central error handler) is added before exposure. Secrets live only in platform env stores.

**Tech Stack:** Node 20, Express 4, Socket.IO 4, Mongoose 8, Angular 17, `helmet`, `express-rate-limit`, `express-mongo-sanitize`, `bcryptjs`, `node:test` + `supertest` for tests, Docker (Koyeb), GitHub Actions (CI).

**Spec:** [docs/superpowers/specs/2026-05-28-free-production-deployment-design.md](../specs/2026-05-28-free-production-deployment-design.md)

---

## Parallel Execution Map (taskboard-ready)

| Unit | Title | Depends on | Owns (files — no overlap with concurrent units) | Wave |
|------|-------|-----------|--------------------------------------------------|------|
| **U1** | Backend foundation & app-level security | — | `backend/package.json`, `backend/package-lock.json`, `backend/src/app.js`, `backend/src/server.js`, `backend/src/config/cors.js`, `backend/src/middleware/errorHandler.js`, `backend/test/*.test.js` (smoke/headers/ratelimit/errors) | 1 |
| **U2** | Auth controller hardening | U1 | `backend/src/controllers/authController.js`, `backend/test/security.admin.test.js` | 2 |
| **U3** | Socket hardening | — | `backend/src/sockets/pollSocket.js` | 1 |
| **U4** | REST controller error hygiene | — | `backend/src/controllers/sessionController.js`, `backend/src/controllers/pollController.js`, `backend/src/controllers/userController.js` | 1 |
| **U6** | Frontend cleanup, prod config & audit | — | everything under `frontend/` (except `dist/`) | 1 |
| **U7** | Backend Dockerfile | U1 | `backend/Dockerfile`, `backend/.dockerignore` | 2 |
| **U8** | CI workflow | — (green run needs U1–U6) | `.github/workflows/ci.yml` | 1 |
| **U9** | Pre-flight checks | — | none (audit only) | 1 |
| **U10** | Provisioning & deploy | U1,U2,U3,U4,U6,U7 | platform dashboards + `frontend/src/environments/environment.prod.ts` (host fill-in) | 3 |
| **U11** | Verify & ops | U10 | `README.md` | 4 |

**Wave schedule for the taskboard:**
- **Wave 1 (launch all at once — 6 parallel agents):** U1, U3, U4, U6, U8, U9. All edit disjoint files (or none).
- **Wave 2 (after U1 merges):** U2, U7.
- **Wave 3 (after backend hardened + Dockerfile + frontend config):** U10 — needs human-held credentials.
- **Wave 4 (after deploy):** U11.

```
        ┌── U1 ─────┬── U2 ──┐
Wave1 ──┤   U3      │   U7   ├── U10 ── U11   (Waves 3,4)
        │   U4      └────────┘
        │   U6 ───────────────┘
        │   U8 (file now; green after Wave 2)
        └── U9
```

**Conflict-avoidance notes (read before dispatching):**
- **Git isolation:** give each Wave-1 unit its own branch or worktree (e.g. `feat/u1-foundation`, `feat/u3-sockets`, …) and merge into an integration branch as each finishes. File ownership is disjoint, so merges are conflict-free — but multiple agents committing into one shared working tree would still clash at the git index level. One branch per unit avoids that.
- U2 and U4 both live in `backend/src/controllers/`, but **U2 owns only `authController.js`** and **U4 owns the other three controllers** — disjoint files, so they never collide. U4 is Wave 1; U2 is Wave 2 (its test needs U1's `app.js`).
- U1, U3, U4 all run in Wave 1 and never share a file (`app.js`+config+tests vs `pollSocket.js` vs `session/poll/user` controllers).
- U6 is entirely frontend; fully isolated from all backend units.
- U10 edits `environment.prod.ts` to fill in the deployed backend host — by then U6 (which created the file) is long done, so no concurrent writer.

---

## U9 — Pre-flight checks

**Depends on:** none · **Owns:** no files · **Parallel-safe with:** all · **Can start:** immediately

### Step 1: Confirm `.env` is ignored and untracked

Run: `git ls-files | grep -E "(^|/)\.env$"`
Expected: **no output**. If `backend/.env` appears, run `git rm --cached backend/.env` and commit before continuing.

### Step 2: Scan history for leaked secrets

Run: `git log -p --all -S "GEMINI_API_KEY" -- backend | grep -iE "GEMINI_API_KEY\s*=\s*\S" | head`
Run: `git log -p --all -S "mongodb+srv" | head`
Expected: no real key/connection-string values. If any real secret is found, **rotate it** during U10 and note it.

### Step 3: Confirm the working Gemini model

Current model is `gemini-2.5-flash` in [backend/src/services/aiInsightsService.js:62](../../../backend/src/services/aiInsightsService.js#L62).

```bash
cd backend
GEMINI_API_KEY=YOUR_REAL_KEY node -e "
const { GoogleGenerativeAI } = require('@google/generative-ai');
(async () => {
  const m = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: 'gemini-2.5-flash' });
  const r = await m.generateContent('Reply with the single word OK');
  console.log('MODEL OK:', r.response.text().trim());
})().catch(e => { console.error('MODEL FAILED:', e.message); process.exit(1); });
"
```
Expected: `MODEL OK: ...`. If it 404s, change the model string in `aiInsightsService.js:62` to one your key supports (e.g. `gemini-2.0-flash`), commit `chore: pin Gemini model`, and tell U10 to use that string.

**Return:** report whether history was clean (which secrets, if any, must be rotated) and the confirmed Gemini model string.

---

## U1 — Backend foundation & app-level security

**Depends on:** none · **Owns:** `backend/package.json`, `package-lock.json`, `src/app.js`, `src/server.js`, `src/config/cors.js`, `src/middleware/errorHandler.js`, `test/{smoke,security.headers,security.ratelimit,security.errors}.test.js` · **Parallel-safe with:** U3, U4, U6, U8, U9 · **Can start:** immediately

This unit splits the Express app out of `server.js` so it can be imported without a DB, and wires every app-level security control (helmet, CORS allowlist, mongo-sanitize, rate limiting, central error handler). It is the foundation that U2 and U7 build on.

- [ ] **Step 1: Install deps + add the test script**

```bash
cd backend
npm install helmet express-rate-limit express-mongo-sanitize
npm install --save-dev supertest
```

In `backend/package.json`, set the `scripts` block to:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Create `backend/src/config/cors.js`**

```js
// Comma-separated list of allowed origins, e.g. "https://pollit.vercel.app,https://www.pollit.app"
const allowedOrigins = (process.env.CLIENT_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function originCheck(origin, callback) {
  // Allow non-browser / same-origin requests (no Origin header) and whitelisted origins.
  if (!origin || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }
  // Disallowed: respond WITHOUT CORS headers (browser blocks); do not throw.
  return callback(null, false);
}

const corsOptions = { origin: originCheck, credentials: true };

module.exports = { allowedOrigins, corsOptions, originCheck };
```

- [ ] **Step 3: Create `backend/src/middleware/errorHandler.js`**

```js
// Central error handler: logs full detail server-side, returns generic messages to clients.
module.exports = function errorHandler(err, req, res, next) {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  const isParse = err.type === 'entity.parse.failed' || err.status === 400;
  const status = isParse ? 400 : err.status || err.statusCode || 500;
  res.status(status).json({ message: status === 400 ? 'Invalid request' : 'Server error' });
};
```

- [ ] **Step 4: Create `backend/src/app.js` (complete, hardened)**

```js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const sessionRoutes = require('./routes/session.routes');
const userRoutes = require('./routes/user.routes');
const pollRoutes = require('./routes/poll.routes');
const { corsOptions } = require('./config/cors');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', 1); // behind Koyeb's proxy; required for correct client IPs (rate limiting)
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(mongoSanitize());

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later' }
});
app.use('/api/auth', authLimiter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/poll', pollRoutes);

app.use((req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler);

module.exports = app;
```

- [ ] **Step 5: Replace `backend/src/server.js` with a thin bootstrap**

```js
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const connectDB = require('./config/db');
const { allowedOrigins } = require('./config/cors');
const pollSocket = require('./sockets/pollSocket');

const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }
});
pollSocket(io);

connectDB().then(() => {
  httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

module.exports = { app, httpServer };
```

- [ ] **Step 6: Write the four infra tests**

Create `backend/test/smoke.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
const request = require('supertest');
const app = require('../src/app');

test('health endpoint responds without a database connection', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});
```

Create `backend/test/security.headers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
const request = require('supertest');
const app = require('../src/app');

test('helmet sets X-Content-Type-Options: nosniff', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
});
test('allowed origin receives a matching CORS header', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'https://allowed.example');
  assert.strictEqual(res.headers['access-control-allow-origin'], 'https://allowed.example');
});
test('disallowed origin receives NO CORS header', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
});
```

Create `backend/test/security.ratelimit.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
process.env.AUTH_RATE_LIMIT_MAX = '2';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('x', 10);
const request = require('supertest');
const app = require('../src/app');

test('auth endpoints return 429 after exceeding the limit', async () => {
  // admin-login touches no DB, so it is safe to hammer in tests
  await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'wrong' });
  await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'wrong' });
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'wrong' });
  assert.strictEqual(res.status, 429);
});
```

Create `backend/test/security.errors.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
const request = require('supertest');
const app = require('../src/app');

test('malformed JSON returns a generic 400 with no leaked detail', async () => {
  const res = await request(app)
    .post('/api/auth/admin-login')
    .set('Content-Type', 'application/json')
    .send('{ this is not json');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.message, 'Invalid request');
  assert.ok(!res.body.error, 'response must not contain an error/stack field');
});
```

- [ ] **Step 7: Run the suite**

Run: `cd backend && npm test`
Expected: all tests PASS (smoke 1, headers 3, ratelimit 1, errors 1). Process exits cleanly (no hanging DB connection).

- [ ] **Step 8: Audit-fix backend deps (this unit owns package.json)**

Run: `cd backend && npm audit --audit-level=high; npm audit fix`
Then re-run: `cd backend && npm test` → all PASS.
If high/critical remain that `fix` won't resolve without `--force`, note them for the PR (do not `--force` blindly).

- [ ] **Step 9: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/app.js backend/src/server.js backend/src/config/cors.js backend/src/middleware/errorHandler.js backend/test
git commit -m "feat(security): split app/server, add helmet+cors+rate-limit+sanitize+error handler, test harness"
```

**Return:** confirmation that `npm test` is green and the audit status.

---

## U3 — Socket hardening

**Depends on:** none · **Owns:** `backend/src/sockets/pollSocket.js` · **Parallel-safe with:** U1, U4, U6, U8, U9 · **Can start:** immediately
(Verifies with `node --check` + grep, so it does not need U1's test harness.)

- [ ] **Step 1: Add a per-socket vote throttle**

In `backend/src/sockets/pollSocket.js`, immediately after `io.on('connection', (socket) => {` ([line 85](../../../backend/src/sockets/pollSocket.js#L85)), add:

```js
    // Per-socket vote throttle: max 5 votes / second
    const voteTimestamps = [];
    function voteAllowed() {
      const now = Date.now();
      while (voteTimestamps.length && now - voteTimestamps[0] > 1000) voteTimestamps.shift();
      if (voteTimestamps.length >= 5) return false;
      voteTimestamps.push(now);
      return true;
    }
```

- [ ] **Step 2: Guard the `audience:join` payload (NoSQL-injection)**

`code` flows into `Session.findOne({ code })`; a payload like `{ code: { $ne: null } }` would otherwise match arbitrary sessions. At the very start of the `audience:join` try block (after `try {`, before `const session = await Session.findOne({ code });` at [line 183](../../../backend/src/sockets/pollSocket.js#L183)), add:

```js
        if (typeof code !== 'string' || code.length > 12) {
          return ack && ack({ ok: false, error: 'Invalid code' });
        }
        if (voterKey !== undefined && typeof voterKey !== 'string') {
          return ack && ack({ ok: false, error: 'Invalid voterKey' });
        }
```

- [ ] **Step 3: Throttle + guard the `audience:vote` payload**

At the very start of the `audience:vote` try block (after `try {` at [line 227](../../../backend/src/sockets/pollSocket.js#L227)), add:

```js
        if (!voteAllowed()) return ack && ack({ ok: false, error: 'Rate limit' });
        if (typeof pollIndex !== 'number' || typeof voterKey !== 'string') {
          return ack && ack({ ok: false, error: 'Invalid vote' });
        }
        if (typeof answer !== 'string' && typeof answer !== 'number') {
          return ack && ack({ ok: false, error: 'Invalid answer' });
        }
```

- [ ] **Step 4: Stop leaking `err.message` from socket acks**

Run: `cd backend && sed -i 's/error: err.message/error: '"'"'Server error'"'"'/g' src/sockets/pollSocket.js`

Verify the only remaining `err.message` uses are server-side logs:
Run: `cd backend && grep -n "err.message" src/sockets/pollSocket.js`
Expected: matches appear **only** inside `console.error(...)` lines (e.g. `'Insights pipeline error:', err.message`), never inside `ack(...)`.

- [ ] **Step 5: Verify (no test harness needed)**

Run: `cd backend && node --check src/sockets/pollSocket.js && grep -c "Invalid code\|Invalid voterKey\|Invalid vote\|Invalid answer" src/sockets/pollSocket.js`
Expected: no syntax error; grep count `4`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/sockets/pollSocket.js
git commit -m "feat(security): throttle socket votes, validate payload types, stop leaking errors"
```

**Return:** confirmation that the guards are present and `node --check` passes.

---

## U4 — REST controller error hygiene

**Depends on:** none · **Owns:** `backend/src/controllers/sessionController.js`, `pollController.js`, `userController.js` (NOT `authController.js` — that's U2) · **Parallel-safe with:** U1, U3, U6, U8, U9 · **Can start:** immediately

These three controllers return `error: err.message` to clients in their `catch` blocks, leaking internal detail. Strip it (the central handler from U1 covers uncaught errors; these `catch` blocks just return a generic message).

- [ ] **Step 1: Strip `error: err.message` from the three controllers**

```bash
cd backend && sed -i "s/res.status(500).json({ message: 'Server error', error: err.message });/res.status(500).json({ message: 'Server error' });/g" src/controllers/sessionController.js src/controllers/pollController.js src/controllers/userController.js
```

- [ ] **Step 2: Verify no leaks remain in these files**

Run: `cd backend && grep -rn "error: err.message" src/controllers/sessionController.js src/controllers/pollController.js src/controllers/userController.js`
Expected: **no output**.

- [ ] **Step 3: Syntax-check**

Run: `cd backend && node --check src/controllers/sessionController.js && node --check src/controllers/pollController.js && node --check src/controllers/userController.js`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/controllers/sessionController.js backend/src/controllers/pollController.js backend/src/controllers/userController.js
git commit -m "feat(security): stop leaking error details from session/poll/user controllers"
```

**Return:** confirmation that no `error: err.message` remains in the three files.

---

## U6 — Frontend cleanup, prod config & audit

**Depends on:** none · **Owns:** everything under `frontend/` (except `dist/`) · **Parallel-safe with:** all backend units · **Can start:** immediately

- [ ] **Step 1: Confirm nothing imports the dead singular `core/service/` dir**

Run: `grep -rn "core/service/" frontend/src --include=*.ts | grep -v "core/services/"`
Expected: **no output** (every import already uses the plural `core/services/`).

- [ ] **Step 2: Delete the dead directory**

```bash
rm -rf frontend/src/app/core/service
```

- [ ] **Step 3: Create `frontend/src/environments/environment.prod.ts`**

(`KOYEB_HOST` is a placeholder U10 replaces with the deployed backend host, e.g. `pollit-backend-yourorg.koyeb.app`.)

```ts
export const environment = {
  apiUrl: 'https://KOYEB_HOST/api',
  socketUrl: 'https://KOYEB_HOST',
  googleClientId: '1063445220015-d6rf7u67s5sm8g7j71mif41vn40cmsrm.apps.googleusercontent.com'
};
```

- [ ] **Step 4: Add `fileReplacements` to the production build config**

In `frontend/angular.json`, change the `configurations.production` block (currently `budgets` + `outputHashing`) to add `fileReplacements` as its first key:

```json
            "production": {
              "fileReplacements": [
                {
                  "replace": "src/environments/environment.ts",
                  "with": "src/environments/environment.prod.ts"
                }
              ],
              "budgets": [
                { "type": "initial", "maximumWarning": "500kb", "maximumError": "1mb" }
              ],
              "outputHashing": "all"
            },
```

- [ ] **Step 5: Create `frontend/vercel.json`**

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist/live-poll-frontend/browser",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

- [ ] **Step 6: Audit-fix frontend deps**

Run: `cd frontend && npm ci && npm audit --audit-level=high; npm audit fix`
Document any high/critical that `fix` can't resolve.

- [ ] **Step 7: Verify the production build picks up the prod env**

Run: `cd frontend && npm run build && grep -rl "KOYEB_HOST" dist/live-poll-frontend/browser | head`
Expected: build succeeds; at least one bundle matches `KOYEB_HOST` (proves `environment.prod.ts` was compiled in). Also validate `vercel.json`:
Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json OK')"` → `vercel.json OK`.

- [ ] **Step 8: Commit**

```bash
git add -A frontend
git commit -m "build(frontend): remove dead service dir, add prod env + file replacement + vercel.json, audit fix"
```

**Return:** confirmation the build succeeds and the prod env is compiled in.

---

## U8 — CI workflow

**Depends on:** none for the file (a **green** run requires U1–U6 merged) · **Owns:** `.github/workflows/ci.yml` · **Parallel-safe with:** all · **Can start:** immediately

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm audit --audit-level=high
  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run build
      - run: npm audit --audit-level=high
```

- [ ] **Step 2: Validate the YAML**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!y.includes('jobs:'))process.exit(1); console.log('workflow present')"`
Expected: `workflow present`.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions build/test/audit pipeline"
git push
```

- [ ] **Step 4: Verify the run after Wave 2 merges**

Run: `gh run list --limit 1` then `gh run watch`.
Expected: both jobs succeed. If `npm audit` fails on an unavoidable dev-only advisory, change that step to `npm audit --audit-level=high || true` and note why.

**Return:** the CI run URL and pass/fail per job.

---

## U2 — Auth controller hardening

**Depends on:** U1 (its test imports `backend/src/app.js`) · **Owns:** `backend/src/controllers/authController.js`, `backend/test/security.admin.test.js` · **Parallel-safe with:** U3, U4, U7 (disjoint files) · **Can start:** after U1 merges

Removes the hardcoded `admin/admin123`, raises the password minimum, removes the hardcoded Google client-id fallback, and stops `authController` from leaking error detail.

- [ ] **Step 1: Write the failing admin-auth test**

Create `backend/test/security.admin.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('s3cretAdminPass', 10);
const request = require('supertest');
const app = require('../src/app');

test('admin login rejects the old hardcoded password', async () => {
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'admin123' });
  assert.strictEqual(res.status, 401);
  assert.ok(!res.body.token);
});
test('admin login accepts correct env credentials and returns an admin token', async () => {
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 's3cretAdminPass' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.user.role, 'admin');
});
test('admin login returns 503 when not configured', async () => {
  const saved = process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_HASH;
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'x' });
  assert.strictEqual(res.status, 503);
  process.env.ADMIN_PASSWORD_HASH = saved;
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && node --test test/security.admin.test.js`
Expected: FAIL — old password currently returns 200.

- [ ] **Step 3: Add the bcrypt import**

At the top of `backend/src/controllers/authController.js`, after line 3, add:

```js
const bcrypt = require('bcryptjs');
```

- [ ] **Step 4: Replace `exports.adminLogin` ([authController.js:100-111](../../../backend/src/controllers/authController.js#L100-L111))**

```js
exports.adminLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    if (!adminUser || !adminHash) {
      return res.status(503).json({ message: 'Admin login not configured' });
    }
    const userOk = typeof username === 'string' && username === adminUser;
    const passOk = typeof password === 'string' && (await bcrypt.compare(password, adminHash));
    if (!userOk || !passOk) {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }
    const token = jwt.sign(
      { id: 'admin', email: 'admin@pollit.local', role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({
      token,
      user: { id: 'admin', name: 'Super Admin', email: 'admin@pollit.local', role: 'admin' }
    });
  } catch (err) {
    next(err);
  }
};
```

- [ ] **Step 5: Raise the password minimum to 8 ([authController.js:15-17](../../../backend/src/controllers/authController.js#L15-L17))**

Change:

```js
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
```

to:

```js
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
```

- [ ] **Step 6: Remove hardcoded Google client-id fallbacks**

Change [line 4](../../../backend/src/controllers/authController.js#L4) from:

```js
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || '1234567890-abcdef.apps.googleusercontent.com');
```

to:

```js
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
```

In `exports.googleLogin`, just after the `if (!credential) { ... }` check (~line 63), add:

```js
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ message: 'Google login not configured' });
    }
```

And change the `audience` line ([line 67](../../../backend/src/controllers/authController.js#L67)) from:

```js
      audience: process.env.GOOGLE_CLIENT_ID || '1234567890-abcdef.apps.googleusercontent.com',
```

to:

```js
      audience: process.env.GOOGLE_CLIENT_ID,
```

- [ ] **Step 7: Strip `error: err.message` from authController's catch blocks**

```bash
cd backend && sed -i "s/res.status(500).json({ message: 'Server error', error: err.message });/res.status(500).json({ message: 'Server error' });/g" src/controllers/authController.js
```
Verify: `cd backend && grep -n "error: err.message" src/controllers/authController.js` → no output.

- [ ] **Step 8: Run the test to confirm it passes + full suite**

Run: `cd backend && node --test test/security.admin.test.js` → PASS (3 tests)
Run: `cd backend && npm test` → all PASS.

- [ ] **Step 9: Generate the production admin hash (hand to U10)**

```bash
cd backend && node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'CHOOSE-A-STRONG-ADMIN-PASSWORD'
```
Record the printed hash for the `ADMIN_PASSWORD_HASH` env var in U10. Do **not** commit the password or hash.

- [ ] **Step 10: Commit**

```bash
git add backend/src/controllers/authController.js backend/test/security.admin.test.js
git commit -m "feat(security): env-based bcrypt admin auth, 8-char passwords, no OAuth fallback"
```

**Return:** confirmation tests pass, and the generated `ADMIN_PASSWORD_HASH` (delivered securely to whoever runs U10).

---

## U7 — Backend Dockerfile

**Depends on:** U1 (needs the final `app.js`/`server.js` to test-build/boot) · **Owns:** `backend/Dockerfile`, `backend/.dockerignore` · **Parallel-safe with:** U2, U3, U4 (disjoint files) · **Can start:** after U1 merges

- [ ] **Step 1: Create `backend/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "src/server.js"]
```

- [ ] **Step 2: Create `backend/.dockerignore`**

```
node_modules
npm-debug.log
.env
*.log
test
.git
```

- [ ] **Step 3: Build the image**

Run: `cd backend && docker build -t pollit-backend .`
Expected: build completes. (If Docker isn't available locally, skip — Koyeb builds it — and note this in the PR.)

- [ ] **Step 4: Smoke-run the container**

Run: `docker run --rm -e JWT_SECRET=x -e CLIENT_URL=http://localhost:4200 -e PORT=8000 -p 8000:8000 pollit-backend & sleep 4 && curl -fsS localhost:8000/api/health; echo; docker stop $(docker ps -q --filter ancestor=pollit-backend) 2>/dev/null || true`
Expected: `{"status":"ok",...}`.

- [ ] **Step 5: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore
git commit -m "build: add Dockerfile and .dockerignore for Koyeb deployment"
```

**Return:** confirmation the image builds and the container serves `/api/health`.

---

## U10 — Provisioning & deploy

**Depends on:** U1, U2, U3, U4 (hardened backend), U7 (Dockerfile), U6 (frontend build config) · **Owns:** platform dashboards + the `KOYEB_HOST` fill-in in `frontend/src/environments/environment.prod.ts` · **Wave:** 3 · Needs human-held credentials. Mostly sequential.

> Ordering resolves the host chicken-and-egg: **backend first** (get its URL for the frontend env), **frontend next** (get its URL), then **set backend `CLIENT_URL` + Google OAuth origins** to the frontend URL.

### Step 1: MongoDB Atlas M0
- https://cloud.mongodb.com → Build a Database → **M0 (Free)** → region near your users.
- Database Access → add a DB user with a strong generated password, role `readWrite`. Record creds (secret).
- Network Access → add `0.0.0.0/0` (Koyeb free egress IPs aren't static; Atlas still enforces TLS + SCRAM — documented tradeoff).
- Connect → Drivers → copy the `mongodb+srv://...` URI, set password + DB name (`.../livepoll?retryWrites=true&w=majority`). Save as `MONGO_URI`.
- (Optional) verify: `cd backend && MONGO_URI='YOUR_ATLAS_URI' JWT_SECRET=x CLIENT_URL=http://localhost:4200 timeout 8 node src/server.js` → `MongoDB connected` then `Server running on port 5000`.

### Step 2: Gemini key
- https://aistudio.google.com/apikey → Create API key. Save as `GEMINI_API_KEY`. Confirm with U9 Step 3 (use the model string U9 reported).

### Step 3: Note the Google OAuth client
- Google Cloud Console → APIs & Services → Credentials → confirm edit access to client `1063445220015-...`. Save as `GOOGLE_CLIENT_ID`. (Origins added in Step 6.)

### Step 4: Deploy backend to Koyeb
- `git push -u origin HEAD` so Koyeb can pull.
- https://app.koyeb.com → Create Service → GitHub → this repo/branch.
- Builder: **Dockerfile**. Build context: `backend`. Dockerfile path: `backend/Dockerfile`. Instance: **Free**. Region: match Atlas. Port: `8000`. Health check: HTTP `/api/health`.
- Env vars (mark sensitive as **Secret**):
  - `MONGO_URI` (secret), `JWT_SECRET` = `openssl rand -base64 48` (secret), `GEMINI_API_KEY` (secret), `GOOGLE_CLIENT_ID`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (secret, from U2 Step 9), `CLIENT_URL` = `http://localhost:4200` (updated in Step 6), `NODE_ENV` = `production`.
- After deploy, copy the host (e.g. `pollit-backend-yourorg.koyeb.app`).
- Verify: `curl -fsS https://YOUR-KOYEB-HOST/api/health; echo` → `{"status":"ok",...}`.

### Step 5: Point the frontend at the backend, then deploy to Vercel
```bash
cd frontend && sed -i 's/KOYEB_HOST/YOUR-KOYEB-HOST/g' src/environments/environment.prod.ts
git add src/environments/environment.prod.ts
git commit -m "config: point frontend prod env at the Koyeb backend host"
git push
```
- https://vercel.com → Add New Project → import this repo. Root Directory: `frontend`. Framework: **Other** (config from `vercel.json`). Deploy → copy the production URL (e.g. `https://pollit.vercel.app`).

### Step 6: Close the CORS + OAuth loop
- Koyeb → service → Environment → set `CLIENT_URL` = `https://pollit.vercel.app` (exact origin, no trailing slash) → redeploy.
- Verify: `curl -fsS -H "Origin: https://pollit.vercel.app" -D - https://YOUR-KOYEB-HOST/api/health -o /dev/null | grep -i access-control-allow-origin` → `Access-Control-Allow-Origin: https://pollit.vercel.app`.
- Google Cloud Console → Credentials → OAuth client → **Authorized JavaScript origins** → add `https://pollit.vercel.app` → Save.
- Verify frontend loads: `curl -fsS -o /dev/null -w "%{http_code}\n" https://pollit.vercel.app` → `200`.

**Return:** the live frontend + backend URLs and confirmation health/CORS checks pass.

---

## U11 — Verify & ops

**Depends on:** U10 · **Owns:** `README.md` · **Wave:** 4

### Step 1: Live smoke test (use a phone on cellular as a second device)
- Backend health: `curl -fsS https://YOUR-KOYEB-HOST/api/health` → ok.
- Open `https://pollit.vercel.app`. Admin login: confirm `admin/admin123` is **rejected** and the new env creds are **accepted**.
- Register a presenter (password ≥ 8) → create a session with 2-3 polls → Go Live → note the 6-digit code.
- On a phone: enter the code → vote. On the presenter screen confirm bars animate in realtime, the audience counter increments, and after ~5 votes/10s the AI Insights panel populates.
- Google login on the presenter login → succeeds.
- CORS negative check: `curl -fsS -H "Origin: https://evil.example" -D - https://YOUR-KOYEB-HOST/api/health -o /dev/null | grep -i access-control-allow-origin || echo "no CORS header for evil origin (correct)"` → prints the "correct" message.

### Step 2: Uptime monitor
- https://uptimerobot.com → Add Monitor → HTTP(s) → `https://YOUR-KOYEB-HOST/api/health` → 5-min interval. Alerts on downtime and keeps the instance warm before demos.

### Step 3: README runbook

Append to `README.md`:

```markdown
## Deployment

- **Frontend:** Vercel (root dir `frontend/`, config in `frontend/vercel.json`) — auto-deploys on push to `main`.
- **Backend:** Koyeb (Dockerfile at `backend/Dockerfile`, build context `backend/`) — auto-deploys on push to `main`. Health check: `/api/health`.
- **Database:** MongoDB Atlas M0. **AI:** Google Gemini. **CI:** GitHub Actions (`.github/workflows/ci.yml`).

### Required backend env (set in Koyeb)
`MONGO_URI`, `JWT_SECRET`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `CLIENT_URL`, `NODE_ENV=production`.
Generate the admin hash: `node -e "console.log(require('bcryptjs').hashSync('PASSWORD',10))"`.

### Rollback
- Frontend: Vercel dashboard → Deployments → promote a previous deployment.
- Backend: Koyeb dashboard → redeploy a previous build, or `git revert <sha> && git push`.

### Backup
- Manual: `mongodump --uri "$MONGO_URI"` (M0 has limited automated backups).
```

### Step 4: Commit and push
```bash
git add README.md
git commit -m "docs: add deployment runbook, env reference, and rollback steps"
git push
```

**Return:** pass/fail per smoke-test step with the live URLs.

---

## Final Verification Checklist (gate before declaring done)

- [ ] `cd backend && npm test` → all tests pass
- [ ] `cd frontend && npm run build` → succeeds
- [ ] `npm audit --audit-level=high` clean (or documented exceptions) in both apps
- [ ] GitHub Actions CI green on `main`
- [ ] `grep -rn "admin123" backend/src` → no output
- [ ] `grep -rn "error: err.message" backend/src` → no output
- [ ] `grep -rn "|| '\*'" backend/src` → no output (no CORS wildcard fallback)
- [ ] Live frontend (`https://...vercel.app`) and backend (`https://...koyeb.app/api/health`) both serve over HTTPS
- [ ] Old `admin/admin123` rejected in production; new admin creds work
- [ ] Realtime vote + audience counter + AI insights verified live across two devices
- [ ] CORS rejects unknown origins in production (U11 Step 1)
- [ ] Recurring cost confirmed $0 (Vercel Hobby + Koyeb free + Atlas M0 + Gemini free)


