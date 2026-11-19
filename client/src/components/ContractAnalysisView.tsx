import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardCopy,
  FileCheck2,
  FileDown,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  History,
  Info,
  Loader2,
  RefreshCw,
  Scale,
  ShieldAlert,
  Sparkles,
  Trash2,
  UploadCloud
} from 'lucide-react';
import type {
  ContractAnalysisRecord,
  ContractChecklistStatus,
  ContractSourceFormat,
  Institution
} from '@shared/types';
import { formatDateTimeBR } from '@shared/labels';
import { api, type ProcessListItem } from '../api/client';

interface Props {
  activeInstitution: Institution | null;
  processes: ProcessListItem[];
}

type InputMode = 'upload' | 'text' | 'process';
type ReportTab = 'checklist' | 'risks' | 'metadata' | 'document';

const SAMPLE_CONTRACT_TEXT = `CONTRATO ADMINISTRATIVO Nº 042/2026
PROCESSO LICITATÓRIO Nº 018/2026 — PREGÃO ELETRÔNICO Nº 018/2026

Pelo presente instrumento administrativo, o MUNICÍPIO DE HORIZONTE AZUL, inscrito no CNPJ nº 18.349.894/0001-95, representado pelo Secretário Municipal de Administração, celebra contrato com a empresa BETA SERVIÇOS E TECNOLOGIA LTDA, CNPJ nº 12.345.678/0001-90, aplicando-se subsidiariamente a Lei nº 8.666/1993 e a Lei nº 14.133/2021.

CLÁUSULA PRIMEIRA – DO OBJETO
O presente contrato tem por objeto a prestação de serviços contínuos de suporte técnico e manutenção de estações de trabalho para as unidades escolares, conforme especificações do Termo de Referência.

CLÁUSULA SEGUNDA – DA VIGÊNCIA
O prazo de vigência será de 12 (doze) meses contados da assinatura do contrato.

CLÁUSULA TERCEIRA – DO VALOR E PAGAMENTO
O valor global estimado do contrato é de R$ 180.000,00 (cento e oitenta mil reais), pago em até 30 dias mediante apresentação de nota fiscal.

CLÁUSULA QUARTA – DO REAJUSTE
Os preços poderão ser reajustados após 12 (doze) meses da assinatura do contrato pelo índice IPCA/IBGE.

CLÁUSULA QUINTA – DAS SANÇÕES
O descumprimento contratual sujeitará a contratada à multa compensatória de 40% (quarenta por cento) sobre o valor total do contrato, além de impedimento de licitar.

CLÁUSULA SEXTA – DA DOTAÇÃO ORÇAMENTÁRIA
As despesas correrão à conta da dotação 02.04.01.12.361.0004.2015.3.3.90.39.00 — Fonte 1500.

CLÁUSULA SÉTIMA – DO FORO
Fica eleito o Foro da Comarca da sede da Contratada para dirimir dúvidas oriundas deste ajuste.`;

function verdictBadge(verdict: ContractAnalysisRecord['verdict']) {
  switch (verdict) {
    case 'APROVADO':
      return {
        label: 'Aprovado (Conforme Art. 92)',
        cls: 'bg-emerald-100 text-emerald-800 border-emerald-200',
        Icon: CheckCircle2
      };
    case 'APROVADO_COM_RESSALVAS':
      return {
        label: 'Aprovado com Ressalvas',
        cls: 'bg-amber-100 text-amber-800 border-amber-200',
        Icon: AlertTriangle
      };
    case 'REPROVADO_SANEAMENTO':
      return {
        label: 'Reprovado p/ Saneamento',
        cls: 'bg-rose-100 text-rose-800 border-rose-200',
        Icon: AlertCircle
      };
  }
}

function statusPill(status: ContractChecklistStatus) {
  switch (status) {
    case 'CONFORME':
      return { label: 'Conforme', cls: 'bg-emerald-100 text-emerald-800' };
    case 'RESSALVA':
      return { label: 'Ressalva', cls: 'bg-amber-100 text-amber-800' };
    case 'NAO_CONFORME':
      return { label: 'Não Conforme', cls: 'bg-rose-100 text-rose-800' };
  }
}

