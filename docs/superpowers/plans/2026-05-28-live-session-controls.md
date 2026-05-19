# Live-Session Controls & Answer Context — Implementation Plan

> **For agentic workers:** This plan is decomposed into **independent work units (U1–U4)** for parallel execution on the taskboard. Each unit lists its **dependencies**, the **files it owns**, and which units it is **parallel-safe** with. **Rule: no two units that can run concurrently ever edit the same file** — so parallel agents never conflict. The code in this plan is **authoritative — copy it verbatim, do not improvise.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three live-session drawbacks in Pollit: (1) presenter can add a question mid-session and review previous questions, (2) MCQ votes carry the option **text** (not the index) so results and AI insights have context, (3) the audience reliably syncs to the presenter on go-live and shows "Question X of Y".

**Architecture:** Socket.IO drives all live state. We separate the **live index** (`currentPollIndex` on the server — what the audience sees/votes on) from a **view index** (presenter-client-only, for reviewing past results). A new `presenter:goLive` event fixes a sync gap where REST `start` emitted nothing; `presenter:addPoll` inserts future-only questions; `totalPolls` is added to `poll:show` and the `audience:join` ack.

**Tech Stack:** Node 20, Express 4, Socket.IO 4, Mongoose 8 (backend); Angular 17 standalone components + signals (frontend). Backend verify: `node --check` + `node --test`. Frontend verify: `npm run build`.

**Spec:** [docs/superpowers/specs/2026-05-28-live-session-controls-design.md](../specs/2026-05-28-live-session-controls-design.md)

---

## Parallel Execution Map (taskboard-ready)

| Unit | Title | Depends on | Owns (files — no overlap with concurrent units) | Wave |
|------|-------|-----------|--------------------------------------------------|------|
| **U1** | Backend live-control socket handlers | — | `backend/src/sockets/pollSocket.js` | 1 |
| **U2** | Frontend socket-service contract | — | `frontend/src/app/core/services/socket.service.ts` | 1 |
| **U3** | Presenter live view (review nav + add question + go-live) | U2 | `frontend/src/app/features/presenter/live/live.component.ts` | 2 |
| **U4** | Audience view (option-text votes + "Question X of Y") | U2 | `frontend/src/app/features/audience/answer/answer.component.ts` | 2 |

**Wave schedule for the taskboard:**
- **Wave 1 (launch together — 2 parallel agents):** U1, U2. Disjoint files (backend vs. frontend service). They agree only through the **contract** defined in this plan — no shared file.
- **Wave 2 (after U2 lands — 2 parallel agents):** U3, U4. Disjoint files; both import the new methods/interfaces U2 created.

```
Wave 1            Wave 2
  U1 (backend) ───────────────┐   (runtime pairing only; no shared file)
                              │
  U2 (socket.service) ──┬── U3 (live.component)
                        └── U4 (answer.component)
```

