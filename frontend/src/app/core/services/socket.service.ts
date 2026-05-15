import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Poll, PollResultGroup, Session } from './session.service';

export interface Insights {
  pulse: string;
  followups: string[];
  outliers: string[];
}

export interface PollShowEvent {
  currentPollIndex: number;
  poll: Poll;
}

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket | null = null;

  // Streams the components subscribe to
  pollShow$ = new Subject<PollShowEvent>();
  resultsUpdate$ = new Subject<PollResultGroup[]>();
  audienceCount$ = new Subject<number>();
  sessionEnded$ = new Subject<void>();
  insightsGenerating$ = new Subject<void>();
  insightsUpdate$ = new Subject<Insights>();

  connect(): Socket {
    if (this.socket && this.socket.connected) return this.socket;
    this.socket = io(environment.socketUrl, { transports: ['websocket', 'polling'] });
    this.attachListeners();
    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  private attachListeners() {
    if (!this.socket) return;
    this.socket.on('poll:show', (e: PollShowEvent) => this.pollShow$.next(e));
    this.socket.on('results:update', (r: PollResultGroup[]) => this.resultsUpdate$.next(r));
    this.socket.on('audience:count', (n: number) => this.audienceCount$.next(n));
    this.socket.on('session:ended', () => this.sessionEnded$.next());
    this.socket.on('insights:generating', () => this.insightsGenerating$.next());
    this.socket.on('insights:update', (i: Insights) => this.insightsUpdate$.next(i));
  }

  // ----- Presenter actions -----
  presenterJoin(sessionId: string, token: string): Promise<{
    ok: boolean; session?: Session; results?: PollResultGroup[]; audienceCount?: number; error?: string;
  }> {
    return this.emitWithAck('presenter:join', { sessionId, token });
  }

  presenterNextPoll(): Promise<{ ok: boolean; error?: string }> {
    return this.emitWithAck('presenter:nextPoll', {});
  }

  presenterEndSession(): Promise<{ ok: boolean }> {
    return this.emitWithAck('presenter:endSession', {});
  }

  presenterInsertPoll(poll: Partial<Poll>): Promise<{ ok: boolean; insertedAt?: number; error?: string }> {
    return this.emitWithAck('presenter:insertPoll', { poll });
  }

  // ----- Audience actions -----
  audienceJoin(code: string): Promise<{
    ok: boolean; sessionId?: string; title?: string; status?: string;
    currentPollIndex?: number; currentPoll?: Poll | null; error?: string;
  }> {
    return this.emitWithAck('audience:join', { code });
  }

  audienceVote(pollIndex: number, answer: any, voterKey: string): Promise<{ ok: boolean; error?: string }> {
    return this.emitWithAck('audience:vote', { pollIndex, answer, voterKey });
  }

  private emitWithAck(event: string, payload: any): Promise<any> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ ok: false, error: 'No socket' });
      this.socket.emit(event, payload, (response: any) => resolve(response || { ok: false }));
    });
  }
}
