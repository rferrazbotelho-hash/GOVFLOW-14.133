import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckSquare, Loader2, Plus, Scale, Sparkles, Trash2, X } from 'lucide-react';
import type {
  CriterioJulgamento,
  Dotacao,
  FormatoLance,
  ModalidadeLicitacao,
  ModoDisputa,
  PesquisaPrecoItem,
  ProcurementProcess,
  Secretario,
  TipoContratacao
} from '@shared/types';
import {
  CRITERIO_JULGAMENTO_OPTIONS,
  FORMATO_LANCE_OPTIONS,
  MODALIDADE_OPTIONS,
  MODO_DISPUTA_OPTIONS,
  TIPO_CONTRATACAO_OPTIONS
} from '@shared/labels';
import { api } from '../api/client';
import { PriceResearchPanel } from './PriceResearchPanel';

interface Props {
  institutionId: string;
  existingProcess?: ProcurementProcess | null;
  onClose: () => void;
  onSaved: (processId: string) => Promise<void>;
}

function allowedCriteriaFor(mod: ModalidadeLicitacao): CriterioJulgamento[] {
  switch (mod) {
    case 'PREGAO_ELETRONICO':
    case 'PREGAO_PRESENCIAL':
      return ['MENOR_PRECO', 'MAIOR_DESCONTO'];
    case 'CONCORRENCIA_ELETRONICA':
    case 'CONCORRENCIA_PRESENCIAL':
      return ['MENOR_PRECO', 'MAIOR_DESCONTO', 'MELHOR_TECNICA', 'TECNICA_E_PRECO', 'MAIOR_RETORNO_ECONOMICO'];
    case 'CONCURSO':
      return ['MELHOR_TECNICA'];
    case 'LEILAO':
      return ['MAIOR_LANCE'];
    case 'DIALOGO_COMPETITIVO':
      return ['MENOR_PRECO', 'TECNICA_E_PRECO', 'MELHOR_TECNICA', 'MAIOR_RETORNO_ECONOMICO'];
    case 'DISPENSA':
    case 'INEXIGIBILIDADE':
      return ['MENOR_PRECO', 'MAIOR_DESCONTO', 'TECNICA_E_PRECO'];
  }
}

function allowedDisputeModesFor(mod: ModalidadeLicitacao, crit: CriterioJulgamento): ModoDisputa[] {
  if (mod === 'INEXIGIBILIDADE') return ['NAO_APLICAVEL'];
  if (mod === 'DISPENSA') return ['ABERTO', 'NAO_APLICAVEL'];
  if (mod === 'LEILAO') return ['ABERTO'];
  if (mod === 'CONCURSO') return ['FECHADO'];
  if (crit === 'MENOR_PRECO' || crit === 'MAIOR_DESCONTO') {
    return ['ABERTO', 'ABERTO_FECHADO', 'FECHADO_ABERTO'];
  }
  if (crit === 'TECNICA_E_PRECO') {
    return ['FECHADO', 'ABERTO_FECHADO', 'FECHADO_ABERTO'];
  }
  return ['ABERTO', 'FECHADO', 'ABERTO_FECHADO', 'FECHADO_ABERTO'];
}

