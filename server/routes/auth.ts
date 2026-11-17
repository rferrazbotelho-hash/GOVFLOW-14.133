import { Router } from 'express';
import {
  authenticateUser,
  createSession,
  deleteSession,
  registerPendingUser,
  updateOwnProfile
} from '../db/authRepository.js';
import {
  attachOptionalAuth,
  clearSessionCookie,
  extractSessionToken,
  requireAuth,
  setSessionCookie
} from '../middleware/auth.js';
import type { AppInfo } from '../../shared/types.js';

const router = Router();

export const APP_PUBLIC_INFO: AppInfo = {
  name: 'GOVFLOW 14.133',
  version: '1.0.0',
  developer: 'Rodrigo Ferraz Botelho',
  support_email: 'rodrigofb@live.com',
  support_whatsapp: '+5537999654266',
  support_whatsapp_digits: '5537999654266'
};

router.get('/app-info', (_req, res) => {
  res.json(APP_PUBLIC_INFO);
});

router.get('/auth/me', (req, res) => {
  const user = attachOptionalAuth(req);
  if (!user) {
    res.json({ authenticated: false, user: null });
    return;
  }
  res.json({ authenticated: true, user });
});

router.post('/auth/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');

  const auth = authenticateUser(username, password);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const session = createSession(auth.user.id);
  setSessionCookie(req, res, session.token);
  res.json({
    authenticated: true,
    user: auth.user,
    token: session.token
  });
});

router.post('/auth/register', (req, res) => {
  try {
    const user = registerPendingUser({
      username: String(req.body?.username || ''),
      name: String(req.body?.name || ''),
      email: String(req.body?.email || ''),
      department: String(req.body?.department || ''),
      password: String(req.body?.password || '')
    });
    res.status(201).json({
      ok: true,
      user,
      message:
        'Solicitação de cadastro registrada! Aguarde a ativação da sua conta pelo Administrador para efetuar o login.'
    });
  } catch (err: any) {
    const msg = err?.message || 'Erro ao registrar usuário.';
    res.status(msg.includes('já está em uso') ? 409 : 400).json({ error: msg });
  }
});

router.post('/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  if (token) {
    deleteSession(token);
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

router.put('/auth/profile', requireAuth, (req, res) => {
  try {
    const updated = updateOwnProfile(req.authUser!.id, {
      name: req.body?.name,
      email: req.body?.email,
      department: req.body?.department,
      currentPassword: req.body?.currentPassword,
      newPassword: req.body?.newPassword
    });
    res.json({ user: updated });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Não foi possível atualizar seu perfil.' });
  }
});

export default router;
