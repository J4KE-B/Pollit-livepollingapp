# Design Spec: Free, Production-Grade, Hardened Deployment of Pollit (VoxPop)

- **Date:** 2026-05-28
- **Status:** Approved design — ready for implementation plan
- **Author:** Claude (brainstormed with project owner)
- **Repo commit at design time:** `608ad1a7`

## 1. Goal

Deploy the existing Pollit live-polling app (Angular 17 + Express/Socket.IO + MongoDB + Google Gemini) to the public internet for **$0/month**, meeting **production and security standards** appropriate for a polished **portfolio/demo** project. "High security" is a hard requirement: known live vulnerabilities must be fixed **before** the app is exposed publicly.

Non-negotiables:
- Total recurring cost: **$0**.
- Public HTTPS on both frontend and backend.
- Realtime features (live vote bars, audience counter, AI insights) must keep working — this constrains the backend host.
- No hardcoded credentials or secrets in the repo or shipped bundles.

## 2. Current State (assessed from code, graph, and taskboard)

**Stack**
- **Frontend:** Angular 17 standalone SPA, built to static assets. All components import services from `core/services/` (plural).
- **Backend:** Express REST + Socket.IO realtime, Mongoose models, listens on `process.env.PORT || 5000`. Health endpoint exists at `/api/health`.
- **DB:** MongoDB (Mongoose). **AI:** Google Gemini. **Auth:** JWT (email/password + Google OAuth) for presenters; a separate admin login.
- Realtime room state (`audienceCount`, AI-insight throttling) is held **in memory** in `backend/src/sockets/pollSocket.js` via a `Map`.

**Confirmed issues / gaps**
| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | 🔴 Critical | Hardcoded admin login `admin` / `admin123` | `backend/src/controllers/authController.js:100-111` |
| 2 | 🔴 Critical | CORS falls back to `*` wildcard (Express + Socket.IO) | `backend/src/server.js:16,34` |
| 3 | 🔴 High | Hardcoded fallback Google client ID in OAuth verify | `backend/src/controllers/authController.js:4,67` |
| 4 | 🟠 High | No rate limiting on REST or socket vote flow | backend-wide |
| 5 | 🟠 High | No security headers (no `helmet`) | `server.js` |
| 6 | 🟠 High | No input sanitization → NoSQL-injection surface on `findOne({ email })`, `findOne({ code })` and socket payloads | controllers + `pollSocket.js` |
| 7 | 🟠 Med | Error responses leak `err.message` to clients (REST + socket acks) | controllers, `pollSocket.js` |
| 8 | 🟡 Med | Weak password policy (min 6 chars) | `authController.js:15` |
| 9 | 🟡 Low | Production build bakes in `localhost:5000` — **no `environment.prod.ts`, no `fileReplacements`** in `angular.json` | `frontend/src/environments/environment.ts`, `frontend/angular.json` |
| 10 | 🟡 Low | Dead duplicate directory `frontend/src/app/core/service/` (singular) — nothing imports it | confirmed via grep |
| 11 | 🟡 Low | Dependency vulnerabilities unaudited | both `package.json` |
| 12 | ℹ Info | JWT stored in browser `localStorage` (XSS-exposed) | frontend auth |
| 13 | ℹ Info | Gemini model string churned (`gemini-1.5-flash` ↔ `gemini-pro`) — verify the working one | `aiInsightsService.js` |

Good news already in place: presenter socket actions verify JWT + session ownership; vote dedup uses a compound unique index; body size limited to 1 MB; `.env` is gitignored.

## 3. Target Architecture

```
  Browsers (presenters + audience phones)
            │  HTTPS + WSS
            ▼
  ┌───────────────────────────┐  REST   ┌────────────────────────────┐
  │  VERCEL — Frontend         │ ──────▶ │  KOYEB (free) — Backend     │
  │  Angular 17 SPA (static)   │  WSS    │  Express + Socket.IO         │
  │  *.vercel.app, HTTPS, CDN  │ ◀─────▶ │  container, *.koyeb.app HTTPS│
  │  git auto-deploy           │         │  health: GET /api/health     │
  └───────────────────────────┘         └─────┬────────────────┬───────┘
                                               │                │
                                  TLS + SCRAM  ▼                ▼ HTTPS
                                  ┌──────────────┐     ┌──────────────────┐
                                  │ MongoDB Atlas│     │ Google Gemini API │
                                  │   M0 (free)  │     │   (free tier)     │
                                  └──────────────┘     └──────────────────┘
```

