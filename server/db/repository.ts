import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { getDb } from './database.js';
import {
  clearGeminiAuthCache,
  DEFAULT_GEMINI_MODEL,
  normalizeGeminiModelName,
  reloadGeminiDotEnv,
  resolveGeminiCredential,
  validateManualGeminiApiKey,
  type GeminiCredentialResolution
} from '../services/geminiAuth.js';
import { sanitizeTcuPrecedents } from '../services/tcuJurisprudence.js';
import {
  AGENT_DEFINITIONS,
  type AgentPiece,
  type AgentStatus,
  type AiAuthSource,
  type AiProviderMode,
  type AiSettings,
  type AuditLogEntry,
  type Dotacao,
  type EffectiveAiProvider,
  type Institution,
  type LegalAlert,
  type PesquisaPrecoItem,
  type PieceVersion,
  type ProcessBundle,
  type ProcurementProcess,
  type Secretario,
  type TipoContratacao
} from '../../shared/types.js';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatSessaoPublicaLabel,
  getCriterioLabel,
  getFormatoLanceLabel,
  getModalidadeLabel,
  getModoDisputaLabel,
  getTipoContratacaoLabel
} from '../../shared/labels.js';
import { validateCertameConfiguration } from '../services/legalRules.js';

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

export function sanitizePesquisaPrecoItens(rawItems: unknown): PesquisaPrecoItem[] {
  if (!Array.isArray(rawItems)) return [];
  const cleaned: PesquisaPrecoItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, any>;
    const descricao = String(rec.descricao ?? '').trim();
    if (!descricao) continue;
    const medida = String(rec.medida ?? rec.unidade ?? 'UN').trim() || 'UN';
    const quantidade = Number(rec.quantidade ?? 0);
    const qtySafe = Number.isFinite(quantidade) && quantidade > 0 ? Math.round(quantidade * 1000) / 1000 : 1;
    let valorUnit = Number(rec.valor_unitario ?? 0);
    let valorTotal = Number(rec.valor_total ?? 0);
    if (!Number.isFinite(valorUnit) || valorUnit < 0) valorUnit = 0;
    if (!Number.isFinite(valorTotal) || valorTotal < 0) valorTotal = 0;
    if (valorUnit === 0 && valorTotal > 0) {
      valorUnit = Math.round((valorTotal / qtySafe) * 100) / 100;
    } else {
      valorUnit = Math.round(valorUnit * 100) / 100;
      if (valorUnit > 0 || valorTotal === 0) {
        valorTotal = Math.round(valorUnit * qtySafe * 100) / 100;
      } else {
        valorTotal = Math.round(valorTotal * 100) / 100;
      }
    }
    cleaned.push({
      item: cleaned.length + 1,
      descricao,
      medida,
      quantidade: qtySafe,
      valor_unitario: valorUnit,
      valor_total: valorTotal
    });
  }
  return cleaned;
}

export function sumPesquisaPrecoItens(itens: PesquisaPrecoItem[]): number {
  return Math.round(itens.reduce((acc, it) => acc + (Number(it.valor_total) || 0), 0) * 100) / 100;
}

export function formatDotacaoLine(dot: Dotacao | null): string {
  if (!dot) return 'Não vinculada (A indicar / SRP)';
  const parts = [
    dot.orgao,
    dot.unidade_orcamentaria,
    dot.funcao,
    dot.subfuncao,
    dot.programa,
    dot.acao,
    `Elemento: ${dot.elemento_despesa}`,
    `Fonte: ${dot.fonte_recurso}`
  ].filter(Boolean);
  const red = dot.codigo_reduzido ? ` [Reduzido: ${dot.codigo_reduzido}]` : '';
  return `${parts.join(' | ')}${red}`;
}

export function normalizeTipoContratacao(value: unknown): TipoContratacao {
  if (value === 'OBRAS_ENGENHARIA' || value === 'SERVICOS' || value === 'AQUISICAO') {
    return value;
  }
  return 'AQUISICAO';
}

export function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const clean = String(item ?? '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function formatDotacoesSummary(dotacoes: Dotacao[], manuais: string[] = []): string {
  const entries = [
    ...dotacoes.map((d) => formatDotacaoLine(d)),
    ...sanitizeStringList(manuais)
  ];
  if (entries.length === 0) return 'Não vinculada (A indicar / SRP)';
  if (entries.length === 1) return entries[0];
  return entries.map((e, idx) => `${idx + 1}) ${e}`).join(' ; ');
}

function resolveProcessLinkedDotacoes(proc: ProcurementProcess): Dotacao[] {
  const ids = sanitizeStringList([
    ...(proc.dotacao_ids || []),
    ...(proc.dotacao_id ? [proc.dotacao_id] : [])
  ]);
  const resolved: Dotacao[] = [];
  for (const id of ids) {
    const dot = getDotacao(id);
    if (dot) resolved.push(dot);
  }
  return resolved;
}

function mapProcessRow(row: any): ProcurementProcess {
  const {
    pesquisa_preco_itens_json,
    dotacao_ids_json,
    dotacoes_manuais_json,
    tcu_acordaos_json,
    ...rest
  } = row;
  const itens = sanitizePesquisaPrecoItens(safeJsonParse(pesquisa_preco_itens_json, []));
  const dotacaoIds = sanitizeStringList([
    ...safeJsonParse<string[]>(dotacao_ids_json, []),
    ...(row.dotacao_id ? [String(row.dotacao_id)] : [])
  ]);
  const dotacoesManuais = sanitizeStringList(safeJsonParse(dotacoes_manuais_json, []));
  const tcuAcordaos = sanitizeTcuPrecedents(safeJsonParse(tcu_acordaos_json, []));
  return {
    ...rest,
    dotacao_id: dotacaoIds[0] ?? row.dotacao_id ?? null,
    dotacao_ids: dotacaoIds,
    dotacoes_manuais: dotacoesManuais,
    tipo_contratacao: normalizeTipoContratacao(row.tipo_contratacao),
    data_certame: row.data_certame || '',
    horario_disputa: row.horario_disputa || '',
    usar_srp: Boolean(row.usar_srp),
    valor_estimado_global: Number(row.valor_estimado_global ?? 0),
    pesquisa_preco_arquivo: row.pesquisa_preco_arquivo || '',
    pesquisa_preco_resumo: row.pesquisa_preco_resumo || '',
    pesquisa_preco_itens: itens,
    tcu_acordaos_vinculados: tcuAcordaos,
    header_version: Number(row.header_version ?? 1)
  };
}

function mapPieceRow(row: any): AgentPiece {
  return {
    ...row,
    agent_number: Number(row.agent_number),
    current_version: Number(row.current_version ?? 0),
    structured_json: safeJsonParse(row.structured_json, {}),
    legal_alerts: safeJsonParse(row.legal_alerts_json, [])
  };
}

function mapVersionRow(row: any): PieceVersion {
  return {
    ...row,
    version_number: Number(row.version_number),
    structured_json: safeJsonParse(row.structured_json, {})
  };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ============================================================
// INSTITUTIONS
// ============================================================
export function listInstitutions(): Institution[] {
  const db = getDb();
  return db.prepare('SELECT * FROM institutions ORDER BY updated_at DESC').all() as unknown as Institution[];
}

export function getInstitution(id: string): Institution | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM institutions WHERE id = ?').get(id);
  return (row as unknown as Institution) || null;
}

