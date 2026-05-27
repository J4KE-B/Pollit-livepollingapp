import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { SessionService, Session, PollResultGroup, Poll } from '../../../core/services/session.service';
import { SocketService, Insights } from '../../../core/services/socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { InsightsPanelComponent } from '../../../shared/components/insights-panel/insights-panel.component';

@Component({
  standalone: true,
  imports: [InsightsPanelComponent],
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
            @if (currentPoll()) {
              <div class="card">
                <div class="muted">
                  Question {{ session()!.currentPollIndex + 1 }} of {{ session()!.polls.length }}
                </div>
                <h3 style="margin:8px 0 16px;">{{ currentPoll()!.question }}</h3>
                <div class="muted" style="margin-bottom:12px;">Type: {{ currentPoll()!.type }}</div>

                @if (currentResult() && currentResult()!.total > 0) {
                  <strong>{{ currentResult()!.total }} responses</strong>
                  <div style="margin-top:12px;">
                    @for (r of currentResult()!.results; track $any(r.answer)) {
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
                <button class="primary" (click)="next()" [disabled]="isLastPoll()">Next Question →</button>
                <button class="danger" (click)="end()">End Session</button>
              } @else if (session()!.status === 'ended') {
                <span class="muted">Session ended</span>
              } @else if (session()!.status === 'draft') {
                <button class="primary" (click)="goLive()">Go Live</button>
              }
            </div>
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

  private subs: Subscription[] = [];

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
      if (res.session) this.session.set(res.session);
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

  currentPoll(): Poll | null {
    const s = this.session();
    if (!s || s.currentPollIndex < 0) return null;
    return s.polls[s.currentPollIndex] || null;
  }

  currentResult(): PollResultGroup | null {
    const s = this.session();
    if (!s) return null;
    return this.results().find(r => r._id === s.currentPollIndex) || null;
  }

  isLastPoll(): boolean {
    const s = this.session();
    return !s || s.currentPollIndex + 1 >= s.polls.length;
  }

  pct(count: number): number {
    const total = this.currentResult()?.total || 0;
    return total ? (count / total) * 100 : 0;
  }

  formatAnswer(a: any): string {
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }

  goLive() {
    const id = this.session()!._id;
    this.svc.start(id).subscribe({
      next: (s) => {
        this.session.set(s);
        const token = this.auth.token();
        if (token) this.socketSvc.presenterJoin(id, token);
      },
      error: (err) => alert(err.error?.message || 'Failed to start')
    });
  }

  next() {
    this.socketSvc.presenterNextPoll().then(res => {
      if (!res.ok) alert(res.error || 'Failed');
    });
  }

  end() {
    if (!confirm('End the session?')) return;
    this.socketSvc.presenterEndSession();
  }

  onUseFollowup(question: string) {
    this.socketSvc.presenterInsertPoll({
      type: 'text',
      question,
      options: []
    }).then(res => {
      if (!res.ok) { alert(res.error || 'Failed to insert'); return; }
      this.socketSvc.presenterNextPoll();
    });
  }
}