### 3.1 Host choices and rationale
- **Frontend → Vercel (Hobby, free):** ideal for an Angular SPA. Global CDN, free SSL, git auto-deploy. Vercel **cannot** host the backend (serverless functions are stateless and can't hold WebSockets / in-memory room state).
- **Backend → Koyeb (free tier):** genuinely free container host with **native WebSocket support** and **no fixed sleep window** while receiving traffic (it only scales to zero after extended idle, then wakes quickly). 1 service, 0.1 vCPU / 512 MB — sufficient for a demo single instance. Chosen over Fly.io (no longer free, ~$1.94/mo) and Render (free but sleeps after 15 min idle).
- **DB → MongoDB Atlas M0 (free, 512 MB):** TLS-enforced, SCRAM auth.
- **AI → Google Gemini free tier:** app degrades gracefully (insights panel stays empty) if the key is absent or quota is hit.
- **Single backend instance is required** because room/audience state is in-memory. No horizontal scaling on the free tier (acceptable; see §8).

## 4. Security Requirements (Phase 1 — must complete before public exposure)

Each maps to a finding in §2.

1. **Admin auth (R1):** Remove `admin/admin123`. Replace with env-driven credentials: `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` (bcrypt), compared via `bcrypt.compare`. Admin JWT keeps `role: 'admin'`. Add/verify a `requireAdmin` middleware (`req.user.role === 'admin'`) on every admin-only endpoint (e.g. the users list).
2. **CORS lockdown (R2):** Replace `process.env.CLIENT_URL || '*'` with a strict allowlist sourced from `CLIENT_URL` (support comma-separated origins); reject unknown origins. Apply to both Express `cors()` and the Socket.IO `cors` block.
3. **Remove hardcoded OAuth fallback (R3):** `OAuth2Client` and `verifyIdToken` must use `process.env.GOOGLE_CLIENT_ID` with **no** hardcoded default; fail closed if unset.
4. **Rate limiting (R4):** `express-rate-limit` globally + a stricter limiter on `/api/auth/*`. Add a lightweight per-socket throttle on `audience:vote` (e.g. token bucket / max N/sec) since each vote writes a DB doc.
5. **Security headers (R5):** `app.use(helmet())` with sane API defaults.
6. **Input sanitization & validation (R6):** `express-mongo-sanitize` for REST. For **socket** payloads (not covered by Express middleware), validate/coerce types explicitly: `code`, `voterKey`, `answer` are strings; `pollIndex` is a number; reject otherwise.
7. **Error hygiene (R7):** Stop returning `err.message` to clients (REST responses and socket acks). Add a central Express error handler; log full errors server-side, return generic client messages.
8. **Password policy (R8):** Raise minimum length (≥8) and add a basic strength check.
9. **Secrets management (R-secrets):** Generate a strong `JWT_SECRET` (≥32 bytes random). All backend secrets live in Koyeb env (secret type); the only frontend "config" baked at build time is the **public** Google client ID + the prod API/socket URLs (not secrets). Confirm `backend/.env` is absent from git history; rotate the Gemini key if it was ever committed.
10. **Dependency audit (R11):** `npm audit fix` on both apps; address high/critical; wire `npm audit --audit-level=high` into CI.
11. **Transport (R-https):** Rely on Vercel + Koyeb automatic HTTPS. Production frontend env must use `https://` and `wss://` URLs (no mixed content).
12. **Documented-but-deferred (R12):** `localStorage` JWT storage is kept (Angular auto-escaping limits XSS); moving to httpOnly cookies is noted as future work, not done now (avoids cross-site cookie complexity for a demo).

## 5. Build & Deployment Configuration (Phase 2)

**Backend (Koyeb)**
- Add a `Dockerfile` (`node:20-alpine`, `npm ci --omit=dev`, `CMD ["node","src/server.js"]`) + `.dockerignore`, building from the `backend/` context.
- Server already binds `process.env.PORT`; Koyeb injects `PORT` — confirm it listens on all interfaces.
- Koyeb HTTP health check → `GET /api/health`.

**Frontend (Vercel)**
- Create `frontend/src/environments/environment.prod.ts` with prod `apiUrl` (`https://<koyeb-host>/api`), `socketUrl` (`https://<koyeb-host>`), and the public `googleClientId`.
- Add `fileReplacements` (environment.ts → environment.prod.ts) to the `production` configuration in `angular.json`.
- Add `frontend/vercel.json` with an SPA rewrite (`/(.*) → /index.html`) and the correct output directory (`dist/live-poll-frontend/browser`).
- Vercel project root directory = `frontend/`, build = `npm run build`.

## 6. Provisioning (Phase 3 — free accounts)
- **MongoDB Atlas:** M0 cluster, DB user (strong password), network access. Koyeb free egress IPs are not guaranteed static → use `0.0.0.0/0` with the protection that Atlas enforces TLS + SCRAM auth (documented tradeoff).
- **Gemini:** API key from Google AI Studio; confirm the working model string (§2 #13).
- **Google OAuth:** add the Vercel origin to **Authorized JavaScript origins** in Google Cloud Console.
- **Koyeb:** create the service from the repo (`backend/` context), set env/secrets (`MONGO_URI`, `JWT_SECRET`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `CLIENT_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`).
- **Vercel:** create the project (`frontend/` root), connect git.

## 7. CI/CD & Ops (Phases 4–5)
- **CI (GitHub Actions, free):** on PR/push to `main` — install + build backend, install + build frontend, run `npm audit --audit-level=high` on both, run tests if present. This gates merges.
- **CD:** platform-native git auto-deploy — Koyeb redeploys backend on push to `backend/`; Vercel redeploys frontend on push to `frontend/`. (Optional: Koyeb deploy via API token in Actions; not required.)
- **Ops (portfolio-calibrated):** free **UptimeRobot** monitor on `/api/health` (doubles as a keep-warm ping to reduce Koyeb cold starts before a demo). Koyeb logs for visibility. Document a manual `mongodump` backup and a rollback procedure (revert commit → auto-redeploy, or platform "redeploy previous build") in the README.

## 8. Out of Scope (YAGNI for a free portfolio/demo)
Autoscaling / multiple instances; Redis Socket.IO adapter (single instance keeps in-memory state valid); multi-region; paid APM/monitoring; word-cloud d3 rendering; custom domain (trivial optional add-on later); migrating JWT to httpOnly cookies.

## 9. Success Criteria
1. Frontend reachable over HTTPS at `*.vercel.app`; backend over HTTPS at `*.koyeb.app`.
2. Full live flow works across two devices: register → create session → go live → audience joins by 6-digit code on a phone → votes animate in realtime → audience counter updates → AI insights populate.
3. No hardcoded credentials/secrets anywhere in the repo or shipped bundle; all secrets in platform env stores.
4. Admin login works only with the new env-based, bcrypt-hashed credentials; admin endpoints enforce the admin role.
5. CORS restricted to the Vercel origin; rate limiting active; `helmet` headers present; client error responses carry no stack/`err.message`.
6. `npm audit --audit-level=high` passes in CI for both apps.
7. Recurring cost is $0.

## 10. Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Koyeb scale-to-zero cold start at the start of a demo | UptimeRobot keep-warm ping; warm-up request before presenting |
| Atlas M0 512 MB / connection limits | Sufficient for demo; document as a scale ceiling |
| Gemini free quota exhaustion | App already degrades gracefully (empty insights panel) |
| Single in-memory instance can't scale horizontally | Accepted for free demo; Redis adapter noted as future work |
| Google OAuth origin mismatch after deploy | Add the exact Vercel origin to Authorized JS origins; verify post-deploy |

## 11. Implementation Phases (summary)
- **Phase 0 — Pre-flight:** delete dead `core/service/` dir; verify no secrets in git history; confirm working Gemini model.
- **Phase 1 — Security hardening:** all of §4.
- **Phase 2 — Build/deploy config:** §5.
- **Phase 3 — Provisioning:** §6.
- **Phase 4 — CI/CD:** §7.
- **Phase 5 — Verify & ops:** end-to-end smoke test on live URLs + §7 ops, README runbook.

A detailed, step-by-step implementation plan (exact commands, file diffs, per-phase verification) follows this spec via the writing-plans process.
