import { Component, inject, signal, OnInit } from '@angular/core';
import { FormBuilder, FormArray, ReactiveFormsModule, Validators, FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SessionService } from '../../../core/services/session.service';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <div class="container">
      <h2>{{ isEdit ? 'Edit' : 'New' }} Session</h2>

      <form [formGroup]="form" (ngSubmit)="save()" class="col">
        <div class="card">
          <label>Title</label>
          <input formControlName="title" placeholder="Q1 Town Hall" />
        </div>

        <div formArrayName="polls">
          @for (group of polls.controls; let i = $index; track i) {
            <div class="card" [formGroupName]="i">
              <div class="row" style="margin-bottom:8px;">
                <strong>Poll #{{ i + 1 }}</strong>
                <span class="spacer"></span>
                <button type="button" class="danger" (click)="removePoll(i)">Remove</button>
              </div>

              <div class="col">
                <select formControlName="type" (change)="onTypeChange(i)">
                  <option value="mcq">Multiple Choice</option>
                  <option value="wordcloud">Word Cloud</option>
                  <option value="rating">Rating (1-5)</option>
                  <option value="text">Open Text</option>
                </select>

                <input formControlName="question" placeholder="Question" />

                @if (asGroup(group).get('type')?.value === 'mcq') {
                  <div formArrayName="options">
                    @for (opt of getOptions(i).controls; let j = $index; track j) {
                      <div class="row" style="margin-top:6px;">
                        <input [formControlName]="j" [placeholder]="'Option ' + (j+1)" />
                        <button type="button" (click)="removeOption(i, j)">×</button>
                      </div>
                    }
                    <button type="button" style="margin-top:8px;" (click)="addOption(i)">+ Add option</button>
                  </div>
                }
              </div>
            </div>
          }
        </div>

        <button type="button" (click)="addPoll()">+ Add Poll</button>

        @if (error()) { <div class="error">{{ error() }}</div> }

        <div class="row">
          <button type="submit" class="primary" [disabled]="form.invalid || saving()">
            {{ saving() ? 'Saving...' : 'Save' }}
          </button>
          <button type="button" (click)="cancel()">Cancel</button>
        </div>
      </form>
    </div>
  `
})
export class BuilderComponent implements OnInit {
  private fb = inject(FormBuilder);
  private svc = inject(SessionService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  isEdit = false;
  sessionId: string | null = null;
  saving = signal(false);
  error = signal<string | null>(null);

  form = this.fb.nonNullable.group({
    title: ['', Validators.required],
    polls: this.fb.array<FormGroup>([])
  });

  get polls() { return this.form.controls.polls as FormArray<FormGroup>; }

  ngOnInit() {
    this.sessionId = this.route.snapshot.paramMap.get('id');
    this.isEdit = !!this.sessionId;

    if (this.isEdit && this.sessionId) {
      this.svc.get(this.sessionId).subscribe(s => {
        this.form.patchValue({ title: s.title });
        s.polls.forEach(p => {
          const group = this.fb.nonNullable.group({
            type: [p.type, Validators.required],
            question: [p.question, Validators.required],
            options: this.fb.array(p.options.map(o => this.fb.nonNullable.control(o, Validators.required)))
          });
          this.polls.push(group);
        });
      });
    } else {
      this.addPoll();
    }
  }

  addPoll() {
    const group = this.fb.nonNullable.group({
      type: ['mcq', Validators.required],
      question: ['', Validators.required],
      options: this.fb.array([
        this.fb.nonNullable.control('', Validators.required),
        this.fb.nonNullable.control('', Validators.required)
      ])
    });
    this.polls.push(group);
  }

  removePoll(i: number) { this.polls.removeAt(i); }

  getOptions(i: number): FormArray {
    return this.polls.at(i).get('options') as FormArray;
  }

  asGroup(g: FormGroup): FormGroup { return g; }

  addOption(i: number) {
    this.getOptions(i).push(this.fb.nonNullable.control('', Validators.required));
  }

  removeOption(i: number, j: number) {
    this.getOptions(i).removeAt(j);
  }

  onTypeChange(i: number) {
    const group = this.polls.at(i);
    const type = group.get('type')?.value;
    const optionsArr = this.getOptions(i);
    if (type !== 'mcq') {
      while (optionsArr.length) optionsArr.removeAt(0);
    } else if (optionsArr.length === 0) {
      optionsArr.push(this.fb.nonNullable.control('', Validators.required));
      optionsArr.push(this.fb.nonNullable.control('', Validators.required));
    }
  }

  save() {
    if (this.form.invalid) return;
    this.saving.set(true);
    const payload = this.form.getRawValue();
    const obs = this.isEdit && this.sessionId
      ? this.svc.update(this.sessionId, payload as any)
      : this.svc.create(payload.title, payload.polls as any);

    obs.subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.error.set(err.error?.message || 'Save failed');
        this.saving.set(false);
      }
    });
  }

  cancel() { this.router.navigate(['/dashboard']); }
}
