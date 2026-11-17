import type { NextFunction, Request, Response } from 'express';
import type { UserAccount } from '../../shared/types.js';
import { getSessionUser } from '../db/authRepository.js';
import { getInstitution, getProcess } from '../db/repository.js';

export const SESSION_COOKIE_NAME = 'govflow_session';

declare global {
  namespace Express {
    interface Request {
      authUser?: UserAccount;
      authToken?: string;
    }
  }
}

export function extractSessionToken(req: Request): string {
  const authHeader = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  const cookieHeader = String(req.headers.cookie || '');
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k === SESSION_COOKIE_NAME && v) {
        try {
          return decodeURIComponent(v);
        } catch {
          return v;
        }
      }
    }
  }
  return '';
}

export function attachOptionalAuth(req: Request): UserAccount | null {
  if (req.authUser) return req.authUser;
  const token = extractSessionToken(req);
  if (!token) return null;
  const user = getSessionUser(token);
  if (!user) return null;
  req.authUser = user;
  req.authToken = token;
  return user;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = attachOptionalAuth(req);
  if (!user) {
    res.status(401).json({ error: 'Sessão não autenticada. Faça login para continuar.' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = attachOptionalAuth(req);
  if (!user) {
    res.status(401).json({ error: 'Sessão não autenticada. Faça login como Administrador.' });
    return;
  }
  if (user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Acesso restrito ao Administrador do sistema.' });
    return;
  }
  next();
}

export function setSessionCookie(req: Request, res: Response, token: string, ttlDays = 7): void {
  const isHttps =
    req.secure || String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https');
  const maxAge = ttlDays * 24 * 60 * 60;
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (isHttps) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps =
    req.secure || String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https');
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isHttps) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function canAccessInstitution(institutionId: string, user: UserAccount): {
  ok: boolean;
  status: 403 | 404;
  error?: string;
} {
  const inst = getInstitution(institutionId);
  if (!inst) {
    return { ok: false, status: 404, error: 'Instituição não encontrada.' };
  }
  if (user.role === 'ADMIN' || !inst.owner_user_id || inst.owner_user_id === user.id) {
    return { ok: true, status: 404 };
  }
  return { ok: false, status: 403, error: 'Acesso negado à instituição de outro usuário.' };
}

export function canAccessProcess(processId: string, user: UserAccount): {
  ok: boolean;
  status: 403 | 404;
  error?: string;
} {
  const proc = getProcess(processId);
  if (!proc) {
    return { ok: false, status: 404, error: 'Processo não encontrado.' };
  }
  if (user.role === 'ADMIN' || !proc.owner_user_id || proc.owner_user_id === user.id) {
    return { ok: true, status: 404 };
  }
  return { ok: false, status: 403, error: 'Acesso negado a processo de outro usuário.' };
}
