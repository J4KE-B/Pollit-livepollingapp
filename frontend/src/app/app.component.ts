import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <div style="display:flex;flex-direction:column;min-height:100vh;">
      <header style="padding:16px 32px;display:flex;align-items:center;gap:24px;">
        <strong style="font-size:24px;color:var(--primary);font-family:var(--font-heading);letter-spacing:-0.5px;">Pollit</strong>
        <a routerLink="/" style="color:var(--on-surface-variant);font-weight:600;font-size:14px;margin-left:8px;">Join</a>
        <span class="spacer"></span>
        @if (auth.isLoggedIn()) {
          <a routerLink="/dashboard" style="color:var(--primary);font-weight:600;font-size:14px;">Dashboard</a>
          <span class="muted" style="font-weight:600;font-size:14px;">{{ auth.currentUser()?.name }}</span>
          <a (click)="auth.logout()" style="cursor:pointer;color:var(--primary);font-weight:600;font-size:14px;">Logout</a>
        } @else {
          <a routerLink="/login" style="color:var(--primary);font-weight:600;font-size:14px;">Login</a>
          <a routerLink="/register" style="color:var(--primary);font-weight:600;font-size:14px;">Register</a>
        }
      </header>
      <main style="flex:1;display:flex;flex-direction:column;align-items:center;padding:24px;">
        <router-outlet />
      </main>
    </div>
  `
})
export class AppComponent {
  constructor(public auth: AuthService) {}
}