export const ContractAnalysisView: React.FC<Props> = ({ activeInstitution, processes }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [analyses, setAnalyses] = useState<ContractAnalysisRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [selected, setSelected] = useState<ContractAnalysisRecord | null>(null);

  const [inputMode, setInputMode] = useState<InputMode>('upload');
  const [titleDraft, setTitleDraft] = useState('');
  const [focusDraft, setFocusDraft] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [extractedFilename, setExtractedFilename] = useState('');
  const [extractedFormat, setExtractedFormat] = useState<ContractSourceFormat>('TXT');
  const [extractDiagnostics, setExtractDiagnostics] = useState<string[]>([]);
  const [selectedProcessId, setSelectedProcessId] = useState<string>('');
  const [selectedProcessAgent, setSelectedProcessAgent] = useState<number>(7);

  const [extracting, setExtracting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [exporting, setExporting] = useState<'docx' | 'pdf' | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [reportTab, setReportTab] = useState<ReportTab>('checklist');
  const [checklistFilter, setChecklistFilter] = useState<'ALL' | ContractChecklistStatus>('ALL');
  const [copiedClauseIdx, setCopiedClauseIdx] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  const loadHistory = useCallback(async (selectId?: string) => {
    setLoadingHistory(true);
    try {
      const list = await api.listContractAnalyses();
      setAnalyses(list);
      if (selectId) {
        const match = list.find((a) => a.id === selectId);
        if (match) setSelected(match);
      } else if (list.length > 0) {
        setSelected((prev) => (prev ? list.find((a) => a.id === prev.id) || list[0] : list[0]));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Falha ao carregar histórico de análises contratuais.');
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!selectedProcessId && processes.length > 0) {
      setSelectedProcessId(processes[0].id);
    }
  }, [processes, selectedProcessId]);

  const handleFilePicked = async (file: File | null | undefined) => {
    if (!file) return;
    setErrorMsg('');
    setInfoMsg('');
    setSelectedFile(file);
    setExtracting(true);
    try {
      const preview = await api.extractContractFile(file);
      setTextDraft(preview.extracted_text);
      setExtractedFilename(preview.filename);
      setExtractedFormat(preview.format);
      setExtractDiagnostics(preview.diagnostics || []);
      if (!titleDraft.trim()) {
        setTitleDraft(`Análise — ${file.name.replace(/\.[^.]+$/, '')}`);
      }
      setInfoMsg(
        `Arquivo "${preview.filename}" (${preview.format}) lido com sucesso: ${preview.char_count.toLocaleString('pt-BR')} caracteres extraídos.`
      );
    } catch (err: any) {
      setExtractDiagnostics([]);
      setErrorMsg(err?.message || 'Falha ao ler o arquivo do contrato.');
    } finally {
      setExtracting(false);
    }
  };

  const handleRunAnalysis = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    setAnalyzing(true);
    try {
      let result: ContractAnalysisRecord;
      if (inputMode === 'process') {
        if (!selectedProcessId) {
          throw new Error('Selecione um processo do GOVFLOW para importar a minuta contratual.');
        }
        result = await api.analyzeContractPayload({
          title: titleDraft.trim() || undefined,
          analysis_focus: focusDraft.trim() || undefined,
          institution_id: activeInstitution?.id,
          process_id: selectedProcessId,
          agent_number: selectedProcessAgent
        });
      } else if (inputMode === 'upload' && selectedFile && !textDraft.trim()) {
        result = await api.analyzeContractFile({
          file: selectedFile,
          title: titleDraft.trim() || undefined,
          analysis_focus: focusDraft.trim() || undefined,
          institution_id: activeInstitution?.id
        });
      } else {
        if (textDraft.trim().length < 40) {
          throw new Error(
            'Envie um arquivo de contrato (.pdf, .docx, .txt) ou cole pelo menos 40 caracteres do instrumento contratual.'
          );
        }
        result = await api.analyzeContractPayload({
          title: titleDraft.trim() || undefined,
          contract_text: textDraft.trim(),
          analysis_focus: focusDraft.trim() || undefined,
          institution_id: activeInstitution?.id,
          source_filename: extractedFilename || undefined,
          source_format: extractedFilename ? extractedFormat : 'TXT'
        });
      }

      setAnalyses((prev) => [result, ...prev.filter((a) => a.id !== result.id)]);
      setSelected(result);
      setReportTab('checklist');
      setChecklistFilter('ALL');
      setInfoMsg(
        `Análise "${result.title}" concluída (${result.compliance_score}% de conformidade Art. 92).`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao executar análise de contrato.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleReanalyzeSelected = async () => {
    if (!selected) return;
    setErrorMsg('');
    setInfoMsg('');
    setReanalyzing(true);
    try {
      const updated = await api.reanalyzeContract(selected.id, {
        analysis_focus: focusDraft.trim() || selected.analysis_focus
      });
      setAnalyses((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setSelected(updated);
      setInfoMsg(`Análise "${updated.title}" atualizada (${updated.compliance_score}%).`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Falha ao reanalisar contrato.');
    } finally {
      setReanalyzing(false);
    }
  };

  const handleDeleteAnalysis = async (id: string) => {
    setErrorMsg('');
    try {
      await api.deleteContractAnalysis(id);
      setAnalyses((prev) => {
        const next = prev.filter((a) => a.id !== id);
        if (selected?.id === id) {
          setSelected(next[0] || null);
        }
        return next;
      });
      setInfoMsg('Análise contratual removida do histórico.');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao excluir análise contratual.');
    }
  };

  const handleExport = async (fmt: 'docx' | 'pdf') => {
    if (!selected) return;
    setErrorMsg('');
    setExporting(fmt);
    try {
      const safeName = selected.title.replace(/[^\w\d_-]+/g, '_').slice(0, 48);
      const downloaded = await api.downloadExportFile(
        `/api/contracts/analyses/${selected.id}/export/${fmt}`,
        `Analise_Contrato_${safeName}.${fmt}`
      );
      setInfoMsg(`Relatório "${downloaded}" exportado com sucesso.`);
    } catch (err: any) {
      setErrorMsg(err?.message || `Falha ao exportar análise em ${fmt.toUpperCase()}.`);
    } finally {
      setExporting(null);
    }
  };

  const copySuggestedClause = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedClauseIdx(idx);
      setTimeout(() => setCopiedClauseIdx(null), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const filteredChecklist =
    selected?.checklist_art92.filter((item) =>
      checklistFilter === 'ALL' ? true : item.status === checklistFilter
    ) || [];

  const conformeCount = selected?.checklist_art92.filter((c) => c.status === 'CONFORME').length || 0;
  const ressalvaCount = selected?.checklist_art92.filter((c) => c.status === 'RESSALVA').length || 0;
  const naoConformeCount = selected?.checklist_art92.filter((c) => c.status === 'NAO_CONFORME').length || 0;
  const criticalCount = selected?.risk_findings.filter((r) => r.severity === 'critical').length || 0;

  return (
    <div className="flex-1 p-5 md:p-7 max-w-[1500px] mx-auto w-full space-y-5">
      {/* Header Institucional */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#071D41] text-white flex items-center justify-center shrink-0 shadow-xs">
            <FileCheck2 className="w-6 h-6 text-emerald-300" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-[#071D41]">
                Análise de Contratos Administrativos
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-[#1351B4]">
                Lei nº 14.133/2021 • Art. 92 &amp; TCU
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-0.5">
              Envie um contrato ou minuta em <strong>PDF, Word (.docx/.doc) ou Texto</strong>, ou importe uma peça do GOVFLOW para auditar cláusulas obrigatórias, prazos, reajuste, penalidades e riscos jurídicos.
            </p>
          </div>
        </div>
        {activeInstitution && (
          <div className="text-right text-[11px] bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2">
            <div className="font-bold text-[#071D41]">{activeInstitution.razao_social}</div>
            <div className="text-slate-500">
              Foro de referência: {activeInstitution.municipio}/{activeInstitution.uf}
            </div>
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {infoMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
          <span>{infoMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* COLUNA ESQUERDA: SUBMISSÃO + HISTÓRICO */}
        <div className="xl:col-span-4 space-y-5">
          <form
            onSubmit={handleRunAnalysis}
            className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden"
          >
            <div className="px-4 py-3 bg-[#071D41] text-white flex items-center justify-between">
              <div className="text-xs font-bold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-300" />
                Submeter Contrato para Auditoria
              </div>
            </div>

            <div className="p-4 space-y-3.5">
              {/* Seletor de Modo */}
              <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-lg text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setInputMode('upload')}
                  className={`py-1.5 px-2 rounded-md transition-colors cursor-pointer ${
                    inputMode === 'upload'
                      ? 'bg-white text-[#071D41] shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Upload Arquivo
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('text')}
                  className={`py-1.5 px-2 rounded-md transition-colors cursor-pointer ${
                    inputMode === 'text'
                      ? 'bg-white text-[#071D41] shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Colar Texto
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('process')}
                  className={`py-1.5 px-2 rounded-md transition-colors cursor-pointer ${
                    inputMode === 'process'
                      ? 'bg-white text-[#071D41] shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Processo GOVFLOW
                </button>
              </div>

              {inputMode === 'upload' && (
                <div className="space-y-2.5">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      handleFilePicked(e.dataTransfer.files?.[0]);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={`rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-colors ${
                      dragOver
                        ? 'border-[#1351B4] bg-blue-50'
                        : 'border-slate-300 hover:border-[#1351B4] bg-slate-50/70'
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.doc,.txt,.md,.html,.htm,.rtf"
                      className="hidden"
                      onChange={(e) => {
                        handleFilePicked(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                    {extracting ? (
                      <div className="flex flex-col items-center gap-1.5 text-xs text-[#1351B4] font-semibold">
                        <Loader2 className="w-6 h-6 animate-spin" />
                        Extraindo cláusulas e texto do contrato...
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1.5">
                        <UploadCloud className="w-7 h-7 text-[#1351B4]" />
                        <div className="text-xs font-bold text-[#071D41]">
                          {selectedFile ? selectedFile.name : 'Clique ou arraste o Contrato aqui'}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Aceita <strong>PDF</strong> (.pdf), <strong>Word</strong> (.docx / .doc) e <strong>Texto</strong> (.txt / .rtf / .html)
                        </div>
                      </div>
                    )}
                  </div>

                  {extractDiagnostics.length > 0 && (
                    <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-[11px] text-[#071D41]">
                      {extractDiagnostics.map((d, i) => (
                        <div key={i}>• {d}</div>
                      ))}
                    </div>
                  )}

                  {textDraft && (
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">
                        Texto Extraído (editável antes de auditar)
                      </label>
                      <textarea
                        rows={5}
                        value={textDraft}
                        onChange={(e) => setTextDraft(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-[11px] font-mono leading-relaxed focus:border-[#1351B4] focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              )}

              {inputMode === 'text' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-bold text-[#071D41]">
                      Texto Integral ou Trecho do Contrato
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setTextDraft(SAMPLE_CONTRACT_TEXT);
                        setExtractedFilename('');
                        if (!titleDraft.trim()) {
                          setTitleDraft('Contrato de Teste nº 042/2026 — Exemplo c/ Falhas');
                        }
                      }}
                      className="text-[11px] font-semibold text-[#1351B4] hover:underline cursor-pointer"
                    >
                      Carregar Exemplo p/ Teste
                    </button>
                  </div>
                  <textarea
                    rows={8}
                    value={textDraft}
                    onChange={(e) => {
                      setTextDraft(e.target.value);
                      if (extractedFilename) setExtractedFilename('');
                    }}
                    placeholder="Cole aqui as cláusulas, preâmbulo e condições do contrato ou minuta para auditoria..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs leading-relaxed focus:border-[#1351B4] focus:outline-none"
                  />
                </div>
              )}

              {inputMode === 'process' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                      Selecionar Processo Licitatório
                    </label>
                    <select
                      value={selectedProcessId}
                      onChange={(e) => setSelectedProcessId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs bg-white focus:border-[#1351B4] focus:outline-none"
                    >
                      {processes.length === 0 && <option value="">Nenhum processo cadastrado</option>}
                      {processes.map((p) => (
                        <option key={p.id} value={p.id}>
                          Lic. {p.numero_processo_licitatorio} — {p.titulo_resumido.slice(0, 50)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                      Peça Contratual do Processo
                    </label>
                    <select
                      value={selectedProcessAgent}
                      onChange={(e) => setSelectedProcessAgent(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs bg-white focus:border-[#1351B4] focus:outline-none"
                    >
                      <option value={7}>Agente 07 — Minuta do Contrato Administrativo</option>
                      <option value={8}>Agente 08 — Minuta da Ata de Registro de Preços (ARP)</option>
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                  Título / Identificação da Análise (opcional)
                </label>
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder="Ex.: Contrato nº 045/2026 — Transporte Escolar"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#071D41] mb-1">
                  Foco Jurídico Específico (opcional)
                </label>
                <input
                  type="text"
                  value={focusDraft}
                  onChange={(e) => setFocusDraft(e.target.value)}
                  placeholder="Ex.: Verificar reajuste, reserva PcD, penalidades e PNCP"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={analyzing || extracting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#1351B4] hover:bg-[#071D41] disabled:opacity-50 text-white text-xs font-bold shadow-sm cursor-pointer"
              >
                {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck2 className="w-4 h-4" />}
                {analyzing ? 'Auditando Cláusulas (Lei 14.133)...' : 'Executar Análise de Contrato'}
              </button>
            </div>
          </form>

          {/* Histórico de Análises Salvas */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="text-xs font-bold text-[#071D41] flex items-center gap-2">
                <History className="w-4 h-4 text-[#1351B4]" />
                Histórico de Contratos Auditados ({analyses.length})
              </div>
            </div>

            {loadingHistory ? (
              <div className="p-6 text-center text-xs text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
                Carregando análises...
              </div>
            ) : analyses.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                Nenhuma análise salva ainda. Envie um PDF, Word ou cole um contrato acima para iniciar.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 max-h-[380px] overflow-y-auto">
                {analyses.map((item) => {
                  const vb = verdictBadge(item.verdict);
                  const active = selected?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelected(item)}
                      className={`p-3 cursor-pointer transition-colors flex items-start justify-between gap-2 ${
                        active ? 'bg-blue-50/90 border-l-4 border-l-[#1351B4]' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="text-xs font-bold text-[#071D41] truncate">{item.title}</div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                          <span className={`px-1.5 py-0.5 rounded border font-bold ${vb.cls}`}>
                            {item.compliance_score}%
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">
                            {item.source_format || 'TXT'}
                          </span>
                          <span className="text-slate-400">{formatDateTimeBR(item.updated_at)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        title="Excluir análise"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handleDeleteAnalysis(item.id);
                        }}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* COLUNA DIREITA: RESULTADO DA AUDITORIA */}
        <div className="xl:col-span-8 space-y-4">
          {!selected ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-3 shadow-xs">
              <div className="w-14 h-14 rounded-2xl bg-blue-50 text-[#1351B4] mx-auto flex items-center justify-center">
                <FolderOpen className="w-7 h-7" />
              </div>
              <h2 className="text-base font-bold text-[#071D41]">
                Pronto para auditar contratos sob a Lei nº 14.133/2021
              </h2>
              <p className="text-xs text-slate-600 max-w-lg mx-auto leading-relaxed">
                Faça o upload de um arquivo <strong>.pdf</strong> ou <strong>.docx</strong>, cole o texto do contrato ou importe a minuta de um processo para receber o checklist completo do <strong>Art. 92</strong>, alertas de nulidade (ex.: citação da Lei 8.666/93, multa acima de 30%, ausência de reserva PcD ou data-base de reajuste) e cláusulas corretivas prontas.
              </p>
            </div>
          ) : (
            <>
              {/* Summary & Export Card */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-bold text-[#071D41]">{selected.title}</h2>
                      {(() => {
                        const vb = verdictBadge(selected.verdict);
                        const VIcon = vb.Icon;
                        return (
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${vb.cls}`}>
                            <VIcon className="w-3.5 h-3.5" />
                            {vb.label}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="text-[11px] text-slate-500 flex flex-wrap gap-3">
                      <span>Motor: <strong>{selected.ai_provider_used}</strong></span>
                      {selected.source_filename && (
                        <span>Origem: <strong>{selected.source_filename}</strong></span>
                      )}
                      <span>Atualizado em {formatDateTimeBR(selected.updated_at)}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={reanalyzing}
                      onClick={handleReanalyzeSelected}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:border-[#1351B4] text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${reanalyzing ? 'animate-spin' : ''}`} />
                      Reanalisar
                    </button>
                    <button
                      type="button"
                      disabled={exporting !== null}
                      onClick={() => handleExport('docx')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {exporting === 'docx' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                      Word (.docx)
                    </button>
                    <button
                      type="button"
                      disabled={exporting !== null}
                      onClick={() => handleExport('pdf')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#071D41] hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {exporting === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                      PDF (.pdf)
                    </button>
                  </div>
                </div>

                <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-xl p-3 leading-relaxed">
                  {selected.summary}
                </p>

                {/* KPI Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3">
                    <div className="text-[10px] font-bold uppercase text-slate-500">Conformidade</div>
                    <div className="text-xl font-extrabold text-[#1351B4]">{selected.compliance_score}%</div>
                  </div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                    <div className="text-[10px] font-bold uppercase text-slate-500">Conformes</div>
                    <div className="text-xl font-extrabold text-emerald-700">{conformeCount}</div>
                  </div>
                  <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                    <div className="text-[10px] font-bold uppercase text-slate-500">Ressalvas</div>
                    <div className="text-xl font-extrabold text-amber-700">{ressalvaCount}</div>
                  </div>
                  <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
                    <div className="text-[10px] font-bold uppercase text-slate-500">Não Conformes</div>
                    <div className="text-xl font-extrabold text-rose-700">{naoConformeCount}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 col-span-2 sm:col-span-1">
                    <div className="text-[10px] font-bold uppercase text-slate-500">Riscos Críticos</div>
                    <div className="text-xl font-extrabold text-rose-800">{criticalCount}</div>
                  </div>
                </div>
              </div>

              {/* Abas de Detalhamento */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                <div className="px-4 pt-3 border-b border-slate-200 flex flex-wrap gap-1 bg-slate-50">
                  {[
                    { id: 'checklist', label: `Checklist Art. 92 (${selected.checklist_art92.length})` },
                    { id: 'risks', label: `Riscos & Cláusulas (${selected.risk_findings.length} / ${selected.suggested_clauses.length})` },
                    { id: 'metadata', label: 'Metadados & Jurisprudência TCU' },
                    { id: 'document', label: 'Parecer Consolidado & Texto' }
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setReportTab(tab.id as ReportTab)}
                      className={`px-3.5 py-2 text-xs font-bold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
                        reportTab === tab.id
                          ? 'bg-white text-[#1351B4] border-[#1351B4]'
                          : 'text-slate-600 border-transparent hover:text-[#071D41]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="p-5">
                  {reportTab === 'checklist' && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-bold text-[#071D41]">
                          Conferência dos Requisitos Obrigatórios (Art. 92 e Correlatos)
                        </div>
                        <div className="flex flex-wrap gap-1 text-[11px]">
                          {(['ALL', 'NAO_CONFORME', 'RESSALVA', 'CONFORME'] as const).map((st) => (
                            <button
                              key={st}
                              type="button"
                              onClick={() => setChecklistFilter(st)}
                              className={`px-2.5 py-1 rounded-full font-semibold border cursor-pointer ${
                                checklistFilter === st
                                  ? 'bg-[#071D41] text-white border-[#071D41]'
                                  : 'bg-white text-slate-600 border-slate-300 hover:border-[#1351B4]'
                              }`}
                            >
                              {st === 'ALL'
                                ? 'Todos'
                                : st === 'NAO_CONFORME'
                                  ? `Não Conformes (${naoConformeCount})`
                                  : st === 'RESSALVA'
                                    ? `Ressalvas (${ressalvaCount})`
                                    : `Conformes (${conformeCount})`}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="overflow-x-auto border border-slate-200 rounded-xl">
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-[#071D41] text-white">
                            <tr>
                              <th className="p-2.5 w-36">Base Legal</th>
                              <th className="p-2.5 w-52">Requisito</th>
                              <th className="p-2.5 w-32">Status</th>
                              <th className="p-2.5">Análise e Recomendação</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200">
                            {filteredChecklist.map((c) => {
                              const pill = statusPill(c.status);
                              return (
                                <tr key={c.id} className="hover:bg-slate-50/80">
                                  <td className="p-2.5 font-bold text-[#071D41] align-top">{c.inciso}</td>
                                  <td className="p-2.5 font-semibold text-slate-800 align-top">{c.item}</td>
                                  <td className="p-2.5 align-top">
                                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${pill.cls}`}>
                                      {pill.label}
                                    </span>
                                  </td>
                                  <td className="p-2.5 text-slate-700 align-top space-y-1">
                                    <div>{c.observacao}</div>
                                    {c.recomendacao && (
                                      <div className="text-[11px] font-semibold text-[#1351B4]">
                                        Providência: {c.recomendacao}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {reportTab === 'risks' && (
                    <div className="space-y-6">
                      <div className="space-y-3">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-[#071D41] flex items-center gap-1.5">
                          <ShieldAlert className="w-4 h-4 text-rose-600" />
                          Alertas e Riscos Jurídicos Detectados ({selected.risk_findings.length})
                        </h3>
                        {selected.risk_findings.length === 0 ? (
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">
                            Nenhum risco crítico ou moderado identificado no texto analisado.
                          </div>
                        ) : (
                          <div className="space-y-2.5">
                            {selected.risk_findings.map((r) => {
                              const cls =
                                r.severity === 'critical'
                                  ? 'bg-rose-50 border-rose-200 text-rose-900'
                                  : r.severity === 'warning'
                                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                                    : 'bg-blue-50 border-blue-200 text-slate-800';
                              const Icon =
                                r.severity === 'critical'
                                  ? AlertCircle
                                  : r.severity === 'warning'
                                    ? AlertTriangle
                                    : Info;
                              return (
                                <div key={r.id} className={`rounded-xl border p-3.5 text-xs space-y-1 ${cls}`}>
                                  <div className="flex items-start gap-2">
                                    <Icon className="w-4 h-4 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                      <div className="text-[10px] font-bold uppercase opacity-80">
                                        {r.categoria} • {r.artigo}
                                      </div>
                                      <div className="font-bold">{r.titulo}</div>
                                      <p className="leading-relaxed">{r.descricao}</p>
                                      <p className="font-semibold">Recomendação: {r.recomendacao}</p>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-[#071D41] flex items-center gap-1.5">
                          <FileSpreadsheet className="w-4 h-4 text-[#1351B4]" />
                          Cláusulas Corretivas Prontas para Inserção ({selected.suggested_clauses.length})
                        </h3>
                        {selected.suggested_clauses.length === 0 ? (
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">
                            Estrutura contratual completa — não há lacunas exigindo cláusula corretiva.
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {selected.suggested_clauses.map((sc, idx) => (
                              <div key={idx} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <div className="text-xs font-bold text-[#071D41]">{sc.clausula}</div>
                                    <div className="text-[11px] text-slate-500">{sc.artigo} • {sc.motivo}</div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => copySuggestedClause(idx, sc.texto_sugerido)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-blue-300 bg-white hover:bg-blue-50 text-[11px] font-bold text-[#1351B4] cursor-pointer"
                                  >
                                    {copiedClauseIdx === idx ? (
                                      <>
                                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                                        Copiada!
                                      </>
                                    ) : (
                                      <>
                                        <ClipboardCopy className="w-3.5 h-3.5" />
                                        Copiar Cláusula
                                      </>
                                    )}
                                  </button>
                                </div>
                                <div className="rounded-lg bg-white border border-slate-200 p-3 text-xs text-slate-800 leading-relaxed">
                                  {sc.texto_sugerido}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {reportTab === 'metadata' && (
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-[#071D41] mb-2">
                          Dados Extraídos do Instrumento Contratual
                        </h3>
                        <div className="overflow-x-auto border border-slate-200 rounded-xl">
                          <table className="w-full text-xs border-collapse">
                            <tbody className="divide-y divide-slate-200">
                              {[
                                ['Número do Contrato', selected.extracted_metadata.numero_contrato || 'Não especificado'],
                                ['Processo Referenciado', selected.extracted_metadata.processo_referencia || 'Não especificado'],
                                ['Regime Legal Detectado', selected.extracted_metadata.regime_legal_detectado],
                                ['Objeto Contratual', selected.extracted_metadata.objeto || 'Consultar cláusula de objeto'],
                                ['Contratante / CNPJ', `${selected.extracted_metadata.contratante || '—'} (${selected.extracted_metadata.cnpj_contratante || 'CNPJ não localizado'})`],
                                ['Representante Signatário', `${selected.extracted_metadata.representante_contratante || 'Não identificado'} ${selected.extracted_metadata.representante_cargo ? `(${selected.extracted_metadata.representante_cargo})` : ''}`],
                                ['Contratada / CNPJ', `${selected.extracted_metadata.contratada || 'Em aberto'} (${selected.extracted_metadata.cnpj_contratada || 'CNPJ não localizado'})`],
                                ['Valor Global', selected.extracted_metadata.valor_global || 'Não identificado'],
                                ['Vigência / Duração', selected.extracted_metadata.vigencia_prazo || 'Não identificada'],
                                ['Índice de Reajuste / Data-Base', `${selected.extracted_metadata.indice_reajuste || 'Não identificado'} ${selected.extracted_metadata.data_base_orcamento ? `(${selected.extracted_metadata.data_base_orcamento})` : ''}`],
                                ['Garantia de Execução', selected.extracted_metadata.garantia_contratual || 'Sem previsão destacada'],
                                ['Foro Eleito', selected.extracted_metadata.foro || 'Não identificado']
                              ].map(([label, val]) => (
                                <tr key={label}>
                                  <td className="p-2.5 w-56 bg-slate-50 font-bold text-[#071D41]">{label}</td>
                                  <td className="p-2.5 text-slate-800">{val}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-[#071D41] mb-2 flex items-center gap-1.5">
                          <Scale className="w-4 h-4 text-[#1351B4]" />
                          Precedentes Aplicáveis do TCU ({selected.tcu_precedents.length})
                        </h3>
                        <div className="space-y-2">
                          {selected.tcu_precedents.map((p) => (
                            <div key={p.id} className="rounded-xl border border-slate-200 p-3 text-xs space-y-1 bg-slate-50/50">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-bold text-[#071D41]">{p.numero} ({p.colegiado})</span>
                                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">
                                  {p.tema_label}
                                </span>
                              </div>
                              <div className="text-[11px] font-semibold text-[#1351B4]">{p.artigos_relacionados}</div>
                              <p className="text-slate-700 leading-relaxed">{p.ementa}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {reportTab === 'document' && (
                    <div className="space-y-5">
                      <div
                        className="gov-doc-paper border border-slate-200 rounded-xl p-6 bg-white"
                        dangerouslySetInnerHTML={{ __html: selected.report_html }}
                      />
                      <details className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                        <summary className="text-xs font-bold text-[#071D41] cursor-pointer">
                          Visualizar Texto Integral Extraído do Contrato ({selected.contract_text.length.toLocaleString('pt-BR')} caracteres)
                        </summary>
                        <pre className="mt-3 whitespace-pre-wrap text-[11px] font-mono text-slate-700 bg-white border border-slate-200 rounded-lg p-3 max-h-96 overflow-y-auto">
                          {selected.contract_text}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
