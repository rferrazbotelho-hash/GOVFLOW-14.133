import { Router } from 'express';
import { addAuditLog, getProcessBundle } from '../db/repository.js';
import { generateConsolidatedPdf } from '../services/exportPdf.js';
import {
  exportConsolidatedDocx,
  exportDossierZip,
  exportSinglePieceDocx
} from '../services/exportDocx.js';
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

function safeFileSlug(str: string): string {
  return (str || 'processo').replace(/[^a-zA-Z0-9_-]+/g, '_');
}

router.get('/processes/:id/export/pdf', async (req, res) => {
  try {
    const bundle = getProcessBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Processo não encontrado.' });

    const pdfBuffer = await generateConsolidatedPdf(bundle);
    addAuditLog({
      process_id: bundle.process.id,
      action: 'DOSSIE_EXPORTADO',
      actor_name: 'Sistema GovFlow',
      actor_role: 'Exportador Oficial',
      details: `PDF Consolidado do Processo ${bundle.process.numero_processo_licitatorio} exportado (${pdfBuffer.length} bytes).`
    });

    const slug = safeFileSlug(bundle.process.numero_processo_licitatorio);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Dossie_GovFlow_${slug}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao gerar PDF consolidado.' });
  }
});

router.get('/processes/:id/export/docx', async (req, res) => {
  try {
    const bundle = getProcessBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Processo não encontrado.' });

    const buf = await exportConsolidatedDocx(bundle);
    addAuditLog({
      process_id: bundle.process.id,
      action: 'DOSSIE_EXPORTADO',
      actor_name: 'Sistema GovFlow',
      actor_role: 'Exportador Oficial',
      details: `DOCX Consolidado do Processo ${bundle.process.numero_processo_licitatorio} exportado.`
    });

    const slug = safeFileSlug(bundle.process.numero_processo_licitatorio);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.setHeader('Content-Disposition', `attachment; filename="Dossie_GovFlow_${slug}.docx"`);
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao gerar DOCX consolidado.' });
  }
});

router.get('/processes/:id/export/docx/:num', async (req, res) => {
  try {
    const bundle = getProcessBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Processo não encontrado.' });
    const num = Number(req.params.num);
    const piece = bundle.pieces.find((p) => p.agent_number === num);
    const buf = await exportSinglePieceDocx(bundle, num);
    const slug = safeFileSlug(bundle.process.numero_processo_licitatorio);
    const keySlug = piece ? safeFileSlug(piece.agent_key) : `peca_${num}`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(num).padStart(2, '0')}_${keySlug}_${slug}.docx"`
    );
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao gerar DOCX da peça.' });
  }
});

router.get('/processes/:id/export/zip', async (req, res) => {
  try {
    const bundle = getProcessBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Processo não encontrado.' });

    const buf = await exportDossierZip(bundle);
    addAuditLog({
      process_id: bundle.process.id,
      action: 'DOSSIE_EXPORTADO',
      actor_name: 'Sistema GovFlow',
      actor_role: 'Exportador Oficial',
      details: `Pacote ZIP (DOCX individuais + consolidado + trilha JSON) exportado.`
    });

    const slug = safeFileSlug(bundle.process.numero_processo_licitatorio);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Pacote_Dossie_GovFlow_${slug}.zip"`);
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao gerar pacote ZIP.' });
  }
});

export default router;
