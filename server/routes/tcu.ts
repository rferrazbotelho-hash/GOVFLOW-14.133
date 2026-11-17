import { Router } from 'express';
import { searchTcuJurisprudence } from '../services/tcuJurisprudence.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use('/tcu', requireAuth);

router.get('/tcu/acordaos', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const tema = typeof req.query.tema === 'string' ? req.query.tema : '';
    const includeLiveApi = req.query.live === '1' || req.query.live === 'true';

    const payload = await searchTcuJurisprudence({ q, tema, includeLiveApi });
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao consultar base de jurisprudência do TCU.' });
  }
});

export default router;
