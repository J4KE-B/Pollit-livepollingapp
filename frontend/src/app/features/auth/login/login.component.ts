import { Component, inject, signal, AfterViewInit, ElementRef, ViewChild, NgZone } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { environment } from '../../../../environments/environment';

declare var google: any;

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="container" style="max-width:420px;flex:1;display:flex;flex-direction:column;justify-content:center;width:100%;">
      <div class="card" style="text-align:center;padding:32px;">
        <h2 style="font-family:var(--font-heading);font-weight:800;font-size:32px;margin-bottom:24px;">Login</h2>
        <form [formGroup]="form" (ngSubmit)="submit()" class="col">
          <input formControlName="email" type="email" placeholder="Email" />
          <input formControlName="password" type="password" placeholder="Password" />
          @if (error()) { <div class="error">{{ error() }}</div> }
          <button type="submit" class="primary" [disabled]="form.invalid || loading()">
            {{ loading() ? 'Logging in...' : 'Login' }}
          </button>
        </form>
        <div style="margin: 12px 0; text-align: center;" class="muted">or</div>
        <div #googleBtn style="display: flex; justify-content: center; margin-bottom: 12px;"></div>
        <p class="muted" style="margin-top:12px;">
          New here? <a routerLink="/register">Create an account</a>
        </p>
      </div>
    </div>
  `
})
export class LoginComponent implements AfterViewInit {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);
  private ngZone = inject(NgZone);

  @ViewChild('googleBtn') googleBtn!: ElementRef;

  loading = signal(false);
  error = signal<string | null>(null);

  form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]]
  });

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    this.auth.login(email, password).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.error.set(err.error?.message || 'Login failed');
        this.loading.set(false);
      }
    });
  }

  ngAfterViewInit() {
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.initialize({
        client_id: environment.googleClientId,
        callback: this.handleGoogleLogin.bind(this)
      });
      google.accounts.id.renderButton(
        this.googleBtn.nativeElement,
        { theme: 'outline', size: 'large' }
      );
    }
  }

  handleGoogleLogin(response: any) {
    this.ngZone.run(() => {
      this.loading.set(true);
      this.auth.loginWithGoogle(response.credential).subscribe({
        next: () => this.router.navigate(['/dashboard']),
        error: (err) => {
          this.error.set(err.error?.message || 'Google Login failed');
          this.loading.set(false);
        }
      });
    });
  }
}