**Conflict-avoidance notes (read before dispatching):**
- **Shared working tree, no git worktrees** (per this project's workflow). Parallel safety comes entirely from file ownership, so **stay inside your OWNS list.** If you think you need another file, STOP and post a message instead of editing it.
- **U2 is the hub.** Both U3 and U4 import from `socket.service.ts`. That is why all socket-service edits are consolidated into U2 and why U3/U4 wait for it. Do **not** edit `socket.service.ts` from U3 or U4.
- **U1 ⟷ U2 contract:** U1 (server) and U2 (client) must use the **exact** event names and payload shapes in the "Shared contract" section below. Both copy from this plan; they never touch each other's file, so they run fully in parallel.
- **No commits during parallel work.** The human batch-commits at the end. Do NOT `git add/commit/push`.
- **No `graphify update`** during parallel work (it rewrites a shared graph). The human refreshes the graph once at the end.
- Running `npm run build` / `npm test` only reads `src/` and writes gitignored output (`dist/`), so concurrent verification is safe.

---

## Shared contract (authoritative — U1 and U2 must match exactly)

**Server → client event:**
- `poll:show` payload: `{ currentPollIndex: number, poll: Poll, totalPolls: number }`  *(adds `totalPolls`)*

**Client → server events (with ack):**
- `presenter:goLive` → payload `{}` → ack `{ ok: boolean, error?: string }`. Server ALSO emits `poll:show` to the room.
- `presenter:addPoll` → payload `{ poll: { type, question, options }, position: 'next' | 'end' }` → ack `{ ok: boolean, polls?: Poll[], insertedAt?: number, error?: string }`.

**Ack updated:**
- `audience:join` ack adds `totalPolls: number`.

Where `Poll = { _id?: string; type: 'mcq'|'wordcloud'|'rating'|'text'; question: string; options: string[] }`.

---

## U1 — Backend live-control socket handlers

**Depends on:** none · **Owns:** `backend/src/sockets/pollSocket.js` · **Parallel-safe with:** U2 · **Can start:** immediately

Adds `presenter:goLive` and `presenter:addPoll`, and adds `totalPolls` to the `poll:show` event and the `audience:join` ack. The existing `presenter:insertPoll` and `presenter:nextPoll` are kept; we only add `totalPolls` to the latter's emit. No test harness for sockets exists, so verification is `node --check` + grep + the existing `npm test` staying green (the real behavior is checked in the end-to-end two-browser smoke test).

- [ ] **Step 1: Add `totalPolls` to the existing `presenter:nextPoll` emit**

In `backend/src/sockets/pollSocket.js`, find the `presenter:nextPoll` handler's emit:

```js
        io.to(room(session._id.toString())).emit('poll:show', {
          currentPollIndex: session.currentPollIndex,
          poll: session.polls[session.currentPollIndex]
        });
```

Replace it with:

```js
        io.to(room(session._id.toString())).emit('poll:show', {
          currentPollIndex: session.currentPollIndex,
          poll: session.polls[session.currentPollIndex],
          totalPolls: session.polls.length
        });
```

- [ ] **Step 2: Add the `presenter:goLive` handler**

Directly **after** the closing `});` of the `presenter:nextPoll` handler (and before the `presenter:endSession` handler), insert:

```js
    // ------- Presenter goes live (sets first poll + syncs audience) -------
    socket.on('presenter:goLive', async (_, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        const session = await Session.findById(socket.data.sessionId);
        if (!session) return ack && ack({ ok: false, error: 'Session not found' });
        if (session.status === 'ended') return ack && ack({ ok: false, error: 'Session has ended' });
        if (session.polls.length === 0) return ack && ack({ ok: false, error: 'Add at least one poll first' });

        session.status = 'live';
        session.currentPollIndex = 0;
        await session.save();

        const state = getState(session._id.toString());
        state.votesSinceInsight = 0;
        state.lastInsightAt = 0;

        io.to(room(session._id.toString())).emit('poll:show', {
          currentPollIndex: session.currentPollIndex,
          poll: session.polls[session.currentPollIndex],
          totalPolls: session.polls.length
        });
        ack && ack({ ok: true });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });
```

- [ ] **Step 3: Add the `presenter:addPoll` handler**

Directly **after** the existing `presenter:insertPoll` handler's closing `});`, insert:

```js
    // ------- Presenter adds a new poll mid-session (next or end; future-only) -------
    socket.on('presenter:addPoll', async ({ poll, position }, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        const validTypes = ['mcq', 'wordcloud', 'rating', 'text'];
        if (!poll || typeof poll.question !== 'string' || !poll.question.trim() ||
            !validTypes.includes(poll.type)) {
          return ack && ack({ ok: false, error: 'Invalid poll' });
        }
        const options = Array.isArray(poll.options)
          ? poll.options.map((o) => String(o).trim()).filter(Boolean)
          : [];
        if (poll.type === 'mcq' && options.length < 2) {
          return ack && ack({ ok: false, error: 'MCQ needs at least 2 options' });
        }

        const session = await Session.findById(socket.data.sessionId);
        if (!session) return ack && ack({ ok: false, error: 'Session not found' });
        if (session.status === 'ended') return ack && ack({ ok: false, error: 'Session has ended' });

        const newPoll = {
          type: poll.type,
          question: poll.question.trim(),
          options: poll.type === 'mcq' ? options : []
        };

        let insertedAt;
        if (position === 'next') {
          // currentPollIndex + 1 is always a FUTURE (unanswered) index -> safe, no reindex of answered polls
          insertedAt = session.currentPollIndex + 1;
          session.polls.splice(insertedAt, 0, newPoll);
        } else {
          session.polls.push(newPoll);
          insertedAt = session.polls.length - 1;
        }
        await session.save();

        ack && ack({ ok: true, polls: session.polls, insertedAt });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });
```

- [ ] **Step 4: Add `totalPolls` to the `audience:join` ack**

In the `audience:join` handler, find its final ack:

```js
        ack && ack({
          ok: true,
          sessionId: session._id,
          title: session.title,
          status: session.status,
          currentPollIndex: session.currentPollIndex,
          currentPoll,
          hasVoted
        });
```

Replace with (adds `totalPolls`):

```js
        ack && ack({
          ok: true,
          sessionId: session._id,
          title: session.title,
          status: session.status,
          currentPollIndex: session.currentPollIndex,
          currentPoll,
          totalPolls: session.polls.length,
          hasVoted
        });
```

- [ ] **Step 5: Verify syntax**

Run: `node --check backend/src/sockets/pollSocket.js`
Expected: no output (exit 0).

- [ ] **Step 6: Verify handlers present**

Run: `grep -nE "presenter:goLive|presenter:addPoll|totalPolls" backend/src/sockets/pollSocket.js`
Expected: `presenter:goLive` (1×), `presenter:addPoll` (1×), `totalPolls` (3× — nextPoll emit, goLive emit, audience:join ack).

- [ ] **Step 7: Existing tests stay green**

Run: `cd backend && npm test`
Expected: same pass count as before your change (PASS, 0 fail). Your edits add socket handlers only and must not break the existing `node:test` suite.

**Return:** confirm `node --check` clean, the grep counts above, and `npm test` pass count unchanged.

---

## U2 — Frontend socket-service contract

**Depends on:** none · **Owns:** `frontend/src/app/core/services/socket.service.ts` · **Parallel-safe with:** U1 · **Can start:** immediately

Adds the client-side methods and types for the new events. This is the **hub** U3 and U4 depend on, so it is its own task. Pure additions — no behavior removed.

- [ ] **Step 1: Replace the whole file with the version below**

Overwrite `frontend/src/app/core/services/socket.service.ts` with exactly:

```ts
import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Poll, PollResultGroup, Session } from './session.service';

export interface Insights {
  pulse: string;
  followups: string[];
  outliers: string[];
}

export interface PollShowEvent {
  currentPollIndex: number;
  poll: Poll;
  totalPolls: number;
}

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket | null = null;

  // Streams the components subscribe to
  pollShow$ = new Subject<PollShowEvent>();
  resultsUpdate$ = new Subject<PollResultGroup[]>();
  audienceCount$ = new Subject<number>();
  sessionEnded$ = new Subject<void>();
  insightsGenerating$ = new Subject<void>();
  insightsUpdate$ = new Subject<Insights>();

  connect(): Socket {
    if (this.socket && this.socket.connected) return this.socket;
    this.socket = io(environment.socketUrl, { transports: ['websocket', 'polling'] });
    this.attachListeners();
    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  private attachListeners() {
    if (!this.socket) return;
    this.socket.on('poll:show', (e: PollShowEvent) => this.pollShow$.next(e));
    this.socket.on('results:update', (r: PollResultGroup[]) => this.resultsUpdate$.next(r));
    this.socket.on('audience:count', (n: number) => this.audienceCount$.next(n));
    this.socket.on('session:ended', () => this.sessionEnded$.next());
    this.socket.on('insights:generating', () => this.insightsGenerating$.next());
    this.socket.on('insights:update', (i: Insights) => this.insightsUpdate$.next(i));
  }

  // ----- Presenter actions -----
  presenterJoin(sessionId: string, token: string): Promise<{
    ok: boolean; session?: Session; results?: PollResultGroup[]; audienceCount?: number; error?: string;
  }> {
    return this.emitWithAck('presenter:join', { sessionId, token });
  }

  presenterGoLive(): Promise<{ ok: boolean; error?: string }> {
    return this.emitWithAck('presenter:goLive', {});
  }

  presenterNextPoll(): Promise<{ ok: boolean; error?: string }> {
    return this.emitWithAck('presenter:nextPoll', {});
  }

  presenterEndSession(): Promise<{ ok: boolean }> {
    return this.emitWithAck('presenter:endSession', {});
  }

  presenterInsertPoll(poll: Partial<Poll>): Promise<{ ok: boolean; insertedAt?: number; error?: string }> {
    return this.emitWithAck('presenter:insertPoll', { poll });
  }

  presenterAddPoll(
    poll: Partial<Poll>,
    position: 'next' | 'end'
  ): Promise<{ ok: boolean; polls?: Poll[]; insertedAt?: number; error?: string }> {
    return this.emitWithAck('presenter:addPoll', { poll, position });
  }

  // ----- Audience actions -----
  audienceJoin(code: string, voterKey: string): Promise<{
    ok: boolean; sessionId?: string; title?: string; status?: string;
    currentPollIndex?: number; currentPoll?: Poll | null; totalPolls?: number; error?: string; hasVoted?: boolean;
  }> {
    return this.emitWithAck('audience:join', { code, voterKey });
  }

  audienceVote(pollIndex: number, answer: any, voterKey: string): Promise<{ ok: boolean; error?: string }> {
    return this.emitWithAck('audience:vote', { pollIndex, answer, voterKey });
  }

  private emitWithAck(event: string, payload: any): Promise<any> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ ok: false, error: 'No socket' });
      this.socket.emit(event, payload, (response: any) => resolve(response || { ok: false }));
    });
  }
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: build succeeds (no TS errors). New methods/types are additive.

**Return:** confirm `npm run build` succeeds and that `presenterGoLive`, `presenterAddPoll`, and `PollShowEvent.totalPolls` exist in the file.

---

## U3 — Presenter live view (review nav + add question + go-live)

**Depends on:** U2 (uses `presenterGoLive`, `presenterAddPoll`, and `PollShowEvent.totalPolls`) · **Owns:** `frontend/src/app/features/presenter/live/live.component.ts` · **Parallel-safe with:** U4 · **Wave:** 2

Introduces the client-only `viewIndex` for presenter review, a dual-purpose `Next ▶`, an `◀ Previous` review button with a LIVE/Reviewing badge, an inline add-question form (type + question + options + next/end), and switches go-live to the socket event. A `livePoll` signal holds the authoritative current poll from `poll:show`, so the live question always renders correctly even right after an insert.

- [ ] **Step 1: Replace the whole file with the version below**

Overwrite `frontend/src/app/features/presenter/live/live.component.ts` with exactly:

```ts
import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { SessionService, Session, PollResultGroup, Poll, PollType } from '../../../core/services/session.service';
import { SocketService, Insights } from '../../../core/services/socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { InsightsPanelComponent } from '../../../shared/components/insights-panel/insights-panel.component';

@Component({
  standalone: true,
  imports: [InsightsPanelComponent, FormsModule],
  template: `
    @if (session()) {
      <div class="container">
        <div class="row" style="margin-bottom:16px;">
          <h2 style="margin:0;">{{ session()!.title }}</h2>
          <span class="spacer"></span>
          <span class="muted">👥 {{ audienceCount() }}</span>
          <span class="muted">Status: {{ session()!.status }}</span>
        </div>

        <div class="card" style="text-align:center;padding:24px;">
          <div class="muted">Join code</div>
          <div style="font-size:56px;font-family:var(--font-heading);font-weight:800;letter-spacing:8px;color:var(--primary);">
            {{ session()!.code }}
          </div>
          <div class="muted" style="font-size:13px;">
            Audience joins at <strong>/join/{{ session()!.code }}</strong>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;">
          <div>
            @if (viewPoll()) {
              <div class="card">
                <div class="row">
                  <span class="muted">
                    Question {{ viewIndex() + 1 }} of {{ session()!.polls.length }}
                  </span>
                  <span class="spacer"></span>
                  @if (isLive()) {
                    <span class="muted" style="color:var(--data-teal);font-weight:700;">● LIVE</span>
                  } @else {
                    <span class="muted">Reviewing · audience on Q{{ session()!.currentPollIndex + 1 }}</span>
                    <button style="margin-left:8px;" (click)="jumpToLive()">Jump to live →</button>
                  }
                </div>
                <h3 style="margin:8px 0 16px;">{{ viewPoll()!.question }}</h3>
                <div class="muted" style="margin-bottom:12px;">Type: {{ viewPoll()!.type }}</div>

                @if (viewResult() && viewResult()!.total > 0) {
                  <strong>{{ viewResult()!.total }} responses</strong>
                  <div style="margin-top:12px;">
                    @for (r of viewResult()!.results; track $any(r.answer)) {
                      <div style="margin:6px 0;">
                        <div class="row">
                          <span style="min-width:140px;font-size:14px;">{{ formatAnswer(r.answer) }}</span>
                          <div style="flex:1;background:var(--surface-variant);border-radius:var(--radius);height:24px;overflow:hidden;">
                            <div [style.width.%]="pct(r.count)" style="background:var(--data-teal);height:100%;transition:width 0.5s cubic-bezier(0.4, 0, 0.2, 1);"></div>
                          </div>
                          <span style="min-width:50px;text-align:right;">{{ r.count }}</span>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="muted">Waiting for responses...</p>
                }
              </div>
            } @else {
              <div class="card">
                <p class="muted">No active poll. Click "Go Live" to start.</p>
              </div>
            }

            <div class="row" style="margin-top:12px;">
              @if (session()!.status === 'live') {
                <button (click)="prev()" [disabled]="viewIndex() <= 0">← Previous</button>
                <button class="primary" (click)="next()" [disabled]="nextDisabled()">Next Question →</button>
                <button (click)="toggleAddForm()">+ Add question</button>
                <span class="spacer"></span>
                <button class="danger" (click)="end()">End Session</button>
              } @else if (session()!.status === 'ended') {
                <span class="muted">Session ended</span>
              } @else if (session()!.status === 'draft') {
                <button class="primary" (click)="goLive()">Go Live</button>
              }
            </div>

            @if (showAddForm() && session()!.status === 'live') {
              <div class="card" style="margin-top:12px;">
                <strong>Add a question</strong>
                <div class="col" style="margin-top:8px;">
                  <select [(ngModel)]="newType" (ngModelChange)="onNewTypeChange()">
                    <option value="mcq">Multiple Choice</option>
                    <option value="wordcloud">Word Cloud</option>
                    <option value="rating">Rating (1-5)</option>
                    <option value="text">Open Text</option>
                  </select>

                  <input [(ngModel)]="newQuestion" placeholder="Question" />

                  @if (newType === 'mcq') {
                    @for (opt of newOptions; let j = $index; track j) {
                      <div class="row" style="margin-top:6px;">
                        <input [(ngModel)]="newOptions[j]" [placeholder]="'Option ' + (j + 1)" />
                        <button type="button" (click)="removeNewOption(j)" [disabled]="newOptions.length <= 2">×</button>
                      </div>
                    }
                    <button type="button" style="margin-top:8px;" (click)="addNewOption()">+ Add option</button>
                  }

                  <div class="row" style="margin-top:12px;align-items:center;gap:16px;">
                    <label><input type="radio" name="pos" value="next" [(ngModel)]="newPosition" /> Insert next</label>
                    <label><input type="radio" name="pos" value="end" [(ngModel)]="newPosition" /> Add to end</label>
                  </div>

                  <div class="row" style="margin-top:12px;">
                    <button class="primary" (click)="addQuestion()" [disabled]="adding()">
                      {{ adding() ? 'Adding...' : 'Add question' }}
                    </button>
                    <button type="button" (click)="toggleAddForm()">Cancel</button>
                  </div>
                </div>
              </div>
            }
          </div>

          <div>
            <app-insights-panel
              [insights]="insights()"
              [generating]="insightGenerating()"
              (useFollowup)="onUseFollowup($event)" />
          </div>
        </div>
      </div>
    } @else {
      <div class="container"><p class="muted">Loading session...</p></div>
    }
  `
})
export class LiveComponent implements OnInit, OnDestroy {
  private svc = inject(SessionService);
  private socketSvc = inject(SocketService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  session = signal<Session | null>(null);
  results = signal<PollResultGroup[]>([]);
  audienceCount = signal(0);
  insights = signal<Insights | null>(null);
  insightGenerating = signal(false);

  // Presenter-only viewing position (review). Defaults to / snaps to the live index.
  viewIndex = signal(0);
  // Authoritative current live poll from poll:show (covers freshly inserted polls).
  livePoll = signal<Poll | null>(null);

  // Add-question form state
  showAddForm = signal(false);
  newType: PollType = 'mcq';
  newQuestion = '';
  newOptions: string[] = ['', ''];
  newPosition: 'next' | 'end' = 'next';
  adding = signal(false);

  private subs: Subscription[] = [];

  isLive = computed(() => {
    const s = this.session();
    return !!s && this.viewIndex() === s.currentPollIndex;
  });

  nextDisabled = computed(() => {
    const s = this.session();
    if (!s) return true;
    if (this.viewIndex() < s.currentPollIndex) return false; // reviewing forward is always allowed
    return s.currentPollIndex + 1 >= s.polls.length; // at live edge: disabled on last poll
  });

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.svc.get(id).subscribe(s => {
      this.session.set(s);
      this.connectSocket(id);
    });
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    this.socketSvc.disconnect();
  }

  private connectSocket(sessionId: string) {
    this.socketSvc.connect();
    const token = this.auth.token();
    if (!token) return;

    this.socketSvc.presenterJoin(sessionId, token).then(res => {
      if (!res.ok) { alert(res.error || 'Failed to join socket'); return; }
      if (res.session) {
        this.session.set(res.session);
        const idx = Math.max(0, res.session.currentPollIndex);
        this.viewIndex.set(idx);
        this.livePoll.set(res.session.polls[res.session.currentPollIndex] ?? null);
      }
      if (res.results) this.results.set(res.results);
      if (res.audienceCount !== undefined) this.audienceCount.set(res.audienceCount);
    });

    this.subs.push(
      this.socketSvc.resultsUpdate$.subscribe(r => this.results.set(r)),
      this.socketSvc.audienceCount$.subscribe(n => this.audienceCount.set(n)),
      this.socketSvc.pollShow$.subscribe(e => {
        const s = this.session();
        if (s) {
          s.currentPollIndex = e.currentPollIndex;
          this.session.set({ ...s });
        }
        this.livePoll.set(e.poll);
        this.viewIndex.set(e.currentPollIndex); // follow live by default
        this.insights.set(null);
      }),
      this.socketSvc.sessionEnded$.subscribe(() => {
        const s = this.session();
        if (s) { s.status = 'ended'; this.session.set({ ...s }); }
      }),
      this.socketSvc.insightsGenerating$.subscribe(() => this.insightGenerating.set(true)),
      this.socketSvc.insightsUpdate$.subscribe(i => {
        this.insights.set(i);
        this.insightGenerating.set(false);
      })
    );
  }

  // The poll currently being viewed (live poll preferred for the live index).
  viewPoll(): Poll | null {
    const s = this.session();
    if (!s || this.viewIndex() < 0) return null;
    if (this.viewIndex() === s.currentPollIndex && this.livePoll()) return this.livePoll();
    return s.polls[this.viewIndex()] || null;
  }

  viewResult(): PollResultGroup | null {
    return this.results().find(r => r._id === this.viewIndex()) || null;
  }

  pct(count: number): number {
    const total = this.viewResult()?.total || 0;
    return total ? (count / total) * 100 : 0;
  }

  formatAnswer(a: any): string {
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }

  goLive() {
    this.socketSvc.presenterGoLive().then(res => {
      if (!res.ok) { alert(res.error || 'Failed to start'); return; }
      const s = this.session();
      if (s) {
        s.status = 'live';
        s.currentPollIndex = 0;
        this.session.set({ ...s });
      }
      this.viewIndex.set(0);
    });
  }

  prev() {
    if (this.viewIndex() > 0) this.viewIndex.set(this.viewIndex() - 1);
  }

  next() {
    const s = this.session();
    if (!s) return;
    if (this.viewIndex() < s.currentPollIndex) {
      this.viewIndex.set(this.viewIndex() + 1); // review forward
      return;
    }
    if (s.currentPollIndex + 1 >= s.polls.length) return; // last poll
    this.socketSvc.presenterNextPoll().then(res => {
      if (!res.ok) alert(res.error || 'Failed');
    });
  }

  jumpToLive() {
    const s = this.session();
    if (s) this.viewIndex.set(s.currentPollIndex);
  }

  end() {
    if (!confirm('End the session?')) return;
    this.socketSvc.presenterEndSession();
  }

  toggleAddForm() {
    const open = !this.showAddForm();
    this.showAddForm.set(open);
    if (open) {
      this.newType = 'mcq';
      this.newQuestion = '';
      this.newOptions = ['', ''];
      this.newPosition = 'next';
    }
  }

  onNewTypeChange() {
    if (this.newType === 'mcq' && this.newOptions.length < 2) {
      this.newOptions = ['', ''];
    }
  }

  addNewOption() { this.newOptions.push(''); }

  removeNewOption(i: number) {
    if (this.newOptions.length > 2) this.newOptions.splice(i, 1);
  }

  addQuestion() {
    const q = this.newQuestion.trim();
    if (!q) { alert('Enter a question'); return; }
    const opts = this.newType === 'mcq'
      ? this.newOptions.map(o => o.trim()).filter(Boolean)
      : [];
    if (this.newType === 'mcq' && opts.length < 2) {
      alert('MCQ needs at least 2 options'); return;
    }
    this.adding.set(true);
    this.socketSvc.presenterAddPoll(
      { type: this.newType, question: q, options: opts },
      this.newPosition
    ).then(res => {
      this.adding.set(false);
      if (!res.ok) { alert(res.error || 'Failed to add'); return; }
      const s = this.session();
      if (s && res.polls) { s.polls = res.polls; this.session.set({ ...s }); }
      this.showAddForm.set(false);
    });
  }

  onUseFollowup(question: string) {
    this.socketSvc.presenterAddPoll({ type: 'text', question, options: [] }, 'next').then(res => {
      if (!res.ok) { alert(res.error || 'Failed to insert'); return; }
      const s = this.session();
      if (s && res.polls) { s.polls = res.polls; this.session.set({ ...s }); }
      this.socketSvc.presenterNextPoll();
    });
  }
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: build succeeds. (If it fails with "presenterGoLive is not a function" or a `totalPolls` type error, U2 has not landed yet — wait for U2.)

**Return:** confirm `npm run build` succeeds; note that Previous/Next/Add-question/Go-Live wiring compiles.

---

## U4 — Audience view (option-text votes + "Question X of Y")

**Depends on:** U2 (uses `PollShowEvent.totalPolls` and the `totalPolls` field on the `audience:join` ack) · **Owns:** `frontend/src/app/features/audience/answer/answer.component.ts` · **Parallel-safe with:** U3 · **Wave:** 2

Sends the MCQ **option text** instead of the index, and shows "Question X of Y".

- [ ] **Step 1: Replace the whole file with the version below**

Overwrite `frontend/src/app/features/audience/answer/answer.component.ts` with exactly:

```ts
import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { Poll } from '../../../core/services/session.service';
import { SocketService } from '../../../core/services/socket.service';
import { load } from '@fingerprintjs/fingerprintjs';

@Component({
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container" style="max-width:520px;">
      @if (loading()) {
        <p class="muted">Connecting...</p>
      } @else if (error()) {
        <div class="card"><div class="error">{{ error() }}</div></div>
      } @else {
        <div class="card">
          <div class="muted">{{ title() }}</div>
          @if (status() === 'draft') {
            <h3>Waiting for the presenter to start...</h3>
          } @else if (status() === 'ended') {
            <h3>Session has ended. Thanks!</h3>
          } @else if (poll()) {
            @if (totalPolls() > 0) {
              <div class="muted" style="margin-bottom:4px;">
                Question {{ pollIndex() + 1 }} of {{ totalPolls() }}
              </div>
            }
            <h3>{{ poll()!.question }}</h3>

            @if (voted()) {
              <p class="muted">✓ Vote recorded! Waiting for the next question...</p>
            } @else {
              @switch (poll()!.type) {
                @case ('mcq') {
                  @for (opt of poll()!.options; let i = $index; track i) {
                    <button style="display:block;width:100%;margin:8px 0;padding:16px;text-align:left;"
                            (click)="vote(opt)">
                      {{ opt }}
                    </button>
                  }
                }
                @case ('rating') {
                  <div class="row" style="justify-content:center;gap:12px;margin-top:16px;">
                    @for (n of [1,2,3,4,5]; track n) {
                      <button style="width:60px;height:60px;font-size:24px;" (click)="vote(n)">{{ n }}</button>
                    }
                  </div>
                }
                @case ('wordcloud') {
                  <input [(ngModel)]="textInput" maxlength="20" placeholder="One word" />
                  <button class="primary" style="margin-top:8px;" (click)="vote(textInput)" [disabled]="!textInput.trim()">
                    Submit
                  </button>
                }
                @case ('text') {
                  <textarea [(ngModel)]="textInput" rows="4" placeholder="Your answer"></textarea>
                  <button class="primary" style="margin-top:8px;" (click)="vote(textInput)" [disabled]="!textInput.trim()">
                    Submit
                  </button>
                }
              }
            }
          } @else {
            <p class="muted">Waiting for the next question...</p>
          }
        </div>
      }
    </div>
  `
})
export class AnswerComponent implements OnInit, OnDestroy {
  private socketSvc = inject(SocketService);
  private route = inject(ActivatedRoute);

