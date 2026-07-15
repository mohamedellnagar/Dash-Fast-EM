import { SyncErrorType } from '../../lib/enums';

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: any;
  timedOut?: boolean;
  networkError?: boolean;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

// Pluggable transport so automated tests can inject a mock (no live calls).
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export interface AuthResponse {
  apiToken: string;
  timeGenerated?: number;
  workspaceName?: string;
  ttl?: number;
}

export interface StatusResponse {
  status?: string;
  testId?: string;
  testName?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  examineeId?: string;
  registrationDate?: string;
  [k: string]: unknown;
}

export interface FastTestError extends Error {
  errorType: SyncErrorType;
  httpStatus?: number;
  fastTestErrorCode?: string;
  fastTestErrorMessage?: string;
}
