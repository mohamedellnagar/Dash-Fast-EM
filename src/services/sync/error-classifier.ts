import { ERROR_CATEGORY, ErrorCategory, SYNC_ERROR, SyncErrorType } from '../../lib/enums';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendedAction: string;
  httpStatus?: number;
  code?: string;
  message?: string;
}

// Map the FastTest client's SyncErrorType to the standardized category.
const SYNC_ERROR_TO_CATEGORY: Record<string, ErrorCategory> = {
  [SYNC_ERROR.UNAUTHORIZED]: ERROR_CATEGORY.AUTHENTICATION,
  [SYNC_ERROR.TOKEN_EXPIRED]: ERROR_CATEGORY.TOKEN_EXPIRED,
  [SYNC_ERROR.AUTH_FAILED]: ERROR_CATEGORY.AUTHENTICATION,
  [SYNC_ERROR.NOT_FOUND]: ERROR_CATEGORY.NOT_FOUND,
  [SYNC_ERROR.INVALID_TESTCODE]: ERROR_CATEGORY.INVALID_TEST_CODE,
  [SYNC_ERROR.WORKSPACE_MISMATCH]: ERROR_CATEGORY.WORKSPACE_MISMATCH,
  [SYNC_ERROR.RATE_LIMITED]: ERROR_CATEGORY.RATE_LIMIT,
  [SYNC_ERROR.TIMEOUT]: ERROR_CATEGORY.TIMEOUT,
  [SYNC_ERROR.CONNECTION_FAILURE]: ERROR_CATEGORY.NETWORK,
  [SYNC_ERROR.SERVER_ERROR]: ERROR_CATEGORY.FASTTEST_INTERNAL_ERROR,
  [SYNC_ERROR.INVALID_RESPONSE]: ERROR_CATEGORY.INVALID_RESPONSE,
};

const META: Record<ErrorCategory, { retryable: boolean; severity: 'LOW' | 'MEDIUM' | 'HIGH'; action: string }> = {
  AUTHENTICATION: { retryable: true, severity: 'HIGH', action: 'Refresh token and retry once; verify workspace API key.' },
  TOKEN_EXPIRED: { retryable: true, severity: 'MEDIUM', action: 'Refresh token and retry.' },
  NOT_FOUND: { retryable: true, severity: 'MEDIUM', action: 'Limited retry, then manual review — TestCode may not exist in this workspace.' },
  INVALID_TEST_CODE: { retryable: false, severity: 'HIGH', action: 'Do not retry; correct the source TestCode.' },
  WORKSPACE_MISMATCH: { retryable: false, severity: 'HIGH', action: 'Manual review; fix subject→workspace mapping.' },
  RATE_LIMIT: { retryable: true, severity: 'MEDIUM', action: 'Respect Retry-After; cool down the workspace.' },
  TIMEOUT: { retryable: true, severity: 'MEDIUM', action: 'Exponential backoff with jitter.' },
  NETWORK: { retryable: true, severity: 'MEDIUM', action: 'Exponential backoff with jitter; check connectivity.' },
  FASTTEST_INTERNAL_ERROR: { retryable: true, severity: 'HIGH', action: 'Exponential backoff with jitter; monitor for repeated 500s.' },
  INVALID_RESPONSE: { retryable: true, severity: 'MEDIUM', action: 'Retry; persist raw response for diagnosis.' },
  DATABASE: { retryable: true, severity: 'HIGH', action: 'Transient DB error; retry with backoff.' },
  QUEUE: { retryable: true, severity: 'MEDIUM', action: 'Queue error; retry.' },
  UNKNOWN: { retryable: true, severity: 'MEDIUM', action: 'Retry with backoff; investigate if it recurs.' },
};

export function categoryFromSyncError(errorType?: string): ErrorCategory {
  return (errorType && SYNC_ERROR_TO_CATEGORY[errorType]) || ERROR_CATEGORY.UNKNOWN;
}

/** Classify by HTTP status when no explicit SyncErrorType is available. */
export function categoryFromHttp(status?: number): ErrorCategory {
  if (status === undefined) return ERROR_CATEGORY.UNKNOWN;
  if (status === 401 || status === 403) return ERROR_CATEGORY.AUTHENTICATION;
  if (status === 404) return ERROR_CATEGORY.NOT_FOUND;
  if (status === 429) return ERROR_CATEGORY.RATE_LIMIT;
  if (status >= 500) return ERROR_CATEGORY.FASTTEST_INTERNAL_ERROR;
  if (status === 0) return ERROR_CATEGORY.NETWORK;
  return ERROR_CATEGORY.INVALID_RESPONSE;
}

export function classify(input: { errorType?: string; httpStatus?: number; code?: string; message?: string }): ClassifiedError {
  const category = input.errorType ? categoryFromSyncError(input.errorType) : categoryFromHttp(input.httpStatus);
  const meta = META[category];
  return {
    category,
    retryable: meta.retryable,
    severity: meta.severity,
    recommendedAction: meta.action,
    httpStatus: input.httpStatus,
    code: input.code,
    message: input.message,
  };
}

export function isRetryable(category: ErrorCategory): boolean {
  return META[category].retryable;
}
