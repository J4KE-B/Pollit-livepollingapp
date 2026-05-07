import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav class="app-nav">
      <span class="nav-brand">⚡ LivePoll</span>
      <a class="nav-link" routerLink="/">Join</a>
      @if (auth.isLoggedIn()) {
        <a class="nav-link" routerLink="/dashboard">Dashboard</a>
        <span class="spacer"></span>
        <span class="muted hide-sm">{{ auth.currentUser()?.name }}</span>
        <button (click)="auth.logout()">Logout</button>
      } @else {
        <span class="spacer"></span>
        <a class="nav-link" routerLink="/login">Login</a>
        <a class="nav-link" routerLink="/register">Register</a>
      }
    </nav>
    <main>
      <router-outlet />
    </main>
  `
})
export class AppComponent {
  constructor(public auth: AuthService) {}
}
