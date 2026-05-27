import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { SessionService, Session } from '../../../core/services/session.service';

@Component({
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="container">
      <div class="row" style="margin-bottom:24px;">
        <h2 style="margin:0;font-family:var(--font-heading);font-weight:800;font-size:32px;">Presenter Dashboard</h2>
        <span class="spacer"></span>
        <button class="primary" routerLink="/session/new">+ New Session</button>
      </div>

      @if (loading()) {
        <p class="muted">Loading...</p>
      } @else if (sessions().length === 0) {
        <div class="card">
          <p>No sessions yet. Create your first one!</p>
        </div>
      } @else {
        @for (s of sessions(); track s._id) {
          <div class="card">
            <div class="row">
              <div>
                <strong>{{ s.title }}</strong>
                <div class="muted">
                  Code: <code>{{ s.code }}</code> · {{ s.polls.length }} polls · {{ s.status }}
                </div>
              </div>
              <span class="spacer"></span>
              @if (s.status === 'draft') {
                <button [routerLink]="['/session', s._id, 'edit']">Edit</button>
                <button class="primary" (click)="goLive(s._id)">Go Live</button>
              } @else if (s.status === 'live') {
                <button class="primary" [routerLink]="['/session', s._id, 'live']">Open Live</button>
              } @else {
                <button [routerLink]="['/session', s._id, 'live']">View Results</button>
              }
              <button class="danger" (click)="remove(s._id)">Delete</button>
            </div>
          </div>
        }
      }
    </div>
  `
})
export class DashboardComponent implements OnInit {
  private svc = inject(SessionService);
  private router = inject(Router);

  sessions = signal<Session[]>([]);
  loading = signal(true);

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.svc.list().subscribe({
      next: (data) => { this.sessions.set(data); this.loading.set(false); },
      error: () => this.loading.set(false)
    });
  }

  goLive(id: string) {
    this.svc.start(id).subscribe({
      next: () => this.router.navigate(['/session', id, 'live']),
      error: (err) => alert(err.error?.message || 'Failed to start')
    });
  }

  remove(id: string) {
    if (!confirm('Delete this session and all responses?')) return;
    this.svc.remove(id).subscribe(() => this.load());
  }
}
