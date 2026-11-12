import crypto from 'node:crypto';

/**
 * The desktop app runs this server on the user's own machine, but any web page the user opens could try
 * to talk to 127.0.0.1. With a token set, the app window opens `/?token=...` once, gets a cookie that
 * is never sent from other sites (SameSite=Strict), and every other request needs that cookie. The
 * Host header must also name this server, which stops DNS rebinding.
 */

export interface GuardConfig {
  token: string | null;
  port: number;
}

export interface GuardInput {
  host: string | undefined;
  cookie: string | undefined;
  /** Path and query, as in `req.url`. */
  url: string;
}

export interface GuardResult {
  allow: boolean;
  status?: number;
  message?: string;
  redirect?: string;
  setCookie?: string;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function checkRequest(cfg: GuardConfig, req: GuardInput): GuardResult {
  if (!cfg.token) return { allow: true };
  if (req.host !== `127.0.0.1:${cfg.port}` && req.host !== `localhost:${cfg.port}`) {
    return { allow: false, status: 403, message: 'Wrong host' };
  }
  const url = new URL(req.url, 'http://localhost');
  const offered = url.searchParams.get('token');
  if (offered !== null && same(offered, cfg.token)) {
    url.searchParams.delete('token');
    return {
      allow: false,
      status: 302,
      redirect: `${url.pathname}${url.search}`,
      setCookie: `bt=${cfg.token}; HttpOnly; SameSite=Strict; Path=/`,
    };
  }
  const cookie = (req.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('bt='));
  if (cookie && same(cookie.slice(3), cfg.token)) return { allow: true };
  return { allow: false, status: 401, message: 'Open Timelines from its own window' };
}
