import { Router } from 'express';
import {
  adminCreateUser,
  adminDeleteUser,
  adminUpdateUser,
  getAdminOverview
} from '../db/authRepository.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

router.use('/admin', requireAdmin);

router.get('/admin/overview', (_req, res) => {
  res.json(getAdminOverview());
});

router.get('/admin/users', (_req, res) => {
  res.json(getAdminOverview().users);
});

router.post('/admin/users', (req, res) => {
  try {
    const created = adminCreateUser({
      username: String(req.body?.username || ''),
      name: String(req.body?.name || ''),
      email: String(req.body?.email || ''),
      department: String(req.body?.department || ''),
      role: req.body?.role === 'ADMIN' ? 'ADMIN' : 'USER',
      is_active: req.body?.is_active !== false,
      password: String(req.body?.password || '')
    });
    res.status(201).json(created);
  } catch (err: any) {
    const msg = err?.message || 'Falha ao cadastrar usuário.';
    res.status(msg.includes('Já existe') ? 409 : 400).json({ error: msg });
  }
});

router.put('/admin/users/:id', (req, res) => {
  try {
    const updated = adminUpdateUser(
      String(req.params.id),
      {
        name: req.body?.name,
        email: req.body?.email,
        department: req.body?.department,
        role: req.body?.role,
        is_active: req.body?.is_active,
        password: req.body?.password
      },
      req.authUser!.id
    );
    res.json(updated);
  } catch (err: any) {
    const msg = err?.message || 'Falha ao atualizar usuário.';
    res.status(msg.includes('não encontrado') ? 404 : 400).json({ error: msg });
  }
});

router.post('/admin/users/:id/activate', (req, res) => {
  try {
    const updated = adminUpdateUser(
      String(req.params.id),
      { is_active: true },
      req.authUser!.id
    );
    res.json(updated);
  } catch (err: any) {
    const msg = err?.message || 'Falha ao ativar usuário.';
    res.status(msg.includes('não encontrado') ? 404 : 400).json({ error: msg });
  }
});

router.delete('/admin/users/:id', (req, res) => {
  try {
    adminDeleteUser(String(req.params.id), req.authUser!.id);
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || 'Falha ao excluir usuário.';
    res.status(msg.includes('não encontrado') ? 404 : 400).json({ error: msg });
  }
});

export default router;
