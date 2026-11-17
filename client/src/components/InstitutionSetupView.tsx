import React, { useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UserCheck,
  Wallet
} from 'lucide-react';
import type { Dotacao, Institution, Secretario } from '@shared/types';
import { formatCnpj, formatCurrencyBRL } from '@shared/labels';
import { api } from '../api/client';

interface Props {
  institutions: Institution[];
  activeInstitutionId: string;
  onSelectInstitution: (id: string) => void;
  onInstitutionUpdated: () => Promise<void>;
}

const SAMPLE_SEC_CSV = `secretaria;nome;cargo;portaria_nomeacao;email
Secretaria Municipal de Obras e Infraestrutura;Eng. Marcos Paulo Ribeiro;Secretário Municipal de Obras;Portaria nº 041/2025;obras@prefeitura.gov.br
Secretaria Municipal de Assistência Social;Dra. Juliana Costa Lima;Secretária de Desenvolvimento Social;Portaria nº 042/2025;social@prefeitura.gov.br`;

const SAMPLE_DOT_CSV = `orgao;unidade_orcamentaria;funcao;subfuncao;programa;acao;elemento_despesa;fonte_recurso;codigo_reduzido;descricao;saldo_disponivel
02 - Poder Executivo;02.07.01 - Secretaria de Obras;15 - Urbanismo;451 - Infraestrutura Urbana;0015 - Cidade Pavimentada;1.022 - Obras e Infraestrutura;4.4.90.51.00 - Obras e Instalações;1.500.000.0000 - Recursos Próprios;410;Pavimentação e drenagem urbana;1500000`;

