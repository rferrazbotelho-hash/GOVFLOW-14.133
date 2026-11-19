import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Copy,
  FileArchive,
  FileDown,
  FileText,
  FlaskConical,
  FolderPlus,
  Loader2,
  Search,
  Trash2
} from 'lucide-react';
import type { Institution, PlatformOnlineStatus } from '@shared/types';
import { formatCurrencyBRL, formatDateBR, getModalidadeLabel } from '@shared/labels';
import { api, type ProcessListItem } from '../api/client';

type StatusFilter = 'ALL' | 'EM_ELABORACAO' | 'PARECER_EMITIDO' | 'AUTORIZADO';

interface Props {
  processes: ProcessListItem[];
  activeInstitution: Institution | null;
  onlineStatus: PlatformOnlineStatus | null;
  openingProcessId?: string | null;
  openError?: string;
  onDismissOpenError?: () => void;
  onOpenProcess: (processId: string) => Promise<void> | void;
  onNewProcess: () => void;
  onOpenInstitutionSetup: () => void;
  onOpenOnlineModal: () => void;
  onDeleteProcess: (processId: string) => void;
  onCloneProcess?: (processId: string) => Promise<void> | void;
}

export const DashboardView: React.FC<Props> = ({
  processes,
  activeInstitution,
  onlineStatus,
  openingProcessId = null,
  openError = '',
  onDismissOpenError,
  onOpenProcess,
  onNewProcess,
  onOpenInstitutionSetup,
  onOpenOnlineModal,
  onDeleteProcess,
  onCloneProcess
}) => {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionInfo, setActionInfo] = useState('');

  const handleExport = async (key: string, url: string, fallback: string) => {
    setActionError('');
    setActionInfo('');
    setExportingKey(key);
    try {
      const downloaded = await api.downloadExportFile(url, fallback);
      setActionInfo(`Download concluído: ${downloaded}`);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Falha ao exportar documento');
    } finally {
      setExportingKey(null);
    }
  };

  const handleClone = async (procId: string) => {
    if (!onCloneProcess) return;
    setActionError('');
    setActionInfo('');
    setCloningId(procId);
    try {
      await onCloneProcess(procId);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Falha ao duplicar processo');
    } finally {
      setCloningId(null);
    }
  };

  const filtered = processes.filter((p) => {
    if (statusFilter === 'AUTORIZADO') {
      if (p.status_geral !== 'AUTORIZADO' && p.status_geral !== 'CONCLUIDO') return false;
    } else if (statusFilter !== 'ALL' && p.status_geral !== statusFilter) {
      return false;
    }
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      p.numero_processo_licitatorio.toLowerCase().includes(q) ||
      p.numero_processo_administrativo.toLowerCase().includes(q) ||
      p.titulo_resumido.toLowerCase().includes(q) ||
      p.secretaria_nome.toLowerCase().includes(q)
    );
  });

  const totalValor = processes.reduce((acc, p) => acc + (p.valor_estimado_global || 0), 0);
  const concluidos = processes.filter((p) => p.status_geral === 'AUTORIZADO' || p.status_geral === 'CONCLUIDO').length;

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      {/* Banner Institucional */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {activeInstitution?.logo_data_url && (
            <img
              src={activeInstitution.logo_data_url}
              alt="Brasão"
              className="h-20 sm:h-24 w-auto max-w-[190px] min-w-[80px] object-contain rounded-xl border border-slate-200 p-2 bg-slate-50 shrink-0"
            />
          )}
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#1351B4]">
              Ecossistema Multi-Agente • Lei nº 14.133/2021
            </div>
            <h1 className="text-xl font-bold text-[#071D41]">
              {activeInstitution?.nome_fantasia || activeInstitution?.razao_social || 'GOVFLOW 14.133'}
            </h1>
            <p className="text-xs text-slate-500">
              {activeInstitution ? `CNPJ ${activeInstitution.cnpj} • ${activeInstitution.municipio}/${activeInstitution.uf}` : 'Configure seu órgão para iniciar'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenOnlineModal}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${
              onlineStatus?.test_mode !== false
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
                : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                onlineStatus?.test_mode !== false ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
              }`}
            />
            <FlaskConical className="w-3.5 h-3.5" />
            {onlineStatus?.test_mode !== false ? 'Modo Teste Online: ATIVO' : 'Modo Teste Online'}
          </button>
          <button
            type="button"
            onClick={onOpenInstitutionSetup}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:border-[#1351B4] text-xs font-semibold text-slate-700 cursor-pointer"
          >
            <Building2 className="w-4 h-4 text-[#1351B4]" />
            Configurar Órgão / CNPJ
          </button>
          <button
            type="button"
            onClick={onNewProcess}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-semibold shadow-xs cursor-pointer"
          >
            <FolderPlus className="w-4 h-4" />
            Novo Processo Licitatório
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="text-xs font-medium text-slate-500">Processos em Carteira</div>
          <div className="text-2xl font-bold text-[#071D41] mt-1">{processes.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">Esteira sequencial de 11 agentes</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="text-xs font-medium text-slate-500">Volume Estimado em Planejamento</div>
          <div className="text-2xl font-bold text-[#1351B4] mt-1">{formatCurrencyBRL(totalValor)}</div>
          <div className="text-[11px] text-slate-500 mt-1">Consolidado DFD / ETP / TR</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="text-xs font-medium text-slate-500">Dossiês Autorizados / Parecer</div>
          <div className="text-2xl font-bold text-[#168821] mt-1">{concluidos}</div>
          <div className="text-[11px] text-slate-500 mt-1">Aptos à publicação no PNCP</div>
        </div>
      </div>

      {/* Lista de Processos */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-bold text-[#071D41]">Processos Licitatórios e Contratações Diretas</h2>
            <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {(
                [
                  { id: 'ALL', label: 'Todos' },
                  { id: 'EM_ELABORACAO', label: 'Em Elaboração' },
                  { id: 'PARECER_EMITIDO', label: 'Parecer Emitido' },
                  { id: 'AUTORIZADO', label: 'Autorizados' }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors ${
                    statusFilter === tab.id
                      ? 'bg-[#1351B4] text-white shadow-2xs'
                      : 'text-slate-600 hover:text-[#071D41]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar nº processo, objeto ou secretaria..."
              className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs w-72 focus:border-[#1351B4] focus:outline-none"
            />
          </div>
        </div>
        {(actionError || openError) && (
          <div role="alert" className="mx-5 mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {actionError || openError}
            </span>
            <button
              type="button"
              onClick={() => {
                setActionError('');
                onDismissOpenError?.();
              }}
              className="text-[11px] font-bold underline cursor-pointer"
            >
              Fechar
            </button>
          </div>
        )}
        {actionInfo && (
          <div className="mx-5 mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {actionInfo}
            </span>
            <button type="button" onClick={() => setActionInfo('')} className="text-[11px] font-bold underline cursor-pointer">
              Fechar
            </button>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            Nenhum processo encontrado. Clique em <strong>Novo Processo Licitatório</strong> para iniciar a esteira de agentes.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map((proc) => {
              const pct =
                proc.total_active_agents > 0
                  ? Math.round((proc.approved_count / proc.total_active_agents) * 100)
                  : 0;
              return (
                <div
                  key={proc.id}
                  className="p-5 hover:bg-slate-50/80 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-[#EFF6FF] border border-blue-200 text-[#071D41] font-mono text-xs font-bold">
                        Lic. {proc.numero_processo_licitatorio}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500">
                        PA {proc.numero_processo_administrativo}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-semibold">
                        {getModalidadeLabel(proc.modalidade)}
                      </span>
                      {proc.usar_srp && (
                        <span className="px-2 py-0.5 rounded bg-blue-100 text-[#1351B4] text-[10px] font-bold">
                          SRP (Art. 82)
                        </span>
                      )}
                      {proc.status_geral === 'AUTORIZADO' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                          <CheckCircle2 className="w-3 h-3" /> Autorizado
                        </span>
                      )}
                    </div>

                    <h3 className="text-sm font-bold text-slate-900 leading-snug">
                      {proc.titulo_resumido}
                    </h3>

                    <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
                      <span>{proc.secretaria_nome}</span>
                      <span>
                        Valor Estimado: <strong className="text-slate-700">{formatCurrencyBRL(proc.valor_estimado_global)}</strong>
                      </span>
                      <span>Atualizado em {formatDateBR(proc.updated_at)}</span>
                    </div>
                  </div>

                  {/* Progresso e Ações */}
                  <div className="flex flex-wrap items-center gap-4 shrink-0">
                    <div className="w-36">
                      <div className="flex justify-between text-[10px] text-slate-600 mb-1">
                        <span>Peças Aprovadas</span>
                        <span className="font-bold">
                          {proc.approved_count}/{proc.total_active_agents}
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#168821]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={exportingKey !== null}
                        onClick={() =>
                          handleExport(
                            `${proc.id}:docx`,
                            `/api/processes/${proc.id}/export/docx`,
                            `Dossie_${proc.numero_processo_licitatorio}.docx`
                          )
                        }
                        title="Baixar Dossiê Consolidado em Word (.docx)"
                        className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-blue-200 bg-blue-50/70 hover:border-[#1351B4] text-[#1351B4] text-[11px] font-bold disabled:opacity-50 cursor-pointer"
                      >
                        {exportingKey === `${proc.id}:docx` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <FileText className="w-3.5 h-3.5" />
                        )}
                        Word
                      </button>
                      <button
                        type="button"
                        disabled={exportingKey !== null}
                        onClick={() =>
                          handleExport(
                            `${proc.id}:zip`,
                            `/api/processes/${proc.id}/export/zip`,
                            `Pecas_Word_${proc.numero_processo_licitatorio}.zip`
                          )
                        }
                        title="Baixar Todas as Peças em Word (.zip)"
                        className="p-2 rounded-lg border border-slate-300 bg-white hover:border-[#168821] text-slate-600 hover:text-[#168821] disabled:opacity-50 cursor-pointer"
                      >
                        {exportingKey === `${proc.id}:zip` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <FileArchive className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={exportingKey !== null}
                        onClick={() =>
                          handleExport(
                            `${proc.id}:pdf`,
                            `/api/processes/${proc.id}/export/pdf`,
                            `Dossie_${proc.numero_processo_licitatorio}.pdf`
                          )
                        }
                        title="Baixar PDF Consolidado"
                        className="p-2 rounded-lg border border-slate-300 bg-white hover:border-[#1351B4] text-slate-600 hover:text-[#1351B4] disabled:opacity-50 cursor-pointer"
                      >
                        {exportingKey === `${proc.id}:pdf` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <FileDown className="w-4 h-4" />
                        )}
                      </button>
                      {onCloneProcess && (
                        <button
                          type="button"
                          disabled={cloningId === proc.id}
                          onClick={() => handleClone(proc.id)}
                          title="Duplicar Processo (nova licitação com mesma pesquisa/configuração)"
                          className="p-2 rounded-lg border border-slate-300 bg-white hover:border-[#1351B4] text-slate-600 hover:text-[#1351B4] disabled:opacity-50 cursor-pointer"
                        >
                          {cloningId === proc.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      {confirmDeleteId === proc.id ? (
                        <div className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2 py-1">
                          <span className="text-[11px] font-semibold text-rose-800 mr-0.5">Excluir?</span>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              onDeleteProcess(proc.id);
                            }}
                            className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold cursor-pointer"
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-1.5 py-0.5 rounded bg-white border border-slate-300 text-slate-600 hover:bg-slate-100 text-[10px] font-semibold cursor-pointer"
                          >
                            Não
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(proc.id)}
                          title="Excluir Processo"
                          className="p-2 rounded-lg border border-slate-300 bg-white hover:border-rose-300 text-slate-500 hover:text-rose-600 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={openingProcessId === proc.id}
                        onClick={() => onOpenProcess(proc.id)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#071D41] hover:bg-[#1351B4] disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
                      >
                        {openingProcessId === proc.id ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Abrindo...
                          </>
                        ) : (
                          <>
                            Abrir Esteira
                            <ArrowRight className="w-3.5 h-3.5" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