  code = '';
  loading = signal(true);
  error = signal<string | null>(null);
  title = signal('');
  status = signal<string>('');
  poll = signal<Poll | null>(null);
  pollIndex = signal(-1);
  totalPolls = signal(0);
  voted = signal(false);
  textInput = '';
  voterKey = '';

  private subs: Subscription[] = [];

  async ngOnInit() {
    this.code = this.route.snapshot.paramMap.get('code')!;
    this.voterKey = await this.getOrCreateVoterKey();

    this.socketSvc.connect();
    this.socketSvc.audienceJoin(this.code, this.voterKey).then(res => {
      this.loading.set(false);
      if (!res.ok) {
        this.error.set(res.error || 'Could not join session');
        return;
      }
      this.title.set(res.title || '');
      this.status.set(res.status || '');
      this.poll.set(res.currentPoll || null);
      this.pollIndex.set(res.currentPollIndex ?? -1);
      this.totalPolls.set(res.totalPolls ?? 0);
      if (res.hasVoted) {
        this.voted.set(true);
      }
    });

    this.subs.push(
      this.socketSvc.pollShow$.subscribe(e => {
        this.poll.set(e.poll);
        this.pollIndex.set(e.currentPollIndex);
        this.totalPolls.set(e.totalPolls ?? this.totalPolls());
        this.voted.set(false);
        this.textInput = '';
        this.status.set('live');
      }),
      this.socketSvc.sessionEnded$.subscribe(() => {
        this.status.set('ended');
        this.poll.set(null);
      })
    );
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    this.socketSvc.disconnect();
  }

