import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <div class="container" style="max-width:420px;flex:1;display:flex;flex-direction:column;justify-content:center;width:100%;">
      <div class="card" style="text-align:center;padding:32px;">
        <h2 style="font-family:var(--font-heading);font-weight:800;font-size:32px;margin-bottom:24px;">Admin Login</h2>
        <form [formGroup]="form" (ngSubmit)="submit()" class="col">
          <input formControlName="username" type="text" placeholder="Username" />
          <input formControlName="password" type="password" placeholder="Password" />
          @if (error()) { <div class="error">{{ error() }}</div> }
          <button type="submit" class="primary" [disabled]="form.invalid || loading()">
            {{ loading() ? 'Logging in...' : 'Login' }}
          </button>
        </form>
      </div>
    </div>
  `
})
export class AdminLoginComponent {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  loading = signal(false);
  error = signal<string | null>(null);

  form = this.fb.nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required]
  });

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    const { username, password } = this.form.getRawValue();
    this.auth.adminLogin(username, password).subscribe({
      next: () => this.router.navigate(['/admin/dashboard']),
      error: (err) => {
        this.error.set(err.error?.message || 'Login failed');
        this.loading.set(false);
      }
    });
  }
}