export const CertameConfigModal: React.FC<Props> = ({
  institutionId,
  existingProcess,
  onClose,
  onSaved
}) => {
  const [secretarios, setSecretarios] = useState<Secretario[]>([]);
  const [dotacoes, setDotacoes] = useState<Dotacao[]>([]);

  const [form, setForm] = useState({
    numero_processo_licitatorio: existingProcess?.numero_processo_licitatorio || '046/2026',
    numero_processo_administrativo: existingProcess?.numero_processo_administrativo || '1.205/2026',
    titulo_resumido: existingProcess?.titulo_resumido || '',
    modalidade: (existingProcess?.modalidade || 'PREGAO_ELETRONICO') as ModalidadeLicitacao,
    tipo_contratacao: (existingProcess?.tipo_contratacao || 'AQUISICAO') as TipoContratacao,
    data_certame: existingProcess?.data_certame || '',
    horario_disputa: existingProcess?.horario_disputa || '',
    modo_disputa: (existingProcess?.modo_disputa || 'ABERTO_FECHADO') as ModoDisputa,
    criterio_julgamento: (existingProcess?.criterio_julgamento || 'MENOR_PRECO') as CriterioJulgamento,
    formato_lance: (existingProcess?.formato_lance || 'POR_ITEM') as FormatoLance,
    usar_srp: existingProcess?.usar_srp ?? false,
    secretario_id: existingProcess?.secretario_id || '',
    responsavel_requisitante: existingProcess?.responsavel_requisitante || '',
    cargo_requisitante: existingProcess?.cargo_requisitante || 'Diretor(a) / Coordenador(a) de Área',
    valor_estimado_global: String(existingProcess?.valor_estimado_global || 0),
    demanda_bruta: existingProcess?.demanda_bruta || ''
  });
  const [selectedDotacaoIds, setSelectedDotacaoIds] = useState<string[]>(() => {
    if (existingProcess?.dotacao_ids && existingProcess.dotacao_ids.length > 0) {
      return existingProcess.dotacao_ids;
    }
    return existingProcess?.dotacao_id ? [existingProcess.dotacao_id] : [];
  });
  const [manualDotacoes, setManualDotacoes] = useState<string[]>(
    () => existingProcess?.dotacoes_manuais || []
  );
  const [manualDotacaoInput, setManualDotacaoInput] = useState('');
  const [pesquisaArquivo, setPesquisaArquivo] = useState(existingProcess?.pesquisa_preco_arquivo || '');
  const [pesquisaResumo, setPesquisaResumo] = useState(existingProcess?.pesquisa_preco_resumo || '');
  const [pesquisaItens, setPesquisaItens] = useState<PesquisaPrecoItem[]>(
    existingProcess?.pesquisa_preco_itens || []
  );
  const submitRunAllRef = useRef(false);
  const [runningBatchAfterSave, setRunningBatchAfterSave] = useState(false);

  // Quick inline add Secretário / Dotação
  const [showQuickSec, setShowQuickSec] = useState(false);
  const [quickSec, setQuickSec] = useState({ secretaria: '', nome: '', portaria_nomeacao: '' });
  const [showQuickDot, setShowQuickDot] = useState(false);
  const [quickDot, setQuickDot] = useState({ unidade_orcamentaria: '', elemento_despesa: '', fonte_recurso: '1.500.000' });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getInstitutionDetail(institutionId).then((res) => {
      setSecretarios(res.secretarios);
      setDotacoes(res.dotacoes);
      setForm((prev) => ({
        ...prev,
        secretario_id: prev.secretario_id || res.secretarios[0]?.id || ''
      }));
      if (!existingProcess && res.dotacoes[0]?.id) {
        setSelectedDotacaoIds((prev) => (prev.length > 0 ? prev : [res.dotacoes[0].id]));
      }
    });
  }, [institutionId, existingProcess]);

  const validCriteria = allowedCriteriaFor(form.modalidade);
  const validModes = allowedDisputeModesFor(form.modalidade, form.criterio_julgamento);

  const handleModalidadeChange = (mod: ModalidadeLicitacao) => {
    const nextCriteria = allowedCriteriaFor(mod);
    const nextCrit = nextCriteria.includes(form.criterio_julgamento) ? form.criterio_julgamento : nextCriteria[0];
    const nextModes = allowedDisputeModesFor(mod, nextCrit);
    const nextMode = nextModes.includes(form.modo_disputa) ? form.modo_disputa : nextModes[0];
    const allowSrp = ['PREGAO_ELETRONICO', 'PREGAO_PRESENCIAL', 'CONCORRENCIA_ELETRONICA', 'CONCORRENCIA_PRESENCIAL', 'DISPENSA', 'INEXIGIBILIDADE'].includes(mod);

    setForm((prev) => ({
      ...prev,
      modalidade: mod,
      criterio_julgamento: nextCrit,
      modo_disputa: nextMode,
      usar_srp: allowSrp ? prev.usar_srp : false
    }));
  };

  const handleCriterioChange = (crit: CriterioJulgamento) => {
    const nextModes = allowedDisputeModesFor(form.modalidade, crit);
    const nextMode = nextModes.includes(form.modo_disputa) ? form.modo_disputa : nextModes[0];
    setForm((prev) => ({
      ...prev,
      criterio_julgamento: crit,
      modo_disputa: nextMode
    }));
  };

  const handleQuickAddSec = async () => {
    if (!quickSec.secretaria.trim() || !quickSec.nome.trim()) return;
    const created = await api.createSecretario(institutionId, {
      ...quickSec,
      cargo: 'Secretário(a) Municipal / Ordenador de Despesas',
      source: 'manual'
    });
    setSecretarios((prev) => [...prev, created]);
    setForm((prev) => ({ ...prev, secretario_id: created.id }));
    setShowQuickSec(false);
    setQuickSec({ secretaria: '', nome: '', portaria_nomeacao: '' });
  };

  const handleAddSelectedDotacao = (dotId: string) => {
    if (!dotId) return;
    setSelectedDotacaoIds((prev) => (prev.includes(dotId) ? prev : [...prev, dotId]));
  };

  const handleRemoveSelectedDotacao = (dotId: string) => {
    setSelectedDotacaoIds((prev) => prev.filter((id) => id !== dotId));
  };

  const handleAddManualDotacao = () => {
    const clean = manualDotacaoInput.trim();
    if (!clean) return;
    setManualDotacoes((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
    setManualDotacaoInput('');
  };

  const handleRemoveManualDotacao = (entry: string) => {
    setManualDotacoes((prev) => prev.filter((item) => item !== entry));
  };

  const handleQuickAddDot = async () => {
    if (!quickDot.unidade_orcamentaria.trim() || !quickDot.elemento_despesa.trim()) return;
    const created = await api.createDotacao(institutionId, {
      orgao: '02 - Poder Executivo',
      unidade_orcamentaria: quickDot.unidade_orcamentaria,
      funcao: '04',
      subfuncao: '122',
      programa: '0001',
      acao: '2.001',
      elemento_despesa: quickDot.elemento_despesa,
      fonte_recurso: quickDot.fonte_recurso,
      source: 'manual'
    });
    setDotacoes((prev) => [...prev, created]);
    setSelectedDotacaoIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
    setShowQuickDot(false);
    setQuickDot({ unidade_orcamentaria: '', elemento_despesa: '', fonte_recurso: '1.500.000' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const shouldElaborateAll = submitRunAllRef.current;
    submitRunAllRef.current = false;
    setSaving(true);
    setRunningBatchAfterSave(shouldElaborateAll);
    setError('');
    try {
      const itemsSum =
        Math.round(pesquisaItens.reduce((acc, it) => acc + (Number(it.valor_total) || 0), 0) * 100) / 100;
      const numericEstimativa = Number(form.valor_estimado_global || 0);
      const pendingManual = manualDotacaoInput.trim();
      const finalManualDotacoes = pendingManual
        ? Array.from(new Set([...manualDotacoes, pendingManual]))
        : manualDotacoes;

      const payload = {
        ...form,
        institution_id: institutionId,
        secretario_id: form.secretario_id || null,
        dotacao_id: selectedDotacaoIds[0] || null,
        dotacao_ids: selectedDotacaoIds,
        dotacoes_manuais: finalManualDotacoes,
        valor_estimado_global: itemsSum > 0 ? itemsSum : numericEstimativa,
        pesquisa_preco_arquivo: pesquisaArquivo || null,
        pesquisa_preco_resumo: pesquisaResumo || null,
        pesquisa_preco_itens: pesquisaItens
      };

      const bundle = existingProcess
        ? await api.updateProcess(existingProcess.id, payload)
        : await api.createProcess(payload);

      if (shouldElaborateAll) {
        await api.executeAllAgents(bundle.process.id, {
          actorName: form.responsavel_requisitante || undefined
        });
      }

      await onSaved(bundle.process.id);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
      setRunningBatchAfterSave(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-4xl my-8 overflow-hidden">
        <div className="px-6 py-4 bg-[#071D41] text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Scale className="w-5 h-5 text-blue-300" />
            <div>
              <h3 className="font-bold text-sm">
                {existingProcess ? 'Editar Dados do Certame (Cabeçalho do Processo)' : 'Novo Processo Licitatório — Dados do Certame'}
              </h3>
              <p className="text-[11px] text-blue-200">
                Alimenta a memória global compartilhada de todos os 11 agentes autônomos (Lei nº 14.133/2021).
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-300 hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          {/* Números Processuais e Objeto */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nº Processo Licitatório *
              </label>
              <input
                required
                value={form.numero_processo_licitatorio}
                onChange={(e) => setForm({ ...form, numero_processo_licitatorio: e.target.value })}
                placeholder="Ex: 045/2026"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nº Processo Administrativo *
              </label>
              <input
                required
                value={form.numero_processo_administrativo}
                onChange={(e) => setForm({ ...form, numero_processo_administrativo: e.target.value })}
                placeholder="Ex: 1.204/2026"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Estimativa Global Preliminar (R$)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.valor_estimado_global}
                onChange={(e) => setForm({ ...form, valor_estimado_global: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Título / Objeto Resumido do Certame *
            </label>
            <input
              required
              value={form.titulo_resumido}
              onChange={(e) => setForm({ ...form, titulo_resumido: e.target.value })}
              placeholder="Ex: Aquisição de medicamentos da atenção básica para atendimento das UBS municipais"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
          </div>

          {/* Upload de Pesquisa de Preço (PDF, Excel, Word) */}
          <PriceResearchPanel
            items={pesquisaItens}
            filename={pesquisaArquivo}
            resumo={pesquisaResumo}
            compact
            onParseFile={(file) => api.parsePriceResearch(file)}
            onChange={({ items, filename, resumo, valorTotal }) => {
              setPesquisaItens(items);
              setPesquisaArquivo(filename);
              setPesquisaResumo(resumo);
              if (valorTotal > 0 || items.length > 0) {
                setForm((prev) => ({
                  ...prev,
                  valor_estimado_global: String(valorTotal)
                }));
              }
            }}
          />

          {/* Enquadramento Lei 14.133 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Tipo da Contratação (Natureza do Objeto — Art. 6º) *
              </label>
              <select
                value={form.tipo_contratacao}
                onChange={(e) => setForm({ ...form, tipo_contratacao: e.target.value as TipoContratacao })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#071D41]"
              >
                {TIPO_CONTRATACAO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} ({o.legalRef})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Data do Certame (Sessão Pública)
              </label>
              <input
                type="date"
                value={form.data_certame}
                onChange={(e) => setForm({ ...form, data_certame: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Horário da Disputa (Brasília/DF)
              </label>
              <input
                type="time"
                value={form.horario_disputa}
                onChange={(e) => setForm({ ...form, horario_disputa: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Modalidade (Art. 28 / Arts. 74-75)
              </label>
              <select
                value={form.modalidade}
                onChange={(e) => handleModalidadeChange(e.target.value as ModalidadeLicitacao)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
              >
                {MODALIDADE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} ({o.legalRef})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Critério de Julgamento (Art. 33)
              </label>
              <select
                value={form.criterio_julgamento}
                onChange={(e) => handleCriterioChange(e.target.value as CriterioJulgamento)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
              >
                {CRITERIO_JULGAMENTO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={!validCriteria.includes(o.value)}>
                    {o.label} ({o.legalRef}){!validCriteria.includes(o.value) ? ' [Incompatível]' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Modo de Disputa (Art. 56 — Condicionado)
              </label>
              <select
                value={form.modo_disputa}
                onChange={(e) => setForm({ ...form, modo_disputa: e.target.value as ModoDisputa })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
              >
                {MODO_DISPUTA_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={!validModes.includes(o.value)}>
                    {o.label} ({o.legalRef}){!validModes.includes(o.value) ? ' [Vedado p/ critério]' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#071D41] mb-1">
                Formato de Lance / Adjudicação (Art. 40 / Súmula 247 TCU)
              </label>
              <select
                value={form.formato_lance}
                onChange={(e) => setForm({ ...form, formato_lance: e.target.value as FormatoLance })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
              >
                {FORMATO_LANCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Checkbox SRP */}
            <div className="md:col-span-2 pt-1">
              <label className="flex items-start gap-2.5 p-2.5 rounded-lg bg-white border border-blue-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.usar_srp}
                  onChange={(e) => setForm({ ...form, usar_srp: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-[#1351B4]"
                />
                <div className="text-xs">
                  <div className="font-bold text-[#071D41] flex items-center gap-1.5">
                    <CheckSquare className="w-3.5 h-3.5 text-[#1351B4]" />
                    Sistema de Registro de Preços (SRP — Art. 82 da Lei nº 14.133/2021)
                  </div>
                  <div className="text-[11px] text-slate-600">
                    Regra de Negócio: quando marcado, ativa obrigatoriamente o <strong>Agente 08 (Minuta da Ata de Registro de Preços)</strong> e adapta o Edital.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {(form.modalidade === 'PREGAO_PRESENCIAL' || form.modalidade === 'CONCORRENCIA_PRESENCIAL') && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <strong>Art. 17, § 2º e § 5º:</strong> A forma presencial é excepcional e exige justificativa motivada no ETP e gravação da sessão pública em áudio e vídeo.
              </div>
            </div>
          )}

          {/* Secretário e Dotação com cadastro rápido inline */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-700">Secretaria / Ordenador de Despesa</label>
                <button
                  type="button"
                  onClick={() => setShowQuickSec(!showQuickSec)}
                  className="text-[11px] font-semibold text-[#1351B4] hover:underline flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Inserir rápido
                </button>
              </div>
              <select
                value={form.secretario_id}
                onChange={(e) => setForm({ ...form, secretario_id: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                <option value="">-- Selecione --</option>
                {secretarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.secretaria} — {s.nome}
                  </option>
                ))}
              </select>

              {showQuickSec && (
                <div className="mt-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                  <input
                    placeholder="Nome da Secretaria"
                    value={quickSec.secretaria}
                    onChange={(e) => setQuickSec({ ...quickSec, secretaria: e.target.value })}
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                  <input
                    placeholder="Nome do Secretário"
                    value={quickSec.nome}
                    onChange={(e) => setQuickSec({ ...quickSec, nome: e.target.value })}
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                  <div className="flex gap-2">
                    <input
                      placeholder="Portaria"
                      value={quickSec.portaria_nomeacao}
                      onChange={(e) => setQuickSec({ ...quickSec, portaria_nomeacao: e.target.value })}
                      className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      onClick={handleQuickAddSec}
                      className="px-2.5 py-1 bg-[#1351B4] text-white rounded text-xs font-semibold cursor-pointer"
                    >
                      Salvar
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="md:col-span-2 bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-800">
                  Dotações Orçamentárias (Múltiplas — Seleção do Órgão ou Inclusão Manual)
                </label>
                <button
                  type="button"
                  onClick={() => setShowQuickDot(!showQuickDot)}
                  className="text-[11px] font-semibold text-[#1351B4] hover:underline flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Cadastrar nova no órgão
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <div>
                  <select
                    aria-label="Selecionar dotação cadastrada para adicionar"
                    value=""
                    onChange={(e) => handleAddSelectedDotacao(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                  >
                    <option value="">-- Selecionar dotação cadastrada para incluir (ou SRP) --</option>
                    {dotacoes.map((d) => {
                      const alreadySelected = selectedDotacaoIds.includes(d.id);
                      return (
                        <option key={d.id} value={d.id} disabled={alreadySelected}>
                          {alreadySelected ? '✓ ' : ''}
                          {d.codigo_reduzido ? `[Red. ${d.codigo_reduzido}] ` : ''}
                          {d.unidade_orcamentaria} | {d.elemento_despesa} (Fonte {d.fonte_recurso})
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualDotacaoInput}
                    onChange={(e) => setManualDotacaoInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddManualDotacao();
                      }
                    }}
                    placeholder="Ou inclusão manual (ex: Red. 412 | 3.3.90.30.00 | Fonte 1.500)"
                    className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleAddManualDotacao}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-[#168821] hover:bg-[#126E1B] text-white text-xs font-semibold cursor-pointer shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Incluir Manual
                  </button>
                </div>
              </div>

              {showQuickDot && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2">
                  <div className="text-[11px] font-semibold text-emerald-900">
                    Cadastrar Dotação Permanente no Órgão e Vincular ao Certame
                  </div>
                  <input
                    placeholder="Unidade Orçamentária"
                    value={quickDot.unidade_orcamentaria}
                    onChange={(e) => setQuickDot({ ...quickDot, unidade_orcamentaria: e.target.value })}
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                  <div className="flex gap-2">
                    <input
                      placeholder="Elemento (ex: 3.3.90.30.00)"
                      value={quickDot.elemento_despesa}
                      onChange={(e) => setQuickDot({ ...quickDot, elemento_despesa: e.target.value })}
                      className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    />
                    <input
                      placeholder="Fonte (ex: 1.500.000)"
                      value={quickDot.fonte_recurso}
                      onChange={(e) => setQuickDot({ ...quickDot, fonte_recurso: e.target.value })}
                      className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      onClick={handleQuickAddDot}
                      className="px-2.5 py-1 bg-[#168821] text-white rounded text-xs font-semibold cursor-pointer"
                    >
                      Salvar e Vincular
                    </button>
                  </div>
                </div>
              )}

              {/* Lista das dotações vinculadas (selecionadas + manuais) */}
              {selectedDotacaoIds.length > 0 || manualDotacoes.length > 0 ? (
                <div className="space-y-1.5 pt-1">
                  {selectedDotacaoIds.map((dotId, idx) => {
                    const dot = dotacoes.find((d) => d.id === dotId);
                    if (!dot) return null;
                    return (
                      <div
                        key={dotId}
                        className="flex items-center justify-between gap-2 bg-white border border-blue-200 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-700"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-[#1351B4] font-bold text-[10px] shrink-0">
                            {idx === 0 ? 'Principal' : `#${idx + 1}`}
                          </span>
                          <span className="truncate">
                            {dot.codigo_reduzido ? `[Red. ${dot.codigo_reduzido}] ` : ''}
                            <strong>{dot.unidade_orcamentaria}</strong> | {dot.elemento_despesa} | Fonte{' '}
                            {dot.fonte_recurso}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveSelectedDotacao(dotId)}
                          className="text-slate-400 hover:text-rose-600 p-0.5 cursor-pointer shrink-0"
                          title="Remover dotação"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}

                  {manualDotacoes.map((entry, idx) => (
                    <div
                      key={`${entry}-${idx}`}
                      className="flex items-center justify-between gap-2 bg-white border border-emerald-200 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-700"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px] shrink-0">
                          Manual
                        </span>
                        <span className="truncate font-medium">{entry}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveManualDotacao(entry)}
                        className="text-slate-400 hover:text-rose-600 p-0.5 cursor-pointer shrink-0"
                        title="Remover dotação manual"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-slate-500">
                  Nenhuma dotação selecionada ({form.usar_srp ? 'facultativo no SRP — Art. 17 Dec. 11.462/2023' : 'selecione ao menos uma na lista ou inclua manualmente'}).
                </div>
              )}
            </div>
          </div>

          {/* Requisitante e Demanda Bruta */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Servidor Requisitante</label>
              <input
                value={form.responsavel_requisitante}
                onChange={(e) => setForm({ ...form, responsavel_requisitante: e.target.value })}
                placeholder="Nome do servidor que originou a demanda"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Cargo do Requisitante</label>
              <input
                value={form.cargo_requisitante}
                onChange={(e) => setForm({ ...form, cargo_requisitante: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Descrição da Necessidade em Linguagem Natural (Alimenta o Agente 01) *
            </label>
            <textarea
              required
              rows={3}
              value={form.demanda_bruta}
              onChange={(e) => setForm({ ...form, demanda_bruta: e.target.value })}
              placeholder="Descreva o problema administrativo a ser resolvido, público atendido e quantitativos estimados (ex: Precisamos atender 8 UBS com 500 caixas de medicamentos essenciais...)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
          </div>

          {error && <div className="text-xs text-rose-600 font-semibold">{error}</div>}

          <div className="flex flex-wrap justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              onClick={() => {
                submitRunAllRef.current = false;
              }}
              className="px-4 py-2 rounded-lg text-xs font-semibold border border-[#1351B4] text-[#1351B4] hover:bg-blue-50 disabled:opacity-50 cursor-pointer"
            >
              {saving && !runningBatchAfterSave
                ? 'Salvando...'
                : existingProcess
                  ? 'Atualizar e Sincronizar Peças'
                  : 'Instaurar Processo na Esteira'}
            </button>
            <button
              type="submit"
              disabled={saving}
              onClick={() => {
                submitRunAllRef.current = true;
              }}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold bg-[#071D41] hover:bg-[#1351B4] disabled:opacity-50 text-white cursor-pointer"
            >
              {saving && runningBatchAfterSave ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              )}
              {saving && runningBatchAfterSave
                ? 'Elaborando Todas as Peças...'
                : existingProcess
                  ? 'Salvar e Reelaborar Todas as Peças (Word)'
                  : 'Instaurar e Elaborar Todas as Peças (Word)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
