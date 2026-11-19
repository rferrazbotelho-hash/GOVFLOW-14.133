import crypto from 'node:crypto';
import type { ContractAnalysisRecord } from '../../shared/types.js';
import { getDb } from './database.js';

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: any): ContractAnalysisRecord {
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    process_id: row.process_id || null,
    title: row.title,
    source_type: row.source_type || 'TEXT',
    source_filename: row.source_filename || null,
    source_format: row.source_format || 'TXT',
    contract_text: row.contract_text || '',
    analysis_focus: row.analysis_focus || '',
    institution_name: row.institution_name || null,
    verdict: row.verdict,
    compliance_score: Number(row.compliance_score ?? 0),
    summary: row.summary || '',
    extracted_metadata: safeParseJson(row.extracted_metadata_json, {
      numero_contrato: null,
      processo_referencia: null,
      objeto: null,
      contratante: null,
      cnpj_contratante: null,
      contratada: null,
      cnpj_contratada: null,
      representante_contratante: null,
      representante_cargo: null,
      valor_global: null,
      valores_em_aberto: false,
      vigencia_prazo: null,
      duracao_em_aberto: false,
      indice_reajuste: null,
      data_base_orcamento: null,
      garantia_contratual: null,
      foro: null,
      regime_legal_detectado: 'NAO_IDENTIFICADO'
    }),
    checklist_art92: safeParseJson(row.checklist_art92_json, []),
    risk_findings: safeParseJson(row.risk_findings_json, []),
    suggested_clauses: safeParseJson(row.suggested_clauses_json, []),
    tcu_precedents: safeParseJson(row.tcu_precedents_json, []),
    report_html: row.report_html || '',
    ai_provider_used: row.ai_provider_used || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function listContractAnalyses(userId?: string): ContractAnalysisRecord[] {
  const db = getDb();
  const rows = userId
    ? (db
        .prepare('SELECT * FROM contract_analyses WHERE owner_user_id = ? ORDER BY updated_at DESC')
        .all(userId) as any[])
    : (db.prepare('SELECT * FROM contract_analyses ORDER BY updated_at DESC').all() as any[]);
  return rows.map(rowToRecord);
}

export function getContractAnalysis(id: string): ContractAnalysisRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM contract_analyses WHERE id = ?')
    .get(id) as any;
  return row ? rowToRecord(row) : null;
}

export function createContractAnalysis(
  input: Omit<ContractAnalysisRecord, 'id' | 'created_at' | 'updated_at'>
): ContractAnalysisRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT INTO contract_analyses (
        id, owner_user_id, process_id, title, source_type, source_filename, source_format,
        contract_text, analysis_focus, institution_name, verdict, compliance_score, summary,
        extracted_metadata_json, checklist_art92_json, risk_findings_json,
        suggested_clauses_json, tcu_precedents_json, report_html, ai_provider_used,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      input.owner_user_id,
      input.process_id || null,
      input.title,
      input.source_type,
      input.source_filename || '',
      input.source_format || 'TXT',
      input.contract_text,
      input.analysis_focus || '',
      input.institution_name || '',
      input.verdict,
      input.compliance_score,
      input.summary,
      JSON.stringify(input.extracted_metadata),
      JSON.stringify(input.checklist_art92),
      JSON.stringify(input.risk_findings),
      JSON.stringify(input.suggested_clauses),
      JSON.stringify(input.tcu_precedents),
      input.report_html,
      input.ai_provider_used,
      now,
      now
    );

  return getContractAnalysis(id)!;
}

export function updateContractAnalysis(
  id: string,
  patch: Partial<Omit<ContractAnalysisRecord, 'id' | 'owner_user_id' | 'created_at'>>
): ContractAnalysisRecord | null {
  const existing = getContractAnalysis(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const next: ContractAnalysisRecord = {
    ...existing,
    ...patch,
    updated_at: now
  };

  getDb()
    .prepare(`
      UPDATE contract_analyses SET
        process_id = ?,
        title = ?,
        source_type = ?,
        source_filename = ?,
        source_format = ?,
        contract_text = ?,
        analysis_focus = ?,
        institution_name = ?,
        verdict = ?,
        compliance_score = ?,
        summary = ?,
        extracted_metadata_json = ?,
        checklist_art92_json = ?,
        risk_findings_json = ?,
        suggested_clauses_json = ?,
        tcu_precedents_json = ?,
        report_html = ?,
        ai_provider_used = ?,
        updated_at = ?
      WHERE id = ?
    `)
    .run(
      next.process_id || null,
      next.title,
      next.source_type,
      next.source_filename || '',
      next.source_format || 'TXT',
      next.contract_text,
      next.analysis_focus || '',
      next.institution_name || '',
      next.verdict,
      next.compliance_score,
      next.summary,
      JSON.stringify(next.extracted_metadata),
      JSON.stringify(next.checklist_art92),
      JSON.stringify(next.risk_findings),
      JSON.stringify(next.suggested_clauses),
      JSON.stringify(next.tcu_precedents),
      next.report_html,
      next.ai_provider_used,
      now,
      id
    );

  return getContractAnalysis(id);
}

export function deleteContractAnalysis(id: string): boolean {
  const res = getDb().prepare('DELETE FROM contract_analyses WHERE id = ?').run(id);
  return Number(res.changes ?? 0) > 0;
}
