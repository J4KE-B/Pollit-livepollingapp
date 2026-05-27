import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionService, Session } from '../../../core/services/session.service';
import { UserService, AdminUser } from '../../../core/services/user.service';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  standalone: true,
  imports: [CommonModule],
  template: `
    <div style="display: flex; min-height: 100vh; width: 100%; background: var(--surface-container-low);">
      <!-- Sidebar -->
      <aside style="width: 280px; background: #fff; border-right: 1px solid var(--outline-variant); padding: 24px; display: flex; flex-direction: column;">
        <h2 style="font-family: var(--font-heading); color: var(--primary); font-size: 24px; margin-bottom: 40px; font-weight: 800;">
          Pollit Admin
        </h2>
        <nav style="display: flex; flex-direction: column; gap: 8px;">
          <a class="sidebar-link" [class.active]="currentTab() === 'sessions'" (click)="currentTab.set('sessions')">Global Sessions</a>
          <a class="sidebar-link" [class.active]="currentTab() === 'users'" (click)="currentTab.set('users')">Users</a>
          <a class="sidebar-link disabled">Analytics</a>
          <a class="sidebar-link disabled">Settings</a>
        </nav>
        <span style="flex:1;"></span>
        <button class="danger" (click)="logout()">Logout Admin</button>
      </aside>

      <!-- Main Content -->
      <main style="flex: 1; padding: 48px 64px;">
        @if (currentTab() === 'sessions') {
          <h1 style="font-family: var(--font-heading); font-size: 32px; font-weight: 700; margin-bottom: 32px;">Global Sessions Overview</h1>

          <!-- Stats -->
          <div style="display: flex; gap: 24px; margin-bottom: 40px;">
            <div class="card stat-card">
              <div class="muted">Total Sessions</div>
              <div class="stat-value">{{ sessions().length }}</div>
            </div>
            <div class="card stat-card">
              <div class="muted">Live Right Now</div>
              <div class="stat-value">{{ liveCount() }}</div>
            </div>
          </div>

          <!-- Data Table -->
          <div class="card" style="padding: 0; overflow: hidden;">
            <table style="width: 100%; border-collapse: collapse; text-align: left;">
              <thead>
                <tr style="background: var(--surface-container-lowest); border-bottom: 1px solid var(--outline-variant);">
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Meeting Title</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Presenter</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Status</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Polls</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (s of sessions(); track s._id) {
                  <tr style="border-bottom: 1px solid var(--surface-container);">
                    <td style="padding: 16px 24px; font-weight: 600;">{{ s.title }}</td>
                    <td style="padding: 16px 24px;">{{ s.presenter?.name || s.presenter || 'Unknown' }}</td>
                    <td style="padding: 16px 24px;">
                      <span class="badge" [class.live]="s.status === 'live'">{{ s.status | uppercase }}</span>
                    </td>
                    <td style="padding: 16px 24px;">{{ s.polls.length }}</td>
                    <td style="padding: 16px 24px; display: flex; gap: 8px;">
                      <button class="outline-btn" (click)="deleteSession(s._id)">Delete</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            @if (sessions().length === 0) {
              <div style="padding: 40px; text-align: center; color: var(--on-surface-variant);">No sessions found across the platform.</div>
            }
          </div>
        }

        @if (currentTab() === 'users') {
          <h1 style="font-family: var(--font-heading); font-size: 32px; font-weight: 700; margin-bottom: 32px;">Registered Users</h1>

          <!-- Users Stats -->
          <div style="display: flex; gap: 24px; margin-bottom: 40px;">
            <div class="card stat-card">
              <div class="muted">Total Users</div>
              <div class="stat-value">{{ users().length }}</div>
            </div>
          </div>

          <!-- Users Data Table -->
          <div class="card" style="padding: 0; overflow: hidden;">
            <table style="width: 100%; border-collapse: collapse; text-align: left;">
              <thead>
                <tr style="background: var(--surface-container-lowest); border-bottom: 1px solid var(--outline-variant);">
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Name</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Email ID</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Auth Method</th>
                  <th style="padding: 16px 24px; font-weight: 600; color: var(--on-surface-variant);">Sessions Created</th>
                </tr>
              </thead>
              <tbody>
                @for (u of users(); track u._id) {
                  <tr style="border-bottom: 1px solid var(--surface-container);">
                    <td style="padding: 16px 24px; font-weight: 600;">{{ u.name }}</td>
                    <td style="padding: 16px 24px;">{{ u.email }}</td>
                    <td style="padding: 16px 24px;">
                      <span class="badge">{{ u.authProvider === 'google' ? 'Google' : 'Local' }}</span>
                    </td>
                    <td style="padding: 16px 24px;">{{ u.sessionCount || 0 }}</td>
                  </tr>
                }
              </tbody>
            </table>
            @if (users().length === 0) {
              <div style="padding: 40px; text-align: center; color: var(--on-surface-variant);">No users found.</div>
            }
          </div>
        }
      </main>
    </div>
  `,
  styles: [`
    .sidebar-link {
      padding: 12px 16px;
      border-radius: var(--radius);
      color: var(--on-surface-variant);
      font-weight: 600;
      cursor: pointer;
    }
    .sidebar-link.active {
      background: var(--primary-fixed);
      color: var(--on-primary-fixed);
    }
    .sidebar-link.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .stat-card {
      flex: 1;
      padding: 24px;
      margin: 0;
    }
    .stat-value {
      font-size: 40px;
      font-family: var(--font-heading);
      font-weight: 800;
      color: var(--primary);
      margin-top: 8px;
    }
    .badge {
      padding: 4px 12px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 600;
      background: var(--surface-container-high);
      color: var(--on-surface-variant);
    }
    .badge.live {
      background: var(--data-teal);
      color: #fff;
    }
    .outline-btn {
      padding: 6px 12px;
      font-size: 12px;
      border: 1px solid var(--outline-variant);
      color: var(--error);
    }
    .outline-btn:hover {
      background: var(--error-container);
      border-color: var(--error);
    }
  `]
})
export class AdminDashboardComponent implements OnInit {
  private sessionService = inject(SessionService);
  private userService = inject(UserService);
  private auth = inject(AuthService);

  currentTab = signal<'sessions' | 'users'>('sessions');
  sessions = signal<any[]>([]);
  users = signal<AdminUser[]>([]);

  ngOnInit() {
    this.loadSessions();
    this.loadUsers();
  }

  loadSessions() {
    this.sessionService.listAll().subscribe({
      next: (data) => this.sessions.set(data),
      error: (err) => console.error('Failed to load all sessions', err)
    });
  }

  loadUsers() {
    this.userService.listAll().subscribe({
      next: (data) => this.users.set(data),
      error: (err) => console.error('Failed to load users', err)
    });
  }

  liveCount() {
    return this.sessions().filter(s => s.status === 'live').length;
  }

  deleteSession(id: string) {
    if (confirm('Are you sure you want to delete this session?')) {
      this.sessionService.remove(id).subscribe({
        next: () => this.loadSessions(),
        error: (err) => console.error('Delete failed', err)
      });
    }
  }

  logout() {
    this.auth.logout();
  }
}
