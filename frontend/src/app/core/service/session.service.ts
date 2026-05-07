import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

export type PollType = 'mcq' | 'wordcloud' | 'rating' | 'text';

export interface Poll {
  _id?: string;
  type: PollType;
  question: string;
  options: string[];
}

export interface Session {
  _id: string;
  code: string;
  title: string;
  presenter: string;
  polls: Poll[];
  currentPollIndex: number;
  status: 'draft' | 'live' | 'ended';
  createdAt: string;
  endedAt?: string;
}

export interface PollResultGroup {
  _id: number;
  total: number;
  results: { answer: any; count: number }[];
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/sessions`;
  private pollBase = `${environment.apiUrl}/poll`;

  list() { return this.http.get<Session[]>(this.base); }
  get(id: string) { return this.http.get<Session>(`${this.base}/${id}`); }
  create(title: string, polls: Poll[]) { return this.http.post<Session>(this.base, { title, polls }); }
  update(id: string, payload: Partial<Session>) { return this.http.put<Session>(`${this.base}/${id}`, payload); }
  remove(id: string) { return this.http.delete<{ message: string }>(`${this.base}/${id}`); }
  results(id: string) { return this.http.get<{ session: Session; results: PollResultGroup[] }>(`${this.base}/${id}/results`); }

  start(id: string) { return this.http.post<Session>(`${this.base}/${id}/start`, {}); }
  next(id: string) { return this.http.post<Session>(`${this.base}/${id}/next`, {}); }
  end(id: string) { return this.http.post<Session>(`${this.base}/${id}/end`, {}); }

  // Public audience
  joinByCode(code: string) {
    return this.http.get<{ sessionId: string; title: string; status: string; currentPollIndex: number; currentPoll: Poll | null }>(`${this.pollBase}/${code}`);
  }
  vote(code: string, pollIndex: number, answer: any, voterKey: string) {
    return this.http.post<{ message: string }>(`${this.pollBase}/${code}/vote`, { pollIndex, answer, voterKey });
  }
}
