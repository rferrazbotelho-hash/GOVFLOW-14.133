import {
  approveAndSignPiece,
  getProcessBundle,
  saveGeneratedPiece
} from '../db/repository.js';
import { getDb } from '../db/database.js';
import {
  AGENT_DEFINITIONS,
  type AgentPiece,
  type LegalAlert,
  type ProcessBundle
} from '../../shared/types.js';
import { normalizeUtf8Text } from '../../shared/typography.js';
import { buildAgentPieceLocally, type GenerationContext } from './agentTemplates.js';
import { tryGenerateWithLlm } from './llmClient.js';
import {
  buildAgentSpecificTaskPrompt,
  buildAgentSystemPrompt
} from './promptRegistry.js';

export interface RunAgentOptions {
  processId: string;
  agentNumber: number;
  feedback?: string;
  actorName?: string;
  estimativaPreliminar?: number;
  dataPretendida?: string;
  prioridade?: 'Baixo' | 'Médio' | 'Alto';
  pesquisaMercado?: string;
}

function isPlainObj(val: unknown): val is Record<string, any> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function mergeStructuredJson(
  agentNumber: number,
  localJson: Record<string, any>,
  llmJson: Record<string, any>
): Record<string, any> {
  const merged: Record<string, any> = {
    ...localJson,
    ...llmJson
  };

  for (const [key, localVal] of Object.entries(localJson)) {
    const llmVal = llmJson[key];
    if (Array.isArray(localVal) && localVal.length > 0) {
      if (!Array.isArray(llmVal) || llmVal.length === 0) {
        merged[key] = localVal;
      }
    } else if (isPlainObj(localVal)) {
      merged[key] = isPlainObj(llmVal) ? { ...localVal, ...llmVal } : localVal;
    } else if (llmVal === undefined || llmVal === null || llmVal === '') {
      merged[key] = localVal;
    }
  }

  // Blindagem de invariantes jurídicas obrigatórias por agente
  if (agentNumber === 7) {
    merged.representante_contratante = localJson.representante_contratante;
    merged.valores_em_aberto = true;
    merged.duracao_em_aberto = true;
    delete merged.ordenador_signatario;
  }

  if (agentNumber === 10) {
    if (
      Array.isArray(localJson.checklist_conformidade) &&
      (!Array.isArray(merged.checklist_conformidade) ||
        merged.checklist_conformidade.length < localJson.checklist_conformidade.length)
    ) {
      merged.checklist_conformidade = localJson.checklist_conformidade;
    }
    if (
      Array.isArray(localJson.tcu_jurisprudencia_aplicavel) &&
      (!Array.isArray(merged.tcu_jurisprudencia_aplicavel) ||
        merged.tcu_jurisprudencia_aplicavel.length === 0)
    ) {
      merged.tcu_jurisprudencia_aplicavel = localJson.tcu_jurisprudencia_aplicavel;
    }
  }

  return merged;
}

export function mergeLegalAlerts(llmAlerts: LegalAlert[], localAlerts: LegalAlert[]): LegalAlert[] {
  const seen = new Set<string>();
  const combined: LegalAlert[] = [];

  for (const alert of [...llmAlerts, ...localAlerts]) {
    const key = `${alert.article.trim().toLowerCase()}::${alert.title.trim().toLowerCase()}`;
    const msgKey = `${alert.article.trim().toLowerCase()}::${alert.message.trim().slice(0, 48).toLowerCase()}`;
    if (seen.has(key) || seen.has(msgKey)) continue;
    seen.add(key);
    seen.add(msgKey);
    combined.push(alert);
  }

  return combined;
}

