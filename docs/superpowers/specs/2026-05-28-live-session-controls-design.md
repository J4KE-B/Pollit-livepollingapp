# Live-Session Controls & Answer Context — Design Spec

**Date:** 2026-05-28
**Status:** Approved (design)
**Scope:** Three drawbacks observed in the live (production) Pollit deployment, fixed without scope creep.

## Problem statement

Observed in the live deployment ([frontend](https://pollit-livepollingapp.vercel.app) / [backend](https://pollit-livepollingapp.onrender.com)):

1. **Presenter has no live question management.** During a live session the presenter can only go *Next* or *End* — there is no way to **add a new question** mid-session, and no way to **go back to a previous question** to review its results.
2. **MCQ answers lose their meaning.** Audience MCQ votes are stored as the **option index** (`0`, `1`, `2`), not the option text. The presenter's result bars, and especially the Gemini AI insights, then reason about "answer 0" with no context — visibly degrading the AI follow-ups.
3. **Audience can get stranded / has no progress context.** A person who joins is not reliably synced to the presenter's question, and has no "Question X of Y" indication of where they are.

## Root causes (verified in code)

1. [`live.component.ts`](../../../frontend/src/app/features/presenter/live/live.component.ts) only renders `Next Question` + `End Session`. The socket layer has `presenter:nextPoll`, `presenter:endSession`, and `presenter:insertPoll` (AI-followup only) — but no "previous" and no general-purpose "add question" UI.
2. [`answer.component.ts:36`](../../../frontend/src/app/features/audience/answer/answer.component.ts#L36) calls `vote(i)` for MCQ — sending the **index**. The vote is stored verbatim in [`Response.answer`](../../../backend/src/models/Response.js), aggregated by value, and fed to [`aiInsightsService`](../../../backend/src/services/aiInsightsService.js) as `0`/`1`/`2`.
3. [`startSession`](../../../backend/src/controllers/pollController.js#L71) (REST, called by the live view's `goLive()`) sets `status='live'` + `currentPollIndex=0` but **emits no socket event**. Anyone who joined while the session was `draft` keeps showing "Waiting for the presenter to start…" and never receives the first `poll:show`. The audience screen also never receives the session's total poll count, so it cannot show "Question X of Y".

## Key design decision: live index vs. view index

The two confirmed product choices interact:

- **Audience is strictly presenter-driven** — it always mirrors the *live* question and votes only on it.
- **"Previous" is presenter-only review** — the audience must NOT move when the presenter looks back.

Therefore we separate two concepts:

| Concept | Where it lives | Meaning |
|---------|----------------|---------|
| **Live index** (`currentPollIndex`) | Server (`Session`) | The question the audience sees and can vote on. Only advanced by `presenter:goLive` / `presenter:nextPoll`. Broadcast via `poll:show`. |
| **View index** (`viewIndex`) | Presenter client only (`live.component.ts` signal) | Which question the presenter is *looking at*. Defaults to and snaps to the live index, but `◀ Previous` can move it back to review stored results. Never leaves the presenter's browser. |

## Feature designs

### Feature 1 — Presenter live controls (add question + previous review)

**Previous (review only):**
- `viewIndex` starts at `currentPollIndex`; on every `poll:show` it snaps to the new live index (presenter follows live by default).
- `◀ Previous` decrements `viewIndex` (floor 0). The presenter sees that past question and its stored results, drawn from the already-loaded `results` array (no new server call, no broadcast).
- The poll/results rendering reads `viewIndex` (not `currentPollIndex`).
- A status badge shows **`● LIVE`** when `viewIndex === currentPollIndex`, else **`Reviewing Q{viewIndex+1} · audience on Q{currentPollIndex+1}`** plus a **`Jump to live`** button (sets `viewIndex = currentPollIndex`).

**Next (dual-purpose):**
- If `viewIndex < currentPollIndex`: clicking `Next ▶` just moves the *view* forward (`viewIndex++`) — still review.
- If `viewIndex === currentPollIndex` and not the last poll: clicking `Next ▶` advances the *live* question (`presenter:nextPoll`); the resulting `poll:show` snaps `viewIndex` forward. `Next ▶` is disabled only when viewing the live question AND it is the last poll.

**Add question (choose each time):**
- Inline form in the live view: **type** (mcq / text / rating / wordcloud), **question** text, **options** (only when type = mcq, ≥2 non-empty), and **position**: `Next` (insert immediately after the live question) or `End` (append).
- New socket event `presenter:addPoll({ poll, position })`:
  - `position: 'next'` → splice at `currentPollIndex + 1`.
  - `position: 'end'` → push to end.
  - **Invariant:** insertion is only ever at a *future* index (`> currentPollIndex`), so already-answered polls never have their `pollIndex` shifted — the `pollIndex → responses` mapping stays correct. (Inserting before/at an answered index is not offered.)
  - Validates `poll.type` ∈ enum, `poll.question` non-empty, and for mcq `options` length ≥ 2.
  - Ack returns the updated poll list (or new length + inserted index) so the presenter client updates `session.polls` — this re-derives "Q X of Y" totals and re-enables `Next ▶`.
- The existing `presenter:insertPoll` (AI follow-up path) is left untouched.

### Feature 2 — MCQ answers carry option text

- Change [`answer.component.ts`](../../../frontend/src/app/features/audience/answer/answer.component.ts) MCQ branch from `vote(i)` to `vote(opt)` — send the **option string**.
- No backend change: `Response.answer` is `Mixed`, aggregation groups by value, the presenter's `formatAnswer` already stringifies, and the Gemini prompt now receives real labels.
- **Forward-only.** Existing numeric responses from past sessions are not migrated (small demo app; new sessions are clean).
- Edge case (accepted): two options with identical text aggregate together — presenters are expected to use distinct option labels.

### Feature 3 — Audience sync + "Question X of Y"

**Go-live sync fix:**
- Add socket event `presenter:goLive` (mirrors `presenter:nextPoll`): verifies presenter role/ownership, sets `status='live'` + `currentPollIndex=0`, saves, and emits `poll:show` to the room. The live view calls `presenterGoLive()` instead of the REST `start()`.
- The REST `startSession` endpoint is left in place (not used by the UI, harmless) to avoid touching unrelated controllers/routes.

**Progress indicator:**
- Add `totalPolls` to the `poll:show` event payload and to the `audience:join` ack.
- The audience screen renders **"Question {pollIndex+1} of {totalPolls}"** above the question, updating on each `poll:show`.

## Contract changes (the shared interface between tasks)

These exact names/shapes are the contract that lets the backend and frontend tasks be built in parallel:

**Socket events (server → client):**
- `poll:show` payload: `{ currentPollIndex: number, poll: Poll, totalPolls: number }` *(adds `totalPolls`)*

**Socket events (client → server) with ack:**
- `presenter:goLive` → ack `{ ok: boolean, error?: string }` *(new; server also emits `poll:show`)*
- `presenter:addPoll` payload `{ poll: { type, question, options }, position: 'next' | 'end' }` → ack `{ ok: boolean, polls?: Poll[], insertedAt?: number, error?: string }` *(new)*

**Acks updated:**
- `audience:join` ack adds `totalPolls: number`.

**Frontend `SocketService` additions:**
- `presenterGoLive(): Promise<{ ok: boolean; error?: string }>`
- `presenterAddPoll(poll, position): Promise<{ ok: boolean; polls?: Poll[]; insertedAt?: number; error?: string }>`
- `PollShowEvent` interface gains `totalPolls: number`.
- `audienceJoin` return type gains `totalPolls?: number`.

## Components & file ownership (for parallel execution)

| Unit | Concern | Owns (file) |
|------|---------|-------------|
| **U1** | Backend socket handlers: `presenter:goLive`, `presenter:addPoll`, `totalPolls` in `poll:show` + `audience:join` | `backend/src/sockets/pollSocket.js` |
| **U2** | Frontend socket contract: new methods + `PollShowEvent.totalPolls` + ack types | `frontend/src/app/core/services/socket.service.ts` |
| **U3** | Presenter live view: review nav (`viewIndex`), add-question form, `goLive` wiring | `frontend/src/app/features/presenter/live/live.component.ts` |
| **U4** | Audience view: `vote(opt)` + "Question X of Y" | `frontend/src/app/features/audience/answer/answer.component.ts` |

**No two concurrently-running units edit the same file.** U1 and U2 (Wave 1) are different files. U3 and U4 (Wave 2) are different files and both depend only on U2's contract.

## Data flow

1. Presenter opens live view → `presenter:join` (existing) returns session + all results.
2. Presenter clicks **Go Live** → `presenter:goLive` → server sets live/index 0, emits `poll:show {index:0, poll, totalPolls}` → audience (incl. draft-joiners) sync to Q1 with "Question 1 of N".
3. Audience MCQ vote sends the **option text** → stored, aggregated, broadcast via `results:update`, fed to Gemini with real labels.
4. Presenter clicks **◀ Previous** → client `viewIndex--`; reads stored results; **no** broadcast; audience unaffected.
5. Presenter clicks **Next ▶** at the live edge → `presenter:nextPoll` → `poll:show` advances everyone; `viewIndex` snaps forward.
6. Presenter **adds a question** (next/end) → `presenter:addPoll` → server splices/pushes (future-only) → ack returns updated polls → presenter "Q X of Y" total updates; audience sees it only when it becomes live.

## Testing / verification

- **U1:** `node --check backend/src/sockets/pollSocket.js`; existing `npm test` (`node --test`) stays green. A lightweight socket integration test is optional (no existing socket harness); behavior is primarily validated by the two-browser smoke test.
- **U2:** `npx tsc --noEmit` / `ng build` clean (pure type/method additions).
- **U3, U4:** `ng build` clean.
- **End-to-end smoke (manual, two browsers):**
  1. Presenter opens live (draft); audience joins via code → shows "Waiting…".
  2. Presenter **Go Live** → audience immediately shows **"Question 1 of N"** and Q1.
  3. Audience votes an MCQ option → presenter bar shows the **option text** (not `0`), AI insight references the label.
  4. Presenter **Next ▶** → audience advances; indicator updates.
  5. Presenter **◀ Previous** → presenter sees Q1 results + `Reviewing` badge; **audience stays on the current question**; `Jump to live` returns the presenter.
  6. Presenter **Add question** (next) → becomes the next live question on `Next ▶`; **Add question** (end) → appears after the rest.

## Out of scope (YAGNI)

- Migrating historical numeric MCQ responses.
- Audience self-paced navigation / reviewing past questions (explicitly rejected — audience stays presenter-driven).
- Re-broadcasting on "Previous" (rejected — review is presenter-only).
- Editing/deleting questions mid-session (only adding).
- Reordering existing questions.
