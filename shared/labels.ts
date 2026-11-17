import type {
  AgentStatus,
  CriterioJulgamento,
  FormatoLance,
  ModalidadeLicitacao,
  ModoDisputa,
  TipoContratacao
} from './types.js';

export const MODALIDADE_OPTIONS: {
  value: ModalidadeLicitacao;
  label: string;
  legalRef: string;
  isDirect?: boolean;
}[] = [
  { value: 'PREGAO_ELETRONICO', label: 'Pregão Eletrônico', legalRef: 'Art. 28, I c/c Art. 17, § 2º' },
  { value: 'PREGAO_PRESENCIAL', label: 'Pregão Presencial', legalRef: 'Art. 28, I c/c Art. 17, § 2º e § 5º' },
  { value: 'CONCORRENCIA_ELETRONICA', label: 'Concorrência Eletrônica', legalRef: 'Art. 28, II c/c Art. 17, § 2º' },
  { value: 'CONCORRENCIA_PRESENCIAL', label: 'Concorrência Presencial', legalRef: 'Art. 28, II c/c Art. 17, § 2º e § 5º' },
  { value: 'CONCURSO', label: 'Concurso', legalRef: 'Art. 28, III e Art. 30' },
  { value: 'LEILAO', label: 'Leilão', legalRef: 'Art. 28, IV e Art. 31' },
  { value: 'DIALOGO_COMPETITIVO', label: 'Diálogo Competitivo', legalRef: 'Art. 28, V e Art. 32' },
  { value: 'DISPENSA', label: 'Contratação Direta — Dispensa de Licitação', legalRef: 'Art. 75', isDirect: true },
  { value: 'INEXIGIBILIDADE', label: 'Contratação Direta — Inexigibilidade', legalRef: 'Art. 74', isDirect: true }
];

export const MODO_DISPUTA_OPTIONS: {
  value: ModoDisputa;
  label: string;
  legalRef: string;
}[] = [
  { value: 'ABERTO', label: 'Aberto', legalRef: 'Art. 56, I' },
  { value: 'FECHADO', label: 'Fechado', legalRef: 'Art. 56, II' },
  { value: 'ABERTO_FECHADO', label: 'Aberto e Fechado', legalRef: 'Art. 56, I e II (Combinado)' },
  { value: 'FECHADO_ABERTO', label: 'Fechado e Aberto', legalRef: 'Art. 56, I e II (Combinado)' },
  { value: 'NAO_APLICAVEL', label: 'Não Aplicável (Contratação Direta)', legalRef: 'Art. 72' }
];

export const CRITERIO_JULGAMENTO_OPTIONS: {
  value: CriterioJulgamento;
  label: string;
  legalRef: string;
}[] = [
  { value: 'MENOR_PRECO', label: 'Menor Preço', legalRef: 'Art. 33, I' },
  { value: 'MAIOR_DESCONTO', label: 'Maior Desconto', legalRef: 'Art. 33, II' },
  { value: 'MELHOR_TECNICA', label: 'Melhor Técnica ou Conteúdo Artístico', legalRef: 'Art. 33, III' },
  { value: 'TECNICA_E_PRECO', label: 'Técnica e Preço', legalRef: 'Art. 33, IV' },
  { value: 'MAIOR_LANCE', label: 'Maior Lance', legalRef: 'Art. 33, V (Leilão)' },
  { value: 'MAIOR_RETORNO_ECONOMICO', label: 'Maior Retorno Econômico', legalRef: 'Art. 33, VI' }
];

export const FORMATO_LANCE_OPTIONS: {
  value: FormatoLance;
  label: string;
}[] = [
  { value: 'POR_ITEM', label: 'Por Item (Regra Geral — Súmula 247 TCU)' },
  { value: 'POR_LOTE', label: 'Por Lote / Grupo (Requer justificativa técnica/econômica)' },
  { value: 'GLOBAL', label: 'Global (Requer justificativa de inviabilidade de parcelamento)' }
];

export const TIPO_CONTRATACAO_OPTIONS: {
  value: TipoContratacao;
  label: string;
  legalRef: string;
}[] = [
  { value: 'AQUISICAO', label: 'Aquisição (Bens / Materiais / Equipamentos)', legalRef: 'Art. 6º, X e XIII' },
  { value: 'OBRAS_ENGENHARIA', label: 'Obras e Engenharia', legalRef: 'Art. 6º, XII e XXI' },
  { value: 'SERVICOS', label: 'Serviços (Gerais / Continuados / Terceirização)', legalRef: 'Art. 6º, XI e XV' }
];

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  PENDENTE: 'Pendente',
  GERANDO: 'Gerando...',
  AGUARDANDO_REVISAO: 'Aguardando Revisão',
  APROVADO: 'Aprovado',
  DESATUALIZADO: 'Desatualizado',
  DISPENSADO: 'Dispensado'
};

export function getModalidadeLabel(value: ModalidadeLicitacao): string {
  return MODALIDADE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function getModoDisputaLabel(value: ModoDisputa): string {
  return MODO_DISPUTA_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function getCriterioLabel(value: CriterioJulgamento): string {
  return CRITERIO_JULGAMENTO_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function getFormatoLanceLabel(value: FormatoLance): string {
  return FORMATO_LANCE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function getTipoContratacaoLabel(value: TipoContratacao | undefined | null): string {
  if (!value) return 'Aquisição (Bens / Materiais / Equipamentos)';
  return TIPO_CONTRATACAO_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function formatCertameDateBR(isoDate?: string | null): string {
  const clean = (isoDate || '').trim();
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[3]}/${match[2]}/${match[1]}`;
  }
  return clean;
}

export function formatCertameHorarioBR(timeStr?: string | null): string {
  const clean = (timeStr || '').trim();
  const match = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    return `${match[1].padStart(2, '0')}h${match[2]}`;
  }
  return clean;
}

export function formatSessaoPublicaLabel(
  dataCertame?: string | null,
  horarioDisputa?: string | null
): string {
  const dataFmt = formatCertameDateBR(dataCertame);
  const horaFmt = formatCertameHorarioBR(horarioDisputa);
  if (dataFmt && horaFmt) {
    return `${dataFmt} às ${horaFmt} — Horário de Brasília/DF`;
  }
  if (dataFmt) {
    return `${dataFmt} (horário a definir — Horário de Brasília/DF)`;
  }
  if (horaFmt) {
    return `Data a definir às ${horaFmt} — Horário de Brasília/DF`;
  }
  return '[Data e horário a definir conforme prazo mínimo de divulgação do Art. 55 — Horário de Brasília/DF]';
}

export function formatCurrencyBRL(value: number | undefined | null): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 'R$ 0,00';
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatCnpj(cnpj: string): string {
  const digits = (cnpj || '').replace(/\D/g, '').slice(0, 14);
  if (digits.length !== 14) return cnpj || '';
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export function formatDateBR(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function formatDateTimeBR(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
