import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <div class="container" style="max-width:420px;flex:1;display:flex;flex-direction:column;justify-content:center;width:100%;">
      <div class="card" style="text-align:center;padding:32px;">
        <h2 style="font-family:var(--font-heading);font-weight:800;font-size:32px;margin-bottom:8px;">Pollit</h2>
        <p class="muted" style="margin-top:0;">Enter the 6-digit code from your presenter</p>
        <form [formGroup]="form" (ngSubmit)="join()" class="col">
          <input
            formControlName="code"
            maxlength="6"
            placeholder="123456"
            style="font-size:32px;text-align:center;letter-spacing:8px;"
          />
          @if (error()) { <div class="error">{{ error() }}</div> }
          <button type="submit" class="primary" [disabled]="form.invalid">Join</button>
        </form>
      </div>
    </div>
  `
})
export class JoinComponent {
  private fb = inject(FormBuilder);
  private router = inject(Router);

  error = signal<string | null>(null);

  form = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]]
  });

  join() {
    if (this.form.invalid) return;
    const code = this.form.getRawValue().code;
    this.router.navigate(['/join', code]);
  }
}
