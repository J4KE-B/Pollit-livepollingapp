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
  fingerprint = '';

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

  /**
   * voterKey = `${visitorId}_${localSessionNonce}`.
   *   visitorId          -> stable DEVICE fingerprint (survives clearing site data / incognito)
   *   localSessionNonce  -> per-browser-storage identity (does NOT survive clearing site data)
   * The backend's unique index dedupes on the full voterKey, so clearing localStorage mints a new
   * identity and would allow a second vote -- except that the device half stays constant, which is
   * precisely what backend/src/security/abuseDetector.js clusters on (FP_IDENTITY_CHURN).
   */
  private async getOrCreateVoterKey(): Promise<string> {
    try {
      const fp = await load();
      const result = await fp.get();

      let localSession = localStorage.getItem('localSessionId');
      if (!localSession) {
        localSession = Math.random().toString(36).slice(2);
        localStorage.setItem('localSessionId', localSession);
      }

      this.fingerprint = result.visitorId;
      return `${result.visitorId}_${localSession}`;
    } catch (e) {
      console.warn('FingerprintJS failed, falling back to localStorage');
      let k = localStorage.getItem('voterKey');
      if (!k) {
        k = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('voterKey', k);
      }
      // No device signal available on this path -- leave fingerprint empty rather than send a
      // random value the backend might mistake for a device id.
      this.fingerprint = '';
      return k;
    }
  }

  vote(answer: any) {
    if (this.pollIndex() < 0) return;
    this.socketSvc
      .audienceVote(this.pollIndex(), answer, this.voterKey, this.fingerprint || undefined)
      .then(res => {
        if (res.ok) {
          this.voted.set(true);
        } else {
          if (res.error === 'Already voted') this.voted.set(true);
          else alert(res.error || 'Vote failed');
        }
      });
  }
}
