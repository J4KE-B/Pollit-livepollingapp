import { Component, Input, Output, EventEmitter } from '@angular/core';
import { trigger, transition, style, animate } from '@angular/animations';
import { Insights } from '../../../core/services/socket.service';

@Component({
  selector: 'app-insights-panel',
  standalone: true,
  animations: [
    trigger('fadeIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(4px)' }),
        animate('400ms ease-out', style({ opacity: 1, transform: 'translateY(0)' }))
      ])
    ])
  ],
  template: `
    <div class="card" style="background:var(--surface-container-lowest);border:1px solid var(--outline-variant);">
      <div class="row" style="margin-bottom:12px;">
        <strong style="color:var(--primary);font-family:var(--font-heading);font-size:18px;">✨ AI Insights</strong>
        <span class="spacer"></span>
        @if (generating) {
          <span class="muted" style="font-size:12px;font-weight:600;">Updating…</span>
        }
      </div>

      @if (!insights) {
        <p class="muted" style="font-size:14px;margin:0;">
          Insights will appear here as votes come in.
        </p>
      } @else {
        <div [@fadeIn]="insights.pulse">
          <div style="font-size:15px;line-height:1.5;margin-bottom:16px;">
            <strong>Pulse:</strong> {{ insights.pulse }}
          </div>

          @if (insights.followups.length) {
            <div style="margin-bottom:16px;">
              <div class="muted" style="font-size:13px;margin-bottom:8px;font-weight:600;">Suggested follow-ups:</div>
              @for (q of insights.followups; track q) {
                <button (click)="useFollowup.emit(q)"
                        style="display:block;width:100%;text-align:left;margin:6px 0;font-size:14px;padding:10px 16px;background:var(--surface);border:1px solid var(--outline-variant);">
                  ▸ {{ q }}
                </button>
              }
            </div>
          }

          @if (insights.outliers.length) {
            <div>
              <div class="muted" style="font-size:13px;margin-bottom:8px;font-weight:600;">Worth discussing:</div>
              @for (o of insights.outliers; track o) {
                <div style="background:var(--surface-container);border-left:4px solid var(--data-amber);padding:10px 14px;margin:6px 0;font-size:14px;border-radius:4px 8px 8px 4px;">
                  {{ o }}
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `
})
export class InsightsPanelComponent {
  @Input() insights: Insights | null = null;
  @Input() generating = false;
  @Output() useFollowup = new EventEmitter<string>();
}
