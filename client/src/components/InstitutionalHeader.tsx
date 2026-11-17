import React from 'react';
import type { Dotacao, Institution, ProcurementProcess, Secretario } from '@shared/types';
import {
  formatCertameDateBR,
  formatCertameHorarioBR,
  formatCnpj,
  formatCurrencyBRL,
  getCriterioLabel,
  getFormatoLanceLabel,
  getModalidadeLabel,
  getModoDisputaLabel,
  getTipoContratacaoLabel
} from '@shared/labels';

interface Props {
  institution: Institution;
  process: ProcurementProcess;
  secretario: Secretario | null;
  dotacao: Dotacao | null;
  dotacoesVinculadas?: Dotacao[];
  onEditCertame?: () => void;
}

export const InstitutionalHeader: React.FC<Props> = ({
  institution,
  process,
  secretario,
  dotacao,
  dotacoesVinculadas,
  onEditCertame
}) => {
  const linkedCount = (dotacoesVinculadas?.length ?? (dotacao ? 1 : 0)) + (process.dotacoes_manuais?.length ?? 0);
  const dotSummary =
    linkedCount === 0
      ? 'Não vinculada'
      : linkedCount === 1
        ? dotacao
          ? `${dotacao.elemento_despesa} (Red. ${dotacao.codigo_reduzido || '—'})`
          : process.dotacoes_manuais?.[0] || 'Dotação Manual'
        : `${linkedCount} dotações vinculadas`;
  return (
    <div className="bg-white border border-slate-200 rounded-t-xl shadow-xs overflow-hidden">
      {/* Faixa Superior Institucional estilo Gov.br */}
      <div className="h-1.5 w-full bg-gradient-to-r from-[#071D41] via-[#1351B4] to-[#168821]" />

      <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-slate-200">
        {/* Brasão à esquerda */}
        <div className="md:col-span-3 flex justify-center md:justify-start">
          {institution.logo_data_url ? (
            <img
              src={institution.logo_data_url}
              alt="Brasão Institucional"
              className="h-24 md:h-28 w-auto max-w-[220px] min-w-[96px] object-contain rounded-lg border border-slate-100 bg-slate-50 p-1.5"
            />
          ) : (
            <div className="h-24 w-28 rounded-lg border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center text-[11px] text-slate-400 text-center px-2">
              Sem Brasão
            </div>
          )}
        </div>

        {/* Dados da Prefeitura centralizados */}
        <div className="md:col-span-6 text-center">
          <div className="text-[11px] font-semibold tracking-wider uppercase text-[#1351B4]">
            República Federativa do Brasil • Poder Público Municipal
          </div>
          <h2 className="text-sm md:text-base font-bold text-[#071D41] uppercase tracking-tight leading-snug">
            {institution.razao_social}
          </h2>
          {institution.nome_fantasia && (
            <div className="text-xs font-medium text-slate-700">{institution.nome_fantasia}</div>
          )}
          <div className="text-[11px] text-slate-500 mt-0.5">
            CNPJ: <span className="font-mono font-medium text-slate-700">{formatCnpj(institution.cnpj)}</span>
            {institution.endereco_completo ? ` • ${institution.endereco_completo}` : ''}
            {institution.municipio ? ` • ${institution.municipio}/${institution.uf}` : ''}
            {institution.cep ? ` • CEP ${institution.cep}` : ''}
          </div>
        </div>

        {/* Número dos Processos à direita */}
        <div className="md:col-span-3 flex flex-col items-center md:items-end text-right gap-1">
          <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-2.5 py-1.5 w-full md:w-auto">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-[#1351B4]">
              Processo Licitatório
            </div>
            <div className="text-sm font-bold text-[#071D41] font-mono">
              Nº {process.numero_processo_licitatorio}
            </div>
          </div>
          <div className="text-[11px] text-slate-600 font-medium">
            Proc. Adm.: <span className="font-mono text-slate-800">{process.numero_processo_administrativo}</span>
          </div>
        </div>
      </div>

      {/* Faixa de Metadados Dinâmicos do Certame */}
      <div className="px-6 py-2 bg-slate-50/90 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            <strong className="text-[#071D41]">Tipo:</strong> {getTipoContratacaoLabel(process.tipo_contratacao).split(' (')[0]}
          </span>
          <span>
            <strong className="text-[#071D41]">Modalidade:</strong> {getModalidadeLabel(process.modalidade)}
          </span>
          <span>
            <strong className="text-[#071D41]">Disputa:</strong> {getModoDisputaLabel(process.modo_disputa)}
          </span>
          <span>
            <strong className="text-[#071D41]">Critério:</strong> {getCriterioLabel(process.criterio_julgamento)} (
            {getFormatoLanceLabel(process.formato_lance).split(' (')[0]})
          </span>
          {process.usar_srp && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-[#1351B4] border border-blue-200">
              SRP ATIVO (Art. 82)
            </span>
          )}
          {(process.data_certame || process.horario_disputa) && (
            <span>
              <strong className="text-[#071D41]">Sessão:</strong>{' '}
              {process.data_certame ? formatCertameDateBR(process.data_certame) : 'Data a definir'}
              {process.horario_disputa ? ` às ${formatCertameHorarioBR(process.horario_disputa)}` : ''}
            </span>
          )}
          {process.valor_estimado_global > 0 && (
            <span>
              <strong className="text-[#071D41]">Valor Est.:</strong>{' '}
              <span className="font-semibold text-emerald-700">
                {formatCurrencyBRL(process.valor_estimado_global)}
              </span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden lg:inline text-slate-500">
            <strong>Secretaria:</strong> {secretario?.secretaria || 'Não vinculada'} |{' '}
            <strong>Dotações:</strong> {dotSummary}
          </span>
          {onEditCertame && (
            <button
              type="button"
              onClick={onEditCertame}
              className="text-[#1351B4] hover:text-[#071D41] font-semibold underline underline-offset-2 cursor-pointer"
            >
              Editar Certame
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
