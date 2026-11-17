import { Router } from 'express';
import {
  approveAndSignPiece,
  getAgentPiece,
  getProcessBundle,
  listPieceVersions,
  restorePieceVersion,
  saveManualPieceEdit
} from '../db/repository.js';
import { executeAgentStep, executeAllAgentSteps } from '../services/agentEngine.js';
import { canAccessProcess, requireAuth } from '../middleware/auth.js';

const router = Router();

router.use('/processes', requireAuth);
router.use('/processes/:id', (req, res, next) => {
  const access = canAccessProcess(String(req.params.id), req.authUser!);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  next();
});

router.post('/processes/:id/agents/execute-all', async (req, res) => {
  try {
    const result = await executeAllAgentSteps({
      processId: req.params.id,
      userId: req.authUser!.id,
      actorName: req.body?.actorName || req.authUser!.name,
      actorRole: req.body?.actorRole,
      autoApprove: Boolean(req.body?.autoApprove),
      feedback: req.body?.feedback
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha na elaboração sequencial dos agentes.' });
  }
});

router.post('/processes/:id/agents/:num/execute', async (req, res) => {
  try {
    const agentNumber = Number(req.params.num);
    const piece = await executeAgentStep({
      processId: req.params.id,
      userId: req.authUser!.id,
      agentNumber,
      feedback: req.body?.feedback,
      actorName: req.body?.actorName || req.authUser!.name,
      estimativaPreliminar:
        req.body?.estimativaPreliminar !== undefined ? Number(req.body.estimativaPreliminar) : undefined,
      dataPretendida: req.body?.dataPretendida,
      prioridade: req.body?.prioridade,
      pesquisaMercado: req.body?.pesquisaMercado
    });
    const bundle = getProcessBundle(req.params.id);
    res.json({ piece, bundle });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha ao executar agente.' });
  }
});

router.put('/processes/:id/agents/:num', (req, res) => {
  try {
    const agentNumber = Number(req.params.num);
    const piece = saveManualPieceEdit({
      processId: req.params.id,
      agentNumber,
      htmlContent: String(req.body?.html_content || ''),
      structuredJson: req.body?.structured_json,
      actorName: req.body?.actorName || 'Revisor do Certame',
      changeSummary: req.body?.changeSummary
    });
    const bundle = getProcessBundle(req.params.id);
    res.json({ piece, bundle });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha ao salvar edição manual.' });
  }
});

router.post('/processes/:id/agents/:num/approve', (req, res) => {
  try {
    const agentNumber = Number(req.params.num);
    const piece = approveAndSignPiece({
      processId: req.params.id,
      agentNumber,
      actorName: req.body?.actorName || 'Ordenador / Gestor do Processo',
      actorRole: req.body?.actorRole || 'Autoridade / Responsável Técnico'
    });
    const bundle = getProcessBundle(req.params.id);
    res.json({ piece, bundle });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha ao aprovar e assinar peça.' });
  }
});

router.get('/processes/:id/agents/:num/versions', (req, res) => {
  const agentNumber = Number(req.params.num);
  const piece = getAgentPiece(req.params.id, agentNumber);
  if (!piece) return res.status(404).json({ error: 'Peça não encontrada.' });
  res.json(listPieceVersions(piece.id));
});

router.post('/processes/:id/agents/:num/restore', (req, res) => {
  try {
    const agentNumber = Number(req.params.num);
    const versionNumber = Number(req.body?.versionNumber ?? req.body?.version_number);
    const piece = restorePieceVersion({
      processId: req.params.id,
      agentNumber,
      versionNumber,
      actorName: req.body?.actorName || 'Revisor do Certame'
    });
    const bundle = getProcessBundle(req.params.id);
    res.json({ piece, bundle });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erro ao restaurar versão.' });
  }
});

export default router;
