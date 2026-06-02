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
        this.viewIndex.set(res.session.currentPollIndex);
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
