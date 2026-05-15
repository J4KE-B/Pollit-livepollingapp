import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="container" style="max-width:420px;">
      <div class="card">
        <h2>Create account</h2>
        <form [formGroup]="form" (ngSubmit)="submit()" class="col">
          <input formControlName="name" placeholder="Name" />
          <input formControlName="email" type="email" placeholder="Email" />
          <input formControlName="password" type="password" placeholder="Password (min 6 chars)" />
          @if (error()) { <div class="error">{{ error() }}</div> }
          <button type="submit" class="primary" [disabled]="form.invalid || loading()">
            {{ loading() ? 'Creating...' : 'Register' }}
          </button>
        </form>
        <p class="muted" style="margin-top:12px;">
          Already have an account? <a routerLink="/login">Login</a>
        </p>
      </div>
    </div>
  `
})
export class RegisterComponent {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  loading = signal(false);
  error = signal<string | null>(null);

  form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]]
  });

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    const { name, email, password } = this.form.getRawValue();
    this.auth.register(name, email, password).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.error.set(err.error?.message || 'Registration failed');
        this.loading.set(false);
      }
    });
  }
}