export const InstitutionSetupView: React.FC<Props> = ({
  institutions,
  activeInstitutionId,
  onSelectInstitution,
  onInstitutionUpdated
}) => {
  const [inst, setInst] = useState<Institution | null>(null);
  const [secretarios, setSecretarios] = useState<Secretario[]>([]);
  const [dotacoes, setDotacoes] = useState<Dotacao[]>([]);
  const [loading, setLoading] = useState(false);

  // CNPJ lookup state
  const [cnpjSearch, setCnpjSearch] = useState('');
  const [lookingUpCnpj, setLookingUpCnpj] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Scraping & Import state
  const [scraping, setScraping] = useState(false);
  const [scrapeDiag, setScrapeDiag] = useState<string[]>([]);
  const [importTarget, setImportTarget] = useState<'secretarios' | 'dotacoes' | null>(null);
  const [importFormat, setImportFormat] = useState<'csv' | 'json'>('csv');
  const [importContent, setImportContent] = useState('');

  // Inline forms for Secretário & Dotação
  const [newSec, setNewSec] = useState({
    secretaria: '',
    nome: '',
    cargo: 'Secretário(a) Municipal e Ordenador(a) de Despesas',
    portaria_nomeacao: '',
    email: ''
  });
  const [newDot, setNewDot] = useState({
    orgao: '02 - Poder Executivo',
    unidade_orcamentaria: '',
    funcao: '',
    subfuncao: '',
    programa: '',
    acao: '',
    elemento_despesa: '',
    fonte_recurso: '1.500.000.0000',
    codigo_reduzido: '',
    descricao: '',
    saldo_disponivel: '0'
  });

  const loadDetail = async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const detail = await api.getInstitutionDetail(id);
      setInst(detail.institution);
      setCnpjSearch(detail.institution.cnpj);
      setSecretarios(detail.secretarios);
      setDotacoes(detail.dotacoes);
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeInstitutionId) {
      loadDetail(activeInstitutionId);
    }
  }, [activeInstitutionId]);

  const handleLookupCnpj = async () => {
    const targetCnpj = cnpjSearch || inst?.cnpj || '';
    setLookingUpCnpj(true);
    setStatusMsg(null);
    try {
      const data = await api.lookupCnpj(targetCnpj);
      setInst((prev) =>
        prev
          ? {
              ...prev,
              cnpj: data.cnpj,
              razao_social: data.razao_social || prev.razao_social,
              nome_fantasia: data.nome_fantasia || prev.nome_fantasia,
              endereco_completo: data.endereco_completo || prev.endereco_completo,
              cep: data.cep || prev.cep,
              municipio: data.municipio || prev.municipio,
              uf: data.uf || prev.uf,
              telefone: data.telefone || prev.telefone,
              email: data.email || prev.email,
              comarca_foro: data.municipio ? `Comarca de ${data.municipio}/${data.uf}` : prev.comarca_foro
            }
          : null
      );
      setCnpjSearch(data.cnpj);
      setStatusMsg({
        type: 'ok',
        text: `Dados consultados com sucesso via ${data.fonte} (Situação: ${data.situacao_cadastral}). Clique em "Salvar Dados do Órgão" para confirmar e sincronizar.`
      });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err.message });
    } finally {
      setLookingUpCnpj(false);
    }
  };

  const handleSaveInstitution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inst) return;
    setStatusMsg(null);
    try {
      const saved = await api.updateInstitution(inst.id, inst);
      setInst(saved);
      await onInstitutionUpdated();
      setStatusMsg({
        type: 'ok',
        text: 'Dados institucionais salvos e sincronizados automaticamente nos cabeçalhos de todos os processos vinculados.'
      });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err.message });
    }
  };

  const handleCreateNewMunicipality = async () => {
    setStatusMsg(null);
    try {
      const created = await api.createInstitution({
        cnpj: '00.000.000/0001-91',
        razao_social: 'NOVA PREFEITURA MUNICIPAL',
        nome_fantasia: 'Prefeitura Municipal (Configure via CNPJ)',
        municipio: 'Cidade',
        uf: 'MG'
      });
      await onInstitutionUpdated();
      onSelectInstitution(created.id);
      setStatusMsg({ type: 'ok', text: 'Novo órgão criado. Preencha o CNPJ e salve os dados.' });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err?.message || 'Erro ao criar novo órgão.' });
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !inst) return;
    setStatusMsg(null);
    try {
      const updated = await api.uploadLogoFile(inst.id, file);
      setInst(updated);
      await onInstitutionUpdated();
      setStatusMsg({
        type: 'ok',
        text: 'Brasão atualizado e injetado no cabeçalho de todas as peças documentais.'
      });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err.message });
    }
  };

  const handleScrape = async () => {
    if (!inst || !inst.portal_transparencia_url.trim()) {
      setStatusMsg({ type: 'err', text: 'Informe a URL do Portal da Transparência / Site Oficial antes de sincronizar.' });
      return;
    }
    setScraping(true);
    setScrapeDiag([]);
    setStatusMsg(null);
    try {
      await api.updateInstitution(inst.id, { portal_transparencia_url: inst.portal_transparencia_url });
      const res = await api.scrapePortal(inst.id, inst.portal_transparencia_url, true);
      setSecretarios(res.secretarios_atualizados);
      setDotacoes(res.dotacoes_atualizadas);
      setScrapeDiag(res.diagnostics);
      setStatusMsg({
        type: 'ok',
        text: `Sincronização concluída: ${res.secretarios.length} secretário(s) e ${res.dotacoes.length} dotação(ões) extraídos.`
      });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err.message });
    } finally {
      setScraping(false);
    }
  };

  const handleImportSubmit = async () => {
    if (!inst || !importTarget) return;
    try {
      const res = await api.importData(inst.id, importTarget, importFormat, importContent);
      await loadDetail(inst.id);
      setImportTarget(null);
      setImportContent('');
      setStatusMsg({ type: 'ok', text: `${res.imported} registro(s) importado(s) com sucesso em ${importTarget}.` });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err.message });
    }
  };

  const handleImportFileRead = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.name.toLowerCase().endsWith('.json')) setImportFormat('json');
    else setImportFormat('csv');
    const reader = new FileReader();
    reader.onload = () => setImportContent(String(reader.result || ''));
    reader.readAsText(f, 'utf-8');
  };

  const downloadTemplate = (target: 'secretarios' | 'dotacoes') => {
    const content = target === 'secretarios' ? SAMPLE_SEC_CSV : SAMPLE_DOT_CSV;
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `modelo_${target}_govflow.csv`;
    a.click();
  };

  const handleAddSecretario = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inst || !newSec.secretaria.trim() || !newSec.nome.trim()) return;
    setStatusMsg(null);
    try {
      await api.createSecretario(inst.id, { ...newSec, source: 'manual' });
      setNewSec({
        secretaria: '',
        nome: '',
        cargo: 'Secretário(a) Municipal e Ordenador(a) de Despesas',
        portaria_nomeacao: '',
        email: ''
      });
      await loadDetail(inst.id);
      setStatusMsg({ type: 'ok', text: 'Ordenador de Despesas / Secretário adicionado com sucesso.' });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err?.message || 'Erro ao adicionar Secretário.' });
    }
  };

  const handleAddDotacao = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inst || !newDot.unidade_orcamentaria.trim() || !newDot.elemento_despesa.trim()) return;
    setStatusMsg(null);
    try {
      await api.createDotacao(inst.id, {
        ...newDot,
        saldo_disponivel: Number(newDot.saldo_disponivel || 0),
        source: 'manual'
      });
      setNewDot({
        orgao: '02 - Poder Executivo',
        unidade_orcamentaria: '',
        funcao: '',
        subfuncao: '',
        programa: '',
        acao: '',
        elemento_despesa: '',
        fonte_recurso: '1.500.000.0000',
        codigo_reduzido: '',
        descricao: '',
        saldo_disponivel: '0'
      });
      await loadDetail(inst.id);
      setStatusMsg({ type: 'ok', text: 'Dotação orçamentária adicionada com sucesso.' });
    } catch (err: any) {
      setStatusMsg({ type: 'err', text: err?.message || 'Erro ao adicionar Dotação Orçamentária.' });
    }
  };

  if (loading && !inst) {
    return (
      <div className="p-10 flex items-center justify-center text-slate-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" />
        Carregando configurações institucionais...
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      {/* Cabeçalho da Tela */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#071D41] flex items-center gap-2">
            <Building2 className="w-6 h-6 text-[#1351B4]" />
            Configuração Institucional do Órgão / Prefeitura
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            Consulta automática via CNPJ (BrasilAPI / ReceitaWS), identidade visual (Brasão) e sincronização de Secretários e Dotações Orçamentárias.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={activeInstitutionId}
            onChange={(e) => onSelectInstitution(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
          >
            {institutions.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nome_fantasia || i.razao_social} ({i.cnpj})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleCreateNewMunicipality}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#071D41] hover:bg-[#1351B4] text-white text-xs font-semibold cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Novo Órgão
          </button>
        </div>
      </div>

      {statusMsg && (
        <div
          className={`rounded-lg px-4 py-3 text-xs font-medium flex items-center gap-2 border ${
            statusMsg.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusMsg.text}</span>
        </div>
      )}

      {inst && (
        <>
          {/* BLOCO 1: IDENTIFICAÇÃO VIA CNPJ + BRASÃO */}
          <form onSubmit={handleSaveInstitution} className="bg-white rounded-xl border border-slate-200 shadow-xs p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-sm font-bold text-[#071D41]">1. Identificação do Órgão e Identidade Visual</h2>
                <p className="text-xs text-slate-500">
                  Alterações aqui atualizam automaticamente os cabeçalhos de todas as peças geradas.
                </p>
              </div>

              {/* Consulta CNPJ */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={cnpjSearch}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '').slice(0, 14);
                    setCnpjSearch(digits.length === 14 ? formatCnpj(digits) : e.target.value);
                  }}
                  placeholder="00.000.000/0001-00"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono w-48 focus:border-[#1351B4] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleLookupCnpj}
                  disabled={lookingUpCnpj}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-semibold cursor-pointer disabled:opacity-60"
                >
                  {lookingUpCnpj ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  Consultar CNPJ
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              {/* Upload de Brasão */}
              <div className="md:col-span-4 flex flex-col items-center justify-center border border-dashed border-slate-300 rounded-xl p-5 bg-slate-50">
                {inst.logo_data_url ? (
                  <img
                    src={inst.logo_data_url}
                    alt="Brasão Municipal"
                    className="h-32 sm:h-36 w-full max-w-[260px] object-contain mb-3 rounded-lg bg-white p-2 border border-slate-200"
                  />
                ) : (
                  <div className="h-32 w-full max-w-[220px] rounded-lg bg-slate-200 flex items-center justify-center text-xs text-slate-500 mb-3">
                    Sem Brasão
                  </div>
                )}
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:border-[#1351B4] text-xs font-semibold text-slate-700 cursor-pointer shadow-2xs">
                  <Upload className="w-3.5 h-3.5 text-[#1351B4]" />
                  Upload Brasão (PNG/SVG)
                  <input
                    type="file"
                    accept="image/png,image/svg+xml,image/jpeg,image/webp"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </label>
                <span className="text-[10px] text-slate-500 mt-1.5 text-center">
                  Injetado em todas as peças, PDFs e DOCXs
                </span>
              </div>

              {/* Campos Cadastrais */}
              <div className="md:col-span-8 grid grid-cols-1 md:grid-cols-3 gap-3.5">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Razão Social *</label>
                  <input
                    required
                    value={inst.razao_social}
                    onChange={(e) => setInst({ ...inst, razao_social: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">CNPJ *</label>
                  <input
                    required
                    value={inst.cnpj}
                    onChange={(e) => setInst({ ...inst, cnpj: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Nome Fantasia / Órgão</label>
                  <input
                    value={inst.nome_fantasia}
                    onChange={(e) => setInst({ ...inst, nome_fantasia: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Prefeito(a) / Autoridade Máxima</label>
                  <input
                    value={inst.prefeito_nome}
                    onChange={(e) => setInst({ ...inst, prefeito_nome: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Endereço Completo</label>
                  <input
                    value={inst.endereco_completo}
                    onChange={(e) => setInst({ ...inst, endereco_completo: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">CEP</label>
                  <input
                    value={inst.cep}
                    onChange={(e) => setInst({ ...inst, cep: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Município</label>
                  <input
                    value={inst.municipio}
                    onChange={(e) => setInst({ ...inst, municipio: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">UF</label>
                  <input
                    maxLength={2}
                    value={inst.uf}
                    onChange={(e) => setInst({ ...inst, uf: e.target.value.toUpperCase() })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs uppercase"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Comarca / Foro</label>
                  <input
                    value={inst.comarca_foro}
                    onChange={(e) => setInst({ ...inst, comarca_foro: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Telefone Institucional</label>
                  <input
                    value={inst.telefone}
                    onChange={(e) => setInst({ ...inst, telefone: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">E-mail Institucional / Licitações</label>
                  <input
                    type="email"
                    value={inst.email}
                    onChange={(e) => setInst({ ...inst, email: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="submit"
                className="px-5 py-2 rounded-lg bg-[#168821] hover:bg-[#126E1B] text-white text-xs font-semibold cursor-pointer shadow-xs"
              >
                Salvar Dados do Órgão
              </button>
            </div>
          </form>

          {/* BLOCO 2: PORTAL DA TRANSPARÊNCIA / SCRAPING & IMPORTAÇÃO */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-[#071D41] flex items-center gap-2">
                  <Globe className="w-4 h-4 text-[#1351B4]" />
                  2. Sincronização Portal da Transparência (Web Scraping / Importação CSV & JSON)
                </h2>
                <p className="text-xs text-slate-500">
                  Extraia automaticamente Secretários e Dotações Orçamentárias da página oficial ou importe planilhas.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setImportTarget('secretarios');
                    setImportContent(SAMPLE_SEC_CSV);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:border-[#1351B4] text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-[#1351B4]" />
                  Importar Secretários (CSV/JSON)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImportTarget('dotacoes');
                    setImportContent(SAMPLE_DOT_CSV);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:border-[#1351B4] text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                  Importar Dotações (CSV/JSON)
                </button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={inst.portal_transparencia_url}
                onChange={(e) => setInst({ ...inst, portal_transparencia_url: e.target.value })}
                placeholder="https://transparencia.municipio.uf.gov.br/..."
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-[#1351B4] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleScrape}
                disabled={scraping}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#071D41] hover:bg-[#1351B4] text-white text-xs font-semibold cursor-pointer disabled:opacity-60"
              >
                {scraping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Sincronizar via Agente Extrator
              </button>
            </div>

            {scrapeDiag.length > 0 && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 space-y-1">
                {scrapeDiag.map((d, i) => (
                  <div key={i}>• {d}</div>
                ))}
              </div>
            )}

            {importTarget && (
              <div className="border border-blue-200 bg-blue-50/50 rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-bold text-[#071D41]">
                    Importação Estruturada: {importTarget === 'secretarios' ? 'Secretários / Ordenadores' : 'Dotações Orçamentárias'}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => downloadTemplate(importTarget)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1351B4] hover:underline cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Baixar Modelo CSV
                    </button>
                    <label className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 px-2.5 py-1 rounded cursor-pointer">
                      <Upload className="w-3 h-3" />
                      Carregar Arquivo
                      <input type="file" accept=".csv,.json,.txt" onChange={handleImportFileRead} className="hidden" />
                    </label>
                    <select
                      value={importFormat}
                      onChange={(e) => setImportFormat(e.target.value as 'csv' | 'json')}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                    >
                      <option value="csv">CSV</option>
                      <option value="json">JSON</option>
                    </select>
                  </div>
                </div>
                <textarea
                  rows={5}
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-xs font-mono"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setImportTarget(null)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-200 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleImportSubmit}
                    className="px-4 py-1.5 rounded-lg bg-[#1351B4] text-white text-xs font-semibold cursor-pointer"
                  >
                    Importar Registros
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* BLOCO 3: SECRETÁRIOS / ORDENADORES DE DESPESA */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-6 space-y-4">
            <h2 className="text-sm font-bold text-[#071D41] flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[#1351B4]" />
              3. Secretarias Municipais e Ordenadores de Despesa ({secretarios.length})
            </h2>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-700 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Secretaria</th>
                    <th className="px-3 py-2 font-semibold">Ordenador / Secretário</th>
                    <th className="px-3 py-2 font-semibold">Cargo</th>
                    <th className="px-3 py-2 font-semibold">Portaria</th>
                    <th className="px-3 py-2 font-semibold">Origem</th>
                    <th className="px-3 py-2 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {secretarios.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium text-slate-900">{s.secretaria}</td>
                      <td className="px-3 py-2">{s.nome}</td>
                      <td className="px-3 py-2 text-slate-600">{s.cargo}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{s.portaria_nomeacao}</td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] uppercase">
                          {s.source}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={async () => {
                            setStatusMsg(null);
                            try {
                              await api.deleteSecretario(inst.id, s.id);
                              await loadDetail(inst.id);
                              setStatusMsg({ type: 'ok', text: 'Ordenador removido com sucesso.' });
                            } catch (err: any) {
                              setStatusMsg({ type: 'err', text: err?.message || 'Erro ao excluir Ordenador.' });
                            }
                          }}
                          className="text-rose-600 hover:text-rose-800 p-1 cursor-pointer"
                          title="Excluir Secretário"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <form onSubmit={handleAddSecretario} className="grid grid-cols-1 md:grid-cols-5 gap-2 pt-2">
              <input
                required
                placeholder="Nome da Secretaria"
                value={newSec.secretaria}
                onChange={(e) => setNewSec({ ...newSec, secretaria: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                required
                placeholder="Nome do Secretário / Ordenador"
                value={newSec.nome}
                onChange={(e) => setNewSec({ ...newSec, nome: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Cargo"
                value={newSec.cargo}
                onChange={(e) => setNewSec({ ...newSec, cargo: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Portaria (ex: Portaria 015/2026)"
                value={newSec.portaria_nomeacao}
                onChange={(e) => setNewSec({ ...newSec, portaria_nomeacao: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-semibold px-3 py-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Adicionar
              </button>
            </form>
          </div>

          {/* BLOCO 4: DOTAÇÕES ORÇAMENTÁRIAS */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-6 space-y-4">
            <h2 className="text-sm font-bold text-[#071D41] flex items-center gap-2">
              <Wallet className="w-4 h-4 text-[#168821]" />
              4. Dotações Orçamentárias Vigentes ({dotacoes.length})
            </h2>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-700 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Órgão / Unidade Orçamentária</th>
                    <th className="px-3 py-2 font-semibold">Função / Subfunção</th>
                    <th className="px-3 py-2 font-semibold">Programa / Ação</th>
                    <th className="px-3 py-2 font-semibold">Elemento & Fonte</th>
                    <th className="px-3 py-2 font-semibold">Saldo</th>
                    <th className="px-3 py-2 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dotacoes.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">{d.orgao}</div>
                        <div className="text-[11px] text-slate-600">{d.unidade_orcamentaria}</div>
                      </td>
                      <td className="px-3 py-2 text-[11px]">
                        <div>{d.funcao}</div>
                        <div className="text-slate-500">{d.subfuncao}</div>
                      </td>
                      <td className="px-3 py-2 text-[11px]">
                        <div>{d.programa}</div>
                        <div className="text-slate-500">{d.acao}</div>
                      </td>
                      <td className="px-3 py-2 text-[11px]">
                        <div className="font-medium text-[#071D41]">{d.elemento_despesa}</div>
                        <div className="text-slate-500">
                          Fonte: {d.fonte_recurso} {d.codigo_reduzido ? `• Red. ${d.codigo_reduzido}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-emerald-700 font-semibold">
                        {formatCurrencyBRL(d.saldo_disponivel)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={async () => {
                            setStatusMsg(null);
                            try {
                              await api.deleteDotacao(inst.id, d.id);
                              await loadDetail(inst.id);
                              setStatusMsg({ type: 'ok', text: 'Dotação orçamentária removida com sucesso.' });
                            } catch (err: any) {
                              setStatusMsg({ type: 'err', text: err?.message || 'Erro ao excluir Dotação.' });
                            }
                          }}
                          className="text-rose-600 hover:text-rose-800 p-1 cursor-pointer"
                          title="Excluir Dotação"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <form onSubmit={handleAddDotacao} className="grid grid-cols-2 md:grid-cols-5 gap-2 pt-2">
              <input
                placeholder="Órgão (ex: 02)"
                value={newDot.orgao}
                onChange={(e) => setNewDot({ ...newDot, orgao: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                required
                placeholder="Unidade Orçamentária *"
                value={newDot.unidade_orcamentaria}
                onChange={(e) => setNewDot({ ...newDot, unidade_orcamentaria: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Função (ex: 12 - Educação)"
                value={newDot.funcao}
                onChange={(e) => setNewDot({ ...newDot, funcao: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Subfunção (ex: 361)"
                value={newDot.subfuncao}
                onChange={(e) => setNewDot({ ...newDot, subfuncao: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Programa (ex: 0012)"
                value={newDot.programa}
                onChange={(e) => setNewDot({ ...newDot, programa: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Ação / Proj. Ativ."
                value={newDot.acao}
                onChange={(e) => setNewDot({ ...newDot, acao: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                required
                placeholder="Elemento de Despesa *"
                value={newDot.elemento_despesa}
                onChange={(e) => setNewDot({ ...newDot, elemento_despesa: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Fonte de Recurso"
                value={newDot.fonte_recurso}
                onChange={(e) => setNewDot({ ...newDot, fonte_recurso: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                placeholder="Cód. Reduzido (ex: 105)"
                value={newDot.codigo_reduzido}
                onChange={(e) => setNewDot({ ...newDot, codigo_reduzido: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Saldo Disponível (R$)"
                value={newDot.saldo_disponivel}
                onChange={(e) => setNewDot({ ...newDot, saldo_disponivel: e.target.value })}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-[#168821] hover:bg-[#126E1B] text-white text-xs font-semibold px-3 py-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Adicionar Dotação
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
};
