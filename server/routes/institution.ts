import { Router } from 'express';
import multer from 'multer';
import {
  deleteDotacao,
  deleteSecretario,
  getDotacao,
  getInstitution,
  getSecretario,
  listDotacoes,
  listInstitutions,
  listSecretarios,
  saveDotacao,
  saveSecretario,
  upsertInstitution
} from '../db/repository.js';
import { lookupCnpj } from '../services/cnpjService.js';
import {
  importDotacoes,
  importSecretarios,
  scrapePortalTransparencia
} from '../services/scraperService.js';
import { canAccessInstitution, requireAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

router.use(['/cnpj', '/institutions'], requireAuth);
router.use('/institutions/:id', (req, res, next) => {
  const access = canAccessInstitution(String(req.params.id), req.authUser!);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  next();
});

router.get('/cnpj/:cnpj', async (req, res) => {
  try {
    const result = await lookupCnpj(req.params.cnpj);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erro ao consultar CNPJ.' });
  }
});

router.get('/institutions', (req, res) => {
  res.json(listInstitutions(req.authUser!.id));
});

router.get('/institutions/:id', (req, res) => {
  const inst = getInstitution(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instituição não encontrada.' });
  res.json({
    institution: inst,
    secretarios: listSecretarios(inst.id),
    dotacoes: listDotacoes(inst.id)
  });
});

router.post('/institutions', (req, res) => {
  try {
    const saved = upsertInstitution({ ...req.body, owner_user_id: req.authUser!.id });
    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/institutions/:id', (req, res) => {
  try {
    const existing = getInstitution(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instituição não encontrada.' });
    const { owner_user_id: _ignoredOwner, ...rest } = req.body || {};
    const saved = upsertInstitution({ ...rest, id: req.params.id });
    res.json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/institutions/:id/logo', upload.single('logo'), (req, res) => {
  try {
    const instId = String(req.params.id);
    const existing = getInstitution(instId);
    if (!existing) return res.status(404).json({ error: 'Instituição não encontrada.' });

    let logoDataUrl = req.body?.logo_data_url || '';
    if (req.file) {
      const mime = req.file.mimetype || 'image/png';
      if (!['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'].includes(mime)) {
        return res.status(400).json({ error: 'Formato inválido. Utilize PNG, SVG, JPG ou WEBP.' });
      }
      logoDataUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
    }

    if (!logoDataUrl) {
      return res.status(400).json({ error: 'Nenhum arquivo ou imagem enviado.' });
    }
    if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml)(;charset=[^;,]+)?(;base64)?,/i.test(logoDataUrl)) {
      return res.status(400).json({ error: 'URL de brasão inválida. Utilize PNG, SVG, JPG ou WEBP em data URL.' });
    }

    const updated = upsertInstitution({ id: instId, logo_data_url: logoDataUrl });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Secretários
router.get('/institutions/:id/secretarios', (req, res) => {
  if (!getInstitution(req.params.id)) {
    return res.status(404).json({ error: 'Instituição não encontrada.' });
  }
  res.json(listSecretarios(req.params.id));
});

router.post('/institutions/:id/secretarios', (req, res) => {
  try {
    if (!getInstitution(req.params.id)) {
      return res.status(404).json({ error: 'Instituição não encontrada.' });
    }
    const secretaria = String(req.body?.secretaria || '').trim();
    const nome = String(req.body?.nome || '').trim();
    if (!secretaria || !nome) {
      return res.status(400).json({ error: 'Informe o nome da Secretaria e do(a) Secretário(a).' });
    }
    const saved = saveSecretario({ ...req.body, secretaria, nome, institution_id: req.params.id });
    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/institutions/:id/secretarios/:secId', (req, res) => {
  try {
    const existing = getSecretario(req.params.secId);
    if (!existing || existing.institution_id !== req.params.id) {
      return res.status(404).json({ error: 'Secretário/Ordenador não encontrado.' });
    }
    const saved = saveSecretario({ ...req.body, id: req.params.secId, institution_id: req.params.id });
    res.json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/institutions/:id/secretarios/:secId', (req, res) => {
  const existing = getSecretario(req.params.secId);
  if (!existing || existing.institution_id !== req.params.id) {
    return res.status(404).json({ error: 'Secretário/Ordenador não encontrado.' });
  }
  deleteSecretario(req.params.secId);
  res.json({ ok: true });
});

// Dotações
router.get('/institutions/:id/dotacoes', (req, res) => {
  if (!getInstitution(req.params.id)) {
    return res.status(404).json({ error: 'Instituição não encontrada.' });
  }
  res.json(listDotacoes(req.params.id));
});

router.post('/institutions/:id/dotacoes', (req, res) => {
  try {
    if (!getInstitution(req.params.id)) {
      return res.status(404).json({ error: 'Instituição não encontrada.' });
    }
    const unidade = String(req.body?.unidade_orcamentaria || '').trim();
    const elemento = String(req.body?.elemento_despesa || '').trim();
    if (!unidade || !elemento) {
      return res.status(400).json({ error: 'Informe a Unidade Orçamentária e o Elemento de Despesa.' });
    }
    const saved = saveDotacao({
      ...req.body,
      unidade_orcamentaria: unidade,
      elemento_despesa: elemento,
      institution_id: req.params.id
    });
    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/institutions/:id/dotacoes/:dotId', (req, res) => {
  try {
    const existing = getDotacao(req.params.dotId);
    if (!existing || existing.institution_id !== req.params.id) {
      return res.status(404).json({ error: 'Dotação Orçamentária não encontrada.' });
    }
    const saved = saveDotacao({ ...req.body, id: req.params.dotId, institution_id: req.params.id });
    res.json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/institutions/:id/dotacoes/:dotId', (req, res) => {
  const existing = getDotacao(req.params.dotId);
  if (!existing || existing.institution_id !== req.params.id) {
    return res.status(404).json({ error: 'Dotação Orçamentária não encontrada.' });
  }
  deleteDotacao(req.params.dotId);
  res.json({ ok: true });
});

// Scraping Portal da Transparência
router.post('/institutions/:id/scrape', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Informe a URL do Portal da Transparência.' });

    const scraped = await scrapePortalTransparencia(url);
    const autoSave = Boolean(req.body?.autoSave);
    if (autoSave) {
      for (const s of scraped.secretarios) {
        saveSecretario({ ...s, institution_id: req.params.id });
      }
      for (const d of scraped.dotacoes) {
        saveDotacao({ ...d, institution_id: req.params.id });
      }
    }
    res.json({
      ...scraped,
      saved: autoSave,
      secretarios_atualizados: listSecretarios(req.params.id),
      dotacoes_atualizadas: listDotacoes(req.params.id)
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Falha ao sincronizar com o Portal da Transparência.' });
  }
});

// Importação CSV / JSON
router.post('/institutions/:id/import', (req, res) => {
  try {
    const target = req.body?.target as 'secretarios' | 'dotacoes';
    const format = req.body?.format as 'csv' | 'json';
    const content = String(req.body?.content || '');

    if (!content.trim()) {
      return res.status(400).json({ error: 'Conteúdo CSV/JSON vazio.' });
    }

    if (target === 'secretarios') {
      const items = importSecretarios(content, format);
      const saved = items.map((s) => saveSecretario({ ...s, institution_id: req.params.id }));
      return res.json({ imported: saved.length, items: saved });
    }

    if (target === 'dotacoes') {
      const items = importDotacoes(content, format);
      const saved = items.map((d) => saveDotacao({ ...d, institution_id: req.params.id }));
      return res.json({ imported: saved.length, items: saved });
    }

    res.status(400).json({ error: 'Target inválido. Use "secretarios" ou "dotacoes".' });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erro ao importar dados.' });
  }
});

export default router;
