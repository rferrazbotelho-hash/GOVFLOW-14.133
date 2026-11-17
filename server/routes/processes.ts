import { Router } from 'express';
import multer from 'multer';
import {
  cloneProcess,
  createProcess,
  deleteProcess,
  getProcessBundle,
  listProcesses,
  updateProcess
} from '../db/repository.js';
import { parsePriceResearchFile } from '../services/priceResearchParser.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

router.post('/price-research/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de Pesquisa de Preço enviado (PDF, Excel ou Word).' });
    }
    const parsed = await parsePriceResearchFile(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    res.json(parsed);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha ao interpretar arquivo de Pesquisa de Preço.' });
  }
});

router.post('/processes/:id/price-research', upload.single('file'), async (req, res) => {
  try {
    const existing = getProcessBundle(String(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Processo não encontrado.' });
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de Pesquisa de Preço enviado (PDF, Excel ou Word).' });
    }
    const parsed = await parsePriceResearchFile(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    const updated = updateProcess(String(req.params.id), {
      pesquisa_preco_arquivo: parsed.filename,
      pesquisa_preco_resumo: parsed.resumo_texto,
      pesquisa_preco_itens: parsed.itens,
      ...(parsed.valor_total_estimado > 0 ? { valor_estimado_global: parsed.valor_total_estimado } : {})
    });
    res.json({ parsed, bundle: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha ao processar Pesquisa de Preço no processo.' });
  }
});

router.get('/processes', (_req, res) => {
  res.json(listProcesses());
});

router.post('/processes', (req, res) => {
  try {
    const bundle = createProcess(req.body);
    res.status(201).json(bundle);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erro ao criar processo.' });
  }
});

router.get('/processes/:id', (req, res) => {
  const bundle = getProcessBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Processo não encontrado.' });
  res.json(bundle);
});

router.put('/processes/:id', (req, res) => {
  try {
    const bundle = updateProcess(req.params.id, req.body);
    if (!bundle) return res.status(404).json({ error: 'Processo não encontrado.' });
    res.json(bundle);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erro ao atualizar processo.' });
  }
});

router.post('/processes/:id/clone', (req, res) => {
  try {
    const bundle = cloneProcess(req.params.id, {
      numero_processo_licitatorio: req.body?.numero_processo_licitatorio,
      titulo_resumido: req.body?.titulo_resumido
    });
    res.status(201).json(bundle);
  } catch (err: any) {
    const msg = err?.message || 'Erro ao duplicar processo.';
    res.status(msg.includes('não encontrado') ? 404 : 400).json({ error: msg });
  }
});

router.delete('/processes/:id', (req, res) => {
  const deleted = deleteProcess(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Processo não encontrado.' });
  }
  res.json({ ok: true });
});

export default router;
