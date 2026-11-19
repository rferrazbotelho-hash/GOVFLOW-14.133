import { Router } from 'express';
import multer from 'multer';
import type { ContractSourceFormat, ContractSourceType } from '../../shared/types.js';
import {
  createContractAnalysis,
  deleteContractAnalysis,
  getContractAnalysis,
  listContractAnalyses,
  updateContractAnalysis
} from '../db/contractAnalysisRepository.js';
import { getInstitution, getProcessBundle, listInstitutions } from '../db/repository.js';
import { canAccessInstitution, canAccessProcess, requireAuth } from '../middleware/auth.js';
import { analyzeContract } from '../services/contractAnalyzer.js';
import { extractContractDocument, extractPlainTextFromHtml } from '../services/contractExtractor.js';
import { exportContractAnalysisDocx } from '../services/exportDocx.js';
import { generateContractAnalysisPdf } from '../services/exportPdf.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

router.use('/contracts', requireAuth);

function resolveUserInstitution(userId: string, requestedInstitutionId?: string) {
  if (requestedInstitutionId) {
    const access = canAccessInstitution(requestedInstitutionId, { id: userId, role: 'USER' } as any);
    if (access.ok) {
      return getInstitution(requestedInstitutionId);
    }
  }
  return listInstitutions(userId)[0] || null;
}

function getAuthorizedAnalysis(id: string, userId: string, role: string) {
  const record = getContractAnalysis(id);
  if (!record) return { ok: false as const, status: 404, error: 'Análise contratual não encontrada.' };
  if (record.owner_user_id !== userId && role !== 'ADMIN') {
    return { ok: false as const, status: 403, error: 'Acesso negado a esta análise contratual.' };
  }
  return { ok: true as const, record };
}

router.get('/contracts/analyses', (req, res) => {
  res.json(listContractAnalyses(req.authUser!.id));
});

router.get('/contracts/analyses/:id', (req, res) => {
  const check = getAuthorizedAnalysis(String(req.params.id), req.authUser!.id, req.authUser!.role);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  res.json(check.record);
});

router.post('/contracts/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de contrato enviado (PDF, Word ou Texto).' });
    }
    const preview = await extractContractDocument(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    res.json(preview);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Falha ao extrair texto do contrato.' });
  }
});

router.post('/contracts/analyze', upload.single('file'), async (req, res) => {
  try {
    const authUser = req.authUser!;
    const rawBody = req.body || {};
    const processId = rawBody.process_id ? String(rawBody.process_id).trim() : null;
    const requestedInstId = rawBody.institution_id ? String(rawBody.institution_id).trim() : undefined;
    const analysisFocus = typeof rawBody.analysis_focus === 'string' ? rawBody.analysis_focus.trim() : '';
    const customTitle = typeof rawBody.title === 'string' ? rawBody.title.trim() : '';
    const pieceNumber = rawBody.agent_number ? Number(rawBody.agent_number) : 7;

    let contractText = typeof rawBody.contract_text === 'string' ? rawBody.contract_text.trim() : '';
    let sourceType: ContractSourceType = 'TEXT';
    let sourceFilename: string | null = typeof rawBody.source_filename === 'string' && rawBody.source_filename.trim()
      ? rawBody.source_filename.trim()
      : null;
    let sourceFormat: ContractSourceFormat = 'TXT';
    let inst = requestedInstId && canAccessInstitution(requestedInstId, authUser).ok
      ? getInstitution(requestedInstId)
      : listInstitutions(authUser.id)[0] || null;

    if (req.file) {
      const preview = await extractContractDocument(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
      contractText = preview.extracted_text;
      sourceType = 'UPLOAD';
      sourceFilename = preview.filename;
      sourceFormat = preview.format;
    } else if (processId) {
      const access = canAccessProcess(processId, authUser);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }
      const bundle = getProcessBundle(processId);
      if (!bundle) {
        return res.status(404).json({ error: 'Processo licitatório vinculado não encontrado.' });
      }
      inst = bundle.institution;
      if (!contractText) {
        const piece =
          bundle.pieces.find((p) => p.agent_number === pieceNumber && p.html_content.trim()) ||
          bundle.pieces.find((p) => p.agent_number === 7 && p.html_content.trim()) ||
          bundle.pieces.find((p) => p.agent_number === 8 && p.html_content.trim());
        if (!piece) {
          return res.status(400).json({
            error: 'O processo selecionado ainda não possui Minuta do Contrato (Agente 07) ou Ata SRP (Agente 08) gerada.'
          });
        }
        contractText = extractPlainTextFromHtml(piece.html_content);
        sourceType = 'PROCESS_PIECE';
        sourceFilename = `${piece.title} — Proc. ${bundle.process.numero_processo_licitatorio}`;
        sourceFormat = 'HTML';
      }
    } else if (sourceFilename) {
      sourceType = 'UPLOAD';
      if (rawBody.source_format === 'PDF' || rawBody.source_format === 'WORD' || rawBody.source_format === 'HTML') {
        sourceFormat = rawBody.source_format;
      }
    }

    if (!contractText || contractText.length < 40) {
      return res.status(400).json({
        error: 'Envie um arquivo de contrato (.pdf, .docx, .txt), selecione um processo com minuta ou cole o texto completo do contrato (mínimo 40 caracteres).'
      });
    }

    const analyzed = await analyzeContract({
      title: customTitle,
      contractText,
      analysisFocus,
      institution: inst,
      userId: authUser.id,
      sourceFilename
    });

    const saved = createContractAnalysis({
      owner_user_id: authUser.id,
      process_id: processId,
      title: analyzed.title,
      source_type: sourceType,
      source_filename: sourceFilename,
      source_format: sourceFormat,
      contract_text: contractText,
      analysis_focus: analysisFocus,
      institution_name: inst?.razao_social || analyzed.extracted_metadata.contratante || '',
      verdict: analyzed.verdict,
      compliance_score: analyzed.compliance_score,
      summary: analyzed.summary,
      extracted_metadata: analyzed.extracted_metadata,
      checklist_art92: analyzed.checklist_art92,
      risk_findings: analyzed.risk_findings,
      suggested_clauses: analyzed.suggested_clauses,
      tcu_precedents: analyzed.tcu_precedents,
      report_html: analyzed.report_html,
      ai_provider_used: analyzed.ai_provider_used
    });

    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Falha ao analisar contrato.' });
  }
});

