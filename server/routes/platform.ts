import os from 'node:os';
import { Router } from 'express';
import { getDb, isServerlessRuntime } from '../db/database.js';
import {
  createProcess,
  getPublicAiSettings,
  listDotacoes,
  listInstitutions,
  listSecretarios
} from '../db/repository.js';
import { executeAllAgentSteps } from '../services/agentEngine.js';
import { searchTcuJurisprudence, TCU_JURISPRUDENCE_CATALOG } from '../services/tcuJurisprudence.js';
import type { PlatformOnlineStatus } from '../../shared/types.js';

const router = Router();

function getOnlineTestModeEnabled(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'online_test_mode'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('online_test_mode', 'true') ON CONFLICT(key) DO NOTHING"
    ).run();
    return true;
  }
  return row.value !== 'false';
}

function setOnlineTestModeEnabled(enabled: boolean): boolean {
  const db = getDb();
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('online_test_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(enabled ? 'true' : 'false');
  return enabled;
}

function collectLanUrls(port: number): string[] {
  const urls: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return Array.from(new Set(urls));
}

async function buildOnlineStatus(probeTcu = false): Promise<PlatformOnlineStatus> {
  const port = Number(process.env.PORT || 3001);
  const isVercel = Boolean(process.env.VERCEL);
  const host = isVercel ? 'vercel-serverless' : process.env.HOST || '0.0.0.0';
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  const testMode = getOnlineTestModeEnabled();
  const ai = getPublicAiSettings();

  let dbOk = false;
  try {
    getDb().prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  let tcuProbe: PlatformOnlineStatus['tcu_probe'];
  if (probeTcu) {
    const startedAt = Date.now();
    try {
      const res = await searchTcuJurisprudence({ q: 'pesquisa precos', includeLiveApi: true });
      tcuProbe = {
        ok: res.live_api_ok,
        latency_ms: Date.now() - startedAt,
        message: res.live_diagnostics || 'Base curada TCU e endpoint Dados Abertos verificados.'
      };
    } catch (err: any) {
      tcuProbe = {
        ok: false,
        latency_ms: Date.now() - startedAt,
        message: err?.message || 'Base curada TCU ativa; endpoint externo indisponível no momento.'
      };
    }
  }

  return {
    online: true,
    test_mode: testMode,
    mode_label: testMode
      ? isServerlessRuntime()
        ? 'MODO TESTE ONLINE ATIVO (VERCEL)'
        : 'MODO TESTE ONLINE ATIVO'
      : 'MODO PRODUÇÃO PADRÃO',
    host,
    port,
    local_url: vercelUrl || `http://localhost:${port}`,
    network_urls: isVercel ? (vercelUrl ? [vercelUrl] : []) : collectLanUrls(port),
    uptime_seconds: Math.round(process.uptime()),
    database_ok: dbOk,
    ai_effective_provider: ai.effectiveProvider,
    ai_auth_label: ai.authSourceLabel,
    tcu_probe: tcuProbe,
    timestamp: new Date().toISOString()
  };
}

router.get('/platform/online-status', async (req, res) => {
  try {
    const probe = req.query.probe === '1' || req.query.probe === 'true';
    const status = await buildOnlineStatus(probe);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/platform/online-test-mode', async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    setOnlineTestModeEnabled(enabled);
    const status = await buildOnlineStatus(false);
    res.json(status);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/platform/sandbox-test', async (req, res) => {
  try {
    const institutions = listInstitutions();
    const targetInstId = req.body?.institutionId || institutions[0]?.id;
    if (!targetInstId) {
      return res.status(400).json({ error: 'Configure ao menos uma instituição/prefeitura antes de criar o processo sandbox.' });
    }

    const secretarios = listSecretarios(targetInstId);
    const dotacoes = listDotacoes(targetInstId);
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const seq = Number(stamp.slice(-3)) || 101;

    const sampleItems = [
      {
        item: 1,
        descricao: 'Estação de Trabalho Corporativa (Desktop Completo com Monitor LED 23,8" Full HD, Processador 8 Núcleos, 16 GB RAM, SSD 512 GB NVMe)',
        medida: 'UN',
        quantidade: 30,
        valor_unitario: 4250,
        valor_total: 127500
      },
      {
        item: 2,
        descricao: 'Switch Gerenciável Layer 2/3 24 Portas Gigabit PoE+ com 4 Portas SFP+',
        medida: 'UN',
        quantidade: 4,
        valor_unitario: 3150,
        valor_total: 12600
      },
      {
        item: 3,
        descricao: 'Nobreak Senoidal Interativo 1500VA Bivolt Automático com Proteção RJ45',
        medida: 'UN',
        quantidade: 15,
        valor_unitario: 980,
        valor_total: 14700
      }
    ];

    const defaultTcu = TCU_JURISPRUDENCE_CATALOG.filter(
      (p) => p.id === 'tcu-ac-1875-2021-p' || p.id === 'tcu-ac-1264-2019-p' || p.id === 'tcu-sum-247'
    );

    const created = createProcess({
      institution_id: targetInstId,
      secretario_id: secretarios[0]?.id || null,
      dotacao_id: dotacoes[0]?.id || null,
      dotacao_ids: dotacoes[0] ? [dotacoes[0].id] : [],
      numero_processo_licitatorio: `TESTE-${String(seq).padStart(3, '0')}/2026`,
      numero_processo_administrativo: `PA-SANDBOX-${seq}/2026`,
      titulo_resumido: '[MODO TESTE ONLINE] Modernização Tecnológica de Laboratórios e Secretarias Municipais',
      tipo_contratacao: 'AQUISICAO',
      data_certame: '2026-12-18',
      horario_disputa: '09:00',
      modalidade: 'PREGAO_ELETRONICO',
      modo_disputa: 'ABERTO_FECHADO',
      criterio_julgamento: 'MENOR_PRECO',
      formato_lance: 'POR_ITEM',
      usar_srp: true,
      demanda_bruta:
        'Processo criado automaticamente pelo Modo Teste Online para validação operacional completa da esteira (Agentes 01 a 11), pesquisa de preços Art. 23, Minuta Contratual exclusiva do Prefeito (valores/vigência em aberto), Parecer Jurídico Art. 53 com Jurisprudência TCU e exportação Word/PDF UTF-8.',
      responsavel_requisitante: secretarios[0]?.nome || 'Equipe Técnica Sandbox',
      cargo_requisitante: secretarios[0]?.cargo || 'Coordenação de Testes Operacionais',
      pesquisa_preco_arquivo: 'sandbox_pesquisa_preco_tcu.xlsx',
      pesquisa_preco_resumo:
        'Pesquisa Sandbox PNCP + Painel de Preços + 3 fornecedores locais (Art. 23, § 1º — Acórdão nº 1.875/2021-TCU-Plenário).',
      pesquisa_preco_itens: sampleItems,
      tcu_acordaos_vinculados: defaultTcu,
      valor_estimado_global: 154800
    });

    const autoRunAll = req.body?.autoRunAll !== false;
    if (autoRunAll) {
      const result = await executeAllAgentSteps({
        processId: created.process.id,
        actorName: 'Operador Modo Teste Online',
        actorRole: 'Homologador de Testes',
        autoApprove: Boolean(req.body?.autoApprove)
      });
      return res.status(201).json({
        created_sandbox: true,
        executed_agents: result.executed_agents,
        bundle: result.bundle
      });
    }

    res.status(201).json({
      created_sandbox: true,
      executed_agents: [],
      bundle: created
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