  private async getOrCreateVoterKey(): Promise<string> {
    try {
      const fp = await load();
      const result = await fp.get();

      let localSession = localStorage.getItem('localSessionId');
      if (!localSession) {
        localSession = Math.random().toString(36).slice(2);
        localStorage.setItem('localSessionId', localSession);
      }

      return `${result.visitorId}_${localSession}`;
    } catch (e) {
      console.warn('FingerprintJS failed, falling back to localStorage');
      let k = localStorage.getItem('voterKey');
      if (!k) {
        k = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('voterKey', k);
      }
      return k;
    }
  }

  vote(answer: any) {
    if (this.pollIndex() < 0) return;
    this.socketSvc.audienceVote(this.pollIndex(), answer, this.voterKey).then(res => {
      if (res.ok) {
        this.voted.set(true);
      } else {
        if (res.error === 'Already voted') this.voted.set(true);
        else alert(res.error || 'Vote failed');
      }
    });
  }
}
```

- [ ] **Step 2: Verify the option-text change is present**

Run: `grep -n "vote(opt)" frontend/src/app/features/audience/answer/answer.component.ts`
Expected: one match (the MCQ button). Confirm `vote(i)` no longer appears: `grep -n "vote(i)" frontend/src/app/features/audience/answer/answer.component.ts` returns nothing.

- [ ] **Step 3: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: build succeeds. (If `totalPolls` is a type error, U2 has not landed — wait for U2.)

**Return:** confirm MCQ sends `opt`, the "Question X of Y" indicator is present, and `npm run build` succeeds.

---

## End-to-end verification (run by the human after all units land + batch commit)

Two browsers (one presenter logged in, one incognito audience):

1. Presenter opens a draft session's live page; audience opens `/join/<code>` → audience shows "Waiting…".
2. Presenter clicks **Go Live** → audience **immediately** shows **"Question 1 of N"** + Q1. *(verifies U1 goLive + U4 indicator + U2 wiring)*
3. Audience votes an MCQ option → presenter's result bar shows the **option text**, not `0`; after ~5 votes/10s the AI pulse references the label. *(verifies U4 vote-text + U1 unchanged aggregation)*
4. Presenter **Next Question →** → audience advances; indicator updates. *(U3 + U1)*
5. Presenter **← Previous** → presenter sees Q1's results + "Reviewing · audience on Q2"; **audience stays on Q2**; **Jump to live →** returns the presenter. *(U3 review, no broadcast)*
6. Presenter **+ Add question** → choose MCQ + **Insert next** → it becomes the next question on **Next →**; choose **Add to end** → it appears after the existing questions. *(U3 form + U1 addPoll)*

---

## Self-review (completed by plan author)

- **Spec coverage:** Feature 1 → U1 (`addPoll`) + U3 (review nav, add form, dual Next). Feature 2 → U4 (`vote(opt)`). Feature 3 → U1 (`goLive` + `totalPolls`) + U4 ("Q X of Y") + U2 (contract). All spec sections map to a task.
- **Contract consistency:** `presenter:goLive`, `presenter:addPoll {poll, position}` → `{ok, polls?, insertedAt?}`, `poll:show {currentPollIndex, poll, totalPolls}`, `audience:join` ack `totalPolls` — identical names/shapes across U1 (server) and U2 (client), and consumed unchanged in U3/U4.
- **No placeholders:** every step has full code and exact verify commands.
- **File ownership:** U1≠U2≠U3≠U4; concurrent pairs (U1,U2) and (U3,U4) never share a file.

---

## Agent prompt (paste to EVERY agent, alongside `team-init`)

```
You are one of ~2 parallel agents implementing the "Live-Session Controls" round on a SHARED working tree (no git worktrees). Conflict-free parallelism depends entirely on file ownership — stay inside your task's OWNS list.