export function upsertInstitution(data: Partial<Institution> & { id?: string }): Institution {
  const db = getDb();
  const now = new Date().toISOString();
  const id = data.id || crypto.randomUUID();
  const existing = getInstitution(id);

  if (existing) {
    const updated: Institution = {
      ...existing,
      ...data,
      id,
      cnpj: formatCnpj(data.cnpj ?? existing.cnpj),
      updated_at: now
    };
    db.prepare(`
      UPDATE institutions SET
        cnpj = ?, razao_social = ?, nome_fantasia = ?, endereco_completo = ?,
        cep = ?, municipio = ?, uf = ?, telefone = ?, email = ?,
        portal_transparencia_url = ?, logo_data_url = ?, comarca_foro = ?,
        prefeito_nome = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.cnpj,
      updated.razao_social,
      updated.nome_fantasia,
      updated.endereco_completo,
      updated.cep,
      updated.municipio,
      updated.uf,
      updated.telefone,
      updated.email,
      updated.portal_transparencia_url,
      updated.logo_data_url,
      updated.comarca_foro,
      updated.prefeito_nome,
      updated.updated_at,
      id
    );
    syncInstitutionProcesses(id, 'Dados institucionais ou brasão da Prefeitura atualizados.');
    return updated;
  }

  const created: Institution = {
    id,
    cnpj: formatCnpj(data.cnpj || ''),
    razao_social: data.razao_social || 'Prefeitura Municipal',
    nome_fantasia: data.nome_fantasia || '',
    endereco_completo: data.endereco_completo || '',
    cep: data.cep || '',
    municipio: data.municipio || '',
    uf: data.uf || '',
    telefone: data.telefone || '',
    email: data.email || '',
    portal_transparencia_url: data.portal_transparencia_url || '',
    logo_data_url: data.logo_data_url || '',
    comarca_foro: data.comarca_foro || (data.municipio ? `Comarca de ${data.municipio}/${data.uf || ''}` : ''),
    prefeito_nome: data.prefeito_nome || 'Prefeito(a) Municipal',
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO institutions (
      id, cnpj, razao_social, nome_fantasia, endereco_completo, cep, municipio, uf,
      telefone, email, portal_transparencia_url, logo_data_url, comarca_foro, prefeito_nome,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    created.id,
    created.cnpj,
    created.razao_social,
    created.nome_fantasia,
    created.endereco_completo,
    created.cep,
    created.municipio,
    created.uf,
    created.telefone,
    created.email,
    created.portal_transparencia_url,
    created.logo_data_url,
    created.comarca_foro,
    created.prefeito_nome,
    created.created_at,
    created.updated_at
  );

  return created;
}

// ============================================================
// SECRETARIOS
// ============================================================
export function listSecretarios(institutionId: string): Secretario[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM secretarios WHERE institution_id = ? ORDER BY secretaria ASC')
    .all(institutionId) as unknown as Secretario[];
}

export function getSecretario(id: string): Secretario | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM secretarios WHERE id = ?').get(id) as unknown as Secretario) || null;
}

export function saveSecretario(data: Partial<Secretario> & { institution_id: string }): Secretario {
  const db = getDb();
  const now = new Date().toISOString();
  const id = data.id || crypto.randomUUID();
  const existing = data.id ? getSecretario(data.id) : null;

  if (existing) {
    const updated: Secretario = {
      ...existing,
      ...data,
      id,
      updated_at: now
    };
    db.prepare(`
      UPDATE secretarios SET
        secretaria = ?, nome = ?, cargo = ?, portaria_nomeacao = ?,
        matricula_cpf = ?, email = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.secretaria,
      updated.nome,
      updated.cargo,
      updated.portaria_nomeacao,
      updated.matricula_cpf || '',
      updated.email || '',
      updated.source,
      updated.updated_at,
      id
    );

    const linkedProcs = db
      .prepare('SELECT id FROM processes WHERE secretario_id = ?')
      .all(id) as { id: string }[];
    for (const p of linkedProcs) {
      syncProcessMetadataAcrossPieces(p.id, `Dados do Ordenador de Despesa (${updated.nome}) atualizados.`, false);
    }
    return updated;
  }

  const created: Secretario = {
    id,
    institution_id: data.institution_id,
    secretaria: data.secretaria || 'Secretaria Municipal',
    nome: data.nome || '',
    cargo: data.cargo || 'Secretário(a) Municipal',
    portaria_nomeacao: data.portaria_nomeacao || '',
    matricula_cpf: data.matricula_cpf || '',
    email: data.email || '',
    source: data.source || 'manual',
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO secretarios (
      id, institution_id, secretaria, nome, cargo, portaria_nomeacao,
      matricula_cpf, email, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    created.id,
    created.institution_id,
    created.secretaria,
    created.nome,
    created.cargo,
    created.portaria_nomeacao,
    created.matricula_cpf ?? '',
    created.email ?? '',
    created.source,
    created.created_at,
    created.updated_at
  );

  return created;
}

export function deleteSecretario(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM secretarios WHERE id = ?').run(id);
}

// ============================================================
// DOTACOES
// ============================================================
export function listDotacoes(institutionId: string): Dotacao[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM dotacoes WHERE institution_id = ? ORDER BY orgao ASC, unidade_orcamentaria ASC')
    .all(institutionId) as unknown as Dotacao[];
}

export function getDotacao(id: string): Dotacao | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM dotacoes WHERE id = ?').get(id) as unknown as Dotacao) || null;
}