router.post('/contracts/analyses/:id/reanalyze', async (req, res) => {
  try {
    const check = getAuthorizedAnalysis(String(req.params.id), req.authUser!.id, req.authUser!.role);
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    const existing = check.record;
    const nextText =
      typeof req.body?.contract_text === 'string' && req.body.contract_text.trim().length >= 40
        ? req.body.contract_text.trim()
        : existing.contract_text;
    const nextFocus =
      typeof req.body?.analysis_focus === 'string'
        ? req.body.analysis_focus.trim()
        : existing.analysis_focus || '';
    const nextTitle =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : existing.title;

    const inst = resolveUserInstitution(req.authUser!.id);
    const analyzed = await analyzeContract({
      title: nextTitle,
      contractText: nextText,
      analysisFocus: nextFocus,
      institution: inst,
      userId: req.authUser!.id,
      sourceFilename: existing.source_filename
    });

    const updated = updateContractAnalysis(existing.id, {
      title: analyzed.title,
      contract_text: nextText,
      analysis_focus: nextFocus,
      institution_name: inst?.razao_social || analyzed.extracted_metadata.contratante || existing.institution_name,
      verdict: analyzed.verdict,
      compliance_score: analyzed.compliance_score,
      summary: analyzed.summary,
      extracted_metadata: analyzed.extracted_metadata,
      checklist_art92: analyzed.checklist_art92,
      risk_findings: analyzed.risk_findings,
      suggested_clauses: analyzed.suggested_clauses,
      tcu_precedents: analyzed.tcu_precedents,
      report_html: analyzed.report_html,
      ai_provider_used: analyzed.ai_provider_used
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Falha ao reanalisar contrato.' });
  }
});

router.delete('/contracts/analyses/:id', (req, res) => {
  const check = getAuthorizedAnalysis(String(req.params.id), req.authUser!.id, req.authUser!.role);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  deleteContractAnalysis(check.record.id);
  res.json({ ok: true });
});

router.get('/contracts/analyses/:id/export/docx', async (req, res) => {
  try {
    const check = getAuthorizedAnalysis(String(req.params.id), req.authUser!.id, req.authUser!.role);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const inst = resolveUserInstitution(req.authUser!.id);
    const buffer = await exportContractAnalysisDocx(check.record, inst);
    const safeName = check.record.title.replace(/[^\w\d_-]+/g, '_').slice(0, 48);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.setHeader('Content-Disposition', `attachment; filename="Analise_Contrato_${safeName}.docx"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao exportar Análise de Contrato em Word.' });
  }
});

router.get('/contracts/analyses/:id/export/pdf', async (req, res) => {
  try {
    const check = getAuthorizedAnalysis(String(req.params.id), req.authUser!.id, req.authUser!.role);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const inst = resolveUserInstitution(req.authUser!.id);
    const buffer = await generateContractAnalysisPdf(check.record, inst);
    const safeName = check.record.title.replace(/[^\w\d_-]+/g, '_').slice(0, 48);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Analise_Contrato_${safeName}.pdf"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao exportar Análise de Contrato em PDF.' });
  }
});

export default router;