1) ORIENT
- Read (authoritative, copy code VERBATIM — do not improvise):
  docs/superpowers/plans/2026-05-28-live-session-controls.md
- Also read: docs/superpowers/specs/2026-05-28-live-session-controls-design.md and .agents/coordination/TASKS.md
- For code questions, use the graphify graph (MCP query_graph / get_node, or `graphify query`) — not broad grep.

2) CLAIM ONE TASK — DECLARE BEFORE CODING
- In .agents/coordination/tasks.json pick the LOWEST-numbered Pending task whose depends_on are all Completed.
- Set it status=in_progress + assignee=<you>, and post "claiming T## [U#]" in .agents/coordination/MESSAGES.md — BEFORE editing any file.

3) EXECUTE the matching [U#] section of the plan
- Edit ONLY your task's OWNS file(s). If you think you need another file: STOP, post a message, do not edit it.
- Apply the verify commands in the plan and prove each with REAL command output (verification-before-completion). Debug systematically if anything fails.

4) HARD CONSTRAINTS
- NO git add / commit / push (the human batch-commits at the very end).
- NO `graphify update` during parallel work (the human refreshes the graph once at the end).
- No scope creep; do not edit the plan/spec or another agent's files.

5) HANDOFFS
- T27 and T28 depend on T26: do not start them until T26 is Completed.
- Post any value another task needs via MESSAGES.md; never hardcode secrets.

6) WHEN DONE
- Set the task status=completed, post your Return line in MESSAGES.md, then LOOP to the next claimable task.
- Stop when no claimable task remains.
```

**After the agents report done — VERIFY, don't trust their notes** (this project's agents have, in past rounds, created duplicate task IDs and introduced regressions): read the four changed files yourself, run `node --check backend/src/sockets/pollSocket.js`, `cd backend && npm test`, `cd frontend && npm run build`, then the two-browser end-to-end smoke test above. Only then batch-commit and refresh graphify once.
