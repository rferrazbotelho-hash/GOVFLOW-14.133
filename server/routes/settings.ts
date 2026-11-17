import { Router } from 'express';
import {
  getPublicAiSettings,
  resetStoredGeminiCredentials,
  updateAiSettings
} from '../db/repository.js';
import { testAiConnectivity } from '../services/llmClient.js';

const router = Router();

router.get('/settings/ai', (_req, res) => {
  res.json(getPublicAiSettings());
});

router.put('/settings/ai', (req, res) => {
  try {
    const updated = updateAiSettings(req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/settings/ai/test', async (_req, res) => {
  try {
    const result = await testAiConnectivity();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/ai/gemini/reset', async (req, res) => {
  try {
    const resetResult = resetStoredGeminiCredentials({
      setAutoProvider: req.body?.setAutoProvider !== false,
      resetModel: Boolean(req.body?.resetModel)
    });
    const diagnostic = await testAiConnectivity();
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
