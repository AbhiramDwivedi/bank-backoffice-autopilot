import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'CUCWSESSID';

/** A logged-in operator session. */
export interface Session {
  id: string;
  user: string;
  createdAt: number;
  /** True once the maintenance interstitial has been shown in this session. */
  interstitialShown: boolean;
}

function cookieId(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[SESSION_COOKIE];
}

/** In-memory session map. One per createApp() instance, so tests are isolated. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(res: Response, user: string): Session {
    const s: Session = { id: randomBytes(16).toString('hex'), user, createdAt: Date.now(), interstitialShown: false };
    this.sessions.set(s.id, s);
    res.cookie(SESSION_COOKIE, s.id, { httpOnly: true, sameSite: 'lax', path: '/' });
    return s;
  }

  get(req: Request): Session | undefined {
    const id = cookieId(req);
    return id ? this.sessions.get(id) : undefined;
  }

  destroy(req: Request, res: Response): void {
    const id = cookieId(req);
    if (id) this.sessions.delete(id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  clear(): void {
    this.sessions.clear();
  }
}
