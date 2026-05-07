import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/audience/join/join.component').then(m => m.JoinComponent) },
  { path: 'join/:code', loadComponent: () => import('./features/audience/answer/answer.component').then(m => m.AnswerComponent) },
  { path: 'login', loadComponent: () => import('./features/auth/login/login.component').then(m => m.LoginComponent) },
  { path: 'register', loadComponent: () => import('./features/auth/register/register.component').then(m => m.RegisterComponent) },
  { path: 'dashboard', canActivate: [authGuard], loadComponent: () => import('./features/presenter/dashboard/dashboard.component').then(m => m.DashboardComponent) },
  { path: 'session/new', canActivate: [authGuard], loadComponent: () => import('./features/presenter/builder/builder.component').then(m => m.BuilderComponent) },
  { path: 'session/:id/edit', canActivate: [authGuard], loadComponent: () => import('./features/presenter/builder/builder.component').then(m => m.BuilderComponent) },
  { path: 'session/:id/live', canActivate: [authGuard], loadComponent: () => import('./features/presenter/live/live.component').then(m => m.LiveComponent) },
  { path: '**', redirectTo: '' }
];
