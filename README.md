# Live Poll - MEAN Stack + Real-Time + AI Insights

A self-hosted Mentimeter-style polling tool. **v2 adds Socket.IO real-time and AI-powered live insights.**

## What's working now (v2)

- Presenter signup/login (JWT)
- Create / edit / delete sessions with 4 poll types (MCQ, word cloud, rating, open text)
- Audience joins by 6-digit code (no signup), votes deduped per browser
- **Real-time** vote updates over Socket.IO — bars animate as votes arrive
- **Live audience counter** on presenter screen
- **AI Insights panel** that updates every ~10s or every 5 votes:
  - One-line "pulse" summary of the room
  - 2-3 suggested follow-up questions
  - Flagged interesting/outlier responses
- **One-click follow-up**: presenter clicks an AI-suggested question → it's inserted as the next poll and goes live immediately

## Stack

- **MongoDB** — Mongoose models for User, Session, Response (compound unique index for vote dedup)
- **Express** — REST API for auth + session CRUD
- **Socket.IO** — real-time poll progression, votes, audience count, insight broadcasts
- **Angular 17** — standalone components, signals, RxJS subjects bridging socket events
- **Google Gemini 1.5 Flash** — AI insights (cheap, fast, excellent for text analysis)

## Setup

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)
- Gemini API key (optional — app works without it, the panel just stays empty)

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env:
#   MONGO_URI, JWT_SECRET (required)
#   GEMINI_API_KEY (optional, for AI insights)
npm run dev
```

Runs on http://localhost:5000

### Frontend

```bash
cd frontend
npm install
npm start
```

Runs on http://localhost:4200

## Demo flow

1. Register at /register
2. New Session → add 2-3 polls (try a mix of types) → Save
3. Dashboard → Go Live (or open the live screen and click Go Live)
4. Open second browser/incognito → http://localhost:4200 → enter the 6-digit code
5. Vote a few times. The presenter screen:
   - Bars animate immediately as votes arrive
   - Audience counter updates
   - After 5 votes (or 10 seconds), the AI Insights panel populates with a pulse + follow-up suggestions
6. Click any suggested follow-up → it becomes the next poll, audience sees it instantly

## What's still skipped (intentionally, to stay light)

- Word cloud d3 rendering (still shows as bar list — easy add later)
- Deployment configs

## Security

- **Abuse/anomaly detection** on vote traffic: sliding-window vote-rate limits
  and device-fingerprint clustering, enforced identically on both the
  Socket.IO and REST vote paths so an attacker can't just switch transports.
  Rules that auto-block are per-device (where one human can't plausibly
  produce the traffic); cross-device signals only flag, so a lecture hall on
  shared NAT never gets mass-blocked.
- **Prompt-injection defense** on open-text poll answers before they reach
  Gemini: heuristic detection, sanitization, and a nonce-delimited untrusted-
  data block so the model can't be steered into treating audience text as
  instructions. Applied to every path audience text takes into the prompt,
  including the aggregated results breakdown.
- Trusted-proxy-aware IP resolution (Socket.IO and REST agree on which
  `X-Forwarded-For` hop to trust), `helmet`, Mongo-injection sanitization, and
  a dedicated `security.*.test.js` suite exercised in CI.

## API + Socket events

REST (unchanged from v1):
```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/sessions, POST /api/sessions, ...
GET    /api/poll/:code, POST /api/poll/:code/vote
```

Socket events:
```
# Presenter → server
presenter:join         { sessionId, token } -> ack
presenter:nextPoll     {} -> ack
presenter:endSession   {} -> ack
presenter:insertPoll   { poll } -> ack

# Audience → server
audience:join          { code } -> ack
audience:vote          { pollIndex, answer, voterKey } -> ack

# Server → all in room
poll:show              { currentPollIndex, poll }
results:update         [PollResultGroup]
audience:count         number
session:ended
insights:generating
insights:update        { pulse, followups, outliers }
```
