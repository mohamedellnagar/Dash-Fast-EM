import { HttpRequest, HttpResponse, HttpTransport } from './types';

// Default transport backed by Node 20's global fetch, with a timeout.
export const fetchTransport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(req.headers ?? {}),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { _raw: text };
      }
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { status: 0, ok: false, body: null, timedOut: true };
    }
    return { status: 0, ok: false, body: null, networkError: true };
  } finally {
    clearTimeout(timer);
  }
};
