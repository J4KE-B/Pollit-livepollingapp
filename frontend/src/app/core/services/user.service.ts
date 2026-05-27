import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

export interface AdminUser {
  _id: string;
  name: string;
  email: string;
  authProvider: string;
  createdAt: string;
  sessionCount: number;
}

@Injectable({ providedIn: 'root' })
export class UserService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/users`;

  listAll() { return this.http.get<AdminUser[]>(`${this.base}/all`); }
}
