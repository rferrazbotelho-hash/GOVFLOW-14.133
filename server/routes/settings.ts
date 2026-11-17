import { Router } from 'express';
import {
  getPublicAiSettings,
  resetStoredGeminiCredentials,
  updateAiSettings
} from '../db/repository.js';
import { testAiConnectivity } from '../services/llmClient.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use('/settings', requireAuth);

router.get('/settings/ai', (req, res) => {
  res.json(getPublicAiSettings(req.authUser!.id));
});

router.put('/settings/ai', (req, res) => {
  try {
    const updated = updateAiSettings(req.body, req.authUser!.id);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/settings/ai/test', async (req, res) => {
  try {
    const result = await testAiConnectivity(req.authUser!.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/ai/gemini/reset', async (req, res) => {
  try {
    const resetResult = resetStoredGeminiCredentials({
      setAutoProvider: req.body?.setAutoProvider !== false,
      resetModel: Boolean(req.body?.resetModel),
      userId: req.authUser!.id
    });
    const diagnostic = await testAiConnectivity(req.authUser!.id);
    res.json({
      clearedDbKey: resetResult.clearedDbKey,
      envReloaded: resetResult.envReloaded,
      settings: resetResult.settings,
      diagnostic
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