export function saveDotacao(data: Partial<Dotacao> & { institution_id: string }): Dotacao {
  const db = getDb();
  const now = new Date().toISOString();
  const id = data.id || crypto.randomUUID();
  const existing = data.id ? getDotacao(data.id) : null;

  if (existing) {
    const updated: Dotacao = {
      ...existing,
      ...data,
      id,
      saldo_disponivel: Number(data.saldo_disponivel ?? existing.saldo_disponivel ?? 0),
      updated_at: now
    };
    db.prepare(`
      UPDATE dotacoes SET
        orgao = ?, unidade_orcamentaria = ?, funcao = ?, subfuncao = ?,
        programa = ?, acao = ?, elemento_despesa = ?, fonte_recurso = ?,
        codigo_reduzido = ?, descricao = ?, saldo_disponivel = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.orgao,
      updated.unidade_orcamentaria,
      updated.funcao,
      updated.subfuncao,
      updated.programa,
      updated.acao,
      updated.elemento_despesa,
      updated.fonte_recurso,
      updated.codigo_reduzido || '',
      updated.descricao || '',
      updated.saldo_disponivel ?? 0,
      updated.source,
      updated.updated_at,
      id
    );

    const linkedProcs = db
      .prepare('SELECT id FROM processes WHERE dotacao_id = ?')
      .all(id) as { id: string }[];
    for (const p of linkedProcs) {
      syncProcessMetadataAcrossPieces(p.id, 'Dotação Orçamentária vinculada atualizada.', false);
    }
    return updated;
  }

  const created: Dotacao = {
    id,
    institution_id: data.institution_id,
    orgao: data.orgao || '',
    unidade_orcamentaria: data.unidade_orcamentaria || '',
    funcao: data.funcao || '',
    subfuncao: data.subfuncao || '',
    programa: data.programa || '',
    acao: data.acao || '',
    elemento_despesa: data.elemento_despesa || '',
    fonte_recurso: data.fonte_recurso || '',
    codigo_reduzido: data.codigo_reduzido || '',
    descricao: data.descricao || '',
    saldo_disponivel: Number(data.saldo_disponivel ?? 0),
    source: data.source || 'manual',
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO dotacoes (
      id, institution_id, orgao, unidade_orcamentaria, funcao, subfuncao,
      programa, acao, elemento_despesa, fonte_recurso, codigo_reduzido,
      descricao, saldo_disponivel, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    created.id,
    created.institution_id,
    created.orgao,
    created.unidade_orcamentaria,
    created.funcao,
    created.subfuncao,
    created.programa,
    created.acao,
    created.elemento_despesa,
    created.fonte_recurso,
    created.codigo_reduzido ?? '',
    created.descricao ?? '',
    created.saldo_disponivel ?? 0,
    created.source,
    created.created_at,
    created.updated_at
  );

  return created;
}

export function deleteDotacao(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM dotacoes WHERE id = ?').run(id);
}

// ============================================================
// PROCESSES & PIECES
// ============================================================
export function listProcesses(): (ProcurementProcess & {
  institution_name: string;
  secretaria_nome: string;
  approved_count: number;
  total_active_agents: number;
})[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*,
      i.nome_fantasia as institution_fantasia,
      i.razao_social as institution_razao,
      COALESCE(s.secretaria, 'Não vinculada') as secretaria_nome,
      (SELECT COUNT(*) FROM agent_pieces ap WHERE ap.process_id = p.id AND ap.status = 'APROVADO') as approved_count,
      (SELECT COUNT(*) FROM agent_pieces ap WHERE ap.process_id = p.id AND ap.status != 'DISPENSADO') as total_active_agents
    FROM processes p
    LEFT JOIN institutions i ON i.id = p.institution_id
    LEFT JOIN secretarios s ON s.id = p.secretario_id
    ORDER BY p.updated_at DESC
  `).all() as any[];

  return rows.map((r) => ({
    ...mapProcessRow(r),
    institution_name: r.institution_fantasia || r.institution_razao || 'Órgão Municipal',
    secretaria_nome: r.secretaria_nome,
    approved_count: Number(r.approved_count ?? 0),
    total_active_agents: Number(r.total_active_agents ?? 11)
  }));
}

export function getProcess(id: string): ProcurementProcess | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM processes WHERE id = ?').get(id);
  return row ? mapProcessRow(row) : null;
}

