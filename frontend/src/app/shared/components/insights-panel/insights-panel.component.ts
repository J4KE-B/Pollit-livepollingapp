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
    <div class="card" style="background:linear-gradient(180deg,#fafaff,#fff);border-color:#d6d4ff;">
      <div class="row" style="margin-bottom:8px;">
        <strong style="color:#4f46e5;">✨ AI Insights</strong>
        <span class="spacer"></span>
        @if (generating) {
          <span class="muted" style="font-size:12px;">Updating…</span>
        }
      </div>

      @if (!insights) {
        <p class="muted" style="font-size:14px;margin:0;">
          Insights will appear here as votes come in.
        </p>
      } @else {
        <div [@fadeIn]="insights.pulse">
          <div style="font-size:15px;line-height:1.5;margin-bottom:12px;">
            <strong>Pulse:</strong> {{ insights.pulse }}
          </div>

          @if (insights.followups?.length) {
            <div style="margin-bottom:12px;">
              <div class="muted" style="font-size:13px;margin-bottom:6px;">Suggested follow-ups:</div>
              @for (q of insights.followups; track q) {
                <button (click)="useFollowup.emit(q)"
                        style="display:block;width:100%;text-align:left;margin:4px 0;font-size:14px;">
                  ▸ {{ q }}
                </button>
              }
            </div>
          }

          @if (insights.outliers?.length) {
            <div>
              <div class="muted" style="font-size:13px;margin-bottom:6px;">Worth discussing:</div>
              @for (o of insights.outliers; track o) {
                <div style="background:#fff7ed;border-left:3px solid #f59e0b;padding:8px 12px;margin:4px 0;font-size:14px;border-radius:4px;">
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