export async function executeAgentStep(opts: RunAgentOptions): Promise<AgentPiece> {
  if (opts.estimativaPreliminar !== undefined && opts.estimativaPreliminar > 0) {
    getDb()
      .prepare('UPDATE processes SET valor_estimado_global = ?, updated_at = ? WHERE id = ?')
      .run(Number(opts.estimativaPreliminar), new Date().toISOString(), opts.processId);
  }

  const bundle = getProcessBundle(opts.processId);
  if (!bundle) {
    throw new Error('Processo licitatório não encontrado.');
  }

  const def = AGENT_DEFINITIONS.find((d) => d.number === opts.agentNumber);
  if (!def) {
    throw new Error(`Agente ${opts.agentNumber} inválido.`);
  }

  if (opts.agentNumber === 8 && !bundle.process.usar_srp) {
    throw new Error(
      'O Agente 08 (Minuta da Ata de Registro de Preços) é condicional ao Sistema de Registro de Preços (SRP). Marque SRP nos Dados do Certame para habilitá-lo.'
    );
  }

  // Verifica se todas as etapas anteriores aplicáveis já possuem saída gerada (ou aprovada)
  const missingPrev = bundle.pieces.filter(
    (p) =>
      p.agent_number < opts.agentNumber &&
      p.status !== 'DISPENSADO' &&
      !p.html_content.trim()
  );

  if (missingPrev.length > 0) {
    const names = missingPrev.map((p) => `Agente ${String(p.agent_number).padStart(2, '0')}`).join(', ');
    throw new Error(
      `Encadeamento sequencial obrigatório: execute antes ${names} para fornecer o contexto validado ao ${def.shortName}.`
    );
  }

  const piecesByNumber = new Map<number, AgentPiece>();
  for (const p of bundle.pieces) {
    piecesByNumber.set(p.agent_number, p);
  }

  const currentPiece = piecesByNumber.get(opts.agentNumber);
  const isRegeneration = Boolean(currentPiece && currentPiece.current_version > 0);

  const ctx: GenerationContext = {
    process: bundle.process,
    institution: bundle.institution,
    secretario: bundle.secretario,
    dotacao: bundle.dotacao,
    dotacoesVinculadas: bundle.dotacoes_vinculadas,
    piecesByNumber,
    auditLogs: bundle.audit_logs,
    feedback: opts.feedback,
    dataPretendida: opts.dataPretendida,
    prioridade: opts.prioridade,
    pesquisaMercado: opts.pesquisaMercado
  };

  // Sempre calcula a base determinística e analítica local (números, Curva ABC, alertas normativos e estrutura)
  const localBaseline = buildAgentPieceLocally(opts.agentNumber, ctx);

  // Monta contexto estruturado compartilhado para o LLM (caso configurado)
  const priorJsonContext: Record<string, any> = {};
  for (const p of bundle.pieces) {
    if (p.agent_number < opts.agentNumber && p.status !== 'DISPENSADO' && p.html_content) {
      priorJsonContext[`agente_${String(p.agent_number).padStart(2, '0')}_${p.agent_key}`] =
        p.structured_json;
    }
  }

  const runtimeInputs = {
    estimativaPreliminar: opts.estimativaPreliminar,
    dataPretendida: opts.dataPretendida,
    prioridade: opts.prioridade,
    pesquisaMercado: opts.pesquisaMercado
  };
  const baseSystemPrompt = buildAgentSystemPrompt(bundle, runtimeInputs);
  const specificTaskPrompt = buildAgentSpecificTaskPrompt(
    opts.agentNumber,
    bundle,
    def.title,
    def.description,
    runtimeInputs
  );

  const systemPrompt = `${baseSystemPrompt}

[REGRAS ESTRUTURAIS E DE LEGIBILIDADE DO ORQUESTRADOR]
1. Execute o ${def.title} (${def.legalBasis}) com rigor jurídico, profundidade analítica e redação limpa e escaneável.
2. No campo 'html_content' do JSON de resposta, entregue o documento em HTML semântico limpo (<div class="gov-doc">...<h2>, <h3>, <h4>, <blockquote>, <p>, <ul>, <li>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <strong>).
3. Inicie cada peça com uma Ficha Técnica limpa em <table> de 2 colunas (nunca concatene 4+ campos na mesma linha separados por '|') seguida por um quadro <blockquote> de Síntese Executiva com indicadores objetivos e conclusão imediata.`;

  const userPrompt = `${specificTaskPrompt}

### MÉTRICAS E ÂNCORAS ANALÍTICAS VALIDADAS PELO MOTOR LOCAL (NÃO ALTERE TOTAIS OU INVARIANTES):
${JSON.stringify(localBaseline.structured_json, null, 2)}

### CONTEXTO VALIDADO DOS AGENTES ANTERIORES (JSON):
${JSON.stringify(priorJsonContext, null, 2)}

${opts.feedback ? `### FEEDBACK / INSTRUÇÃO DE REVISÃO DO GESTOR:\n${opts.feedback}\n` : ''}`;

  const llmResult = await tryGenerateWithLlm({
    agentNumber: opts.agentNumber,
    agentTitle: def.title,
    legalBasis: def.legalBasis,
    systemPrompt,
    userPrompt
  });

  const finalPayload = llmResult
    ? {
        html_content: llmResult.html_content,
        structured_json: mergeStructuredJson(
          opts.agentNumber,
          localBaseline.structured_json,
          llmResult.structured_json
        ),
        legal_alerts: mergeLegalAlerts(llmResult.legal_alerts, localBaseline.legal_alerts)
      }
    : localBaseline;

  const normalizedHtml = normalizeUtf8Text(finalPayload.html_content);
  const providerUsed = llmResult ? llmResult.providerLabel : 'Motor Jurídico Especialista 14.133 (Local)';

  // Atualiza valor_estimado_global do processo se DFD/ETP/TR trouxe valor calculado e processo estava zerado
  const computedValue = Number(
    finalPayload.structured_json?.valor_total_preliminar ??
      finalPayload.structured_json?.valor_estimado_contratacao ??
      finalPayload.structured_json?.valor_total_estimado ??
      0
  );
  if (computedValue > 0 && bundle.process.valor_estimado_global <= 0) {
    getDb()
      .prepare('UPDATE processes SET valor_estimado_global = ?, updated_at = ? WHERE id = ?')
      .run(computedValue, new Date().toISOString(), opts.processId);
  }

  const changeSummary = opts.feedback
    ? normalizeUtf8Text(`Regenerado com feedback (${providerUsed}): "${opts.feedback.slice(0, 120)}"`)
    : isRegeneration
      ? normalizeUtf8Text(`Peça regenerada pelo ${def.shortName} (${providerUsed})`)
      : normalizeUtf8Text(`Peça gerada automaticamente pelo ${def.shortName} (${providerUsed})`);

  return saveGeneratedPiece({
    processId: opts.processId,
    agentNumber: opts.agentNumber,
    structuredJson: finalPayload.structured_json,
    htmlContent: normalizedHtml,
    legalAlerts: finalPayload.legal_alerts,
    aiProviderUsed: providerUsed,
    changeSummary,
    feedbackUsed: opts.feedback,
    actorName: opts.actorName || bundle.process.responsavel_requisitante || 'Orquestrador GovFlow',
    isRegeneration
  });
}

