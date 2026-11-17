import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Edit3,
  FileArchive,
  FileDown,
  FileSpreadsheet,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react';
import {
  AGENT_DEFINITIONS,
  type Dotacao,
  type PesquisaPrecoItem,
  type PieceVersion,
  type ProcessBundle,
  type Secretario
} from '@shared/types';
import { AGENT_STATUS_LABELS, formatCurrencyBRL } from '@shared/labels';
import { api } from '../api/client';
import { InstitutionalHeader } from './InstitutionalHeader';
import { PriceResearchPanel } from './PriceResearchPanel';
import { RichDocumentEditor } from './RichDocumentEditor';
import { RightCopilotPanel } from './RightCopilotPanel';
import { TcuJurisprudencePanel } from './TcuJurisprudencePanel';

interface Props {
  bundle: ProcessBundle;
  selectedAgentNumber: number;
  runningAgentNumber: number | null;
  onSelectAgent: (num: number) => void;
  onRunningChange: (num: number | null) => void;
  onBundleUpdated: (bundle: ProcessBundle) => void;
  onOpenCertameConfig: () => void;
}

export const ProcessWorkspaceView: React.FC<Props> = ({
  bundle,
  selectedAgentNumber,
  runningAgentNumber,
  onSelectAgent,
  onRunningChange,
  onBundleUpdated,
  onOpenCertameConfig
}) => {
  const piece = bundle.pieces.find((p) => p.agent_number === selectedAgentNumber) || bundle.pieces[0];
  const def = AGENT_DEFINITIONS.find((d) => d.number === piece.agent_number)!;

  const [editMode, setEditMode] = useState(false);
  const [draftHtml, setDraftHtml] = useState(piece.html_content);
  const [isDirty, setIsDirty] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [versions, setVersions] = useState<PieceVersion[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  // Quick dropdowns inside the process (Requirement 2.1)
  const [secretarios, setSecretarios] = useState<Secretario[]>([]);
  const [dotacoes, setDotacoes] = useState<Dotacao[]>([]);
  const [demandaDraft, setDemandaDraft] = useState(bundle.process.demanda_bruta);
  const [dfdEstimativa, setDfdEstimativa] = useState(String(bundle.process.valor_estimado_global || ''));
  const [dfdDataPretendida, setDfdDataPretendida] = useState(
    new Date(Date.now() + 45 * 86400000).toLocaleDateString('pt-BR')
  );
  const [dfdPrioridade, setDfdPrioridade] = useState<'Baixo' | 'Médio' | 'Alto'>(
    bundle.process.valor_estimado_global >= 300000
      ? 'Alto'
      : bundle.process.valor_estimado_global >= 80000
        ? 'Médio'
        : 'Baixo'
  );
  const [etpPesquisaMercado, setEtpPesquisaMercado] = useState(
    bundle.process.pesquisa_preco_resumo || ''
  );
  const [runningBatch, setRunningBatch] = useState(false);
  const [confirmReelaborar, setConfirmReelaborar] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [pesquisaArquivo, setPesquisaArquivo] = useState(bundle.process.pesquisa_preco_arquivo || '');
  const [pesquisaResumo, setPesquisaResumo] = useState(bundle.process.pesquisa_preco_resumo || '');
  const [pesquisaItens, setPesquisaItens] = useState<PesquisaPrecoItem[]>(
    bundle.process.pesquisa_preco_itens || []
  );
  const [pesquisaDirty, setPesquisaDirty] = useState(false);
  const [savingPesquisa, setSavingPesquisa] = useState(false);
  const [showPesquisaPanel, setShowPesquisaPanel] = useState(
    (bundle.process.pesquisa_preco_itens?.length || 0) > 0 || Boolean(bundle.process.pesquisa_preco_arquivo)
  );

  // Modal de Assinatura (Aprovar e Assinar Log)
  const [showSignModal, setShowSignModal] = useState(false);
  const [signActionAdvance, setSignActionAdvance] = useState(false);
  const [signerName, setSignerName] = useState(
    bundle.secretario?.nome || bundle.process.responsavel_requisitante || 'Gestor Responsável'
  );
  const [signerRole, setSignerRole] = useState(
    bundle.secretario?.cargo || bundle.process.cargo_requisitante || 'Ordenador de Despesas'
  );

  useEffect(() => {
    setErrorMsg('');
    setInfoMsg('');
    setConfirmReelaborar(false);
  }, [piece.agent_number, bundle.process.id]);

  useEffect(() => {
    setDraftHtml(piece.html_content);
    setIsDirty(false);
    setEditMode(false);
    api
      .listVersions(bundle.process.id, piece.agent_number)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [piece.id, piece.html_content, piece.current_version, bundle.process.id]);

  useEffect(() => {
    setDemandaDraft(bundle.process.demanda_bruta);
    setDfdEstimativa(String(bundle.process.valor_estimado_global || ''));
    setPesquisaArquivo(bundle.process.pesquisa_preco_arquivo || '');
    setPesquisaResumo(bundle.process.pesquisa_preco_resumo || '');
    setPesquisaItens(bundle.process.pesquisa_preco_itens || []);
    setPesquisaDirty(false);
    if (bundle.process.pesquisa_preco_resumo) {
      setEtpPesquisaMercado(bundle.process.pesquisa_preco_resumo);
    }
    setSignerName(
      bundle.secretario?.nome || bundle.process.responsavel_requisitante || 'Gestor Responsável'
    );
    setSignerRole(
      bundle.secretario?.cargo || bundle.process.cargo_requisitante || 'Ordenador de Despesas'
    );
  }, [
    bundle.process.id,
    bundle.process.demanda_bruta,
    bundle.process.valor_estimado_global,
    bundle.process.pesquisa_preco_arquivo,
    bundle.process.pesquisa_preco_resumo,
    bundle.process.pesquisa_preco_itens,
    bundle.secretario
  ]);

  useEffect(() => {
    api.getInstitutionDetail(bundle.institution.id).then((res) => {
      setSecretarios(res.secretarios);
      setDotacoes(res.dotacoes);
    });
  }, [bundle.institution.id]);

  const activePieces = bundle.pieces.filter((p) => p.status !== 'DISPENSADO');
  const currentActiveIdx = activePieces.findIndex((p) => p.agent_number === piece.agent_number);
  const nextActivePiece =
    currentActiveIdx >= 0 && currentActiveIdx < activePieces.length - 1
      ? activePieces[currentActiveIdx + 1]
      : null;

  const handleSavePesquisa = async (silent = false) => {
    setSavingPesquisa(true);
    setErrorMsg('');
    try {
      const total =
        Math.round(pesquisaItens.reduce((acc, it) => acc + (Number(it.valor_total) || 0), 0) * 100) / 100;
      const updated = await api.updateProcess(bundle.process.id, {
        pesquisa_preco_arquivo: pesquisaArquivo || null,
        pesquisa_preco_resumo: pesquisaResumo || null,
        pesquisa_preco_itens: pesquisaItens,
        ...(total > 0 ? { valor_estimado_global: total } : {})
      });
      onBundleUpdated(updated);
      setPesquisaDirty(false);
      if (!silent) {
        setInfoMsg(
          `Pesquisa de preço salva (${pesquisaItens.length} ${pesquisaItens.length === 1 ? 'item' : 'itens'} — ${formatCurrencyBRL(total)}) e vinculada aos agentes.`
        );
      }
      return updated;
    } catch (err: any) {
      setErrorMsg(err.message);
      throw err;
    } finally {
      setSavingPesquisa(false);
    }
  };

  const handleExportFile = async (key: string, url: string, fallback: string) => {
    setErrorMsg('');
    setInfoMsg('');
    setExportingKey(key);
    try {
      const downloaded = await api.downloadExportFile(url, fallback);
      setInfoMsg(`Arquivo "${downloaded}" baixado com sucesso.`);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao exportar arquivo.');
    } finally {
      setExportingKey(null);
    }
  };

  const handleRunAllAgents = async (forceReelaborar = false) => {
    const approvedCount = bundle.pieces.filter((p) => p.status === 'APROVADO').length;
    if (approvedCount > 0 && !forceReelaborar) {
      setConfirmReelaborar(true);
      return;
    }
    setConfirmReelaborar(false);
    setErrorMsg('');
    setInfoMsg('');
    setRunningBatch(true);
    try {
      if (demandaDraft !== bundle.process.demanda_bruta || pesquisaDirty) {
        const total =
          Math.round(pesquisaItens.reduce((acc, it) => acc + (Number(it.valor_total) || 0), 0) * 100) / 100;
        const updatedBundle = await api.updateProcess(bundle.process.id, {
          ...(demandaDraft !== bundle.process.demanda_bruta ? { demanda_bruta: demandaDraft } : {}),
          ...(pesquisaDirty
            ? {
                pesquisa_preco_arquivo: pesquisaArquivo || null,
                pesquisa_preco_resumo: pesquisaResumo || null,
                pesquisa_preco_itens: pesquisaItens,
                ...(total > 0 ? { valor_estimado_global: total } : {})
              }
            : {})
        });
        onBundleUpdated(updatedBundle);
        setPesquisaDirty(false);
      }

      const res = await api.executeAllAgents(bundle.process.id, {
        actorName: bundle.process.responsavel_requisitante || signerName || 'Orquestrador GovFlow',
        actorRole: signerRole
      });
      onBundleUpdated(res.bundle);
      setVersions(await api.listVersions(bundle.process.id, piece.agent_number));
      setInfoMsg(
        `Todas as ${res.executed_agents.length} peças ativas foram elaboradas conforme Pesquisa de Preço, Campos e Modalidade (${bundle.process.modalidade}). Prontas para download em Word (.docx)!`
      );
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setRunningBatch(false);
    }
  };

  const handleRunAgent = async (feedback?: string) => {
    setErrorMsg('');
    setInfoMsg('');
    onRunningChange(piece.agent_number);
    try {
      // Se demanda bruta ou pesquisa de preço foi editada localmente, salva antes de executar
      if ((piece.agent_number === 1 && demandaDraft !== bundle.process.demanda_bruta) || pesquisaDirty) {
        const total =
          Math.round(pesquisaItens.reduce((acc, it) => acc + (Number(it.valor_total) || 0), 0) * 100) / 100;
        const updatedBundle = await api.updateProcess(bundle.process.id, {
          ...(piece.agent_number === 1 && demandaDraft !== bundle.process.demanda_bruta
            ? { demanda_bruta: demandaDraft }
            : {}),
          ...(pesquisaDirty
            ? {
                pesquisa_preco_arquivo: pesquisaArquivo || null,
                pesquisa_preco_resumo: pesquisaResumo || null,
                pesquisa_preco_itens: pesquisaItens,
                ...(total > 0 ? { valor_estimado_global: total } : {})
              }
            : {})
        });
        onBundleUpdated(updatedBundle);
        setPesquisaDirty(false);
      }

      const res = await api.executeAgent(bundle.process.id, piece.agent_number, {
        feedback,
        actorName: bundle.process.responsavel_requisitante || 'Orquestrador GovFlow',
        ...(piece.agent_number === 2
          ? {
              estimativaPreliminar: Number(dfdEstimativa || 0) || undefined,
              dataPretendida: dfdDataPretendida,
              prioridade: dfdPrioridade
            }
          : {}),
        ...(piece.agent_number === 3 && etpPesquisaMercado.trim()
          ? {
              pesquisaMercado: etpPesquisaMercado
            }
          : {})
      });
      onBundleUpdated(res.bundle);
      setVersions(await api.listVersions(bundle.process.id, piece.agent_number));
      setInfoMsg(
        feedback
          ? `Peça regenerada com feedback (v${res.piece.current_version}).`
          : `Agente ${String(piece.agent_number).padStart(2, '0')} executado com sucesso (v${res.piece.current_version}).`
      );
      if (feedback) setFeedbackText('');
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      onRunningChange(null);
    }
  };

  const handleSaveManualEdit = async () => {
    setSavingEdit(true);
    setErrorMsg('');
    try {
      const res = await api.savePieceEdit(bundle.process.id, piece.agent_number, {
        html_content: draftHtml,
        actorName: signerName
      });
      onBundleUpdated(res.bundle);
      setVersions(await api.listVersions(bundle.process.id, piece.agent_number));
      setIsDirty(false);
      setInfoMsg(`Edição manual salva na versão v${res.piece.current_version}.`);
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleOpenSign = (advance: boolean) => {
    setSignActionAdvance(advance);
    setShowSignModal(true);
  };

  const handleConfirmApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowSignModal(false);
    setErrorMsg('');
    try {
      if (isDirty) {
        await api.savePieceEdit(bundle.process.id, piece.agent_number, {
          html_content: draftHtml,
          actorName: signerName
        });
      }
      const res = await api.approvePiece(bundle.process.id, piece.agent_number, {
        actorName: signerName,
        actorRole: signerRole
      });
      onBundleUpdated(res.bundle);
      setInfoMsg(`Peça assinada e registrada no Log de Auditoria por ${signerName}.`);
      if (signActionAdvance && nextActivePiece) {
        onSelectAgent(nextActivePiece.agent_number);
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleRestoreVersion = async (versionNumber: number) => {
    try {
      const res = await api.restoreVersion(bundle.process.id, piece.agent_number, versionNumber, signerName);
      onBundleUpdated(res.bundle);
      setVersions(await api.listVersions(bundle.process.id, piece.agent_number));
      setInfoMsg(`Versão v${versionNumber} restaurada como v${res.piece.current_version}.`);
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleQuickBindingUpdate = async (patch: {
    secretario_id?: string | null;
    dotacao_id?: string | null;
    dotacao_ids?: string[];
  }) => {
    setErrorMsg('');
    try {
      const updated = await api.updateProcess(bundle.process.id, patch);
      onBundleUpdated(updated);
      setInfoMsg('Vínculo atualizado e sincronizado nos cabeçalhos das peças.');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao atualizar vínculo no certame.');
    }
  };

  const isRunning = runningAgentNumber === piece.agent_number;
  const hasContent = Boolean(piece.html_content.trim());
  const readyWordPieces = bundle.pieces.filter((p) => p.status !== 'DISPENSADO' && Boolean(p.html_content.trim()));

  return (
    <div className="flex-1 flex flex-col xl:flex-row min-w-0">
      {/* ÁREA CENTRAL */}
      <div className="flex-1 min-w-0 p-4 md:p-6 space-y-4 overflow-y-auto">
        {/* Barra de Ações do Agente + Exportações */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2 py-0.5 rounded bg-[#071D41] text-white text-[10px] font-bold">
                  AGENTE {String(piece.agent_number).padStart(2, '0')}
                </span>
                <h1 className="text-base font-bold text-[#071D41]">{def.title.replace(/^Agente \d+ — /, '')}</h1>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                    piece.status === 'APROVADO'
                      ? 'bg-emerald-100 text-emerald-800'
                      : piece.status === 'AGUARDANDO_REVISAO'
                        ? 'bg-amber-100 text-amber-800'
                        : piece.status === 'DESATUALIZADO'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {AGENT_STATUS_LABELS[piece.status]}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {def.legalBasis} • {def.description}
              </p>
            </div>

            {/* Exportações Oficiais */}
            <div className="flex flex-wrap items-center gap-1.5">
              {hasContent && (
                <button
                  type="button"
                  disabled={exportingKey !== null}
                  onClick={() =>
                    handleExportFile(
                      `piece:${piece.agent_number}`,
                      `/api/processes/${bundle.process.id}/export/docx/${piece.agent_number}`,
                      `Peca_${String(piece.agent_number).padStart(2, '0')}.docx`
                    )
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-300 bg-blue-50 hover:border-[#1351B4] text-[11px] font-bold text-[#1351B4] disabled:opacity-50 cursor-pointer"
                >
                  {exportingKey === `piece:${piece.agent_number}` ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <FileText className="w-3.5 h-3.5" />
                  )}
                  Word Peça (.docx)
                </button>
              )}
              <button
                type="button"
                disabled={exportingKey !== null}
                onClick={() =>
                  handleExportFile(
                    'docx',
                    `/api/processes/${bundle.process.id}/export/docx`,
                    `Dossie_${bundle.process.numero_processo_licitatorio}.docx`
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
              >
                {exportingKey === 'docx' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileText className="w-3.5 h-3.5" />
                )}
                Dossiê Word (.docx)
              </button>
              <button
                type="button"
                disabled={exportingKey !== null}
                onClick={() =>
                  handleExportFile(
                    'zip',
                    `/api/processes/${bundle.process.id}/export/zip`,
                    `Pecas_Word_${bundle.process.numero_processo_licitatorio}.zip`
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:border-[#168821] text-[11px] font-semibold text-slate-700 disabled:opacity-50 cursor-pointer"
              >
                {exportingKey === 'zip' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#168821]" />
                ) : (
                  <FileArchive className="w-3.5 h-3.5 text-[#168821]" />
                )}
                Todas em Word (.zip)
              </button>
              <button
                type="button"
                disabled={exportingKey !== null}
                onClick={() =>
                  handleExportFile(
                    'pdf',
                    `/api/processes/${bundle.process.id}/export/pdf`,
                    `Dossie_${bundle.process.numero_processo_licitatorio}.pdf`
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#071D41] hover:bg-slate-800 text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
              >
                {exportingKey === 'pdf' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileDown className="w-3.5 h-3.5" />
                )}
                PDF Consolidado
              </button>
            </div>
          </div>

          {/* 4 Botões Obrigatórios da Esteira + Elaboração em Lote + Vínculo Rápido */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isRunning || runningBatch || piece.status === 'DISPENSADO'}
                onClick={() => handleRunAgent()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#1351B4] hover:bg-[#071D41] disabled:opacity-50 text-white text-xs font-semibold cursor-pointer shadow-2xs"
              >
                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {isRunning ? 'Executando...' : 'Executar Agente'}
              </button>

              <button
                type="button"
                disabled={isRunning || runningBatch}
                onClick={() => handleRunAllAgents(false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#071D41] hover:bg-[#1351B4] disabled:opacity-50 text-white text-xs font-semibold cursor-pointer shadow-2xs"
              >
                {runningBatch ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-amber-300" />}
                {runningBatch ? 'Elaborando 01–11...' : 'Elaborar Todas as Peças (01–11)'}
              </button>

              <button
                type="button"
                disabled={!hasContent || piece.status === 'DISPENSADO'}
                onClick={() => setEditMode(!editMode)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer disabled:opacity-50 ${
                  editMode
                    ? 'bg-blue-50 border-[#1351B4] text-[#1351B4]'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Edit3 className="w-3.5 h-3.5" />
                {editMode ? 'Modo Leitura' : 'Revisar/Editar'}
              </button>

              <button
                type="button"
                disabled={!hasContent || isRunning || runningBatch || piece.status === 'DISPENSADO'}
                onClick={() => handleOpenSign(false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#168821] hover:bg-[#126E1B] disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Aprovar e Assinar (Log)
              </button>

              <button
                type="button"
                disabled={isRunning || runningBatch || piece.status === 'DISPENSADO'}
                onClick={() => handleRunAgent(feedbackText || 'Aprimorar fundamentação técnica e clareza administrativa')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:border-[#1351B4] disabled:opacity-50 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Regenerar com Feedback
              </button>
            </div>

            {/* Seleção rápida via Dropdown dentro do processo (Requisito 2.1) */}
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <select
                title="Secretaria / Ordenador"
                value={bundle.process.secretario_id || ''}
                onChange={(e) => handleQuickBindingUpdate({ secretario_id: e.target.value || null })}
                className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] max-w-[180px]"
              >
                <option value="">Secretaria (Selecionar)</option>
                {secretarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.secretaria}
                  </option>
                ))}
              </select>

              <select
                title="Dotação Orçamentária Principal"
                value={bundle.process.dotacao_id || ''}
                onChange={(e) => {
                  const chosen = e.target.value;
                  const existingExtras = (bundle.process.dotacao_ids || []).filter((id) => id !== chosen && id !== bundle.process.dotacao_id);
                  handleQuickBindingUpdate({
                    dotacao_id: chosen || null,
                    dotacao_ids: chosen ? [chosen, ...existingExtras] : existingExtras
                  });
                }}
                className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] max-w-[190px]"
              >
                <option value="">Dotação (Selecionar)</option>
                {dotacoes.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.codigo_reduzido ? `[${d.codigo_reduzido}] ` : ''}
                    {d.elemento_despesa}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={onOpenCertameConfig}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 hover:border-[#1351B4] text-slate-700 font-semibold cursor-pointer"
              >
                <SlidersHorizontal className="w-3 h-3" />
                Dados do Certame
              </button>

              <button
                type="button"
                onClick={() => setShowPesquisaPanel(!showPesquisaPanel)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border font-semibold cursor-pointer ${
                  showPesquisaPanel || pesquisaItens.length > 0
                    ? 'border-blue-300 bg-blue-50 text-[#1351B4]'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-[#1351B4]'
                }`}
              >
                <FileSpreadsheet className="w-3 h-3" />
                Pesquisa de Preço ({pesquisaItens.length})
                {showPesquisaPanel ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Tira rápida de downloads individuais em Word (.docx) */}
          {readyWordPieces.length > 0 && (
            <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1">
                Peças Prontas em Word:
              </span>
              {readyWordPieces.map((wp) => (
                <button
                  key={wp.id}
                  type="button"
                  disabled={exportingKey !== null}
                  onClick={() =>
                    handleExportFile(
                      `strip:${wp.agent_number}`,
                      `/api/processes/${bundle.process.id}/export/docx/${wp.agent_number}`,
                      `Peca_${String(wp.agent_number).padStart(2, '0')}.docx`
                    )
                  }
                  title={`Baixar ${wp.title} em Microsoft Word (.docx)`}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-semibold transition-colors disabled:opacity-50 cursor-pointer ${
                    wp.agent_number === piece.agent_number
                      ? 'border-[#1351B4] bg-blue-50 text-[#1351B4]'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-[#1351B4] hover:text-[#1351B4]'
                  }`}
                >
                  {exportingKey === `strip:${wp.agent_number}` ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  ) : (
                    <FileText className="w-2.5 h-2.5" />
                  )}
                  {String(wp.agent_number).padStart(2, '0')} (.docx)
                </button>
              ))}
            </div>
          )}

          {confirmReelaborar && (
            <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2.5 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>
                  Atenção: {bundle.pieces.filter((p) => p.status === 'APROVADO').length} peça(s) já assinada(s)/aprovada(s) neste processo. Reelaborar todas as peças irá gerar novas versões e exigir nova assinatura.
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleRunAllAgents(true)}
                  className="px-3 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold cursor-pointer"
                >
                  Confirmar Reelaboração
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReelaborar(false)}
                  className="px-2.5 py-1 rounded-md bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 text-[11px] font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-800">
              {errorMsg}
            </div>
          )}
          {infoMsg && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs font-medium text-emerald-800">
              {infoMsg}
            </div>
          )}
        </div>

        {/* Pesquisa de Preço Persistente no Processo (PDF, Excel, Word) */}
        {showPesquisaPanel && (
          <div className="bg-white rounded-xl shadow-xs">
            <PriceResearchPanel
              items={pesquisaItens}
              filename={pesquisaArquivo}
              resumo={pesquisaResumo}
              hasUnsavedChanges={pesquisaDirty}
              savingProcess={savingPesquisa}
              onSaveToProcess={async () => {
                await handleSavePesquisa(false);
              }}
              onParseFile={async (file) => {
                const res = await api.uploadProcessPriceResearch(bundle.process.id, file);
                onBundleUpdated(res.bundle);
                setPesquisaDirty(false);
                setInfoMsg(
                  `Pesquisa "${res.parsed.filename}" importada (${res.parsed.itens.length} itens — ${formatCurrencyBRL(res.parsed.valor_total_estimado)}) e salva no processo.`
                );
                return res.parsed;
              }}
              onChange={({ items, filename, resumo }) => {
                setPesquisaItens(items);
                setPesquisaArquivo(filename);
                setPesquisaResumo(resumo);
                if (resumo && !etpPesquisaMercado) {
                  setEtpPesquisaMercado(resumo);
                }
                setPesquisaDirty(true);
              }}
            />
          </div>
        )}

        {/* Se for Agente 01, exibe caixa editável da Demanda Bruta */}
        {piece.agent_number === 1 && (
          <div className="bg-white border border-blue-200 rounded-xl p-4 shadow-xs space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-[#071D41]">
                Descrição Bruta da Necessidade (Linguagem Natural do Servidor Requisitante)
              </label>
              <span className="text-[10px] text-[#1351B4] font-semibold">
                Input obrigatório do Agente 01
              </span>
            </div>
            <textarea
              rows={3}
              value={demandaDraft}
              onChange={(e) => setDemandaDraft(e.target.value)}
              placeholder="Descreva o problema administrativo que precisa ser resolvido..."
              className="w-full rounded-lg border border-slate-300 p-2.5 text-xs focus:border-[#1351B4] focus:outline-none"
            />
          </div>
        )}

        {/* Se for Agente 02 (DFD), exibe inputs complementares de DFD */}
        {piece.agent_number === 2 && (
          <div className="bg-white border border-blue-200 rounded-xl p-4 shadow-xs grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                Estimativa Preliminar (R$)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={dfdEstimativa}
                onChange={(e) => setDfdEstimativa(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                Data Desejada p/ Conclusão
              </label>
              <input
                type="text"
                value={dfdDataPretendida}
                onChange={(e) => setDfdDataPretendida(e.target.value)}
                placeholder="DD/MM/AAAA"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                Grau de Prioridade (PCA)
              </label>
              <select
                value={dfdPrioridade}
                onChange={(e) => setDfdPrioridade(e.target.value as 'Baixo' | 'Médio' | 'Alto')}
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium"
              >
                <option value="Baixo">Baixo</option>
                <option value="Médio">Médio</option>
                <option value="Alto">Alto (Requer justificativa)</option>
              </select>
            </div>
          </div>
        )}

        {piece.agent_number === 3 && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/80 p-3.5">
            <label className="block text-[11px] font-bold text-[#071D41] mb-1">
              Parâmetros de Pesquisa de Mercado (Art. 23 — Opcional para ETP)
            </label>
            <textarea
              rows={2}
              value={etpPesquisaMercado}
              onChange={(e) => setEtpPesquisaMercado(e.target.value)}
              placeholder="Ex.: Painel de Preços PNCP nº 123/2026, atas vigentes, cotações diretas com 3 fornecedores..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium focus:border-[#1351B4] focus:outline-none"
            />
          </div>
        )}

        {piece.agent_number === 10 && (
          <TcuJurisprudencePanel bundle={bundle} onBundleUpdated={onBundleUpdated} />
        )}

        {/* FOLHA DOCUMENTAL: CABEÇALHO AO VIVO + EDITOR RICO */}
        <div className="max-w-4xl mx-auto">
          <InstitutionalHeader
            institution={bundle.institution}
            process={bundle.process}
            secretario={bundle.secretario}
            dotacao={bundle.dotacao}
            dotacoesVinculadas={bundle.dotacoes_vinculadas}
            onEditCertame={onOpenCertameConfig}
          />

          {piece.status === 'DISPENSADO' ? (
            <div className="bg-white border-x border-b border-slate-200 rounded-b-xl p-10 text-center space-y-3">
              <div className="text-sm font-bold text-slate-700">
                Agente 08 — Minuta da Ata de Registro de Preços (Dispensado)
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Este certame não utiliza o Sistema de Registro de Preços (SRP). Caso deseje ativar a ARP, habilite a opção <strong>SRP (Art. 82)</strong> em <em>Dados do Certame</em>.
              </p>
            </div>
          ) : !hasContent ? (
            <div className="bg-white border-x border-b border-slate-200 rounded-b-xl p-12 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-blue-50 text-[#1351B4] mx-auto flex items-center justify-center">
                <Sparkles className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-[#071D41]">{def.title}</h3>
                <p className="text-xs text-slate-600 mt-1 max-w-lg mx-auto">{def.description}</p>
              </div>
              <div className="text-[11px] text-slate-500">
                <strong>Inputs Encadeados:</strong> {def.requiredInputs.join(' • ')}
              </div>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => handleRunAgent()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-bold shadow-sm cursor-pointer"
              >
                {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {isRunning ? 'Gerando Peça Jurídica...' : 'Executar Agente Autônomo Agora'}
              </button>
            </div>
          ) : (
            <RichDocumentEditor
              htmlContent={draftHtml}
              editable={editMode}
              isDirty={isDirty}
              saving={savingEdit}
              onChange={(html) => {
                setDraftHtml(html);
                setIsDirty(true);
              }}
              onSave={handleSaveManualEdit}
            />
          )}
        </div>
      </div>

      {/* PAINEL DIREITO: COPILOTO / AUDITORIA */}
      <RightCopilotPanel
        piece={piece}
        validationAlerts={bundle.validation_alerts}
        versions={versions}
        auditLogs={bundle.audit_logs}
        running={isRunning}
        hasNextAgent={Boolean(nextActivePiece)}
        nextAgentLabel={nextActivePiece ? `Ag. ${String(nextActivePiece.agent_number).padStart(2, '0')}` : undefined}
        feedbackText={feedbackText}
        onFeedbackChange={setFeedbackText}
        onRegenerateWithFeedback={() =>
          handleRunAgent(feedbackText.trim() || 'Aprimorar fundamentação técnica e clareza administrativa')
        }
        onApproveAndAdvance={() => handleOpenSign(true)}
        onRestoreVersion={handleRestoreVersion}
      />

      {/* MODAL DE ASSINATURA E REGISTRO NO LOG */}
      {showSignModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmApprove}
            className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-md p-5 space-y-4"
          >
            <h3 className="text-sm font-bold text-[#071D41]">
              Aprovar e Assinar Peça (Registro em Trilha de Auditoria)
            </h3>
            <p className="text-xs text-slate-600">
              Confirme o responsável pela aprovação desta peça ({def.shortName}). O sistema registrará timestamp, versão e hash SHA-256 de integridade.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nome do Signatário</label>
                <input
                  required
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Cargo / Função</label>
                <input
                  required
                  value={signerRole}
                  onChange={(e) => setSignerRole(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowSignModal(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#168821] hover:bg-[#126E1B] text-white cursor-pointer"
              >
                Confirmar Assinatura{signActionAdvance && nextActivePiece ? ' & Avançar' : ''}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
