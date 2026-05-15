import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { Poll } from '../../../core/services/session.service';
import { SocketService } from '../../../core/services/socket.service';

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
            <h3>{{ poll()!.question }}</h3>

            @if (voted()) {
              <p class="muted">✓ Vote recorded! Waiting for the next question...</p>
            } @else {
              @switch (poll()!.type) {
                @case ('mcq') {
                  @for (opt of poll()!.options; let i = $index; track i) {
                    <button style="display:block;width:100%;margin:8px 0;padding:16px;text-align:left;"
                            (click)="vote(i)">
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
  voted = signal(false);
  textInput = '';
  voterKey = '';

  private subs: Subscription[] = [];

  ngOnInit() {
    this.code = this.route.snapshot.paramMap.get('code')!;
    this.voterKey = this.getOrCreateVoterKey();

    this.socketSvc.connect();
    this.socketSvc.audienceJoin(this.code).then(res => {
      this.loading.set(false);
      if (!res.ok) {
        this.error.set(res.error || 'Could not join session');
        return;
      }
      this.title.set(res.title || '');
      this.status.set(res.status || '');
      this.poll.set(res.currentPoll || null);
      this.pollIndex.set(res.currentPollIndex ?? -1);
    });

    this.subs.push(
      this.socketSvc.pollShow$.subscribe(e => {
        this.poll.set(e.poll);
        this.pollIndex.set(e.currentPollIndex);
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

  private getOrCreateVoterKey(): string {
    let k = localStorage.getItem('voterKey');
    if (!k) {
      k = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('voterKey', k);
    }
    return k;
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
