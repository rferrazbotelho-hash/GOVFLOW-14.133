import React, { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Code2,
  History,
  Info,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Sparkles
} from 'lucide-react';
import type {
  AgentPiece,
  AuditLogEntry,
  LegalAlert,
  PieceVersion
} from '@shared/types';
import { formatDateTimeBR } from '@shared/labels';

interface Props {
  piece: AgentPiece;
  validationAlerts: LegalAlert[];
  versions: PieceVersion[];
  auditLogs: AuditLogEntry[];
  running: boolean;
  hasNextAgent: boolean;
  nextAgentLabel?: string;
  feedbackText: string;
  onFeedbackChange: (text: string) => void;
  onRegenerateWithFeedback: () => void;
  onApproveAndAdvance: () => void;
  onRestoreVersion: (versionNumber: number) => void;
}

type CopilotTab = 'alerts' | 'versions' | 'json' | 'audit';

function AlertCard({ alert }: { alert: LegalAlert }) {
  const styles =
    alert.severity === 'critical'
      ? 'bg-rose-50 border-rose-200 text-rose-900'
      : alert.severity === 'warning'
        ? 'bg-amber-50 border-amber-200 text-amber-900'
        : 'bg-blue-50 border-blue-200 text-slate-800';

  const Icon =
    alert.severity === 'critical'
      ? AlertCircle
      : alert.severity === 'warning'
        ? AlertTriangle
        : Info;

  const iconColor =
    alert.severity === 'critical'
      ? 'text-rose-600'
      : alert.severity === 'warning'
        ? 'text-amber-600'
        : 'text-[#1351B4]';

  return (
    <div className={`rounded-lg border p-3 text-xs space-y-1 ${styles}`}>
      <div className="flex items-start gap-2">
        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${iconColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">
            {alert.article}
          </div>
          <div className="font-bold leading-snug">{alert.title}</div>
          <p className="mt-1 opacity-90 leading-relaxed">{alert.message}</p>
          {alert.recommendation && (
            <p className="mt-1 text-[11px] font-semibold">Recomendação: {alert.recommendation}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export const RightCopilotPanel: React.FC<Props> = ({
  piece,
  validationAlerts,
  versions,
  auditLogs,
  running,
  hasNextAgent,
  nextAgentLabel,
  feedbackText,
  onFeedbackChange,
  onRegenerateWithFeedback,
  onApproveAndAdvance,
  onRestoreVersion
}) => {
  const [tab, setTab] = useState<CopilotTab>('alerts');
  const allAlerts = [...piece.legal_alerts, ...validationAlerts];
  const canApprove = Boolean(piece.html_content.trim()) && piece.status !== 'DISPENSADO';

  const quickChips = [
    'Detalhar critérios de sustentabilidade e garantia mínima',
    'Reforçar justificativa técnica conforme Súmula 247 TCU',
    'Incluir prazo de entrega parcelado em 30 dias'
  ];

  return (
    <aside className="w-full xl:w-88 bg-white border-l border-slate-200 flex flex-col shrink-0 xl:h-screen xl:sticky xl:top-0">
      {/* Cabeçalho do Copiloto */}
      <div className="px-4 py-3.5 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-[#1351B4]" />
            <h3 className="text-xs font-bold text-[#071D41] uppercase tracking-wider">
              Copiloto Jurídico & Auditoria
            </h3>
          </div>
          <span className="text-[10px] font-mono bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-600">
            v{piece.current_version}
          </span>
        </div>

        {/* Botão Primário: Aprovar & Avançar */}
        <button
          type="button"
          disabled={!canApprove || running}
          onClick={onApproveAndAdvance}
          className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#168821] hover:bg-[#126E1B] disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold shadow-xs transition-all cursor-pointer"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>
            {hasNextAgent
              ? `Aprovar & Avançar (${nextAgentLabel || 'Próximo'})`
              : 'Aprovar & Finalizar Dossiê'}
          </span>
          {hasNextAgent && <ArrowRight className="w-3.5 h-3.5 shrink-0" />}
        </button>

        {piece.approved_at && (
          <div className="mt-2 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5">
            <strong>Assinado por:</strong> {piece.approved_by} em {formatDateTimeBR(piece.approved_at)}
          </div>
        )}
      </div>

      {/* Abas */}
      <div className="grid grid-cols-4 border-b border-slate-200 text-[11px] font-semibold bg-white">
        <button
          type="button"
          onClick={() => setTab('alerts')}
          className={`py-2.5 border-b-2 transition-colors cursor-pointer ${
            tab === 'alerts'
              ? 'border-[#1351B4] text-[#1351B4]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Alertas ({allAlerts.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('versions')}
          className={`py-2.5 border-b-2 transition-colors cursor-pointer ${
            tab === 'versions'
              ? 'border-[#1351B4] text-[#1351B4]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Versões ({versions.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('json')}
          className={`py-2.5 border-b-2 transition-colors cursor-pointer ${
            tab === 'json'
              ? 'border-[#1351B4] text-[#1351B4]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          JSON
        </button>
        <button
          type="button"
          onClick={() => setTab('audit')}
          className={`py-2.5 border-b-2 transition-colors cursor-pointer ${
            tab === 'audit'
              ? 'border-[#1351B4] text-[#1351B4]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Log ({auditLogs.length})
        </button>
      </div>

      {/* Conteúdo das Abas */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {tab === 'alerts' && (
          <>
            {piece.stale_reason && (
              <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 text-rose-600" />
                  Peça Desatualizada
                </div>
                <p className="mt-1">{piece.stale_reason}</p>
              </div>
            )}

            {allAlerts.length === 0 ? (
              <div className="text-xs text-slate-500 text-center py-6">
                Nenhum alerta jurídico pendente nesta etapa.
              </div>
            ) : (
              allAlerts.map((a, idx) => <AlertCard key={`${a.id}-${idx}`} alert={a} />)
            )}
          </>
        )}

        {tab === 'versions' && (
          <div className="space-y-2.5">
            {versions.length === 0 ? (
              <div className="text-xs text-slate-500 text-center py-6">
                Nenhuma versão gerada ainda. Execute o agente para criar a v1.
              </div>
            ) : (
              versions.map((v) => (
                <div
                  key={v.id}
                  className="border border-slate-200 rounded-lg p-3 text-xs space-y-1.5 bg-slate-50/70"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#071D41] flex items-center gap-1">
                      <History className="w-3.5 h-3.5 text-[#1351B4]" />
                      Versão v{v.version_number}
                    </span>
                    <span className="text-[10px] text-slate-500">{formatDateTimeBR(v.created_at)}</span>
                  </div>
                  <p className="text-slate-700">{v.change_summary}</p>
                  <div className="text-[10px] text-slate-500">Autor: {v.created_by}</div>
                  {v.version_number !== piece.current_version && (
                    <button
                      type="button"
                      onClick={() => onRestoreVersion(v.version_number)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1351B4] hover:underline cursor-pointer pt-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Restaurar esta versão
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'json' && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              <Code2 className="w-3.5 h-3.5 text-[#1351B4]" />
              Memória Estruturada Compartilhada (JSON)
            </div>
            <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-[10.5px] overflow-x-auto leading-relaxed">
              {JSON.stringify(piece.structured_json, null, 2)}
            </pre>
          </div>
        )}

        {tab === 'audit' && (
          <div className="space-y-2">
            {auditLogs.map((l) => (
              <div key={l.id} className="border-l-2 border-[#1351B4] pl-2.5 py-1 text-xs space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#071D41] text-[11px]">{l.action}</span>
                  <span className="text-[10px] text-slate-400">{formatDateTimeBR(l.created_at)}</span>
                </div>
                <div className="text-[11px] text-slate-700">{l.details}</div>
                <div className="text-[10px] text-slate-500">
                  {l.actor_name} • {l.actor_role}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rodapé do Copiloto: Regenerar com Feedback */}
      {piece.status !== 'DISPENSADO' && (
        <div className="p-4 border-t border-slate-200 bg-slate-50 space-y-2.5">
          <label className="block text-[11px] font-bold text-[#071D41] flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#1351B4]" />
            Regenerar Peça com Feedback
          </label>
          <div className="flex flex-wrap gap-1">
            {quickChips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => onFeedbackChange(chip)}
                className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-slate-300 hover:border-[#1351B4] text-slate-600 cursor-pointer truncate max-w-full"
              >
                + {chip}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={feedbackText}
            onChange={(e) => onFeedbackChange(e.target.value)}
            placeholder="Descreva ajustes desejados (ex: ajustar prazo para 10 dias úteis, reforçar exigência de atestado)..."
            className="w-full rounded-lg border border-slate-300 bg-white p-2 text-xs focus:border-[#1351B4] focus:outline-none"
          />
          <button
            type="button"
            disabled={running}
            onClick={onRegenerateWithFeedback}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#071D41] hover:bg-[#1351B4] disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {running ? 'Processando Agente...' : 'Regenerar com Feedback'}
          </button>
        </div>
      )}
    </aside>
  );
};
