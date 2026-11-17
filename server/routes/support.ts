import { Router } from 'express';
import {
  addSupportMessage,
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus
} from '../db/authRepository.js';
import { attachOptionalAuth, requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/support/tickets', requireAuth, (req, res) => {
  const user = req.authUser!;
  res.json(listSupportTickets({ userId: user.id, isAdmin: user.role === 'ADMIN' }));
});

router.post('/support/tickets', (req, res) => {
  try {
    const user = attachOptionalAuth(req);
    const ticket = createSupportTicket({
      user_id: user?.id || null,
      requester_name: String(req.body?.requester_name || user?.name || ''),
      requester_email: String(req.body?.requester_email || user?.email || ''),
      requester_phone: String(req.body?.requester_phone || ''),
      channel: req.body?.channel === 'EMAIL' ? 'EMAIL' : 'CHAT',
      subject: String(req.body?.subject || ''),
      message: String(req.body?.message || '')
    });
    res.status(201).json({ ticket });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao abrir chamado de suporte.' });
  }
});

router.post('/support/tickets/:id/messages', requireAuth, (req, res) => {
  try {
    const user = req.authUser!;
    const existing = getSupportTicket(String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Chamado não encontrado.' });
      return;
    }
    if (user.role !== 'ADMIN' && existing.user_id !== user.id) {
      res.status(403).json({ error: 'Sem permissão para interagir neste chamado.' });
      return;
    }

    const updated = addSupportMessage(existing.id, {
      sender_role: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
      sender_name: user.name,
      message: String(req.body?.message || ''),
      next_status:
        user.role === 'ADMIN' && req.body?.status
          ? req.body.status
          : undefined
    });
    res.json({ ticket: updated });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao enviar mensagem no chamado.' });
  }
});

router.put('/support/tickets/:id/status', requireAuth, (req, res) => {
  try {
    const user = req.authUser!;
    const existing = getSupportTicket(String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Chamado não encontrado.' });
      return;
    }
    if (user.role !== 'ADMIN' && existing.user_id !== user.id) {
      res.status(403).json({ error: 'Sem permissão para alterar este chamado.' });
      return;
    }
    const status =
      req.body?.status === 'RESOLVIDO'
        ? 'RESOLVIDO'
        : req.body?.status === 'EM_ATENDIMENTO'
          ? 'EM_ATENDIMENTO'
          : 'ABERTO';
    res.json({ ticket: updateSupportTicketStatus(existing.id, status) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao atualizar status do chamado.' });
  }
});

export default router;