export async function executeAllAgentSteps(opts: {
  processId: string;
  actorName?: string;
  actorRole?: string;
  autoApprove?: boolean;
  feedback?: string;
}): Promise<{ executed_agents: number[]; bundle: ProcessBundle }> {
  const initial = getProcessBundle(opts.processId);
  if (!initial) {
    throw new Error('Processo licitatório não encontrado.');
  }

  const actorName =
    opts.actorName ||
    initial.process.responsavel_requisitante ||
    initial.secretario?.nome ||
    'Orquestrador GovFlow';
  const actorRole =
    opts.actorRole ||
    initial.secretario?.cargo ||
    initial.process.cargo_requisitante ||
    'Equipe de Planejamento / Ordenador';

  const executedAgents: number[] = [];

  for (const def of AGENT_DEFINITIONS) {
    const current = getProcessBundle(opts.processId);
    if (!current) break;
    const piece = current.pieces.find((p) => p.agent_number === def.number);
    if (piece?.status === 'DISPENSADO') continue;

    await executeAgentStep({
      processId: opts.processId,
      agentNumber: def.number,
      actorName,
      feedback: opts.feedback
    });
    executedAgents.push(def.number);

    if (opts.autoApprove) {
      approveAndSignPiece({
        processId: opts.processId,
        agentNumber: def.number,
        actorName,
        actorRole
      });
    }
  }

  const finalBundle = getProcessBundle(opts.processId);
  if (!finalBundle) {
    throw new Error('Erro ao recarregar processo após execução completa.');
  }
  return { executed_agents: executedAgents, bundle: finalBundle };
}