export function createProcess(
  input: Partial<ProcurementProcess> & { institution_id: string }
): ProcessBundle {
  const db = getDb();
  if (!input.institution_id || !getInstitution(input.institution_id)) {
    throw new Error('Órgão/Prefeitura informado não encontrado.');
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const usarSrp = Boolean(input.usar_srp);
  const cleanedItens = sanitizePesquisaPrecoItens(input.pesquisa_preco_itens);
  const itemsTotal = sumPesquisaPrecoItens(cleanedItens);
  const valorGlobal =
    Number(input.valor_estimado_global ?? 0) > 0
      ? Number(input.valor_estimado_global)
      : itemsTotal;
  const dotacaoIds = sanitizeStringList(
    input.dotacao_ids !== undefined
      ? input.dotacao_ids
      : input.dotacao_id
        ? [input.dotacao_id]
        : []
  );
  const dotacoesManuais = sanitizeStringList(input.dotacoes_manuais);
  const tipoContratacao = normalizeTipoContratacao(input.tipo_contratacao);
  const tcuAcordaos = sanitizeTcuPrecedents(input.tcu_acordaos_vinculados);

  const proc: ProcurementProcess = {
    id,
    institution_id: input.institution_id,
    secretario_id: input.secretario_id || null,
    dotacao_id: dotacaoIds[0] ?? null,
    dotacao_ids: dotacaoIds,
    dotacoes_manuais: dotacoesManuais,
    tipo_contratacao: tipoContratacao,
    data_certame: String(input.data_certame || '').trim(),
    horario_disputa: String(input.horario_disputa || '').trim(),
    numero_processo_licitatorio: input.numero_processo_licitatorio || '001/2026',
    numero_processo_administrativo: input.numero_processo_administrativo || '100/2026',
    titulo_resumido: input.titulo_resumido || 'Nova Contratação Pública',
    modalidade: input.modalidade || 'PREGAO_ELETRONICO',
    modo_disputa: input.modo_disputa || 'ABERTO_FECHADO',
    criterio_julgamento: input.criterio_julgamento || 'MENOR_PRECO',
    formato_lance: input.formato_lance || 'POR_ITEM',
    usar_srp: usarSrp,
    demanda_bruta: input.demanda_bruta || '',
    responsavel_requisitante: input.responsavel_requisitante || 'Servidor Requisitante',
    cargo_requisitante: input.cargo_requisitante || 'Coordenador de Área',
    valor_estimado_global: valorGlobal,
    pesquisa_preco_arquivo: input.pesquisa_preco_arquivo || '',
    pesquisa_preco_resumo: input.pesquisa_preco_resumo || '',
    pesquisa_preco_itens: cleanedItens,
    tcu_acordaos_vinculados: tcuAcordaos,
    status_geral: 'EM_ELABORACAO',
    header_version: 1,
    created_at: now,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO processes (
      id, institution_id, secretario_id, dotacao_id,
      numero_processo_licitatorio, numero_processo_administrativo, titulo_resumido,
      modalidade, modo_disputa, criterio_julgamento, formato_lance, usar_srp,
      demanda_bruta, responsavel_requisitante, cargo_requisitante, valor_estimado_global,
      pesquisa_preco_arquivo, pesquisa_preco_resumo, pesquisa_preco_itens_json,
      tipo_contratacao, dotacao_ids_json, dotacoes_manuais_json,
      data_certame, horario_disputa, tcu_acordaos_json,
      status_geral, header_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proc.id,
    proc.institution_id,
    proc.secretario_id,
    proc.dotacao_id,
    proc.numero_processo_licitatorio,
    proc.numero_processo_administrativo,
    proc.titulo_resumido,
    proc.modalidade,
    proc.modo_disputa,
    proc.criterio_julgamento,
    proc.formato_lance,
    proc.usar_srp ? 1 : 0,
    proc.demanda_bruta,
    proc.responsavel_requisitante,
    proc.cargo_requisitante,
    proc.valor_estimado_global,
    proc.pesquisa_preco_arquivo ?? '',
    proc.pesquisa_preco_resumo ?? '',
    JSON.stringify(cleanedItens),
    proc.tipo_contratacao,
    JSON.stringify(dotacaoIds),
    JSON.stringify(dotacoesManuais),
    proc.data_certame ?? '',
    proc.horario_disputa ?? '',
    JSON.stringify(tcuAcordaos),
    proc.status_geral,
    proc.header_version,
    proc.created_at,
    proc.updated_at
  );

  const insertPiece = db.prepare(`
    INSERT INTO agent_pieces (
      id, process_id, agent_number, agent_key, title, legal_basis, status,
      structured_json, html_content, legal_alerts_json, current_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const def of AGENT_DEFINITIONS) {
    const status: AgentStatus = def.conditionalOnSrp && !usarSrp ? 'DISPENSADO' : 'PENDENTE';
    insertPiece.run(
      `${proc.id}-ag-${def.number}`,
      proc.id,
      def.number,
      def.key,
      def.title,
      def.legalBasis,
      status,
      '{}',
      '',
      '[]',
      0,
      now
    );
  }

  addAuditLog({
    process_id: proc.id,
    action: 'PROCESSO_CRIADO',
    actor_name: proc.responsavel_requisitante || 'Usuário Gestor',
    actor_role: proc.cargo_requisitante || 'Área Requisitante',
    details: `Processo Licitatório ${proc.numero_processo_licitatorio} (PA ${proc.numero_processo_administrativo}) instaurado na modalidade ${getModalidadeLabel(proc.modalidade)}.`
  });

  return getProcessBundle(proc.id)!;
}

export function updateProcess(
  id: string,
  patch: Partial<ProcurementProcess>
): ProcessBundle | null {
  const db = getDb();
  const existing = getProcess(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updatedItens =
    patch.pesquisa_preco_itens !== undefined
      ? sanitizePesquisaPrecoItens(patch.pesquisa_preco_itens)
      : existing.pesquisa_preco_itens || [];
  const computedItemsSum = sumPesquisaPrecoItens(updatedItens);
  const nextValorGlobal =
    patch.valor_estimado_global !== undefined
      ? Number(patch.valor_estimado_global)
      : patch.pesquisa_preco_itens !== undefined && computedItemsSum > 0
        ? computedItemsSum
        : existing.valor_estimado_global;

  const nextDotacaoIds =
    patch.dotacao_ids !== undefined
      ? sanitizeStringList(patch.dotacao_ids)
      : patch.dotacao_id !== undefined
        ? patch.dotacao_id
          ? [String(patch.dotacao_id).trim()].filter(Boolean)
          : []
        : existing.dotacao_ids || [];
  const nextPrimaryDotacaoId = nextDotacaoIds[0] ?? null;
  const nextDotacoesManuais =
    patch.dotacoes_manuais !== undefined
      ? sanitizeStringList(patch.dotacoes_manuais)
      : existing.dotacoes_manuais || [];
  const nextTipoContratacao =
    patch.tipo_contratacao !== undefined
      ? normalizeTipoContratacao(patch.tipo_contratacao)
      : existing.tipo_contratacao;
  const nextTcuAcordaos =
    patch.tcu_acordaos_vinculados !== undefined
      ? sanitizeTcuPrecedents(patch.tcu_acordaos_vinculados)
      : existing.tcu_acordaos_vinculados || [];

  const updated: ProcurementProcess = {
    ...existing,
    ...patch,
    id,
    dotacao_id: nextPrimaryDotacaoId,
    dotacao_ids: nextDotacaoIds,
    dotacoes_manuais: nextDotacoesManuais,
    tipo_contratacao: nextTipoContratacao,
    data_certame:
      patch.data_certame !== undefined ? String(patch.data_certame || '').trim() : existing.data_certame || '',
    horario_disputa:
      patch.horario_disputa !== undefined
        ? String(patch.horario_disputa || '').trim()
        : existing.horario_disputa || '',
    usar_srp: patch.usar_srp !== undefined ? Boolean(patch.usar_srp) : existing.usar_srp,
    valor_estimado_global: nextValorGlobal,
    pesquisa_preco_arquivo:
      patch.pesquisa_preco_arquivo !== undefined
        ? patch.pesquisa_preco_arquivo
        : existing.pesquisa_preco_arquivo || '',
    pesquisa_preco_resumo:
      patch.pesquisa_preco_resumo !== undefined
        ? patch.pesquisa_preco_resumo
        : existing.pesquisa_preco_resumo || '',
    pesquisa_preco_itens: updatedItens,
    tcu_acordaos_vinculados: nextTcuAcordaos,
    header_version: existing.header_version + 1,
    updated_at: now
  };

  db.prepare(`
    UPDATE processes SET
      institution_id = ?, secretario_id = ?, dotacao_id = ?,
      numero_processo_licitatorio = ?, numero_processo_administrativo = ?, titulo_resumido = ?,
      modalidade = ?, modo_disputa = ?, criterio_julgamento = ?, formato_lance = ?, usar_srp = ?,
      demanda_bruta = ?, responsavel_requisitante = ?, cargo_requisitante = ?,
      valor_estimado_global = ?, pesquisa_preco_arquivo = ?, pesquisa_preco_resumo = ?,
      pesquisa_preco_itens_json = ?, tipo_contratacao = ?, dotacao_ids_json = ?, dotacoes_manuais_json = ?,
      data_certame = ?, horario_disputa = ?, tcu_acordaos_json = ?,
      status_geral = ?, header_version = ?, updated_at = ?
    WHERE id = ?
  `).run(
    updated.institution_id,
    updated.secretario_id,
    updated.dotacao_id,
    updated.numero_processo_licitatorio,
    updated.numero_processo_administrativo,
    updated.titulo_resumido,
    updated.modalidade,
    updated.modo_disputa,
    updated.criterio_julgamento,
    updated.formato_lance,
    updated.usar_srp ? 1 : 0,
    updated.demanda_bruta,
    updated.responsavel_requisitante,
    updated.cargo_requisitante,
    updated.valor_estimado_global,
    updated.pesquisa_preco_arquivo ?? '',
    updated.pesquisa_preco_resumo ?? '',
    JSON.stringify(updatedItens),
    updated.tipo_contratacao,
    JSON.stringify(nextDotacaoIds),
    JSON.stringify(nextDotacoesManuais),
    updated.data_certame ?? '',
    updated.horario_disputa ?? '',
    JSON.stringify(nextTcuAcordaos),
    updated.status_geral,
    updated.header_version,
    updated.updated_at,
    id
  );

  // Toggle Agente 08 (Minuta da ARP) based on SRP checkbox
  const arpPiece = db
    .prepare('SELECT * FROM agent_pieces WHERE process_id = ? AND agent_number = 8')
    .get(id) as any;

  if (arpPiece) {
    if (updated.usar_srp && arpPiece.status === 'DISPENSADO') {
      const nextStatus: AgentStatus = arpPiece.current_version > 0 ? 'DESATUALIZADO' : 'PENDENTE';
      db.prepare('UPDATE agent_pieces SET status = ?, stale_reason = ?, updated_at = ? WHERE id = ?').run(
        nextStatus,
        nextStatus === 'DESATUALIZADO' ? 'SRP reativado — revise a Minuta da ARP.' : null,
        now,
        arpPiece.id
      );
    } else if (!updated.usar_srp && arpPiece.status !== 'DISPENSADO') {
      db.prepare('UPDATE agent_pieces SET status = ?, stale_reason = ?, updated_at = ? WHERE id = ?').run(
        'DISPENSADO',
        'SRP desativado nos Dados do Certame.',
        now,
        arpPiece.id
      );
    }
  }

  const priceResearchChanged =
    JSON.stringify(existing.pesquisa_preco_itens || []) !== JSON.stringify(updatedItens) ||
    (existing.pesquisa_preco_resumo || '') !== (updated.pesquisa_preco_resumo || '');

  const dotacoesChanged =
    JSON.stringify(existing.dotacao_ids || []) !== JSON.stringify(nextDotacaoIds) ||
    JSON.stringify(existing.dotacoes_manuais || []) !== JSON.stringify(nextDotacoesManuais) ||
    existing.dotacao_id !== updated.dotacao_id;

  const tipoChanged = existing.tipo_contratacao !== updated.tipo_contratacao;
  const sessaoChanged =
    (existing.data_certame || '') !== (updated.data_certame || '') ||
    (existing.horario_disputa || '') !== (updated.horario_disputa || '');
  const tcuChanged =
    JSON.stringify(existing.tcu_acordaos_vinculados || []) !== JSON.stringify(nextTcuAcordaos);

  const substantiveChanged =
    existing.modalidade !== updated.modalidade ||
    existing.modo_disputa !== updated.modo_disputa ||
    existing.criterio_julgamento !== updated.criterio_julgamento ||
    existing.formato_lance !== updated.formato_lance ||
    existing.usar_srp !== updated.usar_srp ||
    tipoChanged ||
    sessaoChanged ||
    dotacoesChanged ||
    existing.secretario_id !== updated.secretario_id ||
    priceResearchChanged;

  const changedFields: string[] = [];
  if (existing.numero_processo_licitatorio !== updated.numero_processo_licitatorio) changedFields.push('Nº Proc. Licitatório');
  if (existing.numero_processo_administrativo !== updated.numero_processo_administrativo) changedFields.push('Nº Proc. Administrativo');
  if (tipoChanged) changedFields.push('Tipo da Contratação');
  if (sessaoChanged) changedFields.push('Data/Horário do Certame');
  if (existing.modalidade !== updated.modalidade) changedFields.push('Modalidade');
  if (existing.modo_disputa !== updated.modo_disputa) changedFields.push('Modo de Disputa');
  if (existing.criterio_julgamento !== updated.criterio_julgamento) changedFields.push('Critério de Julgamento');
  if (existing.formato_lance !== updated.formato_lance) changedFields.push('Formato de Lance');
  if (existing.usar_srp !== updated.usar_srp) changedFields.push('SRP');
  if (dotacoesChanged) changedFields.push('Dotações Orçamentárias');
  if (existing.secretario_id !== updated.secretario_id) changedFields.push('Secretaria / Ordenador');
  if (priceResearchChanged) changedFields.push('Pesquisa de Preço (Itens/Valores)');
  if (tcuChanged) changedFields.push('Jurisprudência TCU (Acórdãos)');

  const reason =
    changedFields.length > 0
      ? `Alteração estrutural (${changedFields.join(', ')}) sincronizada em todas as peças.`
      : 'Dados do certame atualizados e sincronizados.';

  syncProcessMetadataAcrossPieces(id, reason, substantiveChanged);

  if (tcuChanged && !substantiveChanged) {
    // Marca apenas o Parecer Jurídico (Agente 10) se já gerado e não marcado como desatualizado
    const p10 = db
      .prepare('SELECT id, current_version, status FROM agent_pieces WHERE process_id = ? AND agent_number = 10')
      .get(id) as { id: string; current_version: number; status: AgentStatus } | undefined;
    if (p10 && p10.current_version > 0 && p10.status !== 'DISPENSADO') {
      db.prepare('UPDATE agent_pieces SET status = ?, stale_reason = ?, updated_at = ? WHERE id = ?').run(
        'DESATUALIZADO',
        'Lista de Acórdãos do TCU vinculados atualizada — re-execute o Agente 10 para incorporar ao Parecer Jurídico.',
        now,
        p10.id
      );
    }
  }

  addAuditLog({
    process_id: id,
    action: 'CERTAME_ATUALIZADO',
    actor_name: updated.responsavel_requisitante || 'Gestor do Processo',
    actor_role: 'Equipe de Planejamento',
    details: reason
  });

  return getProcessBundle(id);
}

export function deleteProcess(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM processes WHERE id = ?').run(id);
  return Number(res.changes || 0) > 0;
}

export function cloneProcess(
  sourceId: string,
  opts?: { numero_processo_licitatorio?: string; titulo_resumido?: string }
): ProcessBundle {
  const source = getProcess(sourceId);
  if (!source) {
    throw new Error('Processo de origem não encontrado para duplicação.');
  }

  const nextLicNum =
    opts?.numero_processo_licitatorio?.trim() || `${source.numero_processo_licitatorio}-COPIA`;
  const nextTitle =
    opts?.titulo_resumido?.trim() ||
    (source.titulo_resumido.endsWith('(Cópia)') ? source.titulo_resumido : `${source.titulo_resumido} (Cópia)`);

  const cloned = createProcess({
    institution_id: source.institution_id,
    secretario_id: source.secretario_id,
    dotacao_id: source.dotacao_id,
    dotacao_ids: source.dotacao_ids,
    dotacoes_manuais: source.dotacoes_manuais,
    tipo_contratacao: source.tipo_contratacao,
    data_certame: source.data_certame,
    horario_disputa: source.horario_disputa,
    numero_processo_licitatorio: nextLicNum,
    numero_processo_administrativo: `${source.numero_processo_administrativo}-2`,
    titulo_resumido: nextTitle,
    modalidade: source.modalidade,
    modo_disputa: source.modo_disputa,
    criterio_julgamento: source.criterio_julgamento,
    formato_lance: source.formato_lance,
    usar_srp: source.usar_srp,
    demanda_bruta: source.demanda_bruta,
    responsavel_requisitante: source.responsavel_requisitante,
    cargo_requisitante: source.cargo_requisitante,
    valor_estimado_global: source.valor_estimado_global,
    pesquisa_preco_arquivo: source.pesquisa_preco_arquivo,
    pesquisa_preco_resumo: source.pesquisa_preco_resumo,
    pesquisa_preco_itens: source.pesquisa_preco_itens,
    tcu_acordaos_vinculados: source.tcu_acordaos_vinculados
  });

  addAuditLog({
    process_id: cloned.process.id,
    action: 'PROCESSO_CLONADO',
    actor_name: source.responsavel_requisitante || 'Gestor do Processo',
    actor_role: 'Equipe de Planejamento',
    details: `Processo duplicado a partir de Lic. ${source.numero_processo_licitatorio} (${(source.pesquisa_preco_itens || []).length} itens de pesquisa preservados).`
  });

  return getProcessBundle(cloned.process.id)!;
}

/**
 * Sincroniza automaticamente cabeçalhos e tokens estruturais em todas as peças já geradas
 * quando dados da Prefeitura, Secretaria, Dotação ou Certame são alterados.
 */
export function syncProcessMetadataAcrossPieces(
  processId: string,
  reason: string,
  markSubstantiveStale = false
): void {
  const db = getDb();
  const proc = getProcess(processId);
  if (!proc) return;

  const inst = getInstitution(proc.institution_id);
  const sec = proc.secretario_id ? getSecretario(proc.secretario_id) : null;
  const linkedDotacoes = resolveProcessLinkedDotacoes(proc);
  const dot = linkedDotacoes[0] ?? null;
  if (!inst) return;

  const now = new Date().toISOString();
  db.prepare('UPDATE processes SET header_version = header_version + 1, updated_at = ? WHERE id = ?').run(
    now,
    processId
  );

  const pieces = db
    .prepare('SELECT * FROM agent_pieces WHERE process_id = ? ORDER BY agent_number ASC')
    .all(processId) as any[];

  const bindings: Record<string, string> = {
    orgao_razao_social: inst.razao_social,
    orgao_nome_fantasia: inst.nome_fantasia || inst.razao_social,
    orgao_cnpj: formatCnpj(inst.cnpj),
    orgao_endereco: `${inst.endereco_completo} — CEP ${inst.cep} — ${inst.municipio}/${inst.uf}`,
    orgao_municipio_uf: `${inst.municipio}/${inst.uf}`,
    orgao_comarca: inst.comarca_foro || `Comarca de ${inst.municipio}/${inst.uf}`,
    prefeito_nome: inst.prefeito_nome || 'Prefeito(a) Municipal',
    numero_processo_licitatorio: proc.numero_processo_licitatorio,
    numero_processo_administrativo: proc.numero_processo_administrativo,
    tipo_contratacao_label: getTipoContratacaoLabel(proc.tipo_contratacao),
    sessao_publica_data_hora: formatSessaoPublicaLabel(proc.data_certame, proc.horario_disputa),
    modalidade_label: getModalidadeLabel(proc.modalidade),
    modo_disputa_label: getModoDisputaLabel(proc.modo_disputa),
    criterio_julgamento_label: getCriterioLabel(proc.criterio_julgamento),
    formato_lance_label: getFormatoLanceLabel(proc.formato_lance),
    srp_status: proc.usar_srp ? 'Sistema de Registro de Preços (SRP - Art. 82)' : 'Contratação Convencional (Sem SRP)',
    secretaria_nome: sec?.secretaria || 'Secretaria Requisitante não vinculada',
    ordenador_nome: sec?.nome || 'Ordenador de Despesas a designar',
    ordenador_cargo: sec?.cargo || 'Secretário(a) Municipal',
    ordenador_portaria: sec?.portaria_nomeacao || 'Portaria não informada',
    dotacao_completa: formatDotacoesSummary(linkedDotacoes, proc.dotacoes_manuais),
    dotacao_elemento: dot?.elemento_despesa || proc.dotacoes_manuais?.[0] || 'A definir',
    dotacao_fonte: dot?.fonte_recurso || 'A definir',
    valor_estimado_global: formatCurrencyBRL(proc.valor_estimado_global)
  };

  for (const row of pieces) {
    const piece = mapPieceRow(row);
    if (!piece.html_content && piece.current_version === 0) continue;

    let updatedHtml = piece.html_content;
    if (updatedHtml) {
      const $ = cheerio.load(updatedHtml, null, false);
      let mutated = false;
      $('[data-bind]').each((_, el) => {
        const key = $(el).attr('data-bind');
        if (key && bindings[key] !== undefined) {
          $(el).text(bindings[key]);
          mutated = true;
        }
      });
      if (mutated) {
        updatedHtml = $.html();
      }
    }

    const updatedJson = {
      ...piece.structured_json,
      _cabecalho_sincronizado: {
        ...bindings,
        sincronizado_em: now
      }
    };

    let nextStatus = piece.status;
    let staleReason = piece.stale_reason;
    if (
      markSubstantiveStale &&
      piece.status !== 'PENDENTE' &&
      piece.status !== 'DISPENSADO' &&
      piece.agent_number >= 2
    ) {
      nextStatus = 'DESATUALIZADO';
      staleReason = reason;
    }

    const newHash = updatedHtml ? sha256(updatedHtml) : piece.content_hash;

    db.prepare(`
      UPDATE agent_pieces SET
        html_content = ?, structured_json = ?, status = ?, stale_reason = ?, content_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updatedHtml,
      JSON.stringify(updatedJson),
      nextStatus,
      staleReason ?? null,
      newHash ?? null,
      now,
      piece.id
    );
  }
}

export function syncInstitutionProcesses(institutionId: string, reason: string): void {
  const db = getDb();
  const procs = db
    .prepare('SELECT id FROM processes WHERE institution_id = ?')
    .all(institutionId) as { id: string }[];

  for (const p of procs) {
    syncProcessMetadataAcrossPieces(p.id, reason, false);
    addAuditLog({
      process_id: p.id,
      action: 'INSTITUICAO_SINCRONIZADA',
      actor_name: 'Sistema GovFlow',
      actor_role: 'Motor de Integridade',
      details: reason
    });
  }
}

export function getProcessBundle(processId: string): ProcessBundle | null {
  const db = getDb();
  const proc = getProcess(processId);
  if (!proc) return null;

  const institution = getInstitution(proc.institution_id);
  if (!institution) return null;

  const secretario = proc.secretario_id ? getSecretario(proc.secretario_id) : null;
  const dotacoesVinculadas = resolveProcessLinkedDotacoes(proc);
  const dotacao = dotacoesVinculadas[0] ?? null;

  const pieceRows = db
    .prepare('SELECT * FROM agent_pieces WHERE process_id = ? ORDER BY agent_number ASC')
    .all(processId) as any[];
  const pieces = pieceRows.map(mapPieceRow);

  const auditLogs = db
    .prepare('SELECT * FROM audit_logs WHERE process_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(processId) as unknown as AuditLogEntry[];

  const validationAlerts = validateCertameConfiguration(proc);

  return {
    process: proc,
    institution,
    secretario,
    dotacao,
    dotacoes_vinculadas: dotacoesVinculadas,
    pieces,
    audit_logs: auditLogs,
    validation_alerts: validationAlerts
  };
}

// ============================================================
// PIECES, VERSIONS & AUDIT LOGS
// ============================================================
export function getAgentPiece(processId: string, agentNumber: number): AgentPiece | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agent_pieces WHERE process_id = ? AND agent_number = ?')
    .get(processId, agentNumber);
  return row ? mapPieceRow(row) : null;
}

export function saveGeneratedPiece(params: {
  processId: string;
  agentNumber: number;
  structuredJson: Record<string, any>;
  htmlContent: string;
  legalAlerts: LegalAlert[];
  aiProviderUsed: string;
  changeSummary: string;
  feedbackUsed?: string;
  actorName: string;
  isRegeneration?: boolean;
}): AgentPiece {
  const db = getDb();
  const existing = getAgentPiece(params.processId, params.agentNumber);
  if (!existing) {
    throw new Error(`Peça do agente ${params.agentNumber} não encontrada.`);
  }

  const now = new Date().toISOString();
  const nextVersion = existing.current_version + 1;
  const hash = sha256(params.htmlContent);

  db.prepare(`
    UPDATE agent_pieces SET
      status = 'AGUARDANDO_REVISAO',
      structured_json = ?,
      html_content = ?,
      legal_alerts_json = ?,
      ai_provider_used = ?,
      current_version = ?,
      approved_by = NULL,
      approved_role = NULL,
      approved_at = NULL,
      content_hash = ?,
      stale_reason = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(params.structuredJson),
    params.htmlContent,
    JSON.stringify(params.legalAlerts),
    params.aiProviderUsed,
    nextVersion,
    hash,
    now,
    existing.id
  );

  db.prepare(`
    INSERT INTO piece_versions (
      id, piece_id, version_number, html_content, structured_json,
      change_summary, feedback_used, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    existing.id,
    nextVersion,
    params.htmlContent,
    JSON.stringify(params.structuredJson),
    params.changeSummary,
    params.feedbackUsed || null,
    params.actorName,
    now
  );

  // Marca peças posteriores já geradas como DESATUALIZADO para evitar contradição no processo
  db.prepare(`
    UPDATE agent_pieces SET
      status = 'DESATUALIZADO',
      stale_reason = ?,
      updated_at = ?
    WHERE process_id = ? AND agent_number > ? AND status IN ('AGUARDANDO_REVISAO', 'APROVADO')
  `).run(
    `O Agente ${String(params.agentNumber).padStart(2, '0')} foi ${params.isRegeneration ? 'regenerado' : 'executado'}. Revalide esta peça para manter consistência.`,
    now,
    params.processId,
    params.agentNumber
  );

  addAuditLog({
    process_id: params.processId,
    piece_id: existing.id,
    agent_number: params.agentNumber,
    action: params.isRegeneration ? 'PECA_REGENERADA' : 'AGENTE_EXECUTADO',
    actor_name: params.actorName,
    actor_role: params.aiProviderUsed,
    details: params.changeSummary,
    content_hash: hash
  });

  return getAgentPiece(params.processId, params.agentNumber)!;
}

export function saveManualPieceEdit(params: {
  processId: string;
  agentNumber: number;
  htmlContent: string;
  structuredJson?: Record<string, any>;
  actorName: string;
  changeSummary?: string;
}): AgentPiece {
  const db = getDb();
  const existing = getAgentPiece(params.processId, params.agentNumber);
  if (!existing) {
    throw new Error(`Peça do agente ${params.agentNumber} não encontrada.`);
  }

  const now = new Date().toISOString();
  const nextVersion = existing.current_version + 1;
  const hash = sha256(params.htmlContent);
  const mergedJson = params.structuredJson ?? existing.structured_json;

  db.prepare(`
    UPDATE agent_pieces SET
      status = 'AGUARDANDO_REVISAO',
      html_content = ?,
      structured_json = ?,
      current_version = ?,
      approved_by = NULL,
      approved_role = NULL,
      approved_at = NULL,
      content_hash = ?,
      stale_reason = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    params.htmlContent,
    JSON.stringify(mergedJson),
    nextVersion,
    hash,
    now,
    existing.id
  );

  const summary = params.changeSummary || `Edição manual no editor rico (v${nextVersion})`;
  db.prepare(`
    INSERT INTO piece_versions (
      id, piece_id, version_number, html_content, structured_json,
      change_summary, feedback_used, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    existing.id,
    nextVersion,
    params.htmlContent,
    JSON.stringify(mergedJson),
    summary,
    null,
    params.actorName,
    now
  );

  addAuditLog({
    process_id: params.processId,
    piece_id: existing.id,
    agent_number: params.agentNumber,
    action: 'PECA_EDITADA',
    actor_name: params.actorName,
    actor_role: 'Revisor Humano',
    details: summary,
    content_hash: hash
  });

  return getAgentPiece(params.processId, params.agentNumber)!;
}

export function approveAndSignPiece(params: {
  processId: string;
  agentNumber: number;
  actorName: string;
  actorRole: string;
}): AgentPiece {
  const db = getDb();
  const existing = getAgentPiece(params.processId, params.agentNumber);
  if (!existing) {
    throw new Error(`Peça do agente ${params.agentNumber} não encontrada.`);
  }
  if (!existing.html_content.trim()) {
    throw new Error('Execute o agente ou insira conteúdo antes de aprovar e assinar.');
  }

  const now = new Date().toISOString();
  const hash = sha256(existing.html_content);

  db.prepare(`
    UPDATE agent_pieces SET
      status = 'APROVADO',
      approved_by = ?,
      approved_role = ?,
      approved_at = ?,
      content_hash = ?,
      stale_reason = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(params.actorName, params.actorRole, now, hash, now, existing.id);

  // Atualiza status geral do processo nos marcos 10 e 11
  if (params.agentNumber === 10) {
    db.prepare("UPDATE processes SET status_geral = 'PARECER_EMITIDO', updated_at = ? WHERE id = ?").run(
      now,
      params.processId
    );
  } else if (params.agentNumber === 11) {
    db.prepare("UPDATE processes SET status_geral = 'AUTORIZADO', updated_at = ? WHERE id = ?").run(
      now,
      params.processId
    );
  }

  addAuditLog({
    process_id: params.processId,
    piece_id: existing.id,
    agent_number: params.agentNumber,
    action: 'PECA_APROVADA_ASSINADA',
    actor_name: params.actorName,
    actor_role: params.actorRole,
    details: `Peça v${existing.current_version} aprovada e assinada digitalmente (SHA-256: ${hash.slice(0, 12)}...).`,
    content_hash: hash
  });

  return getAgentPiece(params.processId, params.agentNumber)!;
}

export function listPieceVersions(pieceId: string): PieceVersion[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM piece_versions WHERE piece_id = ? ORDER BY version_number DESC')
    .all(pieceId) as any[];
  return rows.map(mapVersionRow);
}

export function restorePieceVersion(params: {
  processId: string;
  agentNumber: number;
  versionNumber: number;
  actorName: string;
}): AgentPiece {
  const db = getDb();
  const piece = getAgentPiece(params.processId, params.agentNumber);
  if (!piece) throw new Error('Peça não encontrada.');
  const row = db
    .prepare('SELECT * FROM piece_versions WHERE piece_id = ? AND version_number = ?')
    .get(piece.id, params.versionNumber) as any;
  if (!row) throw new Error(`Versão v${params.versionNumber} não encontrada.`);

  const version = mapVersionRow(row);
  return saveManualPieceEdit({
    processId: params.processId,
    agentNumber: params.agentNumber,
    htmlContent: version.html_content,
    structuredJson: version.structured_json,
    actorName: params.actorName,
    changeSummary: `Restauração da versão v${params.versionNumber}`
  });
}

export function addAuditLog(entry: {
  process_id: string;
  piece_id?: string | null;
  agent_number?: number | null;
  action: AuditLogEntry['action'];
  actor_name: string;
  actor_role: string;
  details: string;
  content_hash?: string | null;
}): AuditLogEntry {
  const db = getDb();
  const log: AuditLogEntry = {
    id: crypto.randomUUID(),
    process_id: entry.process_id,
    piece_id: entry.piece_id ?? null,
    agent_number: entry.agent_number ?? null,
    action: entry.action,
    actor_name: entry.actor_name,
    actor_role: entry.actor_role,
    details: entry.details,
    content_hash: entry.content_hash ?? null,
    created_at: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO audit_logs (
      id, process_id, piece_id, agent_number, action, actor_name, actor_role, details, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.id,
    log.process_id,
    log.piece_id ?? null,
    log.agent_number ?? null,
    log.action,
    log.actor_name,
    log.actor_role,
    log.details,
    log.content_hash ?? null,
    log.created_at
  );

  return log;
}

// ============================================================
// AI SETTINGS (OPTIONAL LLM CONFIG)
// ============================================================
const VALID_AI_PROVIDERS: AiProviderMode[] = ['auto', 'local', 'gemini', 'openai'];

function normalizeAiProviderMode(value: string | undefined): AiProviderMode {
  const normalized = (value || '').trim().toLowerCase();
  if (VALID_AI_PROVIDERS.includes(normalized as AiProviderMode)) {
    return normalized as AiProviderMode;
  }
  return 'auto';
}

export interface ResolvedAiConfig {
  provider: AiProviderMode;
  effectiveProvider: EffectiveAiProvider;
  authSource: AiAuthSource;
  authSourceLabel: string;
  geminiResolution: GeminiCredentialResolution;
  geminiApiKey: string;
  geminiModel: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl: string;
}

export function getAiConfigRaw(): ResolvedAiConfig {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const provider = normalizeAiProviderMode(map.get('ai_provider') || process.env.AI_PROVIDER);
  const geminiResolution = resolveGeminiCredential(map.get('gemini_api_key') ?? '');
  const geminiApiKey = geminiResolution.apiKey || '';
  const geminiModel = normalizeGeminiModelName(
    map.get('gemini_model') ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL
  );
  const openaiApiKey = (map.get('openai_api_key') ?? process.env.OPENAI_API_KEY ?? '').trim();
  const openaiModel =
    (map.get('openai_model') ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const openaiBaseUrl =
    (map.get('openai_base_url') ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').trim() ||
    'https://api.openai.com/v1';

  let effectiveProvider: EffectiveAiProvider = 'local';
  let authSource: AiAuthSource = 'none';
  let authSourceLabel = geminiResolution.sourceLabel;

  if (provider === 'local') {
    effectiveProvider = 'local';
    authSource = 'none';
    authSourceLabel = 'Motor Local Especialista 14.133 selecionado manualmente (100% offline)';
  } else if (provider === 'gemini') {
    if (geminiResolution.hasCredential) {
      effectiveProvider = 'gemini';
      authSource = geminiResolution.source;
      authSourceLabel = geminiResolution.sourceLabel;
    } else {
      effectiveProvider = 'local';
      authSource = 'none';
      authSourceLabel =
        'Gemini selecionado sem credencial detectada — fallback automático para Motor Local 14.133';
    }
  } else if (provider === 'openai') {
    if (openaiApiKey) {
      effectiveProvider = 'openai';
      authSource = 'openai_key';
      authSourceLabel = 'Chave OpenAI / Compatível configurada';
    } else {
      effectiveProvider = 'local';
      authSource = 'none';
      authSourceLabel =
        'OpenAI selecionado sem chave configurada — fallback automático para Motor Local 14.133';
    }
  } else {
    // Auto mode: activate Gemini seamlessly from env/.env/ADC/DB, then OpenAI, else offline engine.
    if (geminiResolution.hasCredential) {
      effectiveProvider = 'gemini';
      authSource = geminiResolution.source;
      authSourceLabel = geminiResolution.sourceLabel;
    } else if (openaiApiKey) {
      effectiveProvider = 'openai';
      authSource = 'openai_key';
      authSourceLabel = 'Detecção automática via OPENAI_API_KEY / configuração local';
    } else {
      effectiveProvider = 'local';
      authSource = 'none';
      authSourceLabel = geminiResolution.sourceLabel;
    }
  }

  return {
    provider,
    effectiveProvider,
    authSource,
    authSourceLabel,
    geminiResolution,
    geminiApiKey,
    geminiModel,
    openaiApiKey,
    openaiModel,
    openaiBaseUrl
  };
}

function buildGeminiAuthDetail(res: GeminiCredentialResolution): string {
  if (res.ignoredInvalidDbKey) {
    return 'Chave anterior no banco local foi ignorada por formato inválido (mascarado/truncado). Use "Refazer Credenciais Gemini" para limpar.';
  }
  if (res.source === 'db_api_key') {
    return 'Chave manual salva no SQLite local (sobrescreve .env, ambiente e Google ADC).';
  }
  if (res.source === 'env_gemini_key' || res.source === 'env_google_key') {
    return res.hasDotEnvFile
      ? 'Credencial lida automaticamente do ambiente / arquivo .env da aplicação.'
      : 'Credencial lida automaticamente de variável de ambiente do sistema.';
  }
  if (res.source === 'adc_authorized_user' || res.source === 'adc_service_account') {
    const quotaInfo = res.quotaProjectId
      ? `Projeto de cota: ${res.quotaProjectId}.`
      : 'Sem quota_project_id explícito (defina GOOGLE_CLOUD_QUOTA_PROJECT se necessário).';
    return `Autenticação Google Cloud ADC ativa. ${quotaInfo}`;
  }
  return res.hasDotEnvFile
    ? 'Arquivo .env detectado na raiz, porém sem GEMINI_API_KEY/GOOGLE_API_KEY ou ADC configurados; operando no Motor Local 14.133.'
    : 'Nenhum arquivo .env ou ADC detectado neste host; operando em modo offline pelo Motor Local 14.133.';
}

export function getPublicAiSettings(): AiSettings {
  const raw = getAiConfigRaw();
  return {
    provider: raw.provider,
    effectiveProvider: raw.effectiveProvider,
    authSource: raw.authSource,
    authSourceLabel: raw.authSourceLabel,
    geminiAuthDetail: buildGeminiAuthDetail(raw.geminiResolution),
    geminiModel: raw.geminiModel,
    openaiModel: raw.openaiModel,
    openaiBaseUrl: raw.openaiBaseUrl,
    hasGeminiKey: raw.geminiResolution.hasCredential,
    hasOpenaiKey: Boolean(raw.openaiApiKey.trim())
  };
}

export function updateAiSettings(patch: {
  provider?: AiProviderMode;
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
}): AiSettings {
  const db = getDb();
  const upsert = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (patch.geminiApiKey !== undefined && patch.geminiApiKey !== '***') {
    const validated = validateManualGeminiApiKey(patch.geminiApiKey);
    if (!validated.ok) {
      throw new Error(validated.error);
    }
    if (validated.key === '') {
      db.prepare("DELETE FROM app_settings WHERE key = 'gemini_api_key'").run();
    } else if (validated.key !== '***') {
      upsert.run('gemini_api_key', validated.key);
    }
  }
  if (patch.provider !== undefined) upsert.run('ai_provider', normalizeAiProviderMode(patch.provider));
  if (patch.geminiModel !== undefined) {
    const cleanModel = normalizeGeminiModelName(patch.geminiModel);
    upsert.run('gemini_model', cleanModel);
  }
  if (patch.openaiApiKey !== undefined && patch.openaiApiKey !== '***') upsert.run('openai_api_key', patch.openaiApiKey.trim());
  if (patch.openaiModel !== undefined) upsert.run('openai_model', patch.openaiModel.trim());
  if (patch.openaiBaseUrl !== undefined) upsert.run('openai_base_url', patch.openaiBaseUrl.trim());
  clearGeminiAuthCache();
  return getPublicAiSettings();
}

export function resetStoredGeminiCredentials(options?: {
  setAutoProvider?: boolean;
  resetModel?: boolean;
}): {
  clearedDbKey: boolean;
  envReloaded: boolean;
  settings: AiSettings;
} {
  const db = getDb();
  const existingKeyRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'")
    .get() as { value: string } | undefined;
  const clearedDbKey = Boolean(existingKeyRow);

  db.prepare("DELETE FROM app_settings WHERE key = 'gemini_api_key'").run();

  if (options?.setAutoProvider !== false) {
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('ai_provider', 'auto') ON CONFLICT(key) DO UPDATE SET value = 'auto'"
    ).run();
  }

  if (options?.resetModel) {
    db.prepare("DELETE FROM app_settings WHERE key = 'gemini_model'").run();
  }

  clearGeminiAuthCache();
  const envReloaded = reloadGeminiDotEnv();

  return {
    clearedDbKey,
    envReloaded,
    settings: getPublicAiSettings()
  };
}
