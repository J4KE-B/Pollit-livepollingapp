import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <header style="background:#fff;border-bottom:1px solid #e5e5ec;padding:12px 24px;display:flex;align-items:center;gap:16px;">
      <strong style="font-size:18px;">📊 Live Poll</strong>
      <a routerLink="/">Join</a>
      @if (auth.isLoggedIn()) {
        <a routerLink="/dashboard">Dashboard</a>
        <span class="spacer"></span>
        <span class="muted">{{ auth.currentUser()?.name }}</span>
        <button (click)="auth.logout()">Logout</button>
      } @else {
        <span class="spacer"></span>
        <a routerLink="/login">Login</a>
        <a routerLink="/register">Register</a>
      }
    </header>
    <main>
      <router-outlet />
    </main>
  `
})
export class AppComponent {
  constructor(public auth: AuthService) {}
}
