import type {
  AgentPiece,
  AuditLogEntry,
  Dotacao,
  Institution,
  LegalAlert,
  ProcurementProcess,
  Secretario,
  TipoContratacao
} from '../../shared/types.js';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatDateBR,
  formatDateTimeBR,
  formatSessaoPublicaLabel,
  getCriterioLabel,
  getFormatoLanceLabel,
  getModalidadeLabel,
  getModoDisputaLabel,
  getTipoContratacaoLabel
} from '../../shared/labels.js';
import { formatDotacoesSummary } from '../db/repository.js';
import { isDirectContracting, validateCertameConfiguration } from './legalRules.js';
import {
  analyzePricePortfolio,
  extractPieceProvenance,
  formatPrefeitoRoleAndName
} from './promptRegistry.js';
import { selectContextualTcuPrecedents } from './tcuJurisprudence.js';

export interface GenerationContext {
  process: ProcurementProcess;
  institution: Institution;
  secretario: Secretario | null;
  dotacao: Dotacao | null;
  dotacoesVinculadas?: Dotacao[];
  piecesByNumber: Map<number, AgentPiece>;
  auditLogs: AuditLogEntry[];
  feedback?: string;
  dataPretendida?: string;
  prioridade?: 'Baixo' | 'Médio' | 'Alto';
  pesquisaMercado?: string;
}

export interface AgentOutputPayload {
  structured_json: Record<string, any>;
  html_content: string;
  legal_alerts: LegalAlert[];
}

export interface PlannedItem {
  item: number;
  descricao: string;
  unidade: string;
  medida?: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
}

type DomainCategory =
  | 'TI_EDUCACAO'
  | 'SAUDE_INSUMOS'
  | 'OBRAS_ENGENHARIA'
  | 'SERVICOS_CONTINUOS'
  | 'FROTA_VEICULOS'
  | 'BENS_GERAIS';

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bind(key: string, value: string): string {
  return `<span data-bind="${escapeHtml(key)}">${escapeHtml(value)}</span>`;
}

function detectCategory(text: string, tipoContratacao?: TipoContratacao): DomainCategory {
  if (tipoContratacao === 'OBRAS_ENGENHARIA') {
    return 'OBRAS_ENGENHARIA';
  }
  if (tipoContratacao === 'SERVICOS') {
    return 'SERVICOS_CONTINUOS';
  }
  const lower = text.toLowerCase();
  if (/(medicamento|farmác|farmaci|hospital|saúde|vacina|seringa|clínic|odontológ|insumo médico|\bubs\b)/.test(lower)) {
    return 'SAUDE_INSUMOS';
  }
  if (/(\bobra\b|\bobras\b|pavimenta|reforma|construção|asfalto|engenharia|drenagem|creche|prédio)/.test(lower)) {
    return tipoContratacao === 'AQUISICAO' ? 'BENS_GERAIS' : 'OBRAS_ENGENHARIA';
  }
  if (/(veículo|ambulância|ônibus|caminhão|frota|combustível|manutenção veicular|peça automotiva)/.test(lower)) {
    return 'FROTA_VEICULOS';
  }
  if (/(computador|informática|\bswitch\b|\brede\b|software|notebook|tablet|\bti\b|tecnologia|escola|pedagógic)/.test(lower)) {
    return 'TI_EDUCACAO';
  }
  if (/(limpeza|vigilância|terceiriz|serviço contínuo|manutenção predial|locação|transporte)/.test(lower)) {
    return tipoContratacao === 'AQUISICAO' ? 'BENS_GERAIS' : 'SERVICOS_CONTINUOS';
  }
  return 'BENS_GERAIS';
}

function parsePlannedItems(proc: ProcurementProcess, category: DomainCategory): PlannedItem[] {
  const raw = `${proc.titulo_resumido} ${proc.demanda_bruta}`.trim();
  const totalEstimado = proc.valor_estimado_global > 0 ? proc.valor_estimado_global : 240000;

  // Tenta extrair pares "número + substantivo" do texto da demanda
  const matches: { qty: number; desc: string }[] = [];
  const regex = /\b(\d{1,5})\s+([a-zà-úA-ZÀ-Ú][a-zà-úA-ZÀ-Ú\s\-]{3,42}?)(?=\s*(?:,|;|e\s+\d|\.|$|para|com|de\s+rede))/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    const qty = Number(m[1]);
    const desc = m[2].trim();
    if (
      qty > 0 &&
      qty <= 50000 &&
      !/^(anos?|meses|dias?|escolas?|alunos?|unidades?\s+básicas|usuários?|servidores?)/i.test(desc)
    ) {
      matches.push({ qty, desc });
    }
    if (matches.length >= 4) break;
  }

  if (matches.length >= 1) {
    const items: PlannedItem[] = [];
    const n = matches.length;
    let allocated = 0;
    matches.forEach((entry, idx) => {
      const isLast = idx === n - 1;
      const share = isLast ? Math.max(totalEstimado - allocated, 1000) : Math.round((totalEstimado * (n === 1 ? 1 : idx === 0 ? 0.85 : 0.15 / (n - 1))) * 100) / 100;
      allocated += share;
      const unitPrice = Math.round((share / entry.qty) * 100) / 100;
      const realTotal = Math.round(unitPrice * entry.qty * 100) / 100;
      items.push({
        item: idx + 1,
        descricao: `${entry.desc.charAt(0).toUpperCase() + entry.desc.slice(1)} — conforme especificações técnicas do Termo de Referência`,
        unidade: category === 'SERVICOS_CONTINUOS' ? 'Mês/Posto' : 'Unidade',
        quantidade: entry.qty,
        valor_unitario: unitPrice,
        valor_total: realTotal
      });
    });
    return items;
  }

  // Fallback contextualizado pela categoria e valor global
  const templates: Record<DomainCategory, { desc: string; un: string; qty: number; weight: number }[]> = {
    TI_EDUCACAO: [
      { desc: 'Estação de trabalho completa (Desktop/Monitor/Periféricos) padrão educacional com garantia on-site 36 meses', un: 'Unidade', qty: 100, weight: 0.82 },
      { desc: 'Switch gerenciável Gigabit 24 portas PoE+ com instalação lógica e certificação de pontos', un: 'Unidade', qty: 12, weight: 0.18 }
    ],
    SAUDE_INSUMOS: [
      { desc: 'Lote de medicamentos essenciais da Atenção Básica (RENAME/REMUME) com validade mínima de 18 meses', un: 'Kit/Caixa', qty: 500, weight: 0.7 },
      { desc: 'Insumos médico-hospitalares de uso contínuo (seringas, curativos estéreis e descartáveis)', un: 'Caixa', qty: 400, weight: 0.3 }
    ],
    OBRAS_ENGENHARIA: [
      { desc: 'Execução de serviços preliminares, infraestrutura e superestrutura conforme Projeto Básico e Planilha SINAPI', un: 'Serviço Global', qty: 1, weight: 0.75 },
      { desc: 'Acabamentos, instalações complementares, sinalização e comissionamento técnico final', un: 'Etapa', qty: 1, weight: 0.25 }
    ],
    SERVICOS_CONTINUOS: [
      { desc: 'Prestação de serviços técnicos especializados contínuos com disponibilização de equipe e insumos', un: 'Mês', qty: 12, weight: 0.85 },
      { desc: 'Serviços eventuais sob demanda e atendimento emergencial conforme Ordem de Serviço', un: 'Hora Técnica', qty: 120, weight: 0.15 }
    ],
    FROTA_VEICULOS: [
      { desc: 'Fornecimento de veículo/equipamento operacional adaptado às especificações institucionais (0 km)', un: 'Unidade', qty: 2, weight: 0.88 },
      { desc: 'Pacote de manutenção preventiva programada e garantia estendida em rede autorizada', un: 'Plano/Ano', qty: 2, weight: 0.12 }
    ],
    BENS_GERAIS: [
      { desc: `${proc.titulo_resumido || 'Item principal do objeto'} — Lote/Item 01 conforme especificações técnicas`, un: 'Unidade', qty: 50, weight: 0.75 },
      { desc: 'Acessórios, insumos complementares e assistência técnica/entrega técnica vinculada', un: 'Unidade', qty: 50, weight: 0.25 }
    ]
  };

  return templates[category].map((t, idx) => {
    const subtotal = Math.round(totalEstimado * t.weight * 100) / 100;
    const unit = Math.round((subtotal / t.qty) * 100) / 100;
    return {
      item: idx + 1,
      descricao: t.desc,
      unidade: t.un,
      quantidade: t.qty,
      valor_unitario: unit,
      valor_total: Math.round(unit * t.qty * 100) / 100
    };
  });
}

function sumItems(items: PlannedItem[]): number {
  return Math.round(items.reduce((acc, it) => acc + it.valor_total, 0) * 100) / 100;
}

function pesquisaItensToPlanned(proc: ProcurementProcess): PlannedItem[] {
  const uploaded = proc.pesquisa_preco_itens;
  if (!Array.isArray(uploaded) || uploaded.length === 0) return [];
  return uploaded.map((it, idx) => {
    const medida = (it.medida || 'UN').trim();
    const qty = Number(it.quantidade) > 0 ? Number(it.quantidade) : 1;
    const unit = Number(it.valor_unitario) >= 0 ? Number(it.valor_unitario) : 0;
    const total = Number(it.valor_total) > 0 ? Number(it.valor_total) : Math.round(qty * unit * 100) / 100;
    return {
      item: Number(it.item) || idx + 1,
      descricao: it.descricao,
      unidade: medida,
      medida,
      quantidade: qty,
      valor_unitario: unit,
      valor_total: total
    };
  });
}

function getModalityProceduralGuidance(proc: ProcurementProcess): {
  formaSessao: string;
  credenRegra: string;
  disputaResumo: string;
  baseRegime: string;
} {
  switch (proc.modalidade) {
    case 'PREGAO_PRESENCIAL':
    case 'CONCORRENCIA_PRESENCIAL':
      return {
        formaSessao:
          'Sessão pública PRESENCIAL na sede administrativa do Órgão Promotor, com registro obrigatório em ata e gravação integral em áudio e vídeo (Art. 17, §§ 2º e 5º da Lei nº 14.133/2021).',
        credenRegra:
          'Os interessados deverão comparecer na sessão pública presencial munidos de Carta de Credenciamento, documentos de representação legal e envelopes lacrados de proposta e habilitação, sendo toda a sessão gravada em áudio e vídeo anexados aos autos.',
        disputaResumo:
          'O procedimento presencial observa a justificativa técnica de excepcionalidade constante no ETP (Art. 17, § 2º) e realiza-se com pregão verbal/lances presenciais e gravação audiovisual obrigatória (§ 5º).',
        baseRegime: 'Art. 17, §§ 2º e 5º e Art. 28 da Lei nº 14.133/2021'
      };
    case 'DISPENSA':
      return {
        formaSessao:
          'Contratação Direta por Dispensa de Licitação (Art. 75 c/c Art. 72), com divulgação de Aviso de Contratação Direta no PNCP pelo prazo mínimo de 3 (três) dias úteis (Art. 75, § 3º, quando aplicável).',
        credenRegra:
          'Os interessados poderão encaminhar propostas comerciais adicionais acompanhadas da documentação de habilitação ao endereço eletrônico/sistema oficial indicado no Preâmbulo dentro do prazo legal.',
        disputaResumo:
          'Seleção da proposta mais vantajosa com base nos preços referenciais apurados na Pesquisa de Preço (Art. 23 e Art. 72, VI e VII), respeitados os requisitos de razão da escolha do contratado e justificativa de preço.',
        baseRegime: 'Arts. 72 e 75 da Lei nº 14.133/2021'
      };
    case 'INEXIGIBILIDADE':
      return {
        formaSessao:
          'Contratação Direta por Inexigibilidade de Licitação (Art. 74 c/c Art. 72), ante a inviabilidade de competição devidamente caracterizada nos autos.',
        credenRegra:
          'A contratada exclusiva ou notoriamente especializada apresentará comprovação de exclusividade/notória especialização, proposta formal e regularidade fiscal, trabalhista e previdenciária (Arts. 62 a 68 e 72, V).',
        disputaResumo:
          'Não há disputa competitiva em razão da singularidade/exclusividade do objeto, sendo obrigatória a comprovação de compatibilidade do preço com os valores praticados pelo contratado em contratações semelhantes (Art. 23, § 4º).',
        baseRegime: 'Arts. 72 e 74 da Lei nº 14.133/2021'
      };
    case 'CONCURSO':
      return {
        formaSessao:
          'Modalidade Concurso (Art. 30), conduzida por comissão/banca julgadora especializada para escolha de trabalho técnico, científico ou artístico.',
        credenRegra:
          'Os participantes deverão inscrever seus trabalhos técnicos, científicos ou artísticos sob anonimato ou identificação regulamentada, observando critérios objetivos de pontuação artística/técnica e previsão de prêmio ou remuneração.',
        disputaResumo:
          'Julgamento pelo critério de Melhor Técnica ou Conteúdo Artístico por banca julgadora qualificada, vedada avaliação subjetiva sem critérios previamente publicados (Art. 30).',
        baseRegime: 'Art. 28, III e Art. 30 da Lei nº 14.133/2021'
      };
    case 'LEILAO':
      return {
        formaSessao:
          'Modalidade Leilão (Art. 31), conduzida por leiloeiro oficial ou servidor designado, para alienação de bens a quem oferecer o maior lance igual ou superior ao valor da avaliação.',
        credenRegra:
          'Poderão participar pessoas físicas ou jurídicas cadastradas previamente na plataforma oficial ou sessão designada, dispensada a exigência de registro cadastral prévio (Art. 31, § 4º).',
        disputaResumo:
          'Disputa pelo critério de Maior Lance (Art. 33, V), partindo do valor mínimo de avaliação apurado na Pesquisa/Laudo de Avaliação.',
        baseRegime: 'Art. 28, IV e Art. 31 da Lei nº 14.133/2021'
      };
    case 'DIALOGO_COMPETITIVO':
      return {
        formaSessao:
          'Modalidade Diálogo Competitivo (Art. 32), conduzida por comissão de contratação composta por pelo menos 3 servidores efetivos/empregados públicos (Art. 32, § 1º, XI).',
        credenRegra:
          'Os interessados que preencherem os critérios objetivos de pré-seleção participarão da fase de diálogo para construção de alternativas técnicas, sendo posteriormente convidados à apresentação de propostas finais.',
        disputaResumo:
          'Procedimento bifásico: (1) pré-seleção e diálogo para identificação de solução técnica apta a atender necessidade complexa; e (2) fase competitiva restrita aos licitantes pré-selecionados (Art. 32, § 1º).',
        baseRegime: 'Art. 28, V e Art. 32 da Lei nº 14.133/2021'
      };
    default:
      return {
        formaSessao:
          'Sessão pública ELETRÔNICA por meio do Portal Nacional de Contratações Públicas (PNCP) / Plataforma Eletrônica Oficial (Art. 17, § 2º).',
        credenRegra:
          'Poderão participar deste certame os interessados pertencentes ao ramo de atividade compatível com o objeto e que estiverem previamente credenciados no sistema eletrônico oficial indicado no Preâmbulo.',
        disputaResumo:
          'Certame conduzido preferencialmente na forma eletrônica (Art. 17, § 2º), com ampla competitividade e envio eletrônico de propostas e lances.',
        baseRegime: 'Art. 17, § 2º e Art. 28 da Lei nº 14.133/2021'
      };
  }
}

function renderItemsTableHtml(items: PlannedItem[], catalogType?: 'CATMAT' | 'CATSER'): string {
  const showCatalog = Boolean(catalogType);
  const rows = items
    .map(
      (it) => `
      <tr>
        <td>${it.item}</td>
        ${showCatalog ? `<td>${catalogType} — vincular no catálogo PNCP (Item ${String(it.item).padStart(2, '0')})</td>` : ''}
        <td>${escapeHtml(it.descricao)}</td>
        <td>${escapeHtml(it.medida || it.unidade)}</td>
        <td>${it.quantidade}</td>
        <td>${formatCurrencyBRL(it.valor_unitario)}</td>
        <td><strong>${formatCurrencyBRL(it.valor_total)}</strong></td>
      </tr>`
    )
    .join('');
  const total = sumItems(items);
  return `
  <table>
    <thead>
      <tr>
        <th>Item</th>
        ${showCatalog ? '<th>Código CATMAT/CATSER</th>' : ''}
        <th>${showCatalog ? 'Descrição / Especificação Técnica (Art. 41)' : 'Descrição'}</th>
        <th>Medida</th>
        <th>Quantidade</th>
        <th>Valor Unitário</th>
        <th>Valor Total</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      <tr>
        <td colspan="${showCatalog ? 6 : 5}"><strong>VALOR TOTAL ESTIMADO DA CONTRATAÇÃO</strong></td>
        <td><strong>${formatCurrencyBRL(total)}</strong></td>
      </tr>
    </tbody>
  </table>`;
}

function renderOpenContractItemsTableHtml(items: PlannedItem[], catalogType?: 'CATMAT' | 'CATSER'): string {
  const showCatalog = Boolean(catalogType);
  const safeItems = Array.isArray(items) && items.length > 0 ? items : [];
  const rows = safeItems
    .map(
      (it) => `
      <tr>
        <td>${it.item}</td>
        ${showCatalog ? `<td>${catalogType} — vincular no catálogo PNCP (Item ${String(it.item).padStart(2, '0')})</td>` : ''}
        <td>${escapeHtml(it.descricao)}</td>
        <td>${escapeHtml(it.medida || it.unidade)}</td>
        <td>${it.quantidade}</td>
        <td>R$ [__________]</td>
        <td><strong>R$ [__________]</strong></td>
      </tr>`
    )
    .join('');
  return `
  <table>
    <thead>
      <tr>
        <th>Item</th>
        ${showCatalog ? '<th>Código CATMAT/CATSER</th>' : ''}
        <th>${showCatalog ? 'Descrição / Especificação Técnica (Art. 41)' : 'Descrição'}</th>
        <th>Medida</th>
        <th>Quantidade</th>
        <th>Valor Unitário Contratado</th>
        <th>Valor Total Contratado</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="${showCatalog ? 7 : 6}">Especificações e quantitativos vinculados integralmente ao Termo de Referência (Anexo I).</td></tr>`}
      <tr>
        <td colspan="${showCatalog ? 6 : 5}"><strong>VALOR GLOBAL CONTRATADO (A PREENCHER CONFORME PROPOSTA VENCEDORA ADJUDICADA)</strong></td>
        <td><strong>R$ _________________</strong></td>
      </tr>
    </tbody>
  </table>`;
}

function renderMetadataGridHtml(rows: Array<[string, string]>): string {
  const trs = rows
    .map(
      ([label, valueHtml]) =>
        `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${valueHtml}</td></tr>`
    )
    .join('\n          ');
  return `<table class="meta-table">
        <tbody>
          ${trs}
        </tbody>
      </table>`;
}

function renderExecutiveCalloutHtml(title: string, bodyHtml: string): string {
  return `<blockquote class="exec-summary"><strong>${escapeHtml(title)}:</strong> ${bodyHtml}</blockquote>`;
}

function formatPrefeitoQualifiedSpan(rawName?: string | null): {
  displayName: string;
  roleForSignature: string;
  inlinePreambuloHtml: string;
} {
  const info = formatPrefeitoRoleAndName(rawName);
  const boundName = bind('prefeito_nome', info.displayName);
  return {
    displayName: info.displayName,
    roleForSignature: info.isGenericPlaceholder
      ? 'Chefe do Poder Executivo Municipal'
      : 'Prefeito(a) Municipal',
    inlinePreambuloHtml: info.isGenericPlaceholder
      ? `<strong>${boundName}</strong>`
      : `Prefeito(a) Municipal <strong>${boundName}</strong>`
  };
}

function feedbackCallout(feedback?: string): string {
  if (!feedback || !feedback.trim()) return '';
  return `<blockquote class="exec-summary"><strong>Nota de Revisão Incorporada (Feedback do Gestor):</strong> <em>${escapeHtml(feedback.trim())}</em></blockquote>`;
}

type RiskPhaseKey = 'PLANEJAMENTO' | 'SELECAO' | 'GESTAO';

interface RiskMatrixEntry {
  id: string;
  fase: string;
  fase_key: RiskPhaseKey;
  evento: string;
  causa: string;
  consequencia: string;
  probabilidade_valor: 1 | 2 | 3;
  probabilidade: 'Baixa' | 'Média' | 'Alta';
  impacto_valor: 1 | 2 | 3;
  impacto: 'Baixo' | 'Médio' | 'Alto';
  pontuacao_pxi: number;
  nivel_risco: 'Baixo' | 'Médio' | 'Alto';
  acao_preventiva: string;
  responsavel_preventiva: string;
  acao_contingencia: string;
  responsavel_contingencia: string;
  responsavel: string;
}

const PROBABILITY_LABELS: Record<1 | 2 | 3, 'Baixa' | 'Média' | 'Alta'> = {
  1: 'Baixa',
  2: 'Média',
  3: 'Alta'
};

const IMPACT_LABELS: Record<1 | 2 | 3, 'Baixo' | 'Médio' | 'Alto'> = {
  1: 'Baixo',
  2: 'Médio',
  3: 'Alto'
};

interface DomainRiskSpec {
  evento: string;
  causa: string;
  consequencia: string;
  p: 1 | 2 | 3;
  i: 1 | 2 | 3;
  preventiva: string;
  respPreventiva: string;
  contingencia: string;
  respContingencia: string;
}

interface DomainRiskProfile {
  planningSpec: DomainRiskSpec;
  supplySpec: DomainRiskSpec;
  executionSpec: DomainRiskSpec;
}

const DOMAIN_RISK_PROFILES: Record<DomainCategory, DomainRiskProfile> = {
  TI_EDUCACAO: {
    planningSpec: {
      evento: 'Especificação técnica de hardware/rede defasada, proprietária ou incompatível com a infraestrutura elétrica e lógica existente',
      causa: 'Levantamento técnico incompleto dos requisitos de compatibilidade, capacidade de carga elétrica ou direcionamento inadvertido de arquitetura',
      consequencia: 'Restrição à competitividade, impugnações ao edital ou aquisição de equipamentos inoperantes nas unidades',
      p: 2,
      i: 3,
      preventiva: 'Padronizar requisitos mínimos objetivos em normas ABNT/INMETRO e validar capacidade elétrica/rede das unidades no ETP.',
      respPreventiva: 'Integrante Técnico (TI) / Equipe de Planejamento',
      contingencia: 'Promover retificação técnica antes da publicação ou ajustar o escopo de instalação lógica previamente à entrega.',
      respContingencia: 'Equipe de Planejamento / Área Requisitante'
    },
    supplySpec: {
      evento: 'Atraso no fornecimento, descontinuidade de modelo ofertado ou entrega de equipamentos sem certificação/configuração padrão',
      causa: 'Oscilação na cadeia logística de componentes eletroeletrônicos ou ausência de conferência de homologação no recebimento provisório',
      consequencia: 'Atraso na implantação tecnológica e paralisação das atividades operacionais e pedagógicas',
      p: 2,
      i: 3,
      preventiva: 'Exigir comprovação de disponibilidade de linha vigente, checklist técnico rigoroso e aceite condicionado a testes funcionais (Art. 140).',
      respPreventiva: 'Fiscal Técnico / Equipe de Recebimento de TI',
      contingencia: 'Notificar para substituição imediata por equipamento de especificação igual ou superior sem ônus e aplicar multa moratória (Art. 156).',
      respContingencia: 'Gestor do Contrato / Fiscal Técnico'
    },
    executionSpec: {
      evento: 'Descumprimento de SLA de garantia on-site, suporte técnico ou indisponibilidade de peças de reposição durante a vigência',
      causa: 'Ausência de definição objetiva de prazos de atendimento corretivo e rede autorizada na região no Termo de Referência',
      consequencia: 'Equipamentos paralisados por longos períodos e perda prematura da vida útil do investimento público',
      p: 2,
      i: 2,
      preventiva: 'Vincular garantia mínima on-site com SLA de atendimento e chamados rastreáveis em cláusula contratual expressa.',
      respPreventiva: 'Equipe de Planejamento / Procuradoria Jurídica',
      contingencia: 'Acionar garantia contratual com contagem formal de SLA, aplicar penalidades por descumprimento e reter garantia contratual.',
      respContingencia: 'Gestor do Contrato / Fiscal Técnico'
    }
  },
  SAUDE_INSUMOS: {
    planningSpec: {
      evento: 'Especificação sanitária incompleta ou exigência de validade mínima incompatível com a cadeia de distribuição farmacêutica/hospitalar',
      causa: 'Desatualização de descritivos frente às listas RENAME/REMUME ou ausência de consulta ao histórico de consumo epidemiológico',
      consequencia: 'Licitação deserta para itens essenciais ou recebimento de lotes próximos do vencimento',
      p: 2,
      i: 3,
      preventiva: 'Conferir descritivos padronizados pela CATMAT/ANVISA, estipular validade mínima de entrega (≥ 75% ou 18 meses) e validar demanda com a Assistência Farmacêutica.',
      respPreventiva: 'Integrante Técnico (Saúde) / Coordenação de Farmácia',
      contingencia: 'Readequar cronograma de entregas fracionadas ou instruir compra emergencial fundamentada para itens críticos (Art. 75, VIII).',
      respContingencia: 'Secretaria de Saúde / Gestor do Contrato'
    },
    supplySpec: {
      evento: 'Desabastecimento pontual ou entrega de insumos/medicamentos sem registro ANVISA válido, lote divergente ou acondicionamento térmico inadequado',
      causa: 'Falha de controle de qualidade no transporte do fornecedor ou ruptura de estoque do fabricante',
      consequencia: 'Risco sanitário aos pacientes, interrupção de atendimentos nas unidades de saúde e descarte de material',
      p: 2,
      i: 3,
      preventiva: 'Exigir AFE/registro ANVISA na habilitação e instituir protocolo obrigatório de conferência de temperatura, bula e lote no almoxarifado.',
      respPreventiva: 'Fiscal Técnico (Farmacêutico) / Almoxarifado da Saúde',
      contingencia: 'Recusar imediatamente o lote irregular (Art. 140, § 1º), exigir reposição em 48h e convocar remanescente ou aplicar sanções (Art. 156).',
      respContingencia: 'Fiscal Técnico / Gestor do Contrato'
    },
    executionSpec: {
      evento: 'Desequilíbrio entre a demanda sazonal das unidades de saúde e o cronograma de entregas ou vencimento de estoque parado',
      causa: 'Ausência de monitoramento contínuo de estoque mínimo/máximo e acionamento tardio das ordens de fornecimento',
      consequencia: 'Falta de insumos na ponta ou prejuízo ao erário por perda de validade em almoxarifado',
      p: 2,
      i: 2,
      preventiva: 'Estabelecer entregas parceladas sob demanda com controle mensal de estoque e termo de troca para lotes próximos ao vencimento.',
      respPreventiva: 'Gestor do Contrato / Controle de Estoque da Saúde',
      contingencia: 'Reprogramar ordens de fornecimento e executar remanejamento interfederativo ou aditivo legal (Art. 125).',
      respContingencia: 'Gestor do Contrato / Secretaria de Saúde'
    }
  },
  OBRAS_ENGENHARIA: {
    planningSpec: {
      evento: 'Inconsistências em projeto básico, levantamentos topográficos/geotécnicos ou defasagem na planilha orçamentária (SINAPI/SICRO)',
      causa: 'Elaboração apressada de projetos sem vistoria prévia completa do local de intervenção e interferências de redes existentes',
      consequencia: 'Necessidade de aditivos expressivos de prazo e valor, paralisação da obra ou questionamento pelos órgãos de controle',
      p: 2,
      i: 3,
      preventiva: 'Realizar vistoria técnica detalhada, exigir ART/RRT dos responsáveis técnicos pelos projetos e auditar composições unitárias SINAPI/SICRO.',
      respPreventiva: 'Engenheiro / Arquiteto Responsável Técnico',
      contingencia: 'Suspender frentes impactadas, instruir revisão técnica formal com justificativa circunstanciada e limite legal (Art. 125).',
      respContingencia: 'Gestor do Contrato / Secretaria de Obras'
    },
    supplySpec: {
      evento: 'Descompasso no cronograma físico-financeiro, mobilização insuficiente de equipe/equipamentos ou uso de materiais fora das normas ABNT',
      causa: 'Capacidade operacional subestimada da contratada ou deficiência nos ensaios tecnológicos de recebimento em canteiro',
      consequencia: 'Atraso na entrega do equipamento público, patologias construtivas precoces e risco de abandono da obra',
      p: 2,
      i: 3,
      preventiva: 'Exigir Diário de Obra atualizado, ensaios tecnológicos laboratoriais vinculados à medição e fiscalização presencial periódica (Art. 117).',
      respPreventiva: 'Fiscal de Obra (Engenharia) / Gestor do Contrato',
      contingencia: 'Reter medição de etapa não conforme, notificar plano de recuperação de cronograma sob pena de multa e rescisão (Art. 137).',
      respContingencia: 'Fiscal de Obra / Procuradoria Jurídica'
    },
    executionSpec: {
      evento: 'Divergência em medições de serviços executados ou ausência de documentação final (as built, ART/RRT e habite-se/recebimento definitivo)',
      causa: 'Critérios de medição pouco objetivos no edital/contrato ou falhas no acompanhamento documental de encerramento da obra',
      consequencia: 'Pagamento indevido por quantitativo não executado ou impossibilidade de regularizar e utilizar a edificação pública',
      p: 1,
      i: 3,
      preventiva: 'Definir critérios objetivos de medição por etapa concluída e condicionar a última parcela ao recebimento definitivo e entrega de as built.',
      respPreventiva: 'Fiscal de Obra / Setor de Controle Interno',
      contingencia: 'Realizar levantamento físico corretivo (glosa de valores), exigir correções antes do aceite definitivo e reter garantia contratual.',
      respContingencia: 'Gestor do Contrato / Comissão de Recebimento'
    }
  },
  SERVICOS_CONTINUOS: {
    planningSpec: {
      evento: 'Dimensionamento impreciso de postos/horas técnicas ou omissão de encargos trabalhistas, insumos e benefícios na planilha de custos',
      causa: 'Desatualização em relação à Convenção Coletiva de Trabalho (CCT) vigente ou ausência de levantamento histórico da carga de trabalho',
      consequencia: 'Propostas inexequíveis, repactuações imediatas ou rotatividade excessiva de mão de obra',
      p: 2,
      i: 3,
      preventiva: 'Adotar modelo de planilha de custos e formação de preços baseada na CCT vigente e validar escala de cobertura junto às unidades atendidas.',
      respPreventiva: 'Integrante Técnico / Equipe de Planejamento',
      contingencia: 'Realizar diligência saneadora na etapa de proposta (Art. 59, § 2º) ou revisar o dimensionamento contratual antes da ordem de serviço.',
      respContingencia: 'Agente de Contratação / Gestor do Contrato'
    },
    supplySpec: {
      evento: 'Falha na mobilização inicial de equipe, ausência de EPIs/insumos ou descumprimento contínuo dos níveis mínimos de serviço (IMR/ANS)',
      causa: 'Recrutamento tardio pela contratada ou ausência de instrumento de medição de resultado vinculado ao pagamento mensal',
      consequencia: 'Prejuízo à rotina operacional das repartições e atendimento precário à população',
      p: 2,
      i: 3,
      preventiva: 'Instituir Instrumento de Medição de Resultados (IMR) com faixas objetivas de glosa proporcional e exigir comprovação de treinamentos/EPIs na implantação.',
      respPreventiva: 'Fiscal Técnico / Gestor do Contrato',
      contingencia: 'Aplicar glosa automática via IMR, notificar substituição de posto descoberto em 24h e instaurar processo sancionador em caso de reincidência.',
      respContingencia: 'Fiscal Técnico / Gestor do Contrato'
    },
    executionSpec: {
      evento: 'Inadimplemento de salários, vale-alimentação, FGTS ou INSS pela contratada gerando risco de responsabilidade subsidiária do Município (Art. 121)',
      causa: 'Fragilidade financeira da prestadora ou deficiência na conferência mensal da documentação trabalhista antes da liquidação da fatura',
      consequencia: 'Paralisação dos colaboradores terceirizados, ações trabalhistas contra o ente público e bloqueio judicial',
      p: 2,
      i: 3,
      preventiva: 'Exigir comprovação mensal de folha de pagamento, GFIP/eSocial, FGTS e INSS (e conta vinculada/pagamento pelo fato gerador, se aplicável).',
      respPreventiva: 'Fiscal Administrativo / Secretaria de Fazenda',
      contingencia: 'Promover retenção cautelar de créditos devidos à contratada para pagamento direto aos empregados (Art. 121, § 3º) e rescindir unilateralmente.',
      respContingencia: 'Gestor do Contrato / Procuradoria Jurídica'
    }
  },
  FROTA_VEICULOS: {
    planningSpec: {
      evento: 'Especificação veicular/operacional superdimensionada ou incompatível com as vias locais, normas CONTRAN/PROCONVE e custo total de propriedade (TCO)',
      causa: 'Falta de avaliação conjunta de consumo, manutenção em rede autorizada próxima e adaptações específicas do serviço público',
      consequencia: 'Sobrepreço, deserção de fornecedores regionais ou veículos ociosos por dificuldade de manutenção',
      p: 2,
      i: 3,
      preventiva: 'Especificar parâmetros mínimos de desempenho, segurança veicular e exigência de assistência técnica autorizada em raio territorial viável.',
      respPreventiva: 'Integrante Técnico (Frota) / Área Requisitante',
      contingencia: 'Revisar especificações de potência/adaptação sem restrição de marca e reabrir prazo editalício (Art. 55, § 1º).',
      respContingencia: 'Equipe de Planejamento / Agente de Contratação'
    },
    supplySpec: {
      evento: 'Atraso no faturamento/entrega de fábrica, divergência em adaptações especiais ou pendência documental para emplacamento/licenciamento',
      causa: 'Prazo exíguo para transformadoras/implementadoras ou falha na conferência do chassi, RENAVAM e itens de fábrica na entrega técnica',
      consequencia: 'Frota indisponível para atendimento emergencial/operacional e perda do prazo de vigência de recursos vinculados',
      p: 2,
      i: 3,
      preventiva: 'Fixar cronograma realista compatível com prazos de fábrica/implementação e vincular o recebimento definitivo à entrega técnica e documentação de primeiro emplacamento.',
      respPreventiva: 'Fiscal Técnico (Transportes) / Gestor do Contrato',
      contingencia: 'Notificar formalmente com cobrança de multa diária (Art. 156) e exigir veículo/solução provisória ou substituição imediata caso haja inconformidade.',
      respContingencia: 'Gestor do Contrato / Área Requisitante'
    },
    executionSpec: {
      evento: 'Recusa ou demora excessiva em atendimentos de garantia de fábrica, revisões programadas e fornecimento de peças de reposição',
      causa: 'Distância elevada da concessionária autorizada ou ausência de prazos máximos de imobilização do veículo no contrato',
      consequencia: 'Veículos parados em oficina por meses, comprometendo o transporte público, escolar ou de saúde',
      p: 2,
      i: 2,
      preventiva: 'Exigir declaração de rede de assistência técnica e estabelecer prazo máximo para diagnóstico e reparo em garantia no Termo de Referência.',
      respPreventiva: 'Equipe de Planejamento / Fiscal de Frota',
      contingencia: 'Acionar formalmente o fabricante, aplicar penalidades contratuais pelo tempo de indisponibilidade e acionar seguro/garantia.',
      respContingencia: 'Gestor do Contrato / Fiscal de Frota'
    }
  },
  BENS_GERAIS: {
    planningSpec: {
      evento: 'Descrição imprecisa do objeto, ausência de padrões mínimos de qualidade/sustentabilidade (Art. 45) ou parcelamento inadequado em lote único',
      causa: 'Reaproveitamento de especificações genéricas sem verificar a divisibilidade técnica e econômica dos itens (Art. 40, § 2º e § 3º)',
      consequencia: 'Recebimento de bens de baixa durabilidade, restrição injustificada a fornecedores especializados e perda de economicidade',
      p: 2,
      i: 2,
      preventiva: 'Padronizar especificações técnicas por desempenho, critérios de sustentabilidade (ABNT/INMETRO) e justificar o parcelamento por item no ETP.',
      respPreventiva: 'Equipe de Planejamento / Área Requisitante',
      contingencia: 'Adequação do Termo de Referência antes da divulgação do edital ou retificação do critério de julgamento por item.',
      respContingencia: 'Agente de Contratação / Equipe de Planejamento'
    },
    supplySpec: {
      evento: 'Atraso na entrega ou fornecimento de bens/materiais com qualidade inferior à amostra/catálogo aprovado na licitação',
      causa: 'Falha logística do contratado ou substituição unilateral de marca/modelo sem prévia autorização da Administração',
      consequencia: 'Desabastecimento da unidade requisitante e necessidade de retrabalho no processo de devolução',
      p: 2,
      i: 3,
      preventiva: 'Conferir obrigatoriamente marca, modelo, integridade e conformidade técnica com a proposta vencedora no recebimento provisório (Art. 140).',
      respPreventiva: 'Fiscal Técnico / Almoxarifado Central',
      contingencia: 'Recusar o recebimento de item divergente, fixar prazo improrrogável de substituição sem custos e instaurar processo sancionador (Art. 155/156).',
      respContingencia: 'Gestor do Contrato / Fiscal Técnico'
    },
    executionSpec: {
      evento: 'Omissão do fornecedor na assistência técnica, garantia contra vícios ocultos ou descarte/logística reversa durante o ciclo de vida do bem',
      causa: 'Falta de registro sistemático dos prazos de garantia por lote entregue e ausência de notificação tempestiva de defeitos',
      consequencia: 'Inutilização precoce dos bens adquiridos e necessidade de nova despesa pública antes do previsto',
      p: 1,
      i: 2,
      preventiva: 'Estabelecer termo de garantia formal no recebimento definitivo e manter controle patrimonial/garantia na unidade gestora.',
      respPreventiva: 'Fiscal Técnico / Setor de Patrimônio',
      contingencia: 'Notificar extrajudicialmente o fornecedor para troca/reparo no prazo legal e aplicar sanção de impedimento em caso de inércia.',
      respContingencia: 'Gestor do Contrato / Procuradoria Jurídica'
    }
  }
};

function createRisk(params: {
  id: string;
  fase_key: RiskPhaseKey;
  fase: string;
  evento: string;
  causa: string;
  consequencia: string;
  p: 1 | 2 | 3;
  i: 1 | 2 | 3;
  acao_preventiva: string;
  responsavel_preventiva: string;
  acao_contingencia: string;
  responsavel_contingencia: string;
}): RiskMatrixEntry {
  const score = params.p * params.i;
  const nivel: 'Baixo' | 'Médio' | 'Alto' = score >= 6 ? 'Alto' : score >= 3 ? 'Médio' : 'Baixo';
  return {
    id: params.id,
    fase: params.fase,
    fase_key: params.fase_key,
    evento: params.evento,
    causa: params.causa,
    consequencia: params.consequencia,
    probabilidade_valor: params.p,
    probabilidade: PROBABILITY_LABELS[params.p],
    impacto_valor: params.i,
    impacto: IMPACT_LABELS[params.i],
    pontuacao_pxi: score,
    nivel_risco: nivel,
    acao_preventiva: params.acao_preventiva,
    responsavel_preventiva: params.responsavel_preventiva,
    acao_contingencia: params.acao_contingencia,
    responsavel_contingencia: params.responsavel_contingencia,
    responsavel: `${params.responsavel_preventiva} / ${params.responsavel_contingencia}`
  };
}

function buildObjectSpecificRisks(params: {
  category: DomainCategory;
  objetoConsolidado: string;
  secNome: string;
  modalidadeLabel: string;
  usarSrp: boolean;
  direct: boolean;
  itemsCount: number;
  totalValor: number;
}): RiskMatrixEntry[] {
  const { category, objetoConsolidado, secNome, modalidadeLabel, usarSrp, direct, itemsCount, totalValor } = params;
  const profile = DOMAIN_RISK_PROFILES[category];

  return [
    // FASE 1: Planejamento da Contratação (4 riscos concretos)
    createRisk({
      id: 'R01',
      fase_key: 'PLANEJAMENTO',
      fase: 'Planejamento',
      evento: `Subdimensionamento ou superdimensionamento dos quantitativos (${itemsCount} item(ns)) para ${objetoConsolidado}`,
      causa: `Ausência de série histórica consolidada na ${secNome} ou falha na memória de cálculo do DFD/ETP`,
      consequencia: usarSrp
        ? 'Consumo precoce da Ata de Registro de Preços ou expectativa frustrada de demanda sem aquisição efetiva'
        : 'Desabastecimento do serviço público ou imobilização desnecessária de dotação orçamentária',
      p: 2,
      i: 3,
      acao_preventiva: 'Validar a memória de cálculo do ETP com os responsáveis operacionais das unidades antes da aprovação do Termo de Referência.',
      responsavel_preventiva: `Equipe de Planejamento / ${secNome}`,
      acao_contingencia: usarSrp
        ? 'Gerenciar empenhos estritamente conforme demanda real na vigência da Ata (Art. 82).'
        : 'Instruir aditivo quantitativo dentro do limite legal de 25% (Art. 125) com justificativa técnica.',
      responsavel_contingencia: 'Gestor do Contrato / Área Requisitante'
    }),
    createRisk({
      id: 'R02',
      fase_key: 'PLANEJAMENTO',
      fase: 'Planejamento',
      evento: `Pesquisa de preços distorcida ou acima dos parâmetros de mercado para ${objetoConsolidado} (estimativa ${formatCurrencyBRL(totalValor)})`,
      causa: 'Cesta de preços baseada em amostra restrita de fornecedores diretos sem consulta prioritária ao PNCP e Painel de Preços (IN SEGES/ME nº 65/2021)',
      consequencia: 'Risco de sobrepreço na contratação ou certame deserto/fracassado por preços referenciais inexequíveis',
      p: 2,
      i: 3,
      acao_preventiva: 'Compor mapa comparativo de preços conforme hierarquia do Art. 23 (PNCP, Painel de Preços, atas vigentes e 3 cotações válidas), saneando outliers.',
      responsavel_preventiva: 'Setor de Pesquisa de Preços / Compras',
      acao_contingencia: 'Refazer e ampliar a pesquisa de preços antes da sessão pública ou ajustar o valor máximo aceitável em edital retificado.',
      responsavel_contingencia: 'Equipe de Planejamento / Setor de Compras'
    }),
    createRisk({
      id: 'R03',
      fase_key: 'PLANEJAMENTO',
      fase: 'Planejamento',
      evento: profile.planningSpec.evento,
      causa: profile.planningSpec.causa,
      consequencia: profile.planningSpec.consequencia,
      p: profile.planningSpec.p,
      i: profile.planningSpec.i,
      acao_preventiva: profile.planningSpec.preventiva,
      responsavel_preventiva: profile.planningSpec.respPreventiva,
      acao_contingencia: profile.planningSpec.contingencia,
      responsavel_contingencia: profile.planningSpec.respContingencia
    }),
    createRisk({
      id: 'R04',
      fase_key: 'PLANEJAMENTO',
      fase: 'Planejamento',
      evento: `Parcelamento inadequado (lote global injustificado ou fragmentação antieconômica) ou fragilidade na segregação de funções em ${secNome}`,
      causa: 'Ausência de teste cumulativo do Art. 40, § 3º no ETP ou acúmulo indevido de funções entre requisitante e pregoeiro (Art. 7º, § 1º)',
      consequencia: 'Anulação potencial do certame pelos Tribunais de Contas (Súmula nº 247/TCU) ou conflito de interesses na condução licitatória',
      p: 1,
      i: 3,
      acao_preventiva: 'Registrar justificativa técnica do critério por item/lote no ETP e formalizar equipe distinta entre planejamento, seleção e fiscalização.',
      responsavel_preventiva: 'Equipe de Planejamento / Autoridade Competente',
      acao_contingencia: 'Adequar a divisão de lotes antes da publicação do Edital ou redistribuir portaria de designação de agentes.',
      responsavel_contingencia: 'Procuradoria Jurídica / Ordenador de Despesas'
    }),

    // FASE 2: Seleção do Fornecedor (4 riscos concretos)
    createRisk({
      id: 'R05',
      fase_key: 'SELECAO',
      fase: 'Seleção do Fornecedor',
      evento: `Impugnação ou pedido de esclarecimento suspensivo no instrumento de ${modalidadeLabel} para ${objetoConsolidado}`,
      causa: 'Cláusula técnica potencialmente restritiva, prazo exíguo de entrega ou exigência desproporcional de qualificação técnica',
      consequencia: 'Suspensão do cronograma licitatório, atraso na contratação e retrabalho administrativo',
      p: 1,
      i: 3,
      acao_preventiva: 'Submeter edital e Termo de Referência ao controle prévio de legalidade (Art. 53) e revisar exigências frente às Súmulas do TCU.',
      responsavel_preventiva: 'Procuradoria Jurídica / Agente de Contratação',
      acao_contingencia: 'Acolher impugnação procedente com celeridade, retificar a cláusula e reabrir os prazos legais de divulgação (Art. 55, § 1º).',
      responsavel_contingencia: 'Agente de Contratação / Autoridade Competente'
    }),
    createRisk({
      id: 'R06',
      fase_key: 'SELECAO',
      fase: 'Seleção do Fornecedor',
      evento: direct
        ? `Deficiência na comprovação de vantajosidade do preço ou na razão de escolha do fornecedor na ${modalidadeLabel}`
        : `Apresentação de lances manifestamente inexequíveis ou abandono após a fase de disputa em ${modalidadeLabel}`,
      causa: direct
        ? 'Ausência de demonstrativo comparativo objetivo ou certidões de regularidade desatualizadas (Art. 72)'
        : 'Erro de precificação pelo licitante durante a etapa competitiva ou tentativa de especulação de proposta',
      consequencia: direct
        ? 'Reprovação jurídica/controle interno ou apontamento por contratação direta irregular'
        : 'Retorno de fase, atraso na adjudicação e risco de inexecução contratual precoce',
      p: 2,
      i: 2,
      acao_preventiva: direct
        ? 'Instruir o processo com justificativa detalhada de preço (Art. 23), razão da escolha e check completo de habilitação (Art. 72).'
        : 'Inserir critérios objetivos de aferição de exequibilidade no edital e realizar diligência de planilha de custos antes da aceitação (Art. 59, § 2º).',
      responsavel_preventiva: 'Agente de Contratação / Pregoeiro',
      acao_contingencia: direct
        ? 'Complementar a instrução probatória ou converter o rito para procedimento competitivo ordinário.'
        : 'Desclassificar proposta inexequível, convocar licitantes remanescentes na ordem de classificação (Art. 90, § 2º) e abrir processo sancionador (Art. 155).',
      responsavel_contingencia: 'Agente de Contratação / Autoridade Competente'
    }),
    createRisk({
      id: 'R07',
      fase_key: 'SELECAO',
      fase: 'Seleção do Fornecedor',
      evento: `Inabilitação em sequência ou baixa participação competitiva para fornecimento de ${objetoConsolidado}`,
      causa: 'Exigências de qualificação econômico-financeira ou atestados de capacidade técnica incompatíveis com a parcela de maior relevância',
      consequencia: 'Licitação fracassada ou deserta, comprometendo o atendimento da demanda dentro do exercício financeiro',
      p: 1,
      i: 2,
      acao_preventiva: 'Limitar atestados às parcelas de maior relevância técnica/valor (Art. 67) e ampliar divulgação no PNCP e sítio eletrônico oficial (Art. 54).',
      responsavel_preventiva: 'Equipe de Planejamento / Setor de Licitações',
      acao_contingencia: 'Aplicar o saneamento de documentos/diligências complementares (Art. 64) ou republicar o certame com condições ajustadas (Art. 75, III se aplicável).',
      responsavel_contingencia: 'Agente de Contratação / Secretaria Requisitante'
    }),
    createRisk({
      id: 'R08',
      fase_key: 'SELECAO',
      fase: 'Seleção do Fornecedor',
      evento: `Adjudicação a empresa impedida de licitar (CEIS/CNEP/TCU) ou falha na aplicação da LC nº 123/2006 (${modalidadeLabel})`,
      causa: 'Omissão na consulta consolidada de idoneidade prévia à habilitação ou extrapolação dos limites do Art. 4º da Lei nº 14.133/2021',
      consequencia: 'Nulidade do ato de adjudicação/contrato e responsabilização solidária dos agentes envolvidos no julgamento',
      p: 1,
      i: 3,
      acao_preventiva: 'Emitir certidões consolidadas (TCU, CNJ, CEIS e CNEP) e verificar faturamento anual de ME/EPP (Art. 4º, § 2º) antes da adjudicação.',
      responsavel_preventiva: 'Agente de Contratação / Equipe de Apoio',
      acao_contingencia: 'Inabilitar imediatamente o licitante impedido com registro em ata e convocar o próximo colocado na ordem de classificação.',
      responsavel_contingencia: 'Agente de Contratação / Procuradoria Jurídica'
    }),

    // FASE 3: Gestão Contratual e Execução (4 riscos concretos)
    createRisk({
      id: 'R09',
      fase_key: 'GESTAO',
      fase: 'Gestão Contratual e Execução',
      evento: profile.supplySpec.evento,
      causa: profile.supplySpec.causa,
      consequencia: profile.supplySpec.consequencia,
      p: profile.supplySpec.p,
      i: profile.supplySpec.i,
      acao_preventiva: profile.supplySpec.preventiva,
      responsavel_preventiva: profile.supplySpec.respPreventiva,
      acao_contingencia: profile.supplySpec.contingencia,
      responsavel_contingencia: profile.supplySpec.respContingencia
    }),
    createRisk({
      id: 'R10',
      fase_key: 'GESTAO',
      fase: 'Gestão Contratual e Execução',
      evento: usarSrp
        ? `Pedido de reequilíbrio econômico-financeiro ou cancelamento de preço registrado na Ata de ${objetoConsolidado}`
        : profile.executionSpec.evento,
      causa: usarSrp
        ? 'Oscilação superveniente de custos de insumos/frete durante a validade de 12 meses da Ata de Registro de Preços'
        : profile.executionSpec.causa,
      consequencia: usarSrp
        ? 'Interrupção das requisições pelas secretarias participantes ou necessidade de convocação de cadastro de reserva'
        : profile.executionSpec.consequencia,
      p: usarSrp ? 2 : profile.executionSpec.p,
      i: usarSrp ? 2 : profile.executionSpec.i,
      acao_preventiva: usarSrp
        ? 'Formar cadastro de reserva no certame (Art. 82, VII) e prever rito objetivo de revisão e negociação de preços na minuta da Ata.'
        : profile.executionSpec.preventiva,
      responsavel_preventiva: usarSrp
        ? 'Setor de Licitações / Órgão Gerenciador do SRP'
        : profile.executionSpec.respPreventiva,
      acao_contingencia: usarSrp
        ? 'Convocar fornecedores do cadastro de reserva ou liberar o detentor mediante comprovação documental idônea antes do cancelamento (Art. 82).'
        : profile.executionSpec.contingencia,
      responsavel_contingencia: usarSrp
        ? 'Gestor da Ata / Procuradoria Jurídica'
        : profile.executionSpec.respContingencia
    }),
    createRisk({
      id: 'R11',
      fase_key: 'GESTAO',
      fase: 'Gestão Contratual e Execução',
      evento: `Perda superveniente de regularidade fiscal ou atraso no fluxo de liquidação e pagamento na execução para ${secNome}`,
      causa: 'Pendência de certidões negativas (CND Federal, FGTS, Trabalhista) pelo contratado ou falha no empenho prévio e atesto da nota fiscal',
      consequencia: 'Incidência de atualização monetária por atraso e risco de suspensão legítima da execução pela contratada (Art. 137, § 2º, IV)',
      p: 1,
      i: 3,
      acao_preventiva: 'Emitir nota de empenho prévio antes da ordem de execução e exigir conferência mensal automática de regularidade fiscal (Art. 92, XVI).',
      responsavel_preventiva: 'Fiscal Administrativo / Secretaria de Fazenda',
      acao_contingencia: 'Notificar o contratado para regularização em 5 dias úteis mantendo o atesto do serviço efetivamente prestado para evitar enriquecimento sem causa.',
      responsavel_contingencia: 'Gestor do Contrato / Controle Interno'
    }),
    createRisk({
      id: 'R12',
      fase_key: 'GESTAO',
      fase: 'Gestão Contratual e Execução',
      evento: `Fiscalização formal deficiente, ausência de aferição objetiva de IMR ou vencimento sem prorrogação tempestiva (${objetoConsolidado})`,
      causa: 'Falta de livro de ocorrências (Art. 117, § 1º) ou início tardio do procedimento de renovação/nova licitação antes do termo final',
      consequencia: 'Pagamento integral por prestação desconforme ou contratação emergencial indevida por desídia administrativa',
      p: 2,
      i: 3,
      acao_preventiva: 'Implantar checklist mensal do Instrumento de Medição de Resultados (IMR) e alerta automático 90 dias antes do vencimento contratual.',
      responsavel_preventiva: 'Gestor do Contrato / Fiscal Técnico',
      acao_contingencia: 'Aplicar glosas proporcionais em fatura conforme faixas do IMR, notificar formalmente e instaurar apuração sancionatória (Art. 156).',
      responsavel_contingencia: 'Gestor do Contrato / Ordenador de Despesas'
    })
  ];
}

function renderRiskPhaseTableHtml(phaseHeading: string, phaseRisks: RiskMatrixEntry[]): string {
  const rowsHtml = phaseRisks
    .map(
      (r) => `
        <tr>
          <td><strong>${escapeHtml(r.id)} - ${escapeHtml(r.fase)}</strong></td>
          <td>${escapeHtml(r.evento)}</td>
          <td>${escapeHtml(r.causa)}</td>
          <td>${escapeHtml(r.consequencia)}</td>
          <td>${r.probabilidade} (${r.probabilidade_valor})</td>
          <td>${r.impacto} (${r.impacto_valor})</td>
          <td><strong>${r.nivel_risco} (${r.pontuacao_pxi})</strong></td>
          <td>${escapeHtml(r.acao_preventiva)}<br/><strong>Responsável:</strong> ${escapeHtml(r.responsavel_preventiva)}</td>
          <td>${escapeHtml(r.acao_contingencia)}<br/><strong>Responsável:</strong> ${escapeHtml(r.responsavel_contingencia)}</td>
        </tr>`
    )
    .join('');

  return `
    <h3>${escapeHtml(phaseHeading)}</h3>
    <table>
      <thead>
        <tr>
          <th>ID e Fase</th>
          <th>Evento de Risco</th>
          <th>Causa Provável</th>
          <th>Consequência / Dano</th>
          <th>Probabilidade (P)</th>
          <th>Impacto (I)</th>
          <th>Nível de Risco (P × I)</th>
          <th>Ação Preventiva e Responsável</th>
          <th>Ação de Contingência e Responsável</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>`;
}

interface ImrIndicatorSpec {
  indicador: string;
  meta: string;
  formaAfericao: string;
  faixaGlosa: string;
}

interface Art103RiskAllocationSpec {
  evento: string;
  alocacao: 'Contratada' | 'Contratante' | 'Compartilhada';
  fundamento: string;
  mecanismo: string;
}

interface TcoAlternativeSpec {
  solucao: string;
  capex: string;
  opex: string;
  vantagens: string;
  riscosLimites: string;
  conclusao: string;
}

interface DomainDeepProfile {
  normasTecnicas: string;
  ppaEstrategico: string;
  formulaDimensionamento: string;
  cenarioInercia: string;
  tcoAlternativas: TcoAlternativeSpec[];
  imrIndicadores: ImrIndicatorSpec[];
  alocacaoRiscosArt103: Art103RiskAllocationSpec[];
  indicesContabeisArt69: string;
}

type TableCellSpec = string | { label: string; detail?: string; strong?: boolean };

function renderStructuredTableHtml(headers: string[], rows: TableCellSpec[][]): string {
  const ths = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const trs = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => {
            if (typeof cell === 'string') {
              return `<td>${escapeHtml(cell)}</td>`;
            }
            if (cell.detail) {
              return `<td><strong>${escapeHtml(cell.label)}</strong><br/>${escapeHtml(cell.detail)}</td>`;
            }
            return `<td>${cell.strong ? `<strong>${escapeHtml(cell.label)}</strong>` : escapeHtml(cell.label)}</td>`;
          })
          .join('')}</tr>`
    )
    .join('');
  return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

const DOMAIN_DEEP_SPECS: Record<DomainCategory, DomainDeepProfile> = {
  TI_EDUCACAO: {
    normasTecnicas:
      'ABNT NBR IEC 60950 / 62368-1 (Segurança elétrica de TI), Certificação INMETRO Portaria nº 170/2012 (ou equivalente com ensaio acreditado), Eficiência Energética PROCEL/ENERGY STAR, Diretiva RoHS, Norma ABNT NBR 14565 (Cabeamento Estruturado) e padrões de acessibilidade e interoperabilidade da Rede Municipal (e-PING).',
    ppaEstrategico:
      'Alinhado ao Plano Plurianual (PPA) — Programa de Modernização Tecnológica e Inclusão Digital Municipal, às metas de infraestrutura escolar do Plano Municipal de Educação (PME) e às diretrizes de Governo Digital (Lei nº 14.129/2021).',
    formulaDimensionamento:
      'Cálculo baseado na razão aluno/usuário por estação ativa, somada à taxa anual de depreciação tecnológica (ciclo de 4 a 5 anos), déficit de pontos de rede por unidade e reserva técnica operacional de 5% para continuidade imediata.',
    cenarioInercia:
      'Descontinuidade de rotinas pedagógicas e administrativas digitais, indisponibilidade de sistemas essenciais, risco de perda de dados por falhas de hardware obsoleto e vulnerabilidade de segurança cibernética por equipamentos sem suporte de fabricante.',
    tcoAlternativas: [
      {
        solucao: 'Solução A: Aquisição definitiva com garantia técnica on-site de 36 meses',
        capex: 'Investimento inicial integral por unidade adquirida',
        opex: 'Custo residual reduzido em razão da garantia on-site inclusa e menor consumo elétrico',
        vantagens: 'Incorporação patrimonial, previsibilidade de Custo Total de Propriedade (TCO) e SLA contratual rigoroso',
        riscosLimites: 'Depreciação tecnológica ao término do ciclo de garantia',
        conclusao: 'RECOMENDADA (Menor TCO em 36 meses)'
      },
      {
        solucao: 'Solução B: Locação / Outsourcing de parque tecnológico (HaaS)',
        capex: 'Nulo na adesão inicial',
        opex: 'Mensalidades contínuas elevadas (130% a 165% do valor de compra ao fim de 36 meses)',
        vantagens: 'Substituição de ativos sem imobilização de capital',
        riscosLimites: 'Dependência crônica do locador e perda de patrimônio ao fim do contrato',
        conclusao: 'Inviável para equipamentos de uso permanente escolar/administrativo'
      },
      {
        solucao: 'Solução C: Manutenção corretiva emergencial de parque legado',
        capex: 'Nulo no curto prazo',
        opex: 'Elevado custo por peça avulsa escassa e perda de produtividade por paradas frequentes',
        vantagens: 'Posterga desembolso imediato',
        riscosLimites: 'Incompatibilidade com sistemas atuais e alta indisponibilidade operacional',
        conclusao: 'Tecnicamente inadequada e antieconômica'
      }
    ],
    imrIndicadores: [
      {
        indicador: 'IND-01: Conformidade Técnica e Integridade na Entrega',
        meta: '100% dos equipamentos conformes ao TR, lacrados e com nº de série conferido no prazo máximo contratual',
        formaAfericao: 'Checklist de recebimento provisório/definitivo pelo Fiscal Técnico no ato do comissionamento',
        faixaGlosa: 'Atraso > 2 dias úteis ou entrega divergente: glosa de 1% a 3% sobre a parcela entregue fora do SLA + multa moratória'
      },
      {
        indicador: 'IND-02: SLA de Atendimento em Garantia On-Site',
        meta: 'Atendimento e solução de chamados críticos em até 48 horas úteis sem custos adicionais',
        formaAfericao: 'Relatório mensal de chamados abertos versus encerrados emitido pela área de TI requisitante',
        faixaGlosa: 'SLA < 95% no mês de apuração: retenção escalonada de 2% (90%-94,9%) a 5% (< 90%) sobre eventual parcela mensal ou acionamento da garantia contratual'
      },
      {
        indicador: 'IND-03: Disponibilidade Operacional de Parque Comissionado',
        meta: 'Disponibilidade média mensal ≥ 98,5% durante a vigência da garantia/suporte',
        formaAfericao: 'Relatório técnico de incidentes recorrentes (mesmo defeito > 2x em 30 dias)',
        faixaGlosa: 'Equipamento inoperante > 5 dias úteis sem backup equivalente: substituição definitiva obrigatória em 72h sob pena de sanção contratual'
      },
      {
        indicador: 'IND-04: Conformidade Documental e Fiscal Contínua',
        meta: '100% das notas fiscais acompanhadas de certidões vigentes (Art. 92, XVI) e relatórios técnicos',
        formaAfericao: 'Conferência mensal do Fiscal Administrativo antes do atesto para liquidação',
        faixaGlosa: 'Pendência documental impede o atesto definitivo até regularização formal sem juros moratórios contra o Erário'
      }
    ],
    alocacaoRiscosArt103: [
      {
        evento: 'Variação ordinária de insumos importados ou oscilação cambial após a proposta',
        alocacao: 'Contratada',
        fundamento: 'Álea econômica ordinária — Art. 103 e Art. 124, II, "d" da Lei nº 14.133/2021',
        mecanismo: 'Preços fixos no ciclo anual, reajustáveis apenas após 12 meses pelo índice contratual IPCA/IBGE'
      },
      {
        evento: 'Vício oculto, falha prematura de hardware ou incompatibilidade elétrica de fabricação',
        alocacao: 'Contratada',
        fundamento: 'Responsabilidade objetiva do fornecedor — Art. 119 e Art. 140, § 6º da Lei nº 14.133/2021',
        mecanismo: 'Acionamento de garantia on-site e substituição integral em 72 horas sem ônus à Administração'
      },
      {
        evento: 'Atraso na disponibilização de pontos elétricos ou local de instalação nas unidades municipais',
        alocacao: 'Contratante',
        fundamento: 'Fato da Administração — Art. 137, § 2º e Art. 115, § 5º da Lei nº 14.133/2021',
        mecanismo: 'Prorrogação automática de cronograma de entrega pelo mesmo período do impedimento formalizado'
      },
      {
        evento: 'Alteração tributária superveniente ou criação de novo encargo setorial após a sessão pública',
        alocacao: 'Compartilhada',
        fundamento: 'Fato do Príncipe / Teoria da Imprevisão — Art. 124, II, "d" e Art. 134 da Lei nº 14.133/2021',
        mecanismo: 'Revisão bilateral mediante planilha analítica de impacto tributário comprovado (para mais ou para menos)'
      }
    ],
    indicesContabeisArt69:
      'Exigência cumulativa de Liquidez Geral (LG) ≥ 1,00, Solvência Geral (SG) ≥ 1,00 e Liquidez Corrente (LC) ≥ 1,00, ou Patrimônio Líquido mínimo equivalente a 10% (dez por cento) do valor estimado da contratação/lote (Art. 69, § 4º da Lei nº 14.133/2021), mediante Balanço Patrimonial dos 2 (dois) últimos exercícios sociais (Art. 69, I).'
  },
  SAUDE_INSUMOS: {
    normasTecnicas:
      'RDC ANVISA nº 430/2020 (Boas Práticas de Distribuição, Armazenagem e Transporte de Medicamentos), Lei nº 6.360/1976 (Registro Sanitário ANVISA), RDC ANVISA nº 665/2022 (Dispositivos Médicos), Portaria MS nº 2.814/1998 e normas PGRSS (RDC nº 222/2018).',
    ppaEstrategico:
      'Alinhado ao Plano Municipal de Saúde (PMS), à Programação Anual de Saúde (PAS), à Relação Municipal de Medicamentos Essenciais (REMUME) e ao bloco de custeio da Atenção Primária e Especializada do SUS.',
    formulaDimensionamento:
      'Dimensionamento apurado pelo Consumo Médio Mensal (CMM) da série histórica dos últimos 12 meses nas UBS/UPA/CAF, acrescido de estoque de segurança (margem técnica de 20% a 25% para sazonalidade epidemiológica) e deduzido do saldo em almoxarifado.',
    cenarioInercia:
      'Desabastecimento crítico da rede municipal de saúde (UBS, Pronto Atendimento e Farmácia Básica), interrupção de tratamentos contínuos de pacientes crônicos, judicialização da saúde contra o Município com bloqueios judiciais (Sequestro de Verbas) e maior custo emergencial.',
    tcoAlternativas: [
      {
        solucao: 'Solução A: Contratação programada por Registro de Preços (ou aquisição parcelada) conforme CMM',
        capex: 'Desembolso escalonado conforme emissão de Ordens de Fornecimento',
        opex: 'Redução de perdas por vencimento de validade e economia de escala na compra consolidada',
        vantagens: 'Preserva fluxo financeiro municipal, garante validade mínima ≥ 75% na entrega e rastreabilidade por lote',
        riscosLimites: 'Exige monitoramento contínuo do estoque pela Central de Abastecimento Farmacêutico (CAF)',
        conclusao: 'RECOMENDADA (Melhor eficiência clínica e econômica)'
      },
      {
        solucao: 'Solução B: Compra integral imediata em lote único anual',
        capex: 'Desembolso imediato elevado e ocupação máxima de câmaras/almoxarifado',
        opex: 'Risco elevado de vencimento de estoque (descarte oneroso) e necessidade de ampliação de espaço físico',
        vantagens: 'Simplicidade administrativa de pedido único',
        riscosLimites: 'Alto risco sanitário de deterioração e perda financeira por validade expirada',
        conclusao: 'Desaconselhada para insumos perecíveis e de consumo variável'
      },
      {
        solucao: 'Solução C: Compras fragmentadas mensais por dispensa/emergência',
        capex: 'Valores unitários de varejo significativamente superiores à tabela CMED/BPA',
        opex: 'Sobrecusto administrativo processual e risco permanente de ruptura de estoque',
        vantagens: 'Nenhuma vantagem estrutural em cenários previsíveis',
        riscosLimites: 'Violação ao dever de planejamento e possível fracionamento irregular (Art. 75, § 1º)',
        conclusao: 'Vedada pela legislação de regência'
      }
    ],
    imrIndicadores: [
      {
        indicador: 'IND-01: Pontualidade na Entrega em CAF/Almoxarifado',
        meta: '100% dos pedidos atendidos dentro do prazo estipulado na Ordem de Fornecimento',
        formaAfericao: 'Conferência da data de protocolo na CAF frente à data de ciência da Autorização de Fornecimento',
        faixaGlosa: 'Atraso > 2 dias úteis sem justificativa aceita: multa moratória progressiva de 0,5%/dia + advertência'
      },
      {
        indicador: 'IND-02: Validade Sanitária Mínima e Cadeia Fria',
        meta: 'Prazo de validade remanescente ≥ 75% da vida útil na entrega e temperatura controlada conforme bula',
        formaAfericao: 'Inspeção sanitária pelo Farmacêutico Responsável com leitura de registrador térmico no recebimento',
        faixaGlosa: 'Lote fora dos padrões: recusa imediata e substituição compulsória em 48 horas às expensas da Contratada'
      },
      {
        indicador: 'IND-03: Integridade de Embalagens e Rastreabilidade ANVISA',
        meta: '100% dos itens com número de lote legível, registro ANVISA vigente e laudo analítico de controle',
        formaAfericao: 'Laudo de conferência física e documental no recebimento provisório/definitivo',
        faixaGlosa: 'Divergência de lote/registro: bloqueio integral de faturamento do item até saneamento'
      },
      {
        indicador: 'IND-04: Tempo de Resposta a Recolhimento (Recall) ou Avaria',
        meta: 'Substituição de lote avariado ou com desvio de qualidade em até 72 horas úteis da notificação',
        formaAfericao: 'Registro de notificações técnicas da Vigilância Sanitária / CAF',
        faixaGlosa: 'Descumprimento de prazo: glosa de 5% sobre o valor do lote + abertura de processo sancionatório (Art. 156)'
      }
    ],
    alocacaoRiscosArt103: [
      {
        evento: 'Desvio de qualidade, recall ANVISA ou perda de estabilidade térmica no transporte até a CAF',
        alocacao: 'Contratada',
        fundamento: 'Responsabilidade integral de boas práticas de transporte — RDC nº 430/2020 e Art. 119',
        mecanismo: 'Recusa sumária na entrega e recolhimento/reposição integral sem ônus ao Município'
      },
      {
        evento: 'Ajuste oficial anual de preços regulados pela CMED ou variação ordinária de mercado intraprocesso',
        alocacao: 'Contratada',
        fundamento: 'Vinculação à proposta e limite do Preço Máximo de Venda ao Governo (PMVG) — Resolução CMED',
        mecanismo: 'Manutenção obrigatória dos descontos registrados; revisão apenas se comprovada álea extraordinária (Art. 124, II, "d")'
      },
      {
        evento: 'Alteração súbita de protocolo clínico municipal ou surto epidemiológico imprevisível',
        alocacao: 'Contratante',
        fundamento: 'Competência de planejamento sanitário e acréscimos contratuais legais — Art. 124 e Art. 125',
        mecanismo: 'Aditamento quantitativo até o limite de 25% ou reprogramação consensual das ordens de fornecimento'
      },
      {
        evento: 'Suspensão temporária de fabricação de princípio ativo por escassez global comprovada',
        alocacao: 'Compartilhada',
        fundamento: 'Caso fortuito ou força maior externa — Art. 137, V e Art. 124, II, "d"',
        mecanismo: 'Substituição autorizada por marca/apresentação equivalente de mesmo custo ou liberação sem penalidade (Art. 29 Dec. 11.462/2023)'
      }
    ],
    indicesContabeisArt69:
      'Exigência de Liquidez Geral (LG) ≥ 1,00, Solvência Geral (SG) ≥ 1,00 e Liquidez Corrente (LC) ≥ 1,00, alternativamente Patrimônio Líquido mínimo de 10% do valor estimado do item/lote adjudicado (Art. 69, § 4º), além de Autorização de Funcionamento (AFE/ANVISA) e Alvará Sanitário vigente.'
  },
  OBRAS_ENGENHARIA: {
    normasTecnicas:
      'Normas Técnicas da ABNT (NBR 6118, NBR 9050 de Acessibilidade, NBR 5410, NBR 15575), NRs do MTE (NR-18 e NR-35), Especificações DERT/DNIT, Sistema de Custos SINAPI/SICRO (Decreto nº 7.983/2013 como referência de BDI) e Resolução CONFEA/CREA nº 1.094/2017.',
    ppaEstrategico:
      'Alinhado ao PPA Municipal — Programa de Infraestrutura Urbana, Saneamento e Equipamentos Públicos, às metas da LDO para investimentos de capital e ao Plano Diretor Municipal.',
    formulaDimensionamento:
      'Quantitativos apurados rigorosamente em Projeto Básico / Memorial Descritivo, Planilha Orçamentária Analítica de Custos Unitários com BDI diferenciado (Acórdão nº 2.622/2013-TCU) e Cronograma Físico-Financeiro referenciado ao SINAPI/SICRO.',
    cenarioInercia:
      'Degradação acelerada do patrimônio viário ou predial público, interdição de espaços de uso coletivo, elevação exponencial do custo futuro de restauração estrutural e risco à incolumidade pública e acessibilidade dos munícipes.',
    tcoAlternativas: [
      {
        solucao: 'Solução A: Contratação de empresa especializada com fornecimento integral de materiais e mão de obra (Empreitada por Preço Unitário/Global)',
        capex: 'Definido na planilha orçamentária oficial referenciada ao SINAPI',
        opex: 'Cobertura de garantia legal quinquenal de solidez e segurança (Art. 618 do Código Civil)',
        vantagens: 'Responsabilidade técnica unificada via ART/RRT, cronograma físico-financeiro vinculante e controle rigoroso por medições',
        riscosLimites: 'Demanda fiscalização presencial contínua por Engenheiro/Arquiteto Fiscal designado',
        conclusao: 'RECOMENDADA (Maior segurança técnica e jurídica)'
      },
      {
        solucao: 'Solução B: Execução direta com aquisição avulsa de materiais e equipe própria',
        capex: 'Fracionado em dezenas de processos de compra de insumos e aluguel de maquinário',
        opex: 'Risco elevado de ociosidade, perda de materiais e ausência de responsabilidade técnica segurada',
        vantagens: 'Viável apenas para pequenos reparos rotineiros de manutenção predial',
        riscosLimites: 'Incapacidade operacional para serviços complexos e multiplicação de riscos trabalhistas/previdenciários',
        conclusao: 'Inviável para o porte técnico do objeto'
      },
      {
        solucao: 'Solução C: Contratação parcial sem solução completa de drenagem/acabamento',
        capex: 'Aparentemente menor no edital inicial',
        opex: 'Retrabalho e patologias construtivas graves no primeiro ciclo chuvoso',
        vantagens: 'Nenhuma vantagem técnica ou econômica',
        riscosLimites: 'Desperdício de recurso público e responsabilização perante os Tribunais de Contas',
        conclusao: 'Vedada por violação ao princípio da eficiência e ciclo de vida (Art. 11)'
      }
    ],
    imrIndicadores: [
      {
        indicador: 'IND-01: Cumprimento do Cronograma Físico-Financeiro Mensal',
        meta: 'Execução ≥ 95% da etapa prevista para o período de medição em Diário de Obra',
        formaAfericao: 'Boletim de Medição Mensal conferido in loco pelo Engenheiro Fiscal com registro fotográfico georreferenciado',
        faixaGlosa: 'Atraso injustificado > 10% do marco físico: retenção preventiva de medição corretiva e notificação com prazo de plano de recuperação em 5 dias úteis'
      },
      {
        indicador: 'IND-02: Controle Tecnológico de Materiais e Ensaios ABNT',
        meta: '100% das frentes de serviço aprovadas em ensaios laboratoriais (traço, compactação, resistência)',
        formaAfericao: 'Laudos técnicos de ensaio assinados por laboratório acreditado e juntados ao Boletim de Medição',
        faixaGlosa: 'Não conformidade tecnológica: demolição e refazimento integral às expensas da Contratada sem medição'
      },
      {
        indicador: 'IND-03: Segurança do Trabalho, EPIs e Sinalização de Canteiro (NR-18)',
        meta: 'Zero infrações críticas de segurança, 100% da equipe uniformizada e com EPC/EPI e ART/RRT ativa',
        formaAfericao: 'Vistorias semanais da Fiscalização Técnica no Diário de Obra',
        faixaGlosa: 'Descumprimento de NR-18: paralisação cautelar da frente de risco até regularização + multa contratual'
      },
      {
        indicador: 'IND-04: Conformidade Trabalhista, Previdenciária e Fiscal da Mão de Obra',
        meta: '100% da equipe vinculada regularmente com GFIP/eSocial, FGTS e CNO/INSS quitados por competência',
        formaAfericao: 'Auditoria documental do Fiscal Administrativo previamente à liberação de cada medição',
        faixaGlosa: 'Pendência de encargos: retenção proporcional de pagamento até comprovação da quitação (Art. 121, § 3º)'
      }
    ],
    alocacaoRiscosArt103: [
      {
        evento: 'Inconsistências executivas menores ou subdimensionamento de produtividade operacional pela empreiteira',
        alocacao: 'Contratada',
        fundamento: 'Risco ordinário de gestão de canteiro e metodologia construtiva — Art. 103, § 1º',
        mecanismo: 'Assunção integral dos custos de mão de obra/equipamentos necessários à entrega no prazo pactuado'
      },
      {
        evento: 'Condições geológicas/subsuperficiais imprevisíveis ou interferências não cadastradas em redes enterradas',
        alocacao: 'Contratante',
        fundamento: 'Fato imprevisível da área/infraestrutura pública — Art. 124, II, "d" e Art. 103',
        mecanismo: 'Formalização de Termo Aditivo mediante memória de cálculo técnica aprovada pela Fiscalização'
      },
      {
        evento: 'Eventos climáticos extremos que inviabilizem concretagem ou terraplenagem comprovados no Diário de Obra',
        alocacao: 'Compartilhada',
        fundamento: 'Força maior climatológica — Art. 115, § 5º e Art. 103',
        mecanismo: 'Prorrogação exclusiva de prazo de cronograma (sem ônus de reequilíbrio adicional por ociosidade comum)'
      },
      {
        evento: 'Garantia quinquenal por solidez estrutural e vícios construtivos ocultos pós-recebimento definitivo',
        alocacao: 'Contratada',
        fundamento: 'Art. 140, § 6º da Lei nº 14.133/2021 c/c Art. 618 do Código Civil',
        mecanismo: 'Reparação compulsória integral no prazo fixado pela Administração ou execução de garantia contratual'
      }
    ],
    indicesContabeisArt69:
      'Exigência de Liquidez Geral (LG) ≥ 1,00, Solvência Geral (SG) ≥ 1,00 e Liquidez Corrente (LC) ≥ 1,00, acrescida de comprovação de Capital Social ou Patrimônio Líquido mínimo de 10% (dez por cento) do valor estimado (Art. 69, § 4º), além de registro no CREA/CAU e Acervo Técnico (CAT) compatível (Art. 67).'
  },
  SERVICOS_CONTINUOS: {
    normasTecnicas:
      'IN SEGES/MPDG nº 05/2017 (como referencial técnico de contratação de serviços contínuos e planilhas de custos), NRs do MTE (NR-06, NR-07 PCMSO, NR-09/NR-01 PGR), Convenções Coletivas de Trabalho (CCT) vigentes e Política Nacional de Resíduos Sólidos (Lei nº 12.305/2010).',
    ppaEstrategico:
      'Alinhado ao PPA Municipal — Programa de Manutenção, Operacionalização e Qualidade dos Serviços Públicos Municipais e ao Plano Anual de Logística Sustentável.',
    formulaDimensionamento:
      'Dimensionamento fundado na métrica de produtividade referencial (m² limpos por servente, postos/turnos 12x36h ou horas técnicas mensais), levantamento das unidades prediais atendidas e planilha analítica de composição de custos unitários.',
    cenarioInercia:
      'Degradação sanitária e funcional das repartições municipais, exposição de servidores e usuários a ambientes insalubres ou inseguros, paralisação de atendimento ao cidadão e responsabilidade subsidiária potencial caso haja contratação precária.',
    tcoAlternativas: [
      {
        solucao: 'Solução A: Contratação de serviços continuados por empresa especializada com IMR e conta-vinculada/fiscalização trabalhista',
        capex: 'Sem necessidade de imobilização de frota/equipamentos pesados pelo Município',
        opex: 'Custo mensal previsível, com repactuação vinculada estritamente à CCT e reajuste de insumos pelo IPCA',
        vantagens: 'Qualidade aferida por resultado (IMR), cobertura de férias/faltas imediata e proteção jurídica da Administração (Art. 121)',
        riscosLimites: 'Exige fiscalização trabalhista rigorosa mês a mês (Art. 121, § 3º)',
        conclusao: 'RECOMENDADA (Padrão de governança da Lei 14.133/2021)'
      },
      {
        solucao: 'Solução B: Execução direta mediante criação de cargos estatutários ou contratações temporárias',
        capex: 'Aumento permanente da despesa de pessoal (impacto direto no limite prudencial da LRF — Art. 22)',
        opex: 'Custo indireto elevado de gestão de RH, compras avulsas de insumos e passivo previdenciário próprio',
        vantagens: 'Nenhuma para atividades acessórias ou de apoio instrumental',
        riscosLimites: 'Risco de extrapolação do teto da Lei de Responsabilidade Fiscal e perda de especialização técnica',
        conclusao: 'Inadequada para serviços instrumentais e acessórios'
      },
      {
        solucao: 'Solução C: Contratação por demanda avulsa sem continuidade contratual',
        capex: 'Valor unitário elevado por mobilização pontual',
        opex: 'Variação financeira imprevisível e perda de padrão operacional',
        vantagens: 'Somente viável em eventos esporádicos não contínuos',
        riscosLimites: 'Ruptura contínua na prestação de serviços essenciais',
        conclusao: 'Inviável para necessidades permanentes (Art. 106)'
      }
    ],
    imrIndicadores: [
      {
        indicador: 'IND-01: Cobertura Efetiva de Postos / Rotinas Executadas',
        meta: '100% das rotinas diárias ou postos cobertos pontualmente (reposição de ausência em até 2 horas)',
        formaAfericao: 'Relatório diário de frequência biométrica/livro de ocorrências validado pelo Fiscal Setorial',
        faixaGlosa: 'Ausência não coberta no turno: glosa direta de 100% do custo/hora não trabalhado + redutor IMR adicional de 2% por ocorrência reincidente'
      },
      {
        indicador: 'IND-02: Qualidade Técnica da Execução e Produtividade',
        meta: 'Nota média ≥ 90 pontos em vistorias mensais estruturadas por unidade municipal',
        formaAfericao: 'Formulário padronizado de inspeção técnica de qualidade pelo Fiscal Técnico',
        faixaGlosa: 'Pontuação 80–89: glosa de 3% na fatura mensal; 70–79: glosa de 7%; < 70: glosa de 12% + notificação sancionatória'
      },
      {
        indicador: 'IND-03: Fornecimento de Insumos, Uniformes e EPIs',
        meta: '100% dos insumos e EPIs repostos até o 5º dia útil de cada mês com certificação CA válida',
        formaAfericao: 'Checklist de estoque e conferência física nas unidades usuárias',
        faixaGlosa: 'Desabastecimento > 48h após notificação: retenção de 5% do valor mensal da rubrica de insumos + multa'
      },
      {
        indicador: 'IND-04: Regularidade Trabalhista, FGTS, INSS e Salários em Dia',
        meta: '100% dos comprovantes salariais, vale-alimentação, transporte, FGTS e INSS entregues antes da fatura',
        formaAfericao: 'Auditoria documental mensal do Fiscal Administrativo (Art. 121, § 3º da Lei nº 14.133/2021)',
        faixaGlosa: 'Pendência ou atraso salarial: retenção cautelar imediata para pagamento direto ao trabalhador / bloqueio de fatura (Art. 121, § 3º, III)'
      }
    ],
    alocacaoRiscosArt103: [
      {
        evento: 'Absenteísmo, rotatividade de colaboradores ou rescisões trabalhistas ordinárias',
        alocacao: 'Contratada',
        fundamento: 'Poder diretivo e risco empresarial do empregador — Art. 121, caput e Art. 103',
        mecanismo: 'Cobertura imediata sem impacto no IMR nem repasse de custo adicional ao Município'
      },
      {
        evento: 'Aumento salarial decorrente de nova Convenção ou Acordo Coletivo de Trabalho da categoria',
        alocacao: 'Contratante',
        fundamento: 'Direito constitucional e legal à Repactuação — Art. 6º, LIX e Art. 135 da Lei nº 14.133/2021',
        mecanismo: 'Repactuação formal mediante comprovação analítica por planilha de custos e formação de preços após interregno legal'
      },
      {
        evento: 'Acréscimo ou supressão de unidades/áreas atendidas por conveniência administrativa',
        alocacao: 'Contratante',
        fundamento: 'Alteração contratual quantitativa unilateral ou consensual — Art. 124 e Art. 125',
        mecanismo: 'Termo Aditivo respeitado o limite legal de 25% e manutenção da equação econômico-financeira'
      },
      {
        evento: 'Atraso ou inadimplemento reiterado de obrigações fiscais e previdenciárias pela contratada',
        alocacao: 'Contratada',
        fundamento: 'Responsabilidade fiscal exclusiva e vedação de transferência ao Erário — Art. 121, §§ 1º e 2º',
        mecanismo: 'Retenção preventiva de pagamento, execução de garantia contratual (5% — Art. 96) e extinção por culpa (Art. 137)'
      }
    ],
    indicesContabeisArt69:
      'Exigência cumulativa de LG ≥ 1,00, SG ≥ 1,00, LC ≥ 1,00, Capital Circulante Líquido (CCL) ou Capital de Giro de no mínimo 16,66% (quando regime de dedicação exclusiva de mão de obra — IN SEGES 05/2017 como referência) e Patrimônio Líquido mínimo de 10% do valor estimado anualizado (Art. 69, § 4º).'
  },
  FROTA_VEICULOS: {
    normasTecnicas:
      'Código de Trânsito Brasileiro (Lei nº 9.503/1997), Resoluções CONTRAN (segurança veicular, transporte escolar/ambulâncias), PROCONVE/CONAMA (controle de emissões), Portarias ANP (qualidade de combustíveis) e ABNT NBR 14561 (Veículos para atendimento a emergências médicas, quando aplicável).',
    ppaEstrategico:
      'Alinhado ao PPA Municipal — Programa de Logística, Mobilidade, Transporte Escolar Seguro e Frota de Urgência/Emergência e ao Plano de Renovação e Eficiência Energética da Frota Oficial.',
    formulaDimensionamento:
      'Dimensionamento baseado no levantamento de rotas oficiais, quilometragem média mensal percorrida, idade da frota existente (> 5 anos ou > 150.000 km), índice de disponibilidade mecânica e exigências legais de segurança por setor.',
    cenarioInercia:
      'Paralisação do transporte escolar, atendimento pré-hospitalar e fiscalização de campo; explosão dos gastos com manutenção corretiva em veículos sucateados; e risco grave de acidentes por fadiga mecânica.',
    tcoAlternativas: [
      {
        solucao: 'Solução A: Aquisição de veículos zero km / insumos estruturados com garantia de fábrica e rede autorizada',
        capex: 'Investimento inicial estruturado em ativo permanente municipal',
        opex: 'Redução drástica de manutenção corretiva nos primeiros 36 meses e menor consumo de combustível',
        vantagens: 'Incorporação patrimonial, alta disponibilidade operacional (> 97%) e segurança jurídica/rodoviária',
        riscosLimites: 'Depende de plano preventivo de revisões obrigatórias na rede concessionária',
        conclusao: 'RECOMENDADA (Menor Custo Total por km rodado no ciclo de 60 meses)'
      },
      {
        solucao: 'Solução B: Locação de frota continuada sem motorista',
        capex: 'Ausência de investimento inicial',
        opex: 'Custo acumulado em 36 meses frequentemente supera 120% a 150% do valor de aquisição do veículo novo',
        vantagens: 'Manutenção incluída na diária/mensalidade',
        riscosLimites: 'Elevado custo total em longo prazo sem formação de patrimônio público',
        conclusao: 'Inviável para frota de uso permanente estrutural do Município'
      },
      {
        solucao: 'Solução C: Manutenção extensiva indefinida de frota sucateada',
        capex: 'Baixo investimento aparente',
        opex: 'Custo por km rodado antieconômico devido a paradas contínuas e consumo excessivo de peças',
        vantagens: 'Nenhuma vantagem operacional',
        riscosLimites: 'Alto índice de indisponibilidade e grave risco à segurança de passageiros e motoristas',
        conclusao: 'Tecnicamente e economicamente reprovada'
      }
    ],
    imrIndicadores: [
      {
        indicador: 'IND-01: Conformidade Mecânica, Emplacamento e Manual na Entrega',
        meta: '100% dos veículos/peças ou abastecimentos conformes às especificações e normas CONTRAN/ANP',
        formaAfericao: 'Laudo técnico de vistoria mecânica e documental da Diretoria de Frotas no recebimento',
        faixaGlosa: 'Divergência técnica ou atraso injustificado: recusa imediata do item com substituição em até 5 dias úteis + multa moratória'
      },
      {
        indicador: 'IND-02: SLA de Assistência em Garantia / Socorro Mecânico',
        meta: 'Atendimento técnico autorizado em até 48 horas úteis e disponibilização de peça/reparo conforme manual',
        formaAfericao: 'Ordens de Serviço abertas pela Gestão de Frota',
        faixaGlosa: 'Imobilização superior ao SLA previsto em contrato: aplicação de multa de 0,3% por dia útil de atraso sobre o valor do bem/serviço'
      },
      {
        indicador: 'IND-03: Qualidade de Insumos / Peças Genuínas ou Originais',
        meta: '100% de peças novas, de primeiro uso, com garantia mínima de 90 dias a 12 meses conforme fabricante',
        formaAfericao: 'Conferência por amostragem de notas fiscais de origem e embalagem lacrada',
        faixaGlosa: 'Peça recondicionada sem autorização ou paralela divergente: devolução integral e instauração de processo sancionatório (Art. 155, VIII)'
      },
      {
        indicador: 'IND-04: Rastreabilidade Documental e Controle de Faturamento',
        meta: '100% das notas acompanhadas de comprovante de entrega, ordem de serviço/abastecimento e CNDs vigentes',
        formaAfericao: 'Conferência do Fiscal Administrativo antes do atesto financeiro',
        faixaGlosa: 'Ausência de lastro documental: glosa integral do registro não comprovado até regularização'
      }
    ],
    alocacaoRiscosArt103: [
      {
        evento: 'Defeito de fabricação, falha prematura de motor/câmbio ou vício em componentes fornecidos',
        alocacao: 'Contratada',
        fundamento: 'Garantia legal e contratual de fabricante/fornecedor — Art. 119 e Art. 140, § 6º',
        mecanismo: 'Reparo integral ou substituição sem qualquer ônus financeiro, incluindo guincho quando em garantia'
      },
      {
        evento: 'Mau uso comprovado, colisão por culpa exclusiva de condutor público ou adulteração por terceiro',
        alocacao: 'Contratante',
        fundamento: 'Responsabilidade civil e administrativa patrimonial do detentor da frota — Art. 120 (a contrario sensu)',
        mecanismo: 'Apuração via sindicância interna de trânsito e cobertura securitária municipal / orçamento próprio'
      },
      {
        evento: 'Variação extraordinária regulada de preço de combustíveis ou política tributária setorial nacional',
        alocacao: 'Compartilhada',
        fundamento: 'Álea econômica extraordinária quando demonstrado desequilíbrio real — Art. 124, II, "d"',
        mecanismo: 'Revisão simétrica (para cima ou para baixo) lastreada na tabela oficial ANP e nota fiscal de distribuidora'
      },
      {
        evento: 'Atraso no faturamento por erro tributário ou ausência de certidão fiscal da contratada',
        alocacao: 'Contratada',
        fundamento: 'Dever contínuo de manutenção das condições de habilitação — Art. 92, XVI',
        mecanismo: 'Suspensão do prazo de pagamento sem incidência de juros até regularização fiscal plena'
      }
    ],
    indicesContabeisArt69:
      'Exigência de Liquidez Geral (LG) ≥ 1,00, Solvência Geral (SG) ≥ 1,00 e Liquidez Corrente (LC) ≥ 1,00, ou Patrimônio Líquido mínimo de 10% (dez por cento) do valor estimado da contratação (Art. 69, § 4º), bem como comprovação de concessão comercial/rede autorizada quando exigível em garantia.'
  },
  BENS_GERAIS: {
    normasTecnicas:
      'Normas Técnicas da ABNT aplicáveis à natureza dos materiais, certificação compulsória do INMETRO quando exigida, Código de Defesa do Consumidor (Lei nº 8.078/1990 — subsidiário nos termos do Art. 89 da Lei nº 14.133/2021) e critérios do Guia Nacional de Contratações Sustentáveis (AGU).',
    ppaEstrategico:
      'Alinhado ao PPA Municipal — Programa de Manutenção e Suprimento Administrativo das Unidades Gestoras e ao Plano de Contratações Anual (PCA) do exercício financeiro vigente.',
    formulaDimensionamento:
      'Quantitativos apurados pelo levantamento consolidado das requisições setoriais das secretarias municipais, ponderado pelo consumo histórico de 12 (doze) meses no Almoxarifado Central acrescido de reserva técnica de 10%.',
    cenarioInercia:
      'Interrupção do abastecimento ordinário das repartições municipais, prejuízo ao atendimento presencial ao cidadão, queda da eficiência administrativa e risco de compras emergenciais fracionadas a preços superiores aos de mercado.',
    tcoAlternativas: [
      {
        solucao: 'Solução A: Aquisição direta consolidada (ou via Ata de Registro de Preços) com entrega parcelada sob demanda',
        capex: 'Desembolso escalonado por Ordem de Fornecimento sem ociosidade de capital',
        opex: 'Custo operacional mínimo de estocagem e garantia integral contra defeitos de fabricação',
        vantagens: 'Economia de escala, flexibilidade quantitativa e padronização de qualidade em toda a Prefeitura',
        riscosLimites: 'Requer gestão ativa de pedidos pelo setor requisitante',
        conclusao: 'RECOMENDADA (Maior economicidade e controle de estoque)'
      },
      {
        solucao: 'Solução B: Aquisição descentralizada e avulsa por cada secretaria municipal',
        capex: 'Valores unitários elevados por perda de escala negocial',
        opex: 'Multiplicação de custos administrativos com vários processos licitatórios paralelos',
        vantagens: 'Autonomia isolada de pequeno escopo sem ganho global',
        riscosLimites: 'Despadronização, retrabalho burocrático e risco de fracionamento (Art. 75, § 1º)',
        conclusao: 'Desaconselhada pela ausência de ganhos de escala'
      },
      {
        solucao: 'Solução C: Terceirização integral de logística de almoxarifado just-in-time (Fulfillment)',
        capex: 'Taxa administrativa elevada embutida sobre cada item fornecido',
        opex: 'Custo operacional superior à estrutura municipal já instalada',
        vantagens: 'Reduz necessidade de armazenagem própria apenas em grandes metrópoles',
        riscosLimites: 'Sobrepreço embutido de logística terceirizada incompatível com a escala local',
        conclusao: 'Antieconômica para o porte da demanda municipal'
      }
    ],
    imrIndicadores: [
      {
        indicador: 'IND-01: Cumprimento de Prazo e Horário de Entrega',
        meta: '100% das entregas realizadas dentro do prazo estabelecido na Ordem de Fornecimento',
        formaAfericao: 'Registro de protocolo de entrega no Almoxarifado / Unidade Requisitante',
        faixaGlosa: 'Atraso injustificado > 2 dias úteis: multa moratória diária de 0,5% até o limite de 10%, sem prejuízo de rescisão'
      },
      {
        indicador: 'IND-02: Conformidade de Qualidade, Marca Cotada e Embalagem',
        meta: '100% dos itens entregues idênticos à proposta vencedora, íntegros, lacrados e de primeiro uso',
        formaAfericao: 'Checklist de conferência no recebimento provisório e definitivo (Art. 140, II)',
        faixaGlosa: 'Divergência de especificação/avaria: recusa imediata e substituição compulsória em 5 dias úteis às custas da Contratada'
      },
      {
        indicador: 'IND-03: Atendimento a Garantias e Trocas por Defeito',
        meta: 'Resolução de trocas ou defeitos ocultos identificados no uso em até 5 dias úteis da notificação',
        formaAfericao: 'Registro formal de não conformidade emitido pelo Fiscal do Contrato',
        faixaGlosa: 'Inércia na troca: retenção de valor equivalente em fatura pendente ou cobrança direta/garantia + penalidade'
      },
      {
        indicador: 'IND-04: Conformidade Fiscal e Documental no Faturamento',
        meta: '100% das notas fiscais emitidas com descrição fiel à Ordem de Fornecimento e CNDs válidas',
        formaAfericao: 'Conferência pré-atesto pelo Fiscal Administrativo',
        faixaGlosa: 'Inconsistência fiscal: suspensão do prazo de liquidação até emissão de carta de correção/regularização'
      }
    ],
    alocacaoRiscosArt103: [
      {
        evento: 'Aumento ordinário de custos de matéria-prima, frete ou logística de distribuição após a proposta',
        alocacao: 'Contratada',
        fundamento: 'Álea ordinária contratual e vinculação à proposta — Art. 103 e Art. 92, V',
        mecanismo: 'Irreajustabilidade no período inferior a 12 meses; reajuste anual exclusivamente pelo IPCA/IBGE'
      },
      {
        evento: 'Entrega de bem com defeito de fabricação, avaria de transporte ou especificação divergente',
        alocacao: 'Contratada',
        fundamento: 'Responsabilidade pelo fiel cumprimento da entrega — Art. 119 e Art. 140, § 1º',
        mecanismo: 'Recusa formal de recebimento e substituição às expensas exclusivas da fornecedora em até 5 dias úteis'
      },
      {
        evento: 'Recusa injustificada ou atraso no recebimento por indisponibilidade de local municipal indicado',
        alocacao: 'Contratante',
        fundamento: 'Obrigação de viabilizar condições de execução — Art. 115, § 5º e Art. 137, § 2º',
        mecanismo: 'Reagendamento formal de entrega sem aplicação de mora ou penalidade à Contratada'
      },
      {
        evento: 'Desequilíbrio superveniente comprovado por fato imprevisível de repercussão nacional',
        alocacao: 'Compartilhada',
        fundamento: 'Teoria da Imprevisão e revisão contratual — Art. 124, II, "d"',
        mecanismo: 'Revisão instruída por notas fiscais de aquisição anteriores e posteriores à licitação, submetida à Procuradoria'
      }
    ],
    indicesContabeisArt69:
      'Exigência de Liquidez Geral (LG) ≥ 1,00, Solvência Geral (SG) ≥ 1,00 e Liquidez Corrente (LC) ≥ 1,00, ou Patrimônio Líquido mínimo equivalente a 10% (dez por cento) do valor estimado da contratação (Art. 69, § 4º da Lei nº 14.133/2021), mediante Balanço Patrimonial dos 2 (dois) últimos exercícios sociais.'
  }
};

interface TrDomainProfile {
  catalogType: 'CATMAT' | 'CATSER';
  naturezaObjeto: string;
  sustentabilidadeSpec: string;
  amostraRegra: string;
  subcontratacaoRegra: string;
  garantiaContratacaoRegra: string;
  execucaoPrazoLocal: string;
  recebimentoGarantia: string;
  imrRegra: string;
  qualificacaoTecnicaArt67: string;
}

const DOMAIN_TR_CONFIG: Record<DomainCategory, TrDomainProfile> = {
  TI_EDUCACAO: {
    catalogType: 'CATMAT',
    naturezaObjeto: 'Bens e equipamentos comuns de Tecnologia da Informação (Art. 6º, inciso XIII da Lei nº 14.133/2021)',
    sustentabilidadeSpec:
      'Equipamentos com certificação de eficiência energética (PROCEL/ENERGY STAR ou equivalente), ausência de substâncias perigosas (diretiva RoHS) e logística reversa de embalagens/componentes (Art. 5º e Art. 45).',
    amostraRegra:
      'Dispensa-se amostra física prévia na fase de lances; exige-se catálogo técnico oficial, ficha de homologação e comprovação objetiva de especificações técnicas (ou prova de conceito de até 5 dias úteis caso haja dúvida fundada sobre compatibilidade) do licitante provisoriamente classificado em 1º lugar (Art. 41, II).',
    subcontratacaoRegra:
      'É vedada a subcontratação integral do fornecimento (Art. 122), admitindo-se subcontratação acessória apenas para serviços de logística/transporte ou assistência técnica credenciada pelo fabricante, sem transferência de responsabilidade contratual.',
    garantiaContratacaoRegra:
      'Poderá ser exigida garantia de execução contratual de 5% (cinco por cento) do valor inicial do contrato para fornecimentos com suporte on-site plurianual (Art. 96 e Art. 98), dispensada para entregas imediatas e integrais sem obrigações futuras além da garantia padrão de fábrica.',
    execucaoPrazoLocal:
      'Prazo máximo de entrega e instalação técnica de 20 (vinte) dias úteis contados do recebimento da Ordem de Fornecimento/Nota de Empenho, de segunda a sexta-feira, das 08h00 às 17h00, nos endereços das unidades indicadas pela Secretaria Requisitante.',
    recebimentoGarantia:
      'Recebimento provisório no ato da entrega para conferência física de volumes e séries (em até 5 dias úteis); recebimento definitivo em até 10 (dez) dias úteis após testes funcionais e comissionamento (Art. 140). Garantia técnica on-site mínima de 12 (doze) meses (ou 36 meses para estações educacionais) com SLA de atendimento em até 48 horas úteis.',
    imrRegra:
      'Aferição objetiva de conformidade na entrega técnica e monitoramento de SLA dos chamados de garantia on-site mediante relatório mensal de ocorrências pelo Fiscal Técnico.',
    qualificacaoTecnicaArt67:
      'Atestado(s) de capacidade técnica compatível em características, quantidades e prazos (limitado a até 50% do quantitativo das parcelas de maior relevância — Art. 67, § 2º e Súmula 263/TCU) comprovando fornecimento regular de equipamentos de informática.'
  },
  SAUDE_INSUMOS: {
    catalogType: 'CATMAT',
    naturezaObjeto: 'Bens comuns de saúde / insumos farmacêuticos e hospitalares (Art. 6º, inciso XIII da Lei nº 14.133/2021)',
    sustentabilidadeSpec:
      'Conformidade com normas da ANVISA/RDCs aplicáveis, embalagens recicláveis/seguras para cadeia fria ou farmacêutica e destinação ambientalmente adequada de resíduos/lotes impróprios (PGRSS e Art. 45).',
    amostraRegra:
      'Dispensa-se amostra prévia para itens padronizados por registro ANVISA vigente; faculta-se à Administração exigir bula, ficha técnica ou amostra para insumos médico-hospitalares com avaliação funcional pelo setor técnico em até 5 dias úteis (Art. 41, II).',
    subcontratacaoRegra:
      'É vedada a subcontratação do fornecimento principal dos medicamentos e insumos (Art. 122), ressalvado exclusivamente o transporte por transportadora regularmente licenciada pela vigilância sanitária (Boas Práticas de Transporte).',
    garantiaContratacaoRegra:
      'Dispensa-se a garantia financeira prévia do Art. 96 para entregas parceladas em que o pagamento ocorra somente após o recebimento definitivo de cada lote, mitigando o risco de inadimplemento financeiro.',
    execucaoPrazoLocal:
      'Entrega em até 10 (dez) dias úteis a contar da Ordem de Fornecimento, diretamente no Almoxarifado Central da Saúde / Central de Abastecimento Farmacêutico (CAF), em dias úteis das 08h00 às 16h00, com validade mínima equivalente a 75% do prazo total ou 18 (dezoito) meses na data do recebimento.',
    recebimentoGarantia:
      'Recebimento provisório na descarga mediante conferência de nota fiscal, lote, validade e integridade térmica (em até 3 dias úteis); recebimento definitivo em até 5 (cinco) dias úteis pelo Fiscal Técnico Farmacêutico (Art. 140). Garantia sanitária integral durante toda a validade, com substituição em 48 horas em caso de desvio de qualidade ou recall.',
    imrRegra:
      'Controle rigoroso por checklist sanitário de lote, validade, temperatura e prazo de entrega; eventuais substituições de avarias devem ocorrer sem ônus antes do atesto definitivo para pagamento.',
    qualificacaoTecnicaArt67:
      'Autorização de Funcionamento de Empresa (AFE) expedida pela ANVISA, Licença Sanitária estadual/municipal vigente, Certificado de Registro dos produtos na ANVISA e atestado de capacidade técnica compatível (Art. 67, IV).'
  },
  OBRAS_ENGENHARIA: {
    catalogType: 'CATSER',
    naturezaObjeto: 'Obra ou serviço comum de engenharia (Art. 6º, inciso XXI da Lei nº 14.133/2021)',
    sustentabilidadeSpec:
      'Gestão obrigatória de resíduos da construção civil (Resolução CONAMA nº 307/2002), emprego de insumos certificados, controle de ruído/poeira e uso racional de água e energia em canteiro (Art. 45).',
    amostraRegra:
      'Não se exige amostra prévia de serviços de engenharia; durante a execução, aplicam-se ensaios tecnológicos laboratoriais e aprovação técnica de materiais/acabamentos previstos no Projeto Básico/Memorial Descritivo.',
    subcontratacaoRegra:
      'Admite-se subcontratação parcial exclusivamente de serviços especializados acessórios (ex.: ensaios, instalações especiais ou terraplanagem pontual), limitada a 25% (vinte e cinco por cento) do valor contratual e condicionada à prévia anuência formal e comprovação de regularidade da subcontratada (Art. 122).',
    garantiaContratacaoRegra:
      'Exige-se obrigatoriamente garantia de execução contratual correspondente a 5% (cinco por cento) do valor inicial do contrato (Art. 96 e Art. 98), em qualquer das modalidades legais (caução, seguro-garantia ou fiança bancária), devendo observar o prazo de vigência contratual acrescido de 90 dias.',
    execucaoPrazoLocal:
      'Execução conforme Cronograma Físico-Financeiro a partir da Ordem de Serviço, no local designado pela Secretaria de Obras/Infraestrutura, observando normas regulamentadoras de segurança do trabalho (NR-18/NR-35) e horário comercial das 07h30 às 17h30.',
    recebimentoGarantia:
      'Recebimento provisório pelo responsável pelo acompanhamento e fiscalização em até 15 (quinze) dias da comunicação escrita de conclusão; recebimento definitivo em até 90 (noventa) dias mediante termo circunstanciado após verificação completa e entrega de as built (Art. 140, I), mantida a garantia legal quinquenal de solidez e segurança (Art. 618 do Código Civil).',
    imrRegra:
      'Medição mensal vinculada às etapas efetivamente concluídas e aprovadas no Boletim de Medição e Diário de Obra assinado pelo Fiscal de Engenharia (Art. 117).',
    qualificacaoTecnicaArt67:
      'Registro ou inscrição no CREA/CAU da empresa e dos responsáveis técnicos, comprovação de capacidade técnico-profissional (CAT/acervo técnico) e técnico-operacional para parcelas de maior relevância e valor significativo ≥ 4% (Art. 67, § 1º e § 2º).'
  },
  SERVICOS_CONTINUOS: {
    catalogType: 'CATSER',
    naturezaObjeto: 'Serviços comuns de natureza contínua (Art. 6º, incisos XIII e XV da Lei nº 14.133/2021)',
    sustentabilidadeSpec:
      'Adoção de insumos biodegradáveis/certificados, racionalização de consumo de energia e água nas frentes de serviço e descarte ambientalmente adequado de resíduos operacionais (Art. 5º e Art. 45).',
    amostraRegra:
      'Não aplicável amostra física; exige-se apresentação e análise detalhada da Planilha de Custos e Formação de Preços (com memória de cálculo de encargos, benefícios e tributos) na etapa de aceitação da proposta.',
    subcontratacaoRegra:
      'É vedada a subcontratação da atividade principal objeto da prestação contínua (Art. 122), permitindo-se apenas serviços auxiliares específicos expressamente autorizados pela fiscalização, sem vínculo ou transferência de encargos à Administração.',
    garantiaContratacaoRegra:
      'Exige-se garantia contratual de 5% (cinco por cento) do valor anualizado do contrato (Art. 96 e Art. 98), com cobertura específica para obrigações trabalhistas e previdenciárias caso haja dedicação exclusiva de mão de obra (Art. 121).',
    execucaoPrazoLocal:
      'Início da mobilização em até 5 (cinco) dias úteis após a Ordem de Serviço, com execução contínua nas dependências e horários definidos pela Secretaria Requisitante conforme escala de postos/SLA.',
    recebimentoGarantia:
      'Recebimento provisório mensal em até 5 (cinco) dias úteis mediante relatório de execução e planilha de frequência/IMR; recebimento definitivo em até 10 (dez) dias úteis após conferência documental trabalhista, previdenciária e fiscal (Art. 140, I). Garantia técnica contínua de regularidade na prestação do serviço durante toda a vigência.',
    imrRegra:
      'Obrigatória a aplicação mensal de Instrumento de Medição de Resultados (IMR) baseado em indicadores objetivos de pontualidade, cobertura de postos/chamados e qualidade, com previsão de adequação/glosa proporcional do pagamento antes da emissão da nota fiscal.',
    qualificacaoTecnicaArt67:
      'Atestado(s) de capacidade técnico-operacional comprovando gestão e execução anterior de serviços compatíveis em características e porte (mínimo de 50% do quantitativo de postos/escopo e experiência mínima proporcional prevista no Art. 67, § 5º).'
  },
  FROTA_VEICULOS: {
    catalogType: 'CATMAT',
    naturezaObjeto: 'Bens comuns permanentes — veículos/equipamentos automotivos (Art. 6º, inciso XIII da Lei nº 14.133/2021)',
    sustentabilidadeSpec:
      'Atendimento aos limites de emissões de poluentes do programa PROCONVE vigente, eficiência energética veicular e descarte adequado de lubrificantes/pneus na rede autorizada (Art. 45).',
    amostraRegra:
      'Dispensa-se amostra física; exige-se prospecto/catálogo oficial do fabricante contendo ficha técnica completa (motorização, chassi, segurança e adaptações) na fase de julgamento da proposta (Art. 41, II).',
    subcontratacaoRegra:
      'É vedada a subcontratação do fornecimento principal do veículo (Art. 122), admitindo-se subcontratação acessória para implementação/adaptação especial por empresa homologada, sob total responsabilidade técnica da contratada.',
    garantiaContratacaoRegra:
      'Exige-se garantia contratual de 5% (cinco por cento) quando o prazo de entrega técnica envolver adaptações complexas ou planos integrados de manutenção (Art. 96), podendo ser dispensada na aquisição simples com pagamento exclusivo após emplacamento e entrega definitiva.',
    execucaoPrazoLocal:
      'Entrega técnica em até 30 (trinta) dias úteis (ou até 45 dias úteis em caso de adaptação especial) a contar da Ordem de Fornecimento, no Pátio/Garagem Oficial do Município, das 08h00 às 17h00, com veículo zero quilômetro e primeiro emplacamento regularizado em nome do Município.',
    recebimentoGarantia:
      'Recebimento provisório no ato da entrega para inspeção visual, mecânica e documental (em até 5 dias úteis); recebimento definitivo em até 10 (dez) dias úteis após vistoria completa e entrega de manuais/chaves/CRV (Art. 140). Garantia mínima de fábrica de 12 a 24 meses sem limite de quilometragem e assistência técnica autorizada.',
    imrRegra:
      'Checklist técnico completo de vistoria veicular no recebimento e monitoramento de prazos de atendimento em garantia durante a cobertura contratual.',
    qualificacaoTecnicaArt67:
      'Atestado de capacidade técnica comprovando fornecimento compatível de veículos/equipamentos e declaração de disponibilidade de rede de assistência técnica e reposição de peças autorizada (Art. 67).'
  },
  BENS_GERAIS: {
    catalogType: 'CATMAT',
    naturezaObjeto: 'Bens e materiais de consumo/permanentes de natureza comum (Art. 6º, inciso XIII da Lei nº 14.133/2021)',
    sustentabilidadeSpec:
      'Preferência por materiais recicláveis, certificados pela ABNT/INMETRO, com menor impacto ambiental na produção/embalagem e atendimento aos critérios de sustentabilidade do Art. 5º e Art. 45.',
    amostraRegra:
      'Dispensa-se amostra prévia como regra geral; caso necessário para aferição de qualidade ou compatibilidade, poderá ser solicitada amostra/catálogo exclusivamente do licitante classificado provisoriamente em primeiro lugar, com prazo mínimo de 5 dias úteis (Art. 41, II).',
    subcontratacaoRegra:
      'É vedada a subcontratação total ou parcial da obrigação de fornecimento dos bens (Art. 122), admitindo-se apenas o transporte de entrega por frete regular.',
    garantiaContratacaoRegra:
      'Dispensa-se a garantia de execução contratual prevista no Art. 96 para aquisições de bens comuns com entrega imediata/integral ou parcelada mediante empenho prévio, cujo pagamento só ocorre após o atesto definitivo.',
    execucaoPrazoLocal:
      'Entrega em até 15 (quinze) dias úteis a contar do recebimento da Ordem de Fornecimento/Nota de Empenho, no Almoxarifado Central ou unidade indicada pela Secretaria Requisitante, de segunda a sexta-feira, das 08h00 às 17h00.',
    recebimentoGarantia:
      'Recebimento provisório no ato da entrega para conferência quantitativa (em até 5 dias úteis); recebimento definitivo em até 10 (dez) dias úteis após exame qualitativo e compatibilidade com a proposta (Art. 140). Garantia técnica mínima de 12 (doze) meses contra defeitos de fabricação, além da garantia legal do CDC.',
    imrRegra:
      'Verificação objetiva via termo de recebimento comparando quantitativos, integridade das embalagens e conformidade exata de especificação técnica.',
    qualificacaoTecnicaArt67:
      'Atestado(s) de capacidade técnico-operacional emitido(s) por pessoa jurídica de direito público ou privado comprovando fornecimento pertinente e compatível com o objeto em características, quantidades e prazos (Art. 67).'
  }
};

interface BuildAgent07Params {
  proc: ProcurementProcess;
  inst: Institution;
  dotLinha: string;
  comarca: string;
  municipioUf: string;
  todayBR: string;
  category: DomainCategory;
  baseItems: PlannedItem[];
  objetoConsolidado: string;
  trNumberRef?: string;
  feedback?: string;
  direct: boolean;
}

function buildAgent07MinutaContrato(params: BuildAgent07Params): AgentOutputPayload {
  const {
    proc,
    inst,
    dotLinha,
    comarca,
    municipioUf,
    todayBR,
    category,
    baseItems,
    objetoConsolidado,
    trNumberRef,
    feedback,
    direct
  } = params;

  const anoAtual = new Date().getFullYear();
  const procNumSafe = (proc.numero_processo_licitatorio || '000').replace(/[^\w/-]/g, '');
  const numeroContrato = `MINUTA-CONTRATO-${procNumSafe}`;
  const trProfile: TrDomainProfile = DOMAIN_TR_CONFIG[category] || DOMAIN_TR_CONFIG.BENS_GERAIS;
  const trNumeroRef = trNumberRef || `TR-${procNumSafe}`;
  const prefeitoRawName = (inst.prefeito_nome || '').trim() || 'Prefeito(a) Municipal (a designar)';
  const prefeitoSpan = formatPrefeitoQualifiedSpan(inst.prefeito_nome);
  const orgaoRazao = (inst.razao_social || '').trim() || 'Município Contratante';
  const orgaoEndereco = `${inst.endereco_completo || 'Sede Administrativa'} — CEP ${inst.cep || '00000-000'} — ${municipioUf}`;
  const indiceReajuste =
    category === 'OBRAS_ENGENHARIA' ? 'INCC-M/FGV (ou índice setorial SINAPI equivalente)' : 'IPCA/IBGE';
  const prazoPncp = direct ? '10 (dez) dias úteis' : '20 (vinte) dias úteis';

  const clausulaSegundaProrrogacao =
    category === 'SERVICOS_CONTINUOS'
      ? 'O prazo contratual poderá ser prorrogado sucessivamente, respeitada a vigência máxima decenal de 10 (dez) anos, mediante termo aditivo e comprovação formal de que as condições e os preços permanecem vantajosos para a Administração (Arts. 106 e 107 da Lei nº 14.133/2021).'
      : 'Admitida a prorrogação contratual nas hipóteses legais dos Arts. 105 a 107 da Lei nº 14.133/2021, mediante justificativa formal da Administração, bem como a prorrogação automática quando seu objeto não for concluído no período firmado no contrato, ressalvadas as providências cabíveis no caso de culpa da Contratada (Art. 111).';

  const clausulasMinuta = [
    'Cláusula Primeira – Do Objeto (Art. 92, I e II)',
    'Cláusula Segunda – Da Vigência e Prorrogação (Art. 92, VII e Arts. 105-107)',
    'Cláusula Terceira – Modelos de Execução e Gestão Contratual (Art. 92, IV, VII e XVIII)',
    'Cláusula Quarta – Da Subcontratação (Art. 122)',
    'Cláusula Quinta – Do Preço e Condições de Pagamento (Art. 92, V e VI)',
    'Cláusula Sexta – Do Reajuste / Repactuação (Art. 92, V e § 3º / Art. 25, § 7º)',
    'Cláusula Sétima – Das Obrigações do Contratante e da Contratada (Art. 92, XIV, XVI e XVII)',
    'Cláusula Oitava – Da Garantia de Execução (Art. 92, XII e Art. 96)',
    'Cláusula Nona – Das Infrações e Sanções Administrativas (Art. 92, XIV e Arts. 155-163)',
    'Cláusula Décima – Da Extinção Contratual (Art. 92, XIX e Arts. 137-139)',
    'Cláusula Décima Primeira – Da Dotação Orçamentária (Art. 92, VIII)',
    'Cláusula Décima Segunda – Dos Casos Omissos e da Publicação no PNCP (Art. 92, III e Art. 94)',
    'Cláusula Décima Terceira – Do Foro (Art. 92, § 1º)'
  ];

  const dosimetriaTableHtml = renderStructuredTableHtml(
    ['Grau da Infração', 'Condutas Típicas (Art. 155)', 'Sanção Aplicável (Art. 156)', 'Dosimetria / Parâmetro Objetivo'],
    [
      [
        { label: 'Leve (Grau I)', strong: true },
        'Inexecução parcial sem prejuízo relevante à continuidade do serviço ou falha formal sanável (Art. 155, I).',
        'Advertência por escrito (Art. 156, I e § 2º).',
        'Aplicada na primeira ocorrência leve sem reincidência nos últimos 12 meses.'
      ],
      [
        { label: 'Moderada / Mora (Grau II)', strong: true },
        'Atraso injustificado na entrega/execução, descumprimento de prazo de correção ou reincidência de falha leve (Art. 155, VII).',
        'Multa Moratória (Art. 156, II e Art. 162).',
        '0,5% (cinco décimos por cento) por dia útil de atraso sobre a parcela inadimplida, limitada a 15% (30 dias).'
      ],
      [
        { label: 'Grave (Grau III)', strong: true },
        'Inexecução parcial que cause grave dano à Administração, descumprimento reiterado de obrigações fiscais/trabalhistas (Art. 155, II e V).',
        'Multa Compensatória + Impedimento de Licitar e Contratar (Art. 156, II e III).',
        'Multa de 10% a 20% sobre o valor contratual remanescente/total e Impedimento no Município por até 3 (três) anos (§ 4º).'
      ],
      [
        { label: 'Gravíssima (Grau IV)', strong: true },
        'Declaração ou documentação falsa, fraude na execução, comportamento inidôneo ou inexecução total dolosa (Art. 155, III, VIII, IX, X e XII).',
        'Multa Compensatória Máxima + Declaração de Inidoneidade (Art. 156, II e IV).',
        'Multa de 20% a 30% (teto Art. 156, § 3º) e Inidoneidade em todos os entes federativos de 3 a 6 anos (§ 5º).'
      ]
    ]
  );

  const itemsTableHtml = renderOpenContractItemsTableHtml(baseItems, trProfile.catalogType);

  const json = {
    numero_minuta: numeroContrato,
    ano_exercicio: anoAtual,
    contratante: orgaoRazao,
    cnpj_contratante: inst.cnpj,
    representante_contratante: prefeitoRawName,
    cargo_representante_contratante: 'Prefeito(a) Municipal',
    termo_referencia_vinculado: trNumeroRef,
    objeto: objetoConsolidado,
    itens_contrato: baseItems.map((it) => ({
      item: it.item,
      codigo_catalogo: `${trProfile.catalogType} — Item ${String(it.item).padStart(2, '0')}`,
      descricao: it.descricao,
      unidade: it.medida || it.unidade,
      quantidade: it.quantidade,
      valor_unitario_contrato: null,
      valor_total_contrato: null
    })),
    valor_contratual_aberto: true,
    valores_em_aberto: true,
    duracao_em_aberto: true,
    prazo_vigencia_aberto: true,
    indice_reajuste: indiceReajuste,
    data_base_orcamento: todayBR,
    garantia_execucao: trProfile.garantiaContratacaoRegra,
    subcontratacao: trProfile.subcontratacaoRegra,
    prazo_publicacao_pncp: prazoPncp,
    comarca_foro: comarca,
    clausulas_minuta: clausulasMinuta,
    clausulas_obrigatorias_art92: [
      'I - Objeto e seus elementos característicos',
      'II - Vinculação ao edital de licitação e à proposta vencedora',
      'III - Legislação aplicável à execução do contrato e casos omissos',
      'IV - Regime de execução ou forma de fornecimento',
      'V - Preço, condições de pagamento e critérios de reajustamento com data-base',
      'VI - Critérios de atualização monetária por atraso da Administração',
      'VII - Prazos de início, execução, conclusão, entrega, observação e recebimento definitivo',
      'VIII - Crédito orçamentário',
      'IX - Matriz de risco (quando aplicável)',
      'X/XI - Prazo para resposta ao pedido de repactuação e reequilíbrio econômico-financeiro',
      'XII - Garantias oferecidas (Art. 96)',
      'XIV/XVI/XVII - Direitos, responsabilidades, penalidades, manutenção da habilitação e reserva de cargos PcD',
      'XVIII - Modelo de gestão do contrato',
      'XIX - Casos de extinção (Arts. 137-139) e Foro (§ 1º)'
    ],
    feedback_incorporado: feedback || null
  };

  const fichaContratoHtml = renderMetadataGridHtml([
    ['Instrumento Contratual', `Minuta nº ${escapeHtml(numeroContrato)} (Ref. ${escapeHtml(trNumeroRef)})`],
    [
      'Processos Vinculados',
      `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
    ],
    [
      'Modalidade e Critério',
      `${bind('modalidade_label', getModalidadeLabel(proc.modalidade))} &bull; ${bind('criterio_julgamento_label', getCriterioLabel(proc.criterio_julgamento))}`
    ],
    [
      'Representação pelo Contratante',
      `${prefeitoSpan.inlinePreambuloHtml} (Exclusiva do Chefe do Executivo Municipal)`
    ]
  ]);

  const html = `
        <h2>7. MINUTA DE CONTRATO ADMINISTRATIVO Nº ___/${anoAtual}</h2>
        ${fichaContratoHtml}
        ${renderExecutiveCalloutHtml(
          'Diretrizes Contratuais e Blindagem Jurídica (Art. 92)',
          `Instrumento padronizado em <strong>13 cláusulas obrigatórias</strong> vinculadas ao ${escapeHtml(trNumeroRef)}, com representação exclusiva do Poder Executivo Municipal (${escapeHtml(prefeitoSpan.displayName)}), <strong>valores contratuais e prazos iniciais mantidos em aberto</strong> para fiel preenchimento pós-adjudicação, data-base fixada no orçamento estimado (Art. 25, § 7º), reserva de cargos PcD (Art. 92, XVII), dosimetria objetiva (Arts. 155–163) e condição de eficácia via PNCP em <strong>${prazoPncp}</strong>.`
        )}
        ${feedbackCallout(feedback)}

        <h3>Preâmbulo</h3>
        <p>Pelo presente instrumento administrativo, regido pela <strong>Lei Federal nº 14.133/2021</strong> (Arts. 89 a 95 e demais disposições aplicáveis) e vinculado ao <strong>Processo Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}</strong> (Processo Administrativo nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)}), de um lado o(a) <strong>${bind('orgao_razao_social', orgaoRazao)}</strong>, pessoa jurídica de direito público interno, inscrita no CNPJ sob o nº <strong>${bind('orgao_cnpj', formatCnpj(inst.cnpj))}</strong>, com sede administrativa à ${bind('orgao_endereco', orgaoEndereco)}, neste ato representada exclusivamente pelo(a) Exmo(a). Sr(a). ${prefeitoSpan.inlinePreambuloHtml}, Chefe do Poder Executivo Municipal, doravante denominado(a) <strong>CONTRATANTE</strong>;</p>
        <table>
          <thead>
            <tr>
              <th colspan="2">Qualificação Estruturada da Contratada (Preenchimento na Formalização)</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><strong>Razão Social</strong></td><td>[RAZÃO SOCIAL DA EMPRESA VENCEDORA]</td></tr>
            <tr><td><strong>CNPJ / Inscrição</strong></td><td>[00.000.000/0001-00] — Inscrição Estadual/Municipal: [_______________]</td></tr>
            <tr><td><strong>Endereço Sede / CEP</strong></td><td>[Logradouro, nº, Bairro, Município/UF, CEP]</td></tr>
            <tr><td><strong>Representante Legal</strong></td><td>[Nome completo, Cargo/Sócio, CPF nº 000.000.000-00, E-mail institucional]</td></tr>
          </tbody>
        </table>
        <p>doravante denominada <strong>CONTRATADA</strong>, têm entre si justo e acordado o presente Termo de Contrato Administrativo, mediante as cláusulas e condições seguintes, em estrita observância ao <strong>Art. 92 da Lei nº 14.133/2021</strong>:</p>

        <h3>Cláusula Primeira – Do Objeto (Art. 92, I e II)</h3>
        <p>1.1. O presente Contrato tem por objeto: <strong>${escapeHtml(objetoConsolidado)}</strong>, conforme especificações técnicas, quantitativos, padrões de qualidade e condições estabelecidas no <strong>Termo de Referência aprovado (${escapeHtml(trNumeroRef)} — Anexo I)</strong> e nos valores unitários e globais que vierem a ser adjudicados na sessão pública do certame:</p>
        ${itemsTableHtml}
        <p>1.2. Vinculam esta contratação, independentemente de transcrição integral: o Termo de Referência, o Edital/Aviso do Processo Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}, o Mapa de Riscos (com sua Matriz de Alocação Art. 103), a Proposta da Contratada e seus eventuais anexos (Art. 92, II).</p>

        <h3>Cláusula Segunda – Da Vigência e Prorrogação (Art. 92, VII e Arts. 105-107)</h3>
        <p>2.1. O prazo de vigência inicial deste Contrato será de <strong>[______ (______________________________) meses / dias]</strong> <em>[DURAÇÃO CONTRATUAL EM ABERTO — A DEFINIR NA FORMALIZAÇÃO CONFORME RESULTADO ADJUDICADO E CRONOGRAMA DO OBJETO]</em>, contados da data de <strong>[___/___/${anoAtual}]</strong> até <strong>[___/___/______]</strong>, condicionada a sua eficácia à divulgação no Portal Nacional de Contratações Públicas (PNCP), nos termos dos Arts. 94 e 105 da Lei nº 14.133/2021.</p>
        <p>2.2. ${escapeHtml(clausulaSegundaProrrogacao)}</p>

        <h3>Cláusula Terceira – Modelos de Execução e Gestão Contratual (Art. 92, IV, VII e XVIII)</h3>
        <p>3.1. <strong>Regime e Modelo de Execução (Art. 92, IV e VII):</strong> O início da execução/fornecimento dar-se-á no prazo de <strong>[______ (____________) dias úteis/corridos]</strong> <em>[PRAZO DE EXECUÇÃO EM ABERTO PARA FORMALIZAÇÃO]</em> contados da emissão da Ordem de Fornecimento/Serviço. Aplicam-se as seguintes regras operacionais do Termo de Referência: ${escapeHtml(trProfile.execucaoPrazoLocal)} ${escapeHtml(trProfile.recebimentoGarantia)}</p>
        <p>3.2. <strong>Gestão e Fiscalização (Art. 92, XVIII e Art. 117):</strong> A execução será acompanhada por <strong>Gestor do Contrato</strong>, <strong>Fiscal Técnico</strong> e <strong>Fiscal Administrativo</strong> formalmente designados pela Administração, com anotação de ocorrências em registro próprio (Art. 117, § 1º), atuação mediante preposto formalmente indicado pela Contratada (Art. 118) e estrita vinculação ao <strong>Instrumento de Medição de Resultados (IMR)</strong> do Termo de Referência: ${escapeHtml(trProfile.imrRegra)}</p>
        <p>3.3. <strong>Matriz de Alocação de Riscos (Art. 92, IX e Art. 103):</strong> Integram este Contrato as diretrizes de repartição objetiva de riscos previstas no Mapa de Gerenciamento de Riscos (Peça 04), não cabendo reequilíbrio por eventos alocados expressamente à álea ordinária da Contratada.</p>

        <h3>Cláusula Quarta – Da Subcontratação (Art. 122)</h3>
        <p>4.1. Aplicam-se integralmente as regras estabelecidas no Termo de Referência: ${escapeHtml(trProfile.subcontratacaoRegra)}</p>

        <h3>Cláusula Quinta – Do Preço e Condições de Pagamento (Art. 92, V e VI)</h3>
        <p>5.1. O valor global do presente Contrato é de <strong>R$ _________________________ (______________________________________________)</strong> <em>[VALOR CONTRATUAL EM ABERTO — A PREENCHER CONFORME PROPOSTA ADJUDICATÁRIA VENCEDORA E HOMOLOGADA NO CERTAME]</em>, apurado a partir dos preços unitários registrados na Cláusula Primeira, nele já incluídos todos os tributos, fretes, encargos sociais, trabalhistas, previdenciários, garantia e custos operacionais diretos e indiretos.</p>
        <p>5.2. <strong>Liquidação, Pagamento e Glosas de IMR:</strong> Após o recebimento definitivo (Art. 140), aferição do IMR e atesto da Nota Fiscal pela fiscalização, o pagamento será efetuado mediante ordem bancária em até <strong>30 (trinta) dias</strong>, respeitada a ordem cronológica para cada fonte diferenciada de recursos (Art. 141), deduzidas eventuais glosas apuradas no IMR e efetuadas as retenções tributárias obrigatórias na fonte (IRRF, ISSQN, INSS).</p>
        <p>5.3. <strong>Atualização Monetária por Atraso da Administração (Art. 92, V e VI):</strong> Nos casos de eventuais atrasos de pagamento imputáveis exclusivamente ao Contratante, desde que a Contratada não tenha concorrido de alguma forma para tanto e mantenha regularidade fiscal (Art. 92, XVI), o valor devido será atualizado financeiramente pro rata die pelo índice <strong>IPCA-E/IBGE</strong>, acrescido de juros de mora de 0,5% (cinco décimos por cento) ao mês, entre a data limite para pagamento e a efetiva quitação.</p>

        <h3>Cláusula Sexta – Do Reajuste / Repactuação (Art. 92, V, X, XI e § 3º)</h3>
        <p>6.1. <strong>Reajuste em Sentido Estrito (Art. 25, § 7º e Art. 92, § 3º):</strong> Os preços inicialmente contratados são fixos e irreajustáveis no prazo de 1 (um) ano, com <strong>data-base vinculada obrigatoriamente à data do orçamento estimado (${todayBR})</strong>. Após o interregno mínimo de 12 (doze) meses da data-base, e exclusivamente para obrigações iniciadas/executadas após a anualidade, os preços serão reajustados pelo índice oficial <strong>${escapeHtml(indiceReajuste)}</strong> acumulado no período.</p>
        <p>6.2. <strong>Repactuação (Art. 6º, LIX e Art. 135):</strong> Aplicável quando houver serviços contínuos com regime de dedicação exclusiva de mão de obra ou predominância de mão de obra, mediante demonstração analítica da variação dos componentes dos custos em planilha de preços vinculada à Convenção ou Acordo Coletivo de Trabalho vigente, observado o interregno mínimo de 1 (um) ano.</p>
        <p>6.3. <strong>Revisão Extraordinária / Reequilíbrio (Art. 124, II, "d"):</strong> Restabelecimento da equação econômico-financeira inicial somente em caso de força maior, caso fortuito ou fato do príncipe ou em decorrência de fatos imprevisíveis ou previsíveis de consequências incalculáveis, devidamente demonstrados por planilha e documentos idôneos.</p>
        <p>6.4. <strong>Prazo de Análise Administrativa (Art. 92, X e XI):</strong> O prazo para resposta da Administração aos pedidos formalizados e completos de repactuação ou reequilíbrio econômico-financeiro será de até <strong>30 (trinta) dias</strong> contados da instrução integral.</p>

        <h3>Cláusula Sétima – Das Obrigações do Contratante e da Contratada (Art. 92, XIV, XVI e XVII)</h3>
        <p>7.1. <strong>Obrigações do Contratante:</strong> (I) Emitir a nota de empenho prévia e a ordem de início/fornecimento; (II) proporcionar acesso aos locais e prestar esclarecimentos operacionais necessários; (III) exercer fiscalização técnica e administrativa contínua (Art. 117); (IV) notificar formalmente a Contratada sobre irregularidades fixando prazo para correção; (V) receber o objeto conforme rito do Art. 140; e (VI) efetuar os pagamentos regularmente devidos dentro do prazo estipulado.</p>
        <p>7.2. <strong>Obrigações da Contratada:</strong> (I) Executar fielmente o objeto conforme o Termo de Referência, padrões normativos e mitigações da Matriz de Riscos; (II) reparar, corrigir ou substituir às suas expensas vícios, defeitos ou desconformidades em até 5 dias úteis; (III) responder integralmente pelos danos causados diretamente à Administração ou a terceiros decorrentes de culpa ou dolo (Art. 120); (IV) assumir encargos trabalhistas, previdenciários, fiscais e comerciais (Art. 121); (V) indicar preposto aceito pela Administração (Art. 118); (VI) observar integralmente a LGPD (Lei nº 13.709/2018); (VII) <strong>manter, durante toda a execução do contrato, em compatibilidade com as obrigações assumidas, todas as condições exigidas para a habilitação e qualificação na licitação (Art. 92, XVI)</strong>; e (VIII) <strong>cumprir as exigências de reserva de cargos prevista em lei, bem como em outras normas específicas, para pessoa com deficiência (PCD), para reabilitado da Previdência Social e para aprendiz (Art. 92, XVII)</strong>.</p>

        <h3>Cláusula Oitava – Da Garantia de Execução (Art. 92, XII e Art. 96)</h3>
        <p>8.1. Conforme estipulado no Termo de Referência: ${escapeHtml(trProfile.garantiaContratacaoRegra)} Quando exigida, caberá à Contratada optar por caução em dinheiro ou títulos da dívida pública, seguro-garantia ou fiança bancária (Art. 96, § 1º), com validade estendida durante toda a vigência contratual e por mais 90 (noventa) dias após o término, sendo liberada ou restituída após o recebimento definitivo integral do objeto e comprovação da inexistência de débitos trabalhistas/multas.</p>

        <h3>Cláusula Nona – Das Infrações e Sanções Administrativas (Art. 92, XIV e Arts. 155-163)</h3>
        <p>9.1. Comete infração administrativa o contratado que praticar quaisquer das condutas tipificadas no <strong>Art. 155 da Lei nº 14.133/2021</strong>, ficando sujeito à aplicação gradual e proporcional (Dosimetria Objetiva) das sanções do <strong>Art. 156</strong>, conforme quadro vinculante:</p>
        ${dosimetriaTableHtml}
        <p>9.2. <strong>Devido Processo Legal Sancionador (Arts. 157, 158, 166 e 167):</strong> Nenhuma penalidade será aplicada sem instauração de processo administrativo que assegure o contraditório e a ampla defesa, facultando-se à Contratada o prazo de <strong>15 (quinze) dias úteis</strong> para defesa prévia (Art. 157/158), bem como prazo de <strong>15 (quinze) dias úteis</strong> para interposição de recurso administrativo (Art. 166) ou pedido de reconsideração no caso de inidoneidade (Art. 167).</p>

        <h3>Cláusula Décima – Das Alterações e da Extinção Contratual (Art. 92, XIX, Arts. 124-125 e Arts. 137-139)</h3>
        <p>10.1. <strong>Alterações Contratuais (Arts. 124 e 125):</strong> Eventuais alterações contratuais reger-se-ão pela disciplina dos Arts. 124 e seguintes da Lei nº 14.133/2021, ficando a Contratada obrigada a aceitar, nas mesmas condições contratuais, acréscimos ou supressões de até <strong>25% (vinte e cinco por cento)</strong> do valor inicial atualizado do contrato (e até 50% para acréscimos no caso de reforma de edifício ou de equipamento — Art. 125).</p>
        <p>10.2. <strong>Extinção Contratual (Arts. 137 a 139):</strong> O Contrato poderá ser extinto antes de cumpridas as obrigações nele estipuladas por qualquer dos motivos previstos no <strong>Art. 137 da Lei nº 14.133/2021</strong> (inadimplemento, atraso reiterado, decretação de falência, razões de interesse público de alta relevância), mediante ato unilateral e escrito da Administração, de modo consensual por acordo entre as partes ou por decisão arbitral/judicial (Art. 138), produzindo os efeitos previstos no Art. 139 (assunção imediata, retenção de créditos até o limite dos prejuízos e execução de garantia).</p>

        <h3>Cláusula Décima Primeira – Da Dotação Orçamentária (Art. 92, VIII)</h3>
        <p>11.1. As despesas decorrentes da presente contratação correrão à conta da dotação orçamentária: ${bind('dotacao_completa', dotLinha)} (e respectivo empenho prévio emitido para cada contratação decorrente, no caso de SRP).</p>

        <h3>Cláusula Décima Segunda – Dos Casos Omissos e da Publicação no PNCP (Art. 92, III e Art. 94)</h3>
        <p>12.1. Os casos omissos serão decididos pelo Contratante segundo as disposições da Lei nº 14.133/2021, das demais normas federais e municipais aplicáveis, dos preceitos de direito público e, subsidiariamente, dos princípios da teoria geral dos contratos e das disposições da Lei nº 8.078/1990 (Código de Defesa do Consumidor).</p>
        <p>12.2. A divulgação no <strong>Portal Nacional de Contratações Públicas (PNCP)</strong> é <strong>condição indispensável para a eficácia deste Contrato</strong> e de seus aditamentos, devendo ocorrer no prazo máximo de <strong>${prazoPncp}</strong> contados da data de sua assinatura (Art. 94 da Lei nº 14.133/2021).</p>

        <h3>Cláusula Décima Terceira – Do Foro (Art. 92, § 1º)</h3>
        <p>13.1. Fica eleito o Foro da <strong>${bind('orgao_comarca', comarca)}</strong>, correspondente à sede da Administração Contratante, para dirimir os litígios que decorrerem da execução deste Termo de Contrato que não puderem ser compostos pela conciliação administrativa, nos termos do Art. 92, § 1º da Lei nº 14.133/2021.</p>

        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <table>
          <thead>
            <tr>
              <th>Pelo Contratante</th>
              <th>Pela Contratada</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>_________________________________<br/><strong>${bind('prefeito_nome', prefeitoSpan.displayName)}</strong><br/>${escapeHtml(prefeitoSpan.roleForSignature)}<br/>${bind('orgao_razao_social', orgaoRazao)}</td>
              <td>_________________________________<br/><strong>[REPRESENTANTE LEGAL DA CONTRATADA]</strong><br/>[RAZÃO SOCIAL DA CONTRATADA]</td>
            </tr>
            <tr>
              <td><strong>Testemunha 1:</strong> ___________________________<br/>Nome / CPF:</td>
              <td><strong>Testemunha 2:</strong> ___________________________<br/>Nome / CPF:</td>
            </tr>
          </tbody>
        </table>
      `.trim();

  return {
    structured_json: json,
    html_content: html,
    legal_alerts: [
      {
        id: 'ag7-art92-completo',
        severity: 'info',
        article: 'Art. 92, Art. 25, § 7º e Art. 94 da Lei nº 14.133/2021',
        title: 'Minuta Estruturada — Valores/Duração em Aberto e Preâmbulo Exclusivo do Prefeito',
        message: `Minuta estruturada em 13 cláusulas vinculadas ao TR (${trNumeroRef}), com preâmbulo e assinatura exclusiva pelo(a) ${prefeitoSpan.roleForSignature} (${prefeitoSpan.displayName}), valores e vigência inicial em aberto para preenchimento pós-adjudicação, data-base em ${todayBR} (Art. 25, § 7º), reserva de cargos PCD (Art. 92, XVII), publicação PNCP em ${prazoPncp} e foro da ${comarca}.`
      }
    ]
  };
}

interface BuildAgent10Params {
  proc: ProcurementProcess;
  inst: Institution;
  secNome: string;
  dot: Dotacao | null;
  dotLinha: string;
  municipioUf: string;
  todayBR: string;
  category: DomainCategory;
  certameAlerts: LegalAlert[];
  piecesByNumber: Map<number, AgentPiece>;
  totalValor: number;
  objetoConsolidado: string;
  feedback?: string;
}

function buildAgent10ParecerJuridico(params: BuildAgent10Params): AgentOutputPayload {
  const {
    proc,
    inst,
    secNome,
    dot,
    dotLinha,
    municipioUf,
    todayBR,
    category,
    certameAlerts,
    piecesByNumber,
    totalValor,
    objetoConsolidado,
    feedback
  } = params;

  const anoAtual = new Date().getFullYear();
  const modalidadeLabel = getModalidadeLabel(proc.modalidade);
  const modoLabel = getModoDisputaLabel(proc.modo_disputa);
  const criterioLabel = getCriterioLabel(proc.criterio_julgamento);
  const isPregao = proc.modalidade === 'PREGAO_ELETRONICO' || proc.modalidade === 'PREGAO_PRESENCIAL';
  const pregaoCompativelComObjeto = !(isPregao && category === 'OBRAS_ENGENHARIA');
  const selectedTcuPrecedents = selectContextualTcuPrecedents({ proc });
  const priceAnalytics = analyzePricePortfolio(proc.pesquisa_preco_itens || [], totalValor);
  const prefeitoQualificado = formatPrefeitoRoleAndName(inst.prefeito_nome).qualifiedTitle;

  const checklist: {
    item: string;
    artigo: string;
    status: 'CONFORME' | 'RESSALVA' | 'NAO_CONFORME';
    observacao: string;
  }[] = [];

  const hasCriticalCertame = certameAlerts.some((a) => a.severity === 'critical');
  const hasWarningCertame = certameAlerts.some((a) => a.severity === 'warning');

  // 1. Iniciação e DFD
  const p1Piece = piecesByNumber.get(1);
  const p2Piece = piecesByNumber.get(2);
  const p6Piece = piecesByNumber.get(6);
  checklist.push({
    item: 'Demanda da Necessidade (Peça 01) e DFD (Peça 02)',
    artigo: 'Art. 11, Art. 12, VII e Art. 72, I',
    status: p1Piece?.html_content && p2Piece?.html_content ? 'CONFORME' : 'NAO_CONFORME',
    observacao:
      p1Piece?.html_content && p2Piece?.html_content
        ? 'Iniciação fundamentada no interesse público e formalizada em DFD com previsão no PCA e equipe de planejamento.'
        : 'Demanda inicial ou DFD ausente nos autos.'
  });

  // 2. ETP 13 incisos
  const p3Piece = piecesByNumber.get(3);
  const etpIncisos = p3Piece?.structured_json?.incisos_art18_par1;
  const etpComplete = Boolean(etpIncisos && Object.keys(etpIncisos).length >= 13);
  checklist.push({
    item: 'Estudo Técnico Preliminar (13 incisos do Art. 18, § 1º) e Parcelamento',
    artigo: 'Art. 18, §§ 1º e 2º / Art. 40 / Súmula nº 247/TCU',
    status: etpComplete ? 'CONFORME' : p3Piece?.html_content ? 'RESSALVA' : 'NAO_CONFORME',
    observacao: etpComplete
      ? 'ETP abrange integralmente os incisos I a XIII, memória de cálculo, levantamento de mercado comparativo e declaração conclusiva de viabilidade.'
      : 'ETP ausente ou pendente de verificação completa dos 13 incisos.'
  });

  // 3. Mapa de Riscos (3 fases)
  const p4Piece = piecesByNumber.get(4);
  const totalRiscos = Number(p4Piece?.structured_json?.total_riscos ?? 0);
  checklist.push({
    item: 'Mapa de Gerenciamento de Riscos (3 Fases / P × I)',
    artigo: 'Art. 18, X e Art. 22',
    status: !p4Piece?.html_content ? 'NAO_CONFORME' : totalRiscos >= 9 ? 'CONFORME' : 'RESSALVA',
    observacao: !p4Piece?.html_content
      ? 'Mapa de Riscos não gerado.'
      : totalRiscos >= 9
        ? `Matriz estruturada contempla ${totalRiscos} eventos específicos nas 3 fases (Planejamento, Seleção e Gestão Contratual) com matriz P×I.`
        : `Matriz possui apenas ${totalRiscos} eventos; recomenda-se mínimo de 3 riscos concretos por fase.`
  });

  // 4. Coerência entre DFD, ETP, TR, Pesquisa de Preços (Art. 23) e Adequação Orçamentária
  const p5Piece = piecesByNumber.get(5);
  const trVal = Number(p5Piece?.structured_json?.valor_total_estimado ?? 0);
  const dfdVal = Number(p2Piece?.structured_json?.valor_total_preliminar ?? 0);
  const etpVal = Number(
    p3Piece?.structured_json?.valor_estimado_contratacao ??
      p3Piece?.structured_json?.valor_estimado_global ??
      0
  );
  const valuesConsistent =
    trVal > 0 && dfdVal > 0 && Math.abs(trVal - dfdVal) < 1 && (etpVal <= 0 || Math.abs(trVal - etpVal) < 1);
  const hasBudgetIssue = !proc.usar_srp && !dot;
  checklist.push({
    item: 'Termo de Referência, Coerência de Valores (Art. 23) e Adequação Orçamentária',
    artigo: proc.usar_srp
      ? 'Art. 6º, XXIII / Art. 23 / Acórdão nº 1.875/2021-TCU-Plenário / Art. 17 Dec. 11.462/2023'
      : 'Art. 6º, XXIII / Art. 23 / Acórdão nº 1.875/2021-TCU-Plenário / Art. 150',
    status:
      !p5Piece?.html_content || hasBudgetIssue
        ? 'NAO_CONFORME'
        : valuesConsistent
          ? 'CONFORME'
          : 'RESSALVA',
    observacao: !p5Piece?.html_content
      ? 'Termo de Referência ainda não elaborado.'
      : hasBudgetIssue
        ? 'Contratação convencional (sem SRP) exige indicação prévia e vinculação expressa da dotação orçamentária (Art. 150).'
        : valuesConsistent
          ? `Objeto e valores convergentes entre DFD, ETP e TR (${formatCurrencyBRL(trVal)}), com cesta de preços fundamentada no Art. 23 e Acórdão nº 1.875/2021-TCU-Plenário${proc.usar_srp ? ' e dispensa de dotação prévia no SRP pelo Art. 17 do Decreto nº 11.462/2023' : ''}.`
          : 'Detectada divergência numérica entre DFD, ETP e TR — verificar memória de cálculo e cesta de preços (Art. 23).'
  });

  // 5. Adequação da Modalidade, Modo de Disputa, Critério e Natureza do Objeto (Art. 29)
  checklist.push({
    item: 'Adequação Modalidade × Natureza do Objeto × Disputa × Critério',
    artigo: isPregao ? 'Arts. 28, 29, 33 e 56' : 'Arts. 28, 33 e 56',
    status:
      hasCriticalCertame || !pregaoCompativelComObjeto
        ? 'NAO_CONFORME'
        : hasWarningCertame
          ? 'RESSALVA'
          : 'CONFORME',
    observacao: !pregaoCompativelComObjeto
      ? 'Incompatibilidade material (Art. 29, parágrafo único): o Pregão não se aplica a contratações de obras ou serviços especiais de engenharia.'
      : hasCriticalCertame
        ? certameAlerts.filter((a) => a.severity === 'critical').map((a) => a.message).join(' | ')
        : hasWarningCertame
          ? certameAlerts.filter((a) => a.severity === 'warning').map((a) => a.title).join(' | ')
          : `Modalidade ${modalidadeLabel}, modo ${modoLabel} e critério ${criterioLabel} compatíveis com a natureza do objeto${isPregao ? ' (bens/serviços comuns objetivamente definíveis — Art. 29)' : ''}.`
  });

  // 6. Análise das Minutas (Edital, Contrato Art. 92, ARP Art. 82-86) e Competitividade (Art. 9º / LC 123/06)
  const p7Piece = piecesByNumber.get(7);
  const p8Piece = piecesByNumber.get(8);
  const p9Piece = piecesByNumber.get(9);
  const srpOk = !proc.usar_srp || Boolean(p8Piece && p8Piece.html_content && p8Piece.status !== 'DISPENSADO');
  const contrato13Clausulas = (p7Piece?.structured_json?.clausulas_minuta?.length ?? 0) >= 13;
  const contratoLegacyOrdenador = Boolean(p7Piece?.structured_json?.ordenador_signatario);
  const minutasPresentes = Boolean(p7Piece?.html_content && p9Piece?.html_content && srpOk);
  checklist.push({
    item: proc.usar_srp
      ? 'Minutas (Edital Art. 25, Contrato Art. 92 e ARP Art. 82-86) + Competitividade (Art. 9º / LC 123/06)'
      : 'Minutas (Edital Art. 25 e Contrato Art. 92) + Competitividade (Art. 9º / LC 123/06)',
    artigo: 'Art. 9º, Art. 25, Art. 92, LC nº 123/2006 e Súmulas nº 263, 272 e 289/TCU',
    status: !minutasPresentes ? 'NAO_CONFORME' : contrato13Clausulas && !contratoLegacyOrdenador ? 'CONFORME' : 'RESSALVA',
    observacao: !minutasPresentes
      ? 'Edital/Aviso, Minuta de Contrato ou Minuta de ARP obrigatória ausente.'
      : contratoLegacyOrdenador
        ? 'Atenção: a Minuta de Contrato atual (Peça 07) ainda menciona Secretário/Ordenador no preâmbulo ou assinatura; recomenda-se regerar a Peça 07 para adequação exclusiva ao Prefeito Municipal e manutenção dos campos pós-adjudicação em aberto.'
        : contrato13Clausulas
          ? 'Edital (Art. 25) observa tratamento ME/EPP (LC 123/06) e vedação a exigências restritivas (Art. 9º / Súmulas 263, 272 e 289/TCU); Minuta Contratual (Art. 92) contém as 13 cláusulas, preâmbulo exclusivo pelo Prefeito Municipal, preços e vigência em aberto para pós-adjudicação e data-base do orçamento (Art. 25, § 7º).'
          : 'Minuta contratual com estrutura reduzida; recomenda-se conferir integralmente todas as cláusulas do Art. 92.'
  });

  // 7. Autuação e Higidez Documental (peças desatualizadas ou pendentes)
  const stalePieces = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((n) => piecesByNumber.get(n))
    .filter((p) => p && p.status === 'DESATUALIZADO');
  const unapprovedDrafts = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((n) => piecesByNumber.get(n))
    .filter((p) => p && p.status !== 'DISPENSADO' && p.status !== 'APROVADO');

  checklist.push({
    item: 'Autuação Formal (Peça 06) e Higidez / Aprovação das Peças',
    artigo: 'Art. 12, VI, Art. 18 e Art. 53',
    status: !p6Piece?.html_content || stalePieces.length > 0 ? 'NAO_CONFORME' : unapprovedDrafts.length > 0 ? 'RESSALVA' : 'CONFORME',
    observacao: !p6Piece?.html_content
      ? 'Termo de Autuação (Peça 06) ausente nos autos.'
      : stalePieces.length > 0
        ? `Existem ${stalePieces.length} peça(s) marcada(s) como DESATUALIZADO após alteração de parâmetros; exige-se atualização prévia à publicação.`
        : unapprovedDrafts.length > 0
          ? `${unapprovedDrafts.length} peça(s) preparatória(s) ainda pendente(s) de assinatura formal de aprovação antes da remessa à fase externa.`
          : 'Todas as peças 01 a 09 estão devidamente autuadas, coerentes, atualizadas e formalmente aprovadas.'
  });

  const hasNaoConforme = checklist.some((c) => c.status === 'NAO_CONFORME');
  const hasRessalva = checklist.some((c) => c.status === 'RESSALVA');
  const conclusao: 'APROVADO' | 'APROVADO_COM_RESSALVAS' | 'REPROVADO_SANEAMENTO' = hasNaoConforme
    ? 'REPROVADO_SANEAMENTO'
    : hasRessalva
      ? 'APROVADO_COM_RESSALVAS'
      : 'APROVADO';

  const conclusaoOpcaoLabel =
    conclusao === 'APROVADO'
      ? '(a) APROVAÇÃO INTEGRAL PARA PROSSEGUIMENTO da fase externa e publicação do certame'
      : conclusao === 'APROVADO_COM_RESSALVAS'
        ? '(b) APROVAÇÃO CONDICIONADA AO SANEAMENTO DAS RESSALVAS APONTADAS previamente à divulgação do Edital'
        : '(c) DEVOLUÇÃO DOS AUTOS PARA RETIFICAÇÃO ANTES DA PUBLICAÇÃO, ante as inconformidades críticas detectadas';

  const ressalvas = checklist
    .filter((c) => c.status !== 'CONFORME')
    .map((c) => `[${c.artigo}] ${c.item}: ${c.observacao}`);

  const sumarioP6 = Array.isArray(p6Piece?.structured_json?.sumario_autos)
    ? (p6Piece!.structured_json.sumario_autos as { titulo: string; folhas: string }[])
        .map((s) => `${s.titulo} (${s.folhas})`)
        .join('; ')
    : 'Peças 01 a 09 indexadas na instrução preparatória.';

  const statusDisplayMap: Record<'CONFORME' | 'RESSALVA' | 'NAO_CONFORME', string> = {
    CONFORME: 'Conforme',
    RESSALVA: 'Ressalva',
    NAO_CONFORME: 'Pendente / Não Conforme'
  };

  const rowsHtml = checklist
    .map(
      (c) => `
          <tr>
            <td>${escapeHtml(c.item)}</td>
            <td>${escapeHtml(c.artigo)}</td>
            <td><strong>${statusDisplayMap[c.status]}</strong></td>
            <td>${escapeHtml(c.observacao)}</td>
          </tr>`
    )
    .join('');

  const tcuMatrixHtml = renderStructuredTableHtml(
    ['Precedente / Colegiado', 'Origem / Vínculo', 'Tema e Base Normativa', 'Tese Consolidada e Reflexo Direto no Certame'],
    selectedTcuPrecedents.map((p) => [
      { label: `${p.numero} (${p.colegiado})`, strong: true },
      p.vinculadoManualmente
        ? 'Vinculado ao Processo'
        : p.fonte === 'DADOS_ABERTOS_TCU'
          ? 'Dados Abertos TCU'
          : 'Jurisprudência Base TCU',
      `${p.tema_label} — ${p.artigos_relacionados}`,
      `${p.ementa} Aplicação prática: ${p.aplicacao_pratica}`
    ])
  );

  const contratoAuditoriaResumo = !p7Piece?.html_content
    ? 'Minuta de Termo de Contrato (Peça 07) não localizada nos autos — omissão impeditiva.'
    : contratoLegacyOrdenador
      ? 'A Minuta de Termo de Contrato (Peça 07) reúne as 13 cláusulas do Art. 92, porém ainda apresenta Secretário/Ordenador no preâmbulo ou assinatura; recomenda-se regerar para assinatura exclusiva do Prefeito Municipal e campos pós-adjudicação em aberto.'
      : `A Minuta de Termo de Contrato (Peça 07) reúne integralmente as cláusulas essenciais do Art. 92, apresenta preâmbulo e campo de assinatura vinculados exclusivamente ao(à) Chefe do Poder Executivo Municipal (${escapeHtml(prefeitoQualificado)}), resguarda em aberto os valores contratuais unitários/globais e os prazos de vigência/execução inicial para preenchimento fiel à proposta vencedora adjudicada, fixa data-base do reajuste vinculada ao orçamento estimado (Art. 25, § 7º), distingue reajuste e repactuação (Art. 135), exige reserva de cargos para PcD/reabilitados/aprendizes (Art. 92, XVII), disciplina dosimetria sancionatória objetiva (Arts. 155–163) e condição de eficácia via PNCP (Art. 94).`;

  const fichaParecerHtml = renderMetadataGridHtml([
    ['Órgão Consultivo', `Procuradoria Jurídica Municipal — ${bind('orgao_razao_social', inst.razao_social)}`],
    [
      'Processos Vinculados',
      `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
    ],
    [
      'Modalidade e Disputa',
      `${bind('modalidade_label', modalidadeLabel)} &bull; Modo ${bind('modo_disputa_label', modoLabel)}`
    ],
    [
      'Critério e Valor de Referência',
      `${bind('criterio_julgamento_label', criterioLabel)} &bull; <strong>${formatCurrencyBRL(totalValor)}</strong>`
    ],
    [
      'Diagnóstico da Cesta Art. 23',
      escapeHtml(priceAnalytics.summaryText)
    ]
  ]);

  const html = `
        <h2>10. PARECER JURÍDICO REFERENCIAL / CONCLUSIVO Nº ___/${anoAtual}</h2>
        ${fichaParecerHtml}
        ${feedbackCallout(feedback)}

        <h3>Ementa Jurídica</h3>
        <blockquote class="exec-summary"><strong>DIREITO ADMINISTRATIVO. LICITAÇÕES E CONTRATOS PÚBLICOS. CONTROLE PRÉVIO DE LEGALIDADE (ART. 53 DA LEI Nº 14.133/2021).</strong> Processo Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}. ${escapeHtml(modalidadeLabel)}${proc.usar_srp ? ' sob o Sistema de Registro de Preços (Arts. 82–86)' : ''}. Exame da coerência entre DFD, ETP (Art. 18, § 1º), Mapa de Riscos (Arts. 18, X e 22), Termo de Referência (Art. 6º, XXIII), pesquisa de preços (Art. 23 e Acórdãos nº 1.875/2021, 1.712/2025, 1.855/2025 e 318/2026-TCU-Plenário), neutralidade de especificações (Art. 41 e Acórdãos nº 2.829/2015 e 1.264/2019-TCU-Plenário), tratamento diferenciado a ME/EPP (LC nº 123/2006) e aderência às Súmulas nº 247, 263, 272 e 289 do TCU. Análise restrita aos pressupostos jurídico-formais (STF MS nº 24.631 e Art. 28 da LINDB). <strong>Conclusão: ${escapeHtml(conclusaoOpcaoLabel)}.</strong></blockquote>

        <h3>1. Relatório</h3>
        <p>Trata-se de consulta jurídico-administrativa submetida a esta Procuradoria Jurídica no exercício do controle prévio de legalidade estatuído pelo <strong>Art. 53 da Lei Federal nº 14.133/2021</strong>, referente ao procedimento destinado à contratação de: <strong>${escapeHtml(objetoConsolidado)}</strong>, originário da <strong>${bind('secretaria_nome', secNome)}</strong>, com valor global estimado de referência no Termo de Referência de <strong>${formatCurrencyBRL(totalValor)}</strong>.</p>
        <p><strong>Síntese das Folhas e Peças Autuadas:</strong> Consoante Termo de Autuação (Peça 06), encontram-se instruídos nos autos eletrônicos/físicos: ${escapeHtml(sumarioP6)}; além da Minuta de Termo de Contrato Administrativo (Peça 07), ${proc.usar_srp ? 'Minuta de Ata de Registro de Preços (Peça 08), ' : ''}e Minuta do Edital/Aviso Consolidado (Peça 09), vindo o feito concluso a este órgão consultivo.</p>

        <h3>2. Finalidade e Abrangência do Parecer</h3>
        <p>A presente manifestação tem por finalidade realizar o <strong>controle prévio de legalidade</strong> mediante apreciação jurídica da contratação submetida a exame, nos estritos termos do <strong>Art. 53, caput e § 1º, incisos I e II, da Lei Federal nº 14.133/2021</strong>, avaliando os pressupostos objetivos de validade jurídica dos atos preparatórios e das minutas instrumentais em linguagem clara, objetiva e fundamentada na doutrina administrativa e na jurisprudência consolidada do Tribunal de Contas da União (TCU).</p>
        <p><strong>Delimitação Jurisprudencial da Competência Jurídica e Responsabilidade (STF MS nº 24.631, LINDB Art. 28 e Acórdãos nº 2.599/2021 e 2.121/2024-TCU-Plenário):</strong> Cumpre ressalvar que este exame restringe-se aos aspectos jurídico-formais e à conformidade normativa perante a Lei nº 14.133/2021, a LC nº 123/2006 e os regulamentos correlatos. Não compete à Procuradoria Jurídica adentrar no mérito administrativo (juízo discricionário de conveniência e oportunidade do gestor), tampouco auditar levantamentos quantitativos, cotações de mercado ou especificações técnicas especializadas elaboradas pelas áreas técnicas requisitantes, os quais gozam de presunção de veracidade sob responsabilidade exclusiva de seus subscritores.</p>

        <h3>3. Análise da Instrução da Fase Preparatória (Art. 18)</h3>
        <ul>
          <li><strong>3.1. Coerência da Cadeia de Planejamento (Demanda, DFD, ETP, Mapa de Riscos e TR):</strong> A necessidade administrativa exposta na Peça 01 e formalizada no DFD (Peça 02) encontra desenvolvimento técnico estruturado nos 13 incisos do Estudo Técnico Preliminar (Peça 03 — IN SEGES/ME nº 58/2022), mapeamento de contingências e alocação de riscos (Art. 103) no Mapa de Gerenciamento de Riscos (Peça 04 — ${totalRiscos} riscos nas 3 fases) e transposição vinculante no Termo de Referência (Peça 05 — Art. 6º, XXIII e IN SEGES/ME nº 81/2022). ${valuesConsistent ? `Os valores estimados guardam integral convergência aritmética entre DFD, ETP e TR (${formatCurrencyBRL(trVal)}).` : '<strong>Alerta Crítico:</strong> Detectada divergência numérica entre DFD, ETP e TR — recomenda-se conferência imediata antes da divulgação.'}</li>
          <li><strong>3.2. Pesquisa de Preços, Curva ABC e Cesta Referencial (Art. 23, IN SEGES/ME nº 65/2021 e Acórdãos nº 1.875/2021, 1.712/2025, 1.855/2025 e 318/2026-TCU-Plenário):</strong> Verifica-se a utilização de pesquisa de preços estruturada conforme parâmetros do Art. 23, § 1º da Lei nº 14.133/2021. Análise quantitativa da carteira: ${escapeHtml(priceAnalytics.summaryText)} Conforme jurisprudência do TCU, a estimativa não deve restringir-se a cotações privadas sem justificativa, impondo-se prioridade às fontes oficiais (PNCP, Painel de Preços e contratações similares) e saneamento estatístico crítico com atenção redobrada aos itens de Classe A.</li>
          <li><strong>3.3. Adequação Orçamentária e Disciplina Fiscal (Art. 150 / LRF):</strong> ${proc.usar_srp ? 'Tratando-se de procedimento processado pelo Sistema de Registro de Preços (SRP — Art. 82), justifica-se juridicamente a dispensa de indicação prévia de disponibilidade orçamentária nesta fase preparatória nos termos do <strong>Art. 17 do Decreto nº 11.462/2023</strong>, tornando-se obrigatória a indicação da dotação previamente à assinatura contratual ou emissão de empenho.' : dot ? `Verifica-se indicação formal da dotação orçamentária ${bind('dotacao_completa', dotLinha)} com declaração de compatibilidade junto à LOA, LDO e PPA (Art. 150 da Lei nº 14.133/2021 e Art. 16 da LRF).` : '<strong>Omissão Grave Detectada:</strong> ausência de dotação orçamentária vinculada em contratação convencional sem SRP, contrariando frontalmente o Art. 150 da Lei nº 14.133/2021.'}</li>
          <li><strong>3.4. Adequação da Modalidade, Modo de Disputa e Critério (${escapeHtml(modalidadeLabel)} / ${escapeHtml(modoLabel)} / ${escapeHtml(criterioLabel)}):</strong> ${!pregaoCompativelComObjeto ? '<strong>Impropriedade jurídica detectada:</strong> pretende-se utilizar Pregão para objeto classificado como obra de engenharia, contrariando a vedação expressa do Art. 29, parágrafo único, da Lei nº 14.133/2021.' : isPregao ? `À luz do <strong>Art. 29 da Lei nº 14.133/2021</strong>, o objeto caracteriza-se como bem/serviço comum cujos padrões de desempenho e qualidade podem ser objetivamente definidos no edital por especificações usuais de mercado, revelando-se legítima a adoção do ${escapeHtml(modalidadeLabel)}, no modo de disputa ${escapeHtml(modoLabel)} (Art. 56) e critério ${escapeHtml(criterioLabel)} (Art. 33).` : `O enquadramento procedimental (${escapeHtml(modalidadeLabel)}, modo ${escapeHtml(modoLabel)}, critério ${escapeHtml(criterioLabel)}) apresenta-se juridicamente compatível com as hipóteses dos Arts. 28 e 33 da Lei nº 14.133/2021${hasCriticalCertame ? ', observadas as inconsistências críticas listadas no checklist' : ''}.`}</li>
          <li><strong>3.5. Parcelamento do Objeto e Economia de Escala (Art. 40, § 2º e Súmula nº 247/TCU):</strong> A decisão de adjudicação (${escapeHtml(getFormatoLanceLabel(proc.formato_lance))}) encontra-se motivada no Inciso VIII do ETP segundo os critérios cumulativos do Art. 40, § 3º da Lei nº 14.133/2021 e da Súmula nº 247 do TCU.</li>
          <li><strong>3.6. Governança e Segregação de Funções (Art. 7º, § 1º e Acórdão nº 2.829/2015-TCU-Plenário):</strong> Consta nos autos indicação diferenciada das funções de requisição, planejamento e condução licitatória, cumprindo-se a segregação de funções também mediante vedação à atuação simultânea de um mesmo agente como elaborador de pesquisa/TR e fiscal/pregoeiro sem justificativa e designação distinta do Gestor e Fiscais (Art. 117).</li>
        </ul>

        <h3>4. Análise das Minutas (Edital, Contrato e ARP)</h3>
        <ul>
          <li><strong>4.1. Exigências Editalícias, Súmulas do TCU e Tratamento ME/EPP (Art. 9º, Art. 25, Art. 41 e LC nº 123/2006):</strong> A Minuta do Edital/Aviso (Peça 09) contempla os elementos obrigatórios do Art. 25 (prazos mínimos do Art. 55, modo de disputa do Art. 56, desempate do Art. 60, negociação do Art. 61, exequibilidade do Art. 59 e impugnações/recursos dos Arts. 164–165). Sob o prisma da competitividade (<strong>Art. 9º, I</strong>) e dos <strong>Acórdãos nº 1.264/2019 e 1.092/2026-TCU-Plenário</strong>, não se constatam cláusulas de direcionamento de marca sem justificativa formal de padronização (Art. 41), tampouco exigências de custos prévios desnecessários (<strong>Súmula nº 272/TCU</strong>) ou atestados excessivos (<strong>Súmula nº 263/TCU</strong> — limitados a 50% das parcelas com relevância mínima de 4% na forma do Art. 67, §§ 1º e 2º), encontrando-se justificados os índices contábeis do Art. 69 (LG/SG/LC ≥ 1,00 — <strong>Súmula nº 289/TCU</strong>) e assegurado o tratamento diferenciado às ME/EPP nos termos da <strong>LC nº 123/2006</strong> e do Art. 4º da Lei nº 14.133/2021.</li>
          <li><strong>4.2. Cláusulas Necessárias da Minuta Contratual (Art. 92 e Art. 25, § 7º):</strong> ${contratoAuditoriaResumo}</li>
          <li><strong>4.3. Regime do Sistema de Registro de Preços (Arts. 82 a 86 e Decreto nº 11.462/2023):</strong> ${proc.usar_srp ? 'A Minuta de Ata de Registro de Preços (Peça 08) observa fielmente o prazo de vigência de 1 (um) ano contado do primeiro dia útil pós-PNCP prorrogável por igual período (Art. 84), veda acréscimos quantitativos, disciplina o Cadastro de Reserva e fixa os limites legais de adesão carona de 50% individual e dobro (2x) global (Art. 86, §§ 4º e 5º).' : 'Contratação convencional sem utilização do Sistema de Registro de Preços (Peça 08 dispensada nos autos).'}</li>
        </ul>

        <h3>4.4. Matriz de Jurisprudência Aplicável do TCU (Acórdãos e Súmulas Vinculados)</h3>
        <p>Consolidação analítica dos entendimentos sumulados e acórdãos do Plenário do Tribunal de Contas da União aplicáveis ao controle prévio de legalidade deste processo${(proc.tcu_acordaos_vinculados?.length ?? 0) > 0 ? `, incluindo ${proc.tcu_acordaos_vinculados?.length ?? 0} precedente(s) expressamente vinculado(s) pela Procuradoria Jurídica` : ''}:</p>
        ${tcuMatrixHtml}

        <h3>5. Checklist de Conformidade Legal</h3>
        <table>
          <thead>
            <tr>
              <th>Item Verificado</th>
              <th>Base Legal</th>
              <th>Status (Conforme / Ressalva / Pendente)</th>
              <th>Análise / Fundamentação</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <h3>6. Conclusão e Recomendações</h3>
        <p>Diante de todo o exposto, exercendo o controle prévio de legalidade preconizado pelo Art. 53 da Lei Federal nº 14.133/2021, à luz da jurisprudência do TCU e do STF aplicável, esta Procuradoria Jurídica opina fundamentadamente pela opção: <strong>${escapeHtml(conclusaoOpcaoLabel)}</strong>.</p>
        ${
          ressalvas.length === 0
            ? '<p>Não foram identificadas ressalvas ou pendências formais impeditivas no conjunto documental analisado.</p>'
            : `<p><strong>Pontos que exigem atenção / saneamento pelo gestor (Art. 53, § 3º):</strong></p><ul>${ressalvas.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        }
        <p><strong>Condicionantes e Providências Obrigatórias Pré-Publicação:</strong></p>
        <ul>
          <li>Confirmar a assinatura e aprovação formal das peças preparatórias nos autos antes da abertura da fase externa;</li>
          <li>Publicar o Edital/Aviso e seus anexos integralmente no <strong>Portal Nacional de Contratações Públicas (PNCP)</strong>, no Diário Oficial e em sítio eletrônico oficial (Art. 54 e § 1º);</li>
          <li>Observar rigorosamente os prazos mínimos entre a divulgação do Edital e a data da sessão pública (Art. 55 da Lei nº 14.133/2021);</li>
          <li>Promover a designação formal do Agente de Contratação/Pregoeiro, Equipe de Apoio, Gestor do Contrato e Fiscais com respeito à segregação de funções (Arts. 7º, 8º e 117).</li>
        </ul>

        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <p>_________________________________________________________<br/>
        <strong>Procurador(a) Jurídico(a) Municipal / Assessor(a) Jurídico(a)</strong><br/>
        Inscrição OAB/${escapeHtml(inst.uf || 'UF')} nº ______________<br/>
        Procuradoria-Geral do(a) ${bind('orgao_razao_social', inst.razao_social)}</p>
      `.trim();

  const alerts: LegalAlert[] = checklist
    .filter((c) => c.status !== 'CONFORME')
    .map((c, i) => ({
      id: `ag10-chk-${i}`,
      severity: c.status === 'NAO_CONFORME' ? 'critical' : 'warning',
      article: c.artigo,
      title: c.item,
      message: c.observacao
    }));

  if (alerts.length === 0) {
    alerts.push({
      id: 'ag10-ok',
      severity: 'info',
      article: 'Art. 53 da Lei nº 14.133/2021',
      title: 'Parecer Jurídico Favorável sem Ressalvas',
      message: `Todos os critérios formais, contratuais e de jurisprudência TCU (${selectedTcuPrecedents.length} precedentes examinados) encontram-se em conformidade.`
    });
  }

  return {
    structured_json: {
      numero_parecer: `PJ-${proc.numero_processo_licitatorio.replace(/[^\w/-]/g, '')}/${anoAtual}`,
      conclusao,
      conclusao_label: conclusaoOpcaoLabel,
      checklist_conformidade: checklist,
      ressalvas,
      folhas_autuadas_citadas: sumarioP6,
      pregao_compativel_art29: pregaoCompativelComObjeto,
      tcu_acordaos_citados: selectedTcuPrecedents.map((p) => ({
        id: p.id,
        numero: p.numero,
        tema: p.tema,
        tema_label: p.tema_label,
        vinculado_manualmente: p.vinculadoManualmente
      })),
      feedback_incorporado: feedback || null
    },
    html_content: html,
    legal_alerts: alerts
  };
}

export function buildAgentPieceLocally(agentNumber: number, ctx: GenerationContext): AgentOutputPayload {
  const { process: proc, institution: inst, secretario: sec, dotacao: dot, piecesByNumber, auditLogs, feedback } = ctx;
  const category = detectCategory(`${proc.titulo_resumido} ${proc.demanda_bruta}`, proc.tipo_contratacao);
  const tipoContratacaoLabel = getTipoContratacaoLabel(proc.tipo_contratacao);
  const sessaoPublicaLabel = formatSessaoPublicaLabel(proc.data_certame, proc.horario_disputa);
  const certameAlerts = validateCertameConfiguration(proc);
  const todayBR = formatDateBR(new Date());
  const municipioUf = `${inst.municipio || 'Município'}/${inst.uf || 'UF'}`;
  const comarca = inst.comarca_foro || `Comarca de ${municipioUf}`;
  const secNome = sec?.secretaria || 'Secretaria Requisitante a Definir';
  const ordenadorNome = sec?.nome || 'Ordenador de Despesas a Designar';
  const ordenadorCargo = sec?.cargo || 'Secretário(a) Municipal';
  const ordenadorPortaria = sec?.portaria_nomeacao || 'Portaria de Nomeação vigente';
  const dotLinha = formatDotacoesSummary(
    ctx.dotacoesVinculadas ?? (dot ? [dot] : []),
    proc.dotacoes_manuais
  );
  const direct = isDirectContracting(proc.modalidade);
  const modalityGuidance = getModalityProceduralGuidance(proc);
  const deepSpec = DOMAIN_DEEP_SPECS[category];
  const trDomain = DOMAIN_TR_CONFIG[category];

  // Recupera itens da Pesquisa de Preço enviada (prioridade máxima) ou de peças anteriores para consistência absoluta
  const p1 = piecesByNumber.get(1)?.structured_json;
  const p2 = piecesByNumber.get(2)?.structured_json;
  const p3 = piecesByNumber.get(3)?.structured_json;
  const p4 = piecesByNumber.get(4)?.structured_json;
  const p5 = piecesByNumber.get(5)?.structured_json;

  const uploadedPesquisaItems = pesquisaItensToPlanned(proc);
  const baseItems: PlannedItem[] =
    (uploadedPesquisaItems.length > 0 && uploadedPesquisaItems) ||
    (Array.isArray(p5?.itens_planilha) && p5.itens_planilha.length > 0 && p5.itens_planilha) ||
    (Array.isArray(p3?.itens_estimados) && p3.itens_estimados.length > 0 && p3.itens_estimados) ||
    (Array.isArray(p2?.itens) && p2.itens.length > 0 && p2.itens) ||
    parsePlannedItems(proc, category);

  const totalValor = sumItems(baseItems);
  const priceAnalytics = analyzePricePortfolio(
    baseItems.map((it) => ({
      item: it.item,
      descricao: it.descricao,
      medida: it.medida || it.unidade,
      quantidade: it.quantidade,
      valor_unitario: it.valor_unitario,
      valor_total: it.valor_total
    })),
    totalValor
  );
  const prefeitoSpan = formatPrefeitoQualifiedSpan(inst.prefeito_nome);
  const objetoConsolidado =
    p5?.objeto_definicao ||
    p3?.objeto_solucao ||
    p2?.objeto_sucinto ||
    proc.titulo_resumido ||
    'Contratação de bens e/ou serviços para atendimento de demanda pública municipal';
  const pesquisaFonteResumo =
    ctx.pesquisaMercado?.trim() ||
    proc.pesquisa_preco_resumo?.trim() ||
    'Cesta de preços públicos composta por registros do PNCP, Painel de Preços, contratações similares de entes municipais e pesquisa direta complementar (Art. 23, § 1º da Lei nº 14.133/2021).';

  switch (agentNumber) {
    // ========================================================
    // AGENTE 01: EXPOSIÇÃO DE DEMANDA E NECESSIDADE ADMINISTRATIVA
    // ========================================================
    case 1: {
      const relato = (proc.demanda_bruta || proc.titulo_resumido || '').trim();
      const modalidadeLabel = getModalidadeLabel(proc.modalidade);
      const criterioLabel = getCriterioLabel(proc.criterio_julgamento);
      const modoLabel = getModoDisputaLabel(proc.modo_disputa);
      const formatoLanceLabel = getFormatoLanceLabel(proc.formato_lance);
      const diagnosticoAtual =
        `No âmbito operacional da ${secNome}, constata-se situação deficitária relativa ao objeto "${proc.titulo_resumido || 'demanda apresentada'}", que demanda intervenção administrativa estruturada: ${relato}. ` +
        `A persistência desse cenário compromete a regularidade das rotinas finalísticas, eleva os custos corretivos por manutenção/contingência improvisada e impacta diretamente a continuidade e a qualidade dos serviços públicos prestados aos munícipes de ${municipioUf}.`;

      const problema =
        `O cerne do problema administrativo consiste em eliminar o déficit operacional identificado na ${secNome} preservando estrita neutralidade tecnológica e isonomia competitiva (Art. 41 da Lei nº 14.133/2021), sem direcionamento prévio de marca ou solução comercial fechada. ` +
        `A instrução visa restabelecer níveis mensuráveis de disponibilidade, conformidade normativa e eficiência administrativa, encaminhando a demanda para processamento sob a modalidade ${modalidadeLabel} (critério ${criterioLabel}, ${formatoLanceLabel}) e reservando ao Estudo Técnico Preliminar (Art. 18, § 1º, V) o cotejo comparativo das soluções de mercado sob a óptica do Custo Total de Propriedade (TCO).`;

      const interessePublico =
        `A solução da necessidade administrativa tutela diretamente o interesse público primário e materializa os objetivos legais estatuídos no Art. 11 da Lei Federal nº 14.133/2021, assegurando o resultado mais vantajoso considerando o ciclo de vida completo, o tratamento isonômico entre licitantes, a prevenção de sobrepreço e inexequibilidade e o incentivo à eficiência e ao desenvolvimento nacional sustentável em ${municipioUf}.`;

      const alinhamentoEstrategico =
        `${deepSpec.ppaEstrategico} Adicionalmente, a demanda guarda vinculação direta com as atribuições regimentais da ${secNome} e com a previsão orçamentária preliminar indicada na dotação ${dotLinha}.`;

      const temPesquisaAnexa = uploadedPesquisaItems.length > 0 || Boolean(proc.pesquisa_preco_arquivo);

      const quadroInerciaHtml = renderStructuredTableHtml(
        ['Dimensão de Análise', 'Cenário de Inércia (Não Contratação)', 'Cenário com Atendimento da Demanda'],
        [
          [
            { label: 'Impacto Operacional', strong: true },
            deepSpec.cenarioInercia,
            `Restabelecimento imediato da capacidade instalada e continuidade ininterrupta das rotinas da ${secNome}.`
          ],
          [
            { label: 'Impacto Econômico-Financeiro', strong: true },
            'Elevação de gastos emergenciais fragmentados, perda de escala negocial e desperdício por ineficiência operacional.',
            `Ganho de economicidade pela disputa competitiva (${modalidadeLabel} / ${criterioLabel}) e previsibilidade orçamentária.`
          ],
          [
            { label: 'Conformidade Normativa e Controle', strong: true },
            'Risco de apontamentos por desatendimento a metas institucionais, falhas sanitárias/segurança ou passivos administrativos.',
            `Observância integral aos requisitos técnicos (${deepSpec.normasTecnicas.split(',')[0]}) e governança da Lei nº 14.133/2021.`
          ]
        ]
      );

      const json = {
        titulo_peca: 'EXPOSIÇÃO DE DEMANDA E NECESSIDADE ADMINISTRATIVA',
        secretaria_solicitante: secNome,
        ordenador_despesa: ordenadorNome,
        responsavel_requisitante: proc.responsavel_requisitante,
        cargo_requisitante: proc.cargo_requisitante,
        dotacao_indicada: dotLinha,
        objeto_informado: proc.titulo_resumido,
        modalidade_informada: modalidadeLabel,
        criterio_informado: criterioLabel,
        modo_disputa_informado: modoLabel,
        formato_lance_informado: formatoLanceLabel,
        usar_srp: proc.usar_srp,
        pesquisa_preco_arquivo: proc.pesquisa_preco_arquivo || null,
        itens_pesquisa_preco: baseItems,
        valor_estimado_global: totalValor,
        demanda_bruta_original: relato,
        situacao_atual: diagnosticoAtual,
        problema_administrativo: problema,
        interesse_publico: interessePublico,
        alinhamento_estrategico: alinhamentoEstrategico,
        cenario_inercia: deepSpec.cenarioInercia,
        normas_tecnicas_referencia: deepSpec.normasTecnicas,
        categoria_detectada: category,
        diretriz_sem_direcionamento: true,
        pareto_classe_a_pct: priceAnalytics.classeACumulativePct,
        price_portfolio_analytics: priceAnalytics,
        feedback_incorporado: feedback || null
      };

      const fichaDemandaHtml = renderMetadataGridHtml([
        ['Órgão / CNPJ', `${bind('orgao_razao_social', inst.razao_social)} &bull; CNPJ: ${bind('orgao_cnpj', formatCnpj(inst.cnpj))}`],
        [
          'Processos Vinculados',
          `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
        ],
        [
          'Tipo e Modalidade',
          `${bind('tipo_contratacao_label', tipoContratacaoLabel)} &bull; ${bind('modalidade_label', modalidadeLabel)}`
        ],
        [
          'Critério e Regime',
          `${bind('criterio_julgamento_label', criterioLabel)} (${bind('formato_lance_label', formatoLanceLabel)}) &bull; SRP: <strong>${bind('srp_status', proc.usar_srp ? 'SIM (Art. 82)' : 'NÃO')}</strong>`
        ]
      ]);

      const html = `
        <h2>1. EXPOSIÇÃO DE DEMANDA E NECESSIDADE ADMINISTRATIVA</h2>
        ${fichaDemandaHtml}
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva da Necessidade (Art. 11 e Art. 41)',
          `Demanda originada pela <strong>${bind('secretaria_nome', secNome)}</strong> com estimativa global preliminar de <strong>${formatCurrencyBRL(totalValor)}</strong>. ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}

        <h3>1. Identificação da Área Requisitante</h3>
        ${renderMetadataGridHtml([
          ['Unidade Administrativa', bind('secretaria_nome', secNome)],
          ['Ordenador(a) de Despesas', `${bind('ordenador_nome', ordenadorNome)} (${bind('ordenador_portaria', ordenadorPortaria)})`],
          ['Servidor Requisitante', `${escapeHtml(proc.responsavel_requisitante)} — ${escapeHtml(proc.cargo_requisitante)}`],
          ['Objeto Resumido', escapeHtml(proc.titulo_resumido)],
          ['Dotação de Referência', bind('dotacao_completa', dotLinha)]
        ])}

        <h3>2. Contextualização da Situação Atual e Quadro Diagnóstico</h3>
        <p>${escapeHtml(diagnosticoAtual)}</p>
        <p><strong>Quadro Analítico: Cenário de Inércia vs. Atendimento da Demanda</strong></p>
        ${quadroInerciaHtml}

        <h3>3. Definição do Problema Administrativo e Diretriz de Neutralidade (Art. 41)</h3>
        <p>${escapeHtml(problema)}</p>
        <p><strong>Parâmetros Técnicos e Normativos Preliminares:</strong> ${escapeHtml(deepSpec.normasTecnicas)}</p>

        <h3>4. Interesse Público Tutelado (Art. 11 da Lei nº 14.133/2021)</h3>
        <p>${escapeHtml(interessePublico)}</p>
        <ul>
          <li><strong>Resultado Mais Vantajoso (Art. 11, I):</strong> Seleção da proposta apta a gerar maior vantajosidade considerando todo o ciclo de vida do objeto, qualidade técnica e assistência pós-entrega.</li>
          <li><strong>Tratamento Isonômico e Justa Competição (Art. 11, II):</strong> Definição de especificações usuais de mercado, vedando marcas exclusivas ou cláusulas restritivas imotivadas.</li>
          <li><strong>Prevenção de Sobrepreço e Inexequibilidade (Art. 11, III):</strong> Referencial prévio de preços públicos consistente com o Art. 23 da Lei nº 14.133/2021.</li>
          <li><strong>Inovação e Sustentabilidade (Art. 11, IV e Art. 5º):</strong> Adoção de requisitos socioambientais compatíveis com a Política Nacional de Resíduos Sólidos e eficiência energética.</li>
        </ul>

        <h3>5. Alinhamento Estratégico (PPA/LDO/PCA) e Enquadramento Preliminar (${escapeHtml(modalityGuidance.baseRegime)})</h3>
        <p>${escapeHtml(alinhamentoEstrategico)}</p>
        <p><strong>Regime Procedimental Informado:</strong> ${escapeHtml(modalityGuidance.formaSessao)} ${escapeHtml(modalityGuidance.disputaResumo)}</p>

        <h3>6. Dimensionamento Preliminar com Base na Pesquisa de Preço (Art. 23)</h3>
        <p><strong>Fonte de Referência:</strong> ${temPesquisaAnexa ? `Arquivo anexado: <strong>${escapeHtml(proc.pesquisa_preco_arquivo || 'Planilha de Pesquisa de Preço')}</strong> — ` : ''}${escapeHtml(pesquisaFonteResumo)}</p>
        <p><strong>Critério Preliminar de Quantificação:</strong> ${escapeHtml(deepSpec.formulaDimensionamento)}</p>
        ${renderItemsTableHtml(baseItems)}

        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.<br/>
        <strong>${escapeHtml(proc.responsavel_requisitante)}</strong> — ${escapeHtml(proc.cargo_requisitante)}<br/>
        <em>Área Requisitante — ${bind('secretaria_nome', secNome)}</em></p>
      `.trim();

      return {
        structured_json: json,
        html_content: html,
        legal_alerts: [
          {
            id: 'ag1-foco-problema',
            severity: 'info',
            article: 'Art. 11 e Art. 18, I da Lei nº 14.133/2021',
            title: 'Foco no Problema (Neutralidade Tecnológica)',
            message: 'A Exposição de Demanda concentrou-se no problema administrativo e interesse público, sem direcionamento de marca ou solução pré-concebida.'
          },
          ...certameAlerts.slice(0, 2)
        ]
      };
    }

    // ========================================================
    // AGENTE 02: DFD — DOCUMENTO DE FORMALIZAÇÃO DA DEMANDA
    // ========================================================
    case 2: {
      const numeroDfd = `DFD-${proc.numero_processo_administrativo.replace(/[^\w/-]/g, '')}`;
      const objetoSucinto = proc.titulo_resumido || 'Contratação de solução destinada ao atendimento da demanda formalizada';
      const dataPretendida =
        ctx.dataPretendida?.trim() || new Date(Date.now() + 45 * 86400000).toLocaleDateString('pt-BR');
      const grauPrioridade =
        ctx.prioridade || (totalValor >= 300000 ? 'Alto' : totalValor >= 80000 ? 'Médio' : 'Baixo');
      const justificativaAlta =
        grauPrioridade === 'Alto'
          ? 'Justificativa da Prioridade Alta: a ausência de atendimento imediato gera risco concreto de paralisação ou prejuízo direto à continuidade do serviço público essencial identificado na Peça 01.'
          : 'Prioridade compatível com o cronograma regular de contratações da unidade requisitante.';
      const problemaBase = p1?.situacao_atual || p1?.problema_administrativo || proc.demanda_bruta;
      const matriculaPortaria = sec?.matricula_cpf
        ? `${sec.matricula_cpf} / ${ordenadorPortaria}`
        : ordenadorPortaria;

      const json = {
        numero_dfd: numeroDfd,
        area_requisitante: secNome,
        responsavel_demanda: {
          nome: proc.responsavel_requisitante,
          cargo: proc.cargo_requisitante,
          ordenador: ordenadorNome,
          portaria_matricula: matriculaPortaria
        },
        ordenador_despesa: ordenadorNome,
        ordenador_cargo: ordenadorCargo,
        ordenador_portaria: ordenadorPortaria,
        objeto_sucinto: objetoSucinto,
        justificativa_necessidade: `${problemaBase} ${p1?.interesse_publico || ''}`.trim(),
        itens: baseItems,
        valor_total_preliminar: totalValor,
        data_pretendida_conclusao: dataPretendida,
        grau_prioridade: grauPrioridade,
        justificativa_prioridade: justificativaAlta,
        alinhamento_pca: `Previsto no Plano de Contratações Anual (PCA ${new Date().getFullYear()}) da ${secNome} — Art. 12, VII da Lei nº 14.133/2021.`,
        equipe_planejamento: {
          integrante_requisitante: `${proc.responsavel_requisitante} (${proc.cargo_requisitante})`,
          integrante_tecnico: 'Servidor Técnico a designar pela Secretaria Requisitante',
          integrante_administrativo: 'Agente de Planejamento / Setor de Licitações'
        },
        dotacao_resumo: dotLinha,
        feedback_incorporado: feedback || null
      };

      const dfdCronogramaHtml = renderStructuredTableHtml(
        ['Marco / Etapa Processual', 'Prazo Estimado (Dias Úteis)', 'Responsável / Setor'],
        [
          [{ label: '01. Elaboração de ETP e Mapa de Riscos (Art. 18, I e X)', strong: true }, 'Até 10 dias úteis', 'Equipe de Planejamento da Contratação'],
          [{ label: '02. Termo de Referência e Pesquisa de Preços Consolidada (Art. 23)', strong: true }, 'Até 08 dias úteis', `Área Técnica (${secNome}) e Setor de Compras`],
          [{ label: '03. Minutas e Parecer Jurídico Prévio (Art. 53)', strong: true }, 'Até 07 dias úteis', 'Setor de Licitações e Procuradoria Jurídica'],
          [{ label: '04. Publicação PNCP e Sessão Pública (Art. 54 e 55)', strong: true }, 'Prazo mínimo legal do Art. 55', `Agente de Contratação / Pregoeiro (${getModalidadeLabel(proc.modalidade)})`],
          [{ label: '05. Homologação, Assinatura e Ordem de Início (Art. 71)', strong: true }, 'Até 05 dias úteis após adjudicação', `${ordenadorNome} / Gestor do Contrato`]
        ]
      );

      const dfdAssinaturasHtml = renderStructuredTableHtml(
        ['Área Requisitante / Demandante', 'Autorização do(a) Ordenador(a) de Despesas'],
        [
          [
            {
              label: proc.responsavel_requisitante,
              detail: `${proc.cargo_requisitante} — ${secNome} | Data: ${todayBR}`
            },
            {
              label: ordenadorNome,
              detail: `${ordenadorCargo} (${matriculaPortaria}) | Autorizado em ${todayBR}`
            }
          ]
        ]
      );

      const fichaDfdHtml = renderMetadataGridHtml([
        ['Documento / Código', `${escapeHtml(numeroDfd)} &bull; Base Legal: Art. 12, VII e Art. 72, I da Lei nº 14.133/2021`],
        [
          'Processos Vinculados',
          `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
        ],
        [
          'Prioridade e Previsão',
          `Grau <strong>${escapeHtml(grauPrioridade)}</strong> &bull; Início/Conclusão prevista: ${escapeHtml(dataPretendida)}`
        ]
      ]);

      const html = `
        <h2>2. DOCUMENTO DE FORMALIZAÇÃO DA DEMANDA (DFD)</h2>
        ${fichaDfdHtml}
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva do DFD (PCA e Priorização)',
          `Formaliza demanda da <strong>${bind('secretaria_nome', secNome)}</strong> estimada em <strong>${formatCurrencyBRL(totalValor)}</strong>, grau de prioridade <strong>${escapeHtml(grauPrioridade)}</strong>. ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}

        <h3>1. Setor Requisitante e Responsável pela Demanda</h3>
        <table>
          <tbody>
            <tr><td><strong>Órgão / Entidade</strong></td><td>${bind('orgao_razao_social', inst.razao_social)} (CNPJ: ${bind('orgao_cnpj', formatCnpj(inst.cnpj))})</td></tr>
            <tr><td><strong>Setor / Secretaria Requisitante</strong></td><td>${bind('secretaria_nome', secNome)}</td></tr>
            <tr><td><strong>Responsável pela Demanda</strong></td><td>${escapeHtml(proc.responsavel_requisitante)} — ${escapeHtml(proc.cargo_requisitante)}</td></tr>
            <tr><td><strong>Ordenador(a) de Despesas</strong></td><td>${bind('ordenador_nome', ordenadorNome)} — ${bind('ordenador_cargo', ordenadorCargo)} (${bind('ordenador_portaria', matriculaPortaria)})</td></tr>
            <tr><td><strong>Modalidade / Critério / Regime</strong></td><td>${bind('modalidade_label', getModalidadeLabel(proc.modalidade))} | ${bind('criterio_julgamento_label', getCriterioLabel(proc.criterio_julgamento))} (${bind('formato_lance_label', getFormatoLanceLabel(proc.formato_lance))}) | SRP: <strong>${bind('srp_status', proc.usar_srp ? 'SIM (Art. 82)' : 'NÃO')}</strong></td></tr>
          </tbody>
        </table>

        <h3>2. Objeto Sucinto da Contratação</h3>
        <p>${escapeHtml(objetoSucinto)}.</p>
        <p><strong>Natureza Preliminar (Art. 6º):</strong> ${escapeHtml(trDomain.naturezaObjeto)}</p>

        <h3>3. Justificativa da Necessidade da Contratação</h3>
        <p>${escapeHtml(problemaBase)}</p>
        <p>${escapeHtml(p1?.interesse_publico || 'A contratação visa assegurar a continuidade e a eficiência das políticas públicas municipais (Art. 11 da Lei nº 14.133/2021).')}</p>
        <p><strong>Risco do Não Atendimento (Cenário de Inércia):</strong> ${escapeHtml(deepSpec.cenarioInercia)}</p>

        <h3>4. Quantitativo Estimado Preliminarmente</h3>
        <p><strong>Metodologia de Quantificação:</strong> ${escapeHtml(deepSpec.formulaDimensionamento)}</p>
        ${renderItemsTableHtml(baseItems)}
        <p><strong>Estimativa Preliminar Global:</strong> ${formatCurrencyBRL(totalValor)} (${proc.pesquisa_preco_arquivo ? `conforme arquivo ${escapeHtml(proc.pesquisa_preco_arquivo)}` : 'conforme pesquisa de mercado consolidada na Peça 01'}).</p>

        <h3>5. Previsão de Data para Início da Execução/Entrega, Cronograma e Grau de Prioridade</h3>
        <table>
          <tbody>
            <tr><td><strong>Data Pretendida para Conclusão / Início</strong></td><td>${escapeHtml(dataPretendida)}</td></tr>
            <tr><td><strong>Grau de Prioridade</strong></td><td><strong>${escapeHtml(grauPrioridade)}</strong></td></tr>
            <tr><td><strong>Justificativa da Prioridade</strong></td><td>${escapeHtml(justificativaAlta)}</td></tr>
          </tbody>
        </table>
        <p><strong>Cronograma Macro Estimado da Instrução Preparatória e Fase Externa:</strong></p>
        ${dfdCronogramaHtml}

        <h3>6. Indicação de Vinculação com o Plano de Contratações Anual (PCA)</h3>
        <table>
          <tbody>
            <tr><td><strong>Previsão no PCA Vigente (${new Date().getFullYear()})</strong></td><td>[ X ] Sim — Contemplado no PCA &nbsp;&nbsp; [ &nbsp; ] Não — Solicita inclusão excepcional</td></tr>
            <tr><td><strong>Enquadramento no PCA</strong></td><td>${escapeHtml(json.alinhamento_pca)}</td></tr>
            <tr><td><strong>Alinhamento PPA / LDO</strong></td><td>${escapeHtml(deepSpec.ppaEstrategico)}</td></tr>
          </tbody>
        </table>

        <h3>7. Indicação da Equipe de Planejamento da Contratação (Segregação de Funções — Art. 7º, § 1º)</h3>
        <table>
          <thead>
            <tr>
              <th>Função na Equipe</th>
              <th>Integrante Indicado</th>
              <th>Unidade / Lotação</th>
              <th>Atribuição Legal no Planejamento</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><strong>Integrante Requisitante</strong></td><td>${escapeHtml(proc.responsavel_requisitante)}</td><td>${bind('secretaria_nome', secNome)}</td><td>Definir a necessidade administrativa, quantitativos e critérios funcionais de recebimento.</td></tr>
            <tr><td><strong>Integrante Técnico</strong></td><td>Servidor Técnico designado pela Pasta</td><td>Área Técnica da ${bind('secretaria_nome', secNome)}</td><td>Elaborar especificações técnicas neutras (Art. 41), ETP, IMR e matriz técnica de riscos.</td></tr>
            <tr><td><strong>Integrante Administrativo</strong></td><td>Representante do Setor de Contratações</td><td>Secretaria de Administração / Licitações</td><td>Assegurar conformidade procedimental à Lei nº 14.133/2021, prazos do Art. 55 e minuta de instrumentos.</td></tr>
          </tbody>
        </table>
        <p><small><em>Observância ao Princípio da Segregação de Funções (Art. 7º, § 1º): veda-se a designação do mesmo agente para atuação simultânea na elaboração de especificações/julgamento e na fiscalização financeira ou controle interno posterior.</em></small></p>

        <h3>8. Adequação Orçamentária Preliminar</h3>
        <p>As despesas decorrentes da futura contratação possuem adequação preliminar indicada na dotação orçamentária: ${bind('dotacao_completa', dotLinha)}${proc.usar_srp ? ' (observada a dispensa de bloqueio prévio no Registro de Preços até a emissão de instrumento obrigacional — Art. 17 do Decreto nº 11.462/2023).' : ', compatível com a Lei Orçamentária Anual vigente.'}</p>

        <p><strong>Encaminhamento e Autorização:</strong> Submete-se o presente DFD à apreciação do(a) Ordenador(a) de Despesas para aprovação formal e autorização de instauração do Estudo Técnico Preliminar e Mapa de Riscos (Art. 18, § 1º e inciso X da Lei nº 14.133/2021).</p>
        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        ${dfdAssinaturasHtml}
      `.trim();

      return {
        structured_json: json,
        html_content: html,
        legal_alerts: [
          {
            id: 'ag2-pca',
            severity: 'info',
            article: 'Art. 12, VII da Lei nº 14.133/2021',
            title: 'Alinhamento ao Plano de Contratações Anual (PCA)',
            message: 'Confirme o código de item correspondente no PCA publicado no PNCP antes de avançar para a fase externa.'
          },
          ...certameAlerts
        ]
      };
    }

    // ========================================================
    // AGENTE 03: ETP — ESTUDO TÉCNICO PRELIMINAR (13 INCISOS)
    // ========================================================
    case 3: {
      const numeroEtp = `ETP-${proc.numero_processo_administrativo.replace(/[^\w/-]/g, '')}`;
      const objetoSolucao = p2?.objeto_sucinto || objetoConsolidado;
      const parcelamentoPorItem = proc.formato_lance === 'POR_ITEM';
      const justificativaParcelamento = parcelamentoPorItem
        ? `Em observância ao Art. 40, inciso V, alínea "b" e § 2º da Lei nº 14.133/2021, bem como à Súmula nº 247 do TCU, adota-se o parcelamento do objeto POR ITEM, ampliando a competitividade e permitindo a participação de microempresas e empresas de pequeno porte sem prejuízo técnico ou perda de economia de escala.`
        : `Embora a regra geral seja o parcelamento (Súmula nº 247 do TCU e Art. 40, § 2º da Lei nº 14.133/2021), demonstra-se técnica e economicamente vantajosa a adjudicação ${getFormatoLanceLabel(proc.formato_lance)}, haja vista a interdependência operacional entre os componentes, a padronização de garantia e a economia de escala obtida na gestão de um único fornecedor/lote.`;

      const srpNota = proc.usar_srp
        ? 'Adota-se o Sistema de Registro de Preços (Art. 82) considerando a conveniência de aquisições/contratações parceladas e a possibilidade de variação da demanda ao longo de 12 meses.'
        : 'Contratação convencional com quantitativo certo e determinado para execução integral nos termos contratuais.';

      const json = {
        numero_etp: numeroEtp,
        objeto_solucao: objetoSolucao,
        itens_estimados: baseItems,
        valor_estimado_contratacao: totalValor,
        parcelamento_decisao: proc.formato_lance,
        viabilidade_conclusiva: 'VIÁVEL E RAZOÁVEL',
        pareto_classe_a_pct: priceAnalytics.classeACumulativePct,
        price_portfolio_analytics: priceAnalytics,
        incisos_art18_par1: {
          I_necessidade: `${p2?.justificativa_necessidade || proc.demanda_bruta} Cenário de Inércia: ${deepSpec.cenarioInercia}`,
          II_pca: `${p2?.alinhamento_pca || 'Demanda alinhada ao PCA vigente.'} ${deepSpec.ppaEstrategico}`,
          III_requisitos: `Normas aplicáveis: ${deepSpec.normasTecnicas} Sustentabilidade (Art. 45): ${trDomain.sustentabilidadeSpec} Habilitação compatível com os arts. 62 a 70.`,
          IV_quantidades: `Fórmula de Dimensionamento: ${deepSpec.formulaDimensionamento}`,
          V_levantamento_mercado: 'Análise comparativa sob a perspectiva do Custo Total de Propriedade (TCO) considerando ciclo de vida, OPEX e aderência operacional.',
          VI_estimativa_valor: totalValor,
          VII_solucao_como_todo: `${objetoSolucao}, contemplando fornecimento/execução integral, ${trDomain.execucaoPrazoLocal} e ${trDomain.recebimentoGarantia} ${srpNota}`,
          VIII_parcelamento: justificativaParcelamento,
          IX_resultados_pretendidos: 'Economicidade comprovada na disputa competitiva, redução de despesas corretivas, continuidade operacional e padronização de qualidade por IMR.',
          X_providencias_previas: 'Designação formal de Gestor e Fiscais (Arts. 7º e 117), preparação logística das unidades, conferência orçamentária e gestão de riscos.',
          XI_contratacoes_correlatas: 'Mapeamento de interdependências elétricas/estruturais/tecnológicas e confirmação de inexistência de óbices impeditivos (Art. 18, § 2º).',
          XII_impactos_ambientais: `Mitigação socioambiental e logística reversa (Lei nº 12.305/2010 e Art. 144): ${trDomain.sustentabilidadeSpec}`,
          XIII_posicionamento_conclusivo: 'A equipe de planejamento conclui pela viabilidade técnica, socioeconômica e ambiental da contratação nos termos do Art. 18, § 1º, XIII.'
        },
        feedback_incorporado: feedback || null
      };

      const pesquisaTexto = pesquisaFonteResumo;

      const memoriaCalculoRows = baseItems
        .map(
          (it) => `
          <tr>
            <td>${it.item}</td>
            <td>${escapeHtml(it.descricao)}</td>
            <td>${escapeHtml(it.medida || it.unidade)}</td>
            <td>${it.quantidade}</td>
            <td>${proc.pesquisa_preco_arquivo ? `Pesquisa de Preço (${escapeHtml(proc.pesquisa_preco_arquivo)})` : 'Demanda consolidada no DFD × cobertura operacional'}</td>
            <td>${formatCurrencyBRL(it.valor_unitario)}</td>
            <td><strong>${formatCurrencyBRL(it.valor_total)}</strong></td>
          </tr>`
        )
        .join('');

      const tcoMercadoHtml = renderStructuredTableHtml(
        [
          'Alternativa Avaliada',
          'CAPEX / Investimento Inicial',
          'OPEX / Manutenção no Ciclo de Vida',
          'Vantagens Técnicas',
          'Limitações e Riscos (TCO)',
          'Conclusão Comparativa'
        ],
        deepSpec.tcoAlternativas.map((alt) => [
          { label: alt.solucao, strong: true },
          alt.capex,
          alt.opex,
          alt.vantagens,
          alt.riscosLimites,
          { label: alt.conclusao, strong: alt.conclusao.startsWith('RECOMENDADA') }
        ])
      );

      const resultadosPretendidosHtml = renderStructuredTableHtml(
        ['Eixo de Resultado (Art. 18, § 1º, IX)', 'Objetivo Mensurável', 'Indicador de Verificação'],
        [
          [
            { label: 'Economicidade e Ganho de Escala', strong: true },
            'Obtenção de proposta vantajosa abaixo dos referenciais saneados da pesquisa de preços (Art. 23).',
            'Comparativo entre valor homologado e orçamento estimado (economia percentual na ata da sessão).'
          ],
          [
            { label: 'Eficiência Operacional e Continuidade', strong: true },
            `Eliminação de paradas ou gargalos operacionais na ${secNome} durante todo o ciclo contratual.`,
            'Cumprimento das metas do Instrumento de Medição de Resultados (IMR ≥ 95% de conformidade).'
          ],
          [
            { label: 'Otimização do Custo Total de Propriedade (TCO)', strong: true },
            'Redução de custos ocultos com reparos emergenciais, retrabalho ou desperdício de insumos.',
            'Cobertura integral de garantia técnica/padrão de qualidade sem ônus adicional ao Erário.'
          ]
        ]
      );

      const providenciasPreviasHtml = renderStructuredTableHtml(
        ['Ordem', 'Providência Administrativa Prévia (Art. 18, § 1º, X)', 'Responsável', 'Momento / Marco'],
        [
          ['01', 'Designação formal de Gestor, Fiscal Técnico e Fiscal Administrativo do Contrato (Arts. 7º e 117)', 'Ordenador(a) de Despesas', 'Anterior à assinatura contratual/ARP'],
          ['02', 'Preparação de almoxarifado, unidades receptoras, pontos elétricos/lógicos ou agenda de recebimento', secNome, 'Previamente à Ordem de Fornecimento/Serviço'],
          ['03', `Conferência de disponibilidade orçamentária (${dotLinha})${proc.usar_srp ? ' — Nota: SRP dispensa bloqueio prévio até contratação (Dec. 11.462/2023, Art. 17)' : ''}`, 'Contabilidade / Fazenda', 'Pré-empenho / Fase Preparatória'],
          ['04', 'Capacitação da fiscalização acerca do IMR e cláusulas sancionatórias do Termo de Referência', 'Equipe de Planejamento / Controle Interno', 'Até o início da vigência']
        ]
      );

      const etpAssinaturasHtml = renderStructuredTableHtml(
        ['Equipe de Planejamento — Elaboração', 'Conformidade Técnica e Aprovação'],
        [
          [
            {
              label: `${proc.responsavel_requisitante} (Integrante Requisitante)`,
              detail: `${proc.cargo_requisitante} — ${secNome}`
            },
            {
              label: `${ordenadorNome} — Aprovação Superior`,
              detail: `${ordenadorCargo} (${ordenadorPortaria}) | Data: ${todayBR}`
            }
          ]
        ]
      );

      const fichaEtpHtml = renderMetadataGridHtml([
        ['Documento / Código', `${escapeHtml(numeroEtp)} &bull; Art. 18, §§ 1º e 2º da Lei nº 14.133/2021 e IN SEGES/ME nº 58/2022`],
        [
          'Órgão / Processo Adm.',
          `${bind('orgao_razao_social', inst.razao_social)} &bull; Proc. Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)}`
        ],
        [
          'Estimativa e Regime',
          `<strong>${formatCurrencyBRL(totalValor)}</strong> &bull; Adjudicação: ${escapeHtml(getFormatoLanceLabel(proc.formato_lance))} &bull; SRP: <strong>${proc.usar_srp ? 'SIM (Art. 82)' : 'NÃO'}</strong>`
        ]
      ]);

      const html = `
        <h2>3. ESTUDO TÉCNICO PRELIMINAR (ETP)</h2>
        ${fichaEtpHtml}
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva de Viabilidade (13 Incisos — Art. 18, § 1º)',
          `Estudo conclusivo pela viabilidade técnica, socioeconômica e ambiental sob o modelo de <strong>${escapeHtml(getModalidadeLabel(proc.modalidade))}</strong>. ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}

        <h3>1. Descrição da Necessidade da Contratação (Inciso I — Elemento Obrigatório)</h3>
        <p>${escapeHtml(json.incisos_art18_par1.I_necessidade)}</p>

        <h3>2. Demonstração da Previsão da Contratação no PCA (Inciso II)</h3>
        <p>${escapeHtml(json.incisos_art18_par1.II_pca)}</p>

        <h3>3. Requisitos da Contratação (Inciso III — Padrões Técnicos, Qualidade e Sustentabilidade / Art. 45)</h3>
        <p>Os bens/serviços deverão atender rigorosamente aos padrões mínimos de qualidade, segurança e desempenho estabelecidos nas normas técnicas vigentes: <strong>${escapeHtml(deepSpec.normasTecnicas)}</strong>.</p>
        <p><strong>Critérios de Sustentabilidade (Art. 5º, Art. 45 e Art. 144):</strong> ${escapeHtml(trDomain.sustentabilidadeSpec)}</p>
        <p><strong>Requisitos de Habilitação e Garantia (Arts. 62 a 70):</strong> Qualificação jurídica, fiscal/trabalhista regular (Art. 68), capacidade técnica compatível (Art. 67) e saúde econômico-financeira comprovada (Art. 69), vedada a exigência de marca exclusiva sem justificativa técnica formal (Art. 41, I).</p>

        <h3>4. Estimativa das Quantidades a Serem Contratadas e Memória de Cálculo (Inciso IV — Elemento Obrigatório)</h3>
        <p>O dimensionamento abaixo preserva integral consistência com o DFD aprovado, detalhando a memória de cálculo para atendimento às demandas da ${bind('secretaria_nome', secNome)}:</p>
        <p><strong>Fórmula e Critério Técnico de Dimensionamento:</strong> ${escapeHtml(deepSpec.formulaDimensionamento)}</p>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Descrição / Especificação</th>
              <th>Medida</th>
              <th>Quantidade</th>
              <th>Memória de Cálculo / Critério de Dimensionamento</th>
              <th>Valor Unitário</th>
              <th>Valor Total</th>
            </tr>
          </thead>
          <tbody>
            ${memoriaCalculoRows}
            <tr>
              <td colspan="6"><strong>TOTAL GLOBAL ESTIMADO (MEMÓRIA CONSOLIDADA)</strong></td>
              <td><strong>${formatCurrencyBRL(totalValor)}</strong></td>
            </tr>
          </tbody>
        </table>

        <h3>5. Levantamento de Mercado e Custo Total de Propriedade — TCO (Inciso V)</h3>
        <p>Em atendimento ao Art. 18, § 1º, V da Lei nº 14.133/2021, procedeu-se ao cotejo comparativo das alternativas disponíveis no mercado considerando não apenas o desembolso inicial (CAPEX), mas o <strong>Custo Total de Propriedade (TCO)</strong> ao longo de todo o ciclo de vida contratual:</p>
        ${tcoMercadoHtml}

        <h3>6. Estimativa do Valor da Contratação e Metodologia de Preços (Inciso VI — Elemento Obrigatório / Art. 23)</h3>
        <p>O valor global estimado da contratação é de <strong>${formatCurrencyBRL(totalValor)}</strong>, apurado mediante cesta diversificada de preços em observância estrita ao <strong>Art. 23, § 1º da Lei nº 14.133/2021</strong> e aos parâmetros da <strong>IN SEGES/ME nº 65/2021</strong> (combinação prioritária de contratações similares no PNCP/Painel de Preços, atas vigentes e cotações diretas com fornecedores, submetida a saneamento estatístico com expurgo de valores inexequíveis ou excessivamente elevados por média/mediana)${proc.pesquisa_preco_arquivo ? `, com lastro no documento anexado <strong>${escapeHtml(proc.pesquisa_preco_arquivo)}</strong>` : ''}: ${escapeHtml(pesquisaTexto)}</p>
        <p><strong>Diagnóstico Quantitativo da Carteira (Curva ABC / Pareto):</strong> ${escapeHtml(priceAnalytics.summaryText)}</p>
        ${renderItemsTableHtml(baseItems)}

        <h3>7. Descrição da Solução como um Todo (Inciso VII — Ciclo de Vida, Garantia e Assistência)</h3>
        <p>${escapeHtml(json.incisos_art18_par1.VII_solucao_como_todo)}</p>
        <ul>
          <li><strong>Fase de Entrega / Mobilização:</strong> ${escapeHtml(trDomain.execucaoPrazoLocal)}</li>
          <li><strong>Recebimento e Aceite Técnico (Art. 140):</strong> ${escapeHtml(trDomain.recebimentoGarantia)}</li>
          <li><strong>Modelo de Seleção e Execução:</strong> ${escapeHtml(modalityGuidance.formaSessao)} ${escapeHtml(modalityGuidance.disputaResumo)}</li>
        </ul>

        <h3>8. Justificativas para o Parcelamento ou Não da Contratação (Inciso VIII — Elemento Obrigatório / Art. 40, §§ 2º e 3º)</h3>
        <p>${escapeHtml(justificativaParcelamento)}</p>
        <p><strong>Teste Acumulativo do Art. 40, § 3º da Lei nº 14.133/2021:</strong> (a) <em>Viabilidade técnica de divisão:</em> verificada conforme a natureza autônoma ou interdependente dos itens; (b) <em>Economia de escala:</em> avaliada frente aos custos de logística, gestão contratual e competitividade regional/nacional; (c) <em>Preservação de responsabilidade e garantia:</em> assegurada pela vinculação objetiva no Termo de Referência (Súmula nº 247/TCU).</p>

        <h3>9. Demonstrativo dos Resultados Pretendidos (Inciso IX)</h3>
        <p>Os resultados institucionais esperados com a contratação na ${bind('secretaria_nome', secNome)} estão estruturados em indicadores verificáveis de economicidade e eficácia:</p>
        ${resultadosPretendidosHtml}

        <h3>10. Providências Prévias à Celebração do Contrato (Inciso X)</h3>
        <p>Para a plena eficácia da execução contratual, deverão ser adotadas pela Administração as seguintes medidas preparatórias e organizacionais:</p>
        ${providenciasPreviasHtml}

        <h3>11. Contratações Correlatas e/ou Interdependentes (Inciso XI)</h3>
        <p>${escapeHtml(json.incisos_art18_par1.XI_contratacoes_correlatas)} Registra-se que a logística interna, infraestrutura predial/tecnológica e dotações de apoio da ${bind('secretaria_nome', secNome)} encontram-se compatibilizadas, inexistindo contratos conflitantes que impeçam a execução regular (Art. 18, § 2º).</p>

        <h3>12. Descrição de Possíveis Impactos Ambientais e Medidas Mitigadoras (Inciso XII)</h3>
        <p>Em observância ao Art. 18, § 1º, XII, ao Art. 45 e ao Art. 144 da Lei nº 14.133/2021, bem como à Política Nacional de Resíduos Sólidos (Lei nº 12.305/2010), mitigam-se eventuais impactos mediante exigência contratual de embalagens recicláveis/atende à logística reversa, preferência por itens de menor consumo energético/menor geração de resíduos perigosos e destinação ambientalmente certificada ao fim da vida útil.</p>

        <h3>13. Posicionamento Conclusivo sobre a Adequação da Contratação (Inciso XIII — Elemento Obrigatório)</h3>
        <p>Diante das análises técnica, mercadológica (TCO), jurídica, socioeconômica e ambiental expostas nos tópicos 1 a 12, a Equipe de Planejamento declara expressamente a <strong>VIABILIDADE TÉCNICA, SOCIOECONÔMICA E AMBIENTAL DA CONTRATAÇÃO</strong> sob a modalidade <strong>${bind('modalidade_label', getModalidadeLabel(proc.modalidade))}</strong>, critério <strong>${bind('criterio_julgamento_label', getCriterioLabel(proc.criterio_julgamento))}</strong> (${bind('formato_lance_label', getFormatoLanceLabel(proc.formato_lance))}).</p>
        ${etpAssinaturasHtml}
      `.trim();

      return {
        structured_json: json,
        html_content: html,
        legal_alerts: [
          {
            id: 'ag3-13-incisos',
            severity: 'info',
            article: 'Art. 18, § 1º e § 2º da Lei nº 14.133/2021',
            title: 'Cobertura Integral dos 13 Incisos do ETP',
            message: 'Todos os 13 incisos do § 1º do Art. 18 foram contemplados, incluindo memória de cálculo, Súmula 247 TCU e posicionamento conclusivo.'
          },
          ...certameAlerts
        ]
      };
    }

    // ========================================================
    // AGENTE 04: MAPA DE GERENCIAMENTO DE RISCOS (ART. 18, X E ART. 22)
    // ========================================================
    case 4: {
      const modalidadeLabel = getModalidadeLabel(proc.modalidade);
      const riscos = buildObjectSpecificRisks({
        category,
        objetoConsolidado,
        secNome,
        modalidadeLabel,
        usarSrp: proc.usar_srp,
        direct,
        itemsCount: baseItems.length,
        totalValor
      });

      const fasePlanejamento = riscos.filter((r) => r.fase_key === 'PLANEJAMENTO');
      const faseSelecao = riscos.filter((r) => r.fase_key === 'SELECAO');
      const faseGestao = riscos.filter((r) => r.fase_key === 'GESTAO');

      const riscosAltos = riscos.filter((r) => r.nivel_risco === 'Alto').length;
      const riscosMedios = riscos.filter((r) => r.nivel_risco === 'Médio').length;
      const riscosBaixos = riscos.filter((r) => r.nivel_risco === 'Baixo').length;

      const quadroResumoRiscosHtml = renderStructuredTableHtml(
        ['Fase do Metaprocesso', 'Qtd. Riscos', 'Nível Alto [6–9]', 'Nível Médio [3–4]', 'Nível Baixo [1–2]'],
        [
          [
            { label: 'Fase 1: Planejamento da Contratação', strong: true },
            String(fasePlanejamento.length),
            String(fasePlanejamento.filter((r) => r.nivel_risco === 'Alto').length),
            String(fasePlanejamento.filter((r) => r.nivel_risco === 'Médio').length),
            String(fasePlanejamento.filter((r) => r.nivel_risco === 'Baixo').length)
          ],
          [
            { label: 'Fase 2: Seleção do Fornecedor', strong: true },
            String(faseSelecao.length),
            String(faseSelecao.filter((r) => r.nivel_risco === 'Alto').length),
            String(faseSelecao.filter((r) => r.nivel_risco === 'Médio').length),
            String(faseSelecao.filter((r) => r.nivel_risco === 'Baixo').length)
          ],
          [
            { label: 'Fase 3: Gestão Contratual e Execução', strong: true },
            String(faseGestao.length),
            String(faseGestao.filter((r) => r.nivel_risco === 'Alto').length),
            String(faseGestao.filter((r) => r.nivel_risco === 'Médio').length),
            String(faseGestao.filter((r) => r.nivel_risco === 'Baixo').length)
          ],
          [
            { label: 'TOTAL CONSOLIDADO DA MATRIZ', strong: true },
            { label: String(riscos.length), strong: true },
            { label: String(riscosAltos), strong: true },
            { label: String(riscosMedios), strong: true },
            { label: String(riscosBaixos), strong: true }
          ]
        ]
      );

      const alocacaoArt103Html = renderStructuredTableHtml(
        ['Evento de Risco Contratual', 'Parte Responsável (Alocação)', 'Fundamento Legal (Art. 22 / Art. 103)', 'Mecanismo Contratual de Tratamento'],
        deepSpec.alocacaoRiscosArt103.map((item) => [
          { label: item.evento, strong: true },
          { label: item.alocacao, strong: true },
          item.fundamento,
          item.mecanismo
        ])
      );

      const fichaRiscosHtml = renderMetadataGridHtml([
        [
          'Processos Vinculados',
          `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
        ],
        [
          'Modalidade e Regime',
          `${bind('modalidade_label', modalidadeLabel)} &bull; SRP: <strong>${proc.usar_srp ? 'SIM (Art. 82)' : 'NÃO'}</strong>`
        ],
        ['Objeto Mapeado', escapeHtml(objetoConsolidado)],
        ['Base Normativa', 'Art. 18, inciso X, Art. 22 e Art. 103 da Lei Federal nº 14.133/2021']
      ]);

      const html = `
        <h2>4. MAPA DE GERENCIAMENTO DE RISCOS (ART. 18, X E ART. 22)</h2>
        ${fichaRiscosHtml}
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva da Matriz P × I',
          `Mapeados <strong>${riscos.length} eventos específicos de risco</strong> nas 3 fases (<strong>${riscosAltos} Alto</strong>, <strong>${riscosMedios} Médio</strong>, <strong>${riscosBaixos} Baixo</strong>), com priorização de controles preventivos sobre a exposição financeira da carteira: ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}

        <h3>Nota Metodológica de Análise e Avaliação de Riscos</h3>
        <p>O presente Mapa de Gerenciamento de Riscos adota metodologia qualitativa e quantitativa alinhada ao Art. 18, inciso X, ao Art. 22 e ao Art. 103 da Lei nº 14.133/2021, avaliando os eventos que possam comprometer o sucesso da seleção do fornecedor ou a regular execução contratual nas 3 (três) fases do metaprocesso de contratação:</p>
        <table>
          <thead>
            <tr>
              <th>Critério Analítico</th>
              <th>Escala de Mensuração e Classificação</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Probabilidade (P)</strong></td>
              <td><strong>Baixa = 1</strong> (evento remoto ou histórico esporádico) | <strong>Média = 2</strong> (evento possível durante o ciclo) | <strong>Alta = 3</strong> (evento recorrente no mercado/órgão)</td>
            </tr>
            <tr>
              <td><strong>Impacto (I)</strong></td>
              <td><strong>Baixo = 1</strong> (efeito operacional absorvível) | <strong>Médio = 2</strong> (atraso moderado ou retrabalho relevante) | <strong>Alto = 3</strong> (desabastecimento, sobrepreço ou paralisação de serviço essencial)</td>
            </tr>
            <tr>
              <td><strong>Nível de Risco (P × I)</strong></td>
              <td><strong>Baixo [1–2]:</strong> monitoramento rotineiro | <strong>Médio [3–4]:</strong> ação preventiva obrigatória | <strong>Alto [6–9]:</strong> tratamento prioritário, cláusulas vinculantes e contingência imediata</td>
            </tr>
          </tbody>
        </table>

        <h3>Quadro Resumo Quantitativo de Criticidade por Fase</h3>
        ${quadroResumoRiscosHtml}

        ${renderRiskPhaseTableHtml('Fase 1: Planejamento da Contratação', fasePlanejamento)}
        ${renderRiskPhaseTableHtml('Fase 2: Seleção do Fornecedor', faseSelecao)}
        ${renderRiskPhaseTableHtml('Fase 3: Gestão Contratual e Execução', faseGestao)}

        <h3>Matriz de Alocação Objetiva de Riscos Contratuais (Art. 22 e Art. 103 da Lei nº 14.133/2021)</h3>
        <p>Nos termos do Art. 22 e do Art. 103 da Lei nº 14.133/2021, a repartição objetiva de encargos econômicos e operacionais supervenientes entre Administração Contratante e Contratada vincula o Termo de Referência e a Minuta Contratual conforme o quadro abaixo:</p>
        ${alocacaoArt103Html}

        <h3>Conclusão da Matriz e Governança Contratual</h3>
        <p>Foram mapeados <strong>${riscos.length} eventos de risco</strong> específicos ao objeto (<strong>${riscosAltos} de nível Alto</strong>, <strong>${riscosMedios} de nível Médio</strong> e <strong>${riscosBaixos} de nível Baixo</strong>). As ações preventivas, medidas de contingência e critérios de alocação (Art. 103) definidos vinculam a atuação da Equipe de Planejamento, do Agente de Contratação e dos Fiscais, refletindo-se nas obrigações, no IMR e nas penalidades do Termo de Referência e da Minuta Contratual (Art. 22).</p>

        <h3>Bloco de Assinatura — Equipe de Planejamento da Contratação</h3>
        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <table>
          <thead>
            <tr>
              <th>Integrante Requisitante</th>
              <th>Integrante Técnico</th>
              <th>Integrante Administrativo</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>_________________________________<br/><strong>${escapeHtml(proc.responsavel_requisitante)}</strong><br/>${escapeHtml(proc.cargo_requisitante)}<br/>${bind('secretaria_nome', secNome)}</td>
              <td>_________________________________<br/><strong>Integrante Técnico Designado</strong><br/>Área Técnica / Demanda<br/>${bind('secretaria_nome', secNome)}</td>
              <td>_________________________________<br/><strong>Integrante Administrativo</strong><br/>Planejamento / Licitações<br/>Setor de Contratações</td>
            </tr>
          </tbody>
        </table>
      `.trim();

      return {
        structured_json: {
          riscos,
          fases: {
            planejamento: fasePlanejamento,
            selecao_fornecedor: faseSelecao,
            gestao_contratual: faseGestao
          },
          alocacao_riscos_art103: deepSpec.alocacaoRiscosArt103,
          total_riscos: riscos.length,
          riscos_altos: riscosAltos,
          riscos_medios: riscosMedios,
          riscos_baixos: riscosBaixos,
          metodologia: {
            probabilidade: 'Baixa = 1 | Média = 2 | Alta = 3',
            impacto: 'Baixo = 1 | Médio = 2 | Alto = 3',
            niveis: 'Baixo [1-2], Médio [3-4], Alto [6-9]'
          },
          modalidade: modalidadeLabel,
          usar_srp: proc.usar_srp,
          objeto_referencia: objetoConsolidado,
          feedback_incorporado: feedback || null
        },
        html_content: html,
        legal_alerts: [
          {
            id: 'ag4-riscos-3-fases',
            severity: 'info',
            article: 'Art. 18, X e Art. 22 da Lei nº 14.133/2021',
            title: 'Cobertura Completa das 3 Fases (P × I)',
            message: `Matriz estruturada com ${riscos.length} eventos específicos distribuídos entre Planejamento (${fasePlanejamento.length}), Seleção do Fornecedor (${faseSelecao.length}) e Gestão Contratual (${faseGestao.length}).`
          }
        ]
      };
    }

    // ========================================================
    // AGENTE 05: TERMO DE REFERÊNCIA (TR - ART. 6º, XXIII)
    // ========================================================
    case 5: {
      const numeroTr = `TR-${proc.numero_processo_licitatorio.replace(/[^\w/-]/g, '')}`;
      const trProfile = DOMAIN_TR_CONFIG[category];
      const prazoVigenciaMeses = 12;
      const prorrogavel =
        category === 'SERVICOS_CONTINUOS'
          ? 'Prorrogável sucessivamente até o limite decenal de 10 (dez) anos, desde que atestada a vantajosidade econômica das condições e preços pela Administração, na forma dos arts. 106 e 107 da Lei nº 14.133/2021.'
          : 'Vigência de 12 (doze) meses contados da divulgação no PNCP (Art. 105), admitida prorrogação na forma dos arts. 105 a 107 e prorrogação automática do escopo quando o objeto não for concluído no período firmado (Art. 111), sem prejuízo da continuidade da garantia técnica.';
      const pesquisaParametrosTr =
        p3?.pesquisa_mercado_parametros ||
        'Cesta de preços públicos composta por consulta ao PNCP, Painel de Preços, contratações similares de outros entes públicos e pesquisa direta com fornecedores do ramo pertinente, em observância ao Art. 23, § 1º da Lei nº 14.133/2021.';
      const adequacaoTexto = proc.usar_srp
        ? `Tratando-se de contratação processada pelo Sistema de Registro de Preços (SRP - Art. 82 da Lei nº 14.133/2021), fica dispensada a indicação prévia da disponibilidade orçamentária na fase preparatória/licitatória, nos termos do Art. 17 do Decreto Federal nº 11.462/2023 (aplicável por regulamentação/simetria), sendo a dotação orçamentária exigida obrigatoriamente apenas para a formalização do contrato ou emissão de Nota de Empenho. Registro informativo da dotação vinculada: ${dotLinha}.`
        : `As despesas decorrentes desta contratação correrão à conta da seguinte dotação orçamentária vigente: ${dotLinha}. Declara-se, nos termos do Art. 150 da Lei nº 14.133/2021 e do Art. 16 da LRF, que a despesa possui adequação orçamentária e financeira com a Lei Orçamentária Anual (LOA) e compatibilidade com o Plano Plurianual (PPA) e com a Lei de Diretrizes Orçamentárias (LDO) do exercício.`;

      const json = {
        numero_tr: numeroTr,
        objeto_definicao: objetoConsolidado,
        natureza_objeto: trProfile.naturezaObjeto,
        codigo_catalogo_tipo: trProfile.catalogType,
        prazo_vigencia_meses: prazoVigenciaMeses,
        prorrogavel_texto: prorrogavel,
        fundamentacao_etp: p3?.numero_etp || `ETP-${proc.numero_processo_administrativo}`,
        riscos_mitigados: p4?.total_riscos || 9,
        itens_planilha: baseItems,
        valor_total_estimado: totalValor,
        modalidade: proc.modalidade,
        modo_disputa: proc.modo_disputa,
        criterio_julgamento: proc.criterio_julgamento,
        formato_lance: proc.formato_lance,
        usar_srp: proc.usar_srp,
        srp_dispensa_dotacao_art17_dec11462: proc.usar_srp,
        adequacao_orcamentaria: dotLinha,
        alineas_art6_xxiii: {
          a_definicao_objeto: objetoConsolidado,
          b_fundamentacao: `ETP ${p3?.numero_etp || proc.numero_processo_administrativo} e Mapa de Riscos (${p4?.total_riscos || 9} riscos)`,
          c_solucao_como_todo: p3?.incisos_art18_par1?.VII_solucao_como_todo || objetoConsolidado,
          d_requisitos: trProfile.sustentabilidadeSpec,
          e_modelo_execucao: trProfile.execucaoPrazoLocal,
          f_modelo_gestao: trProfile.imrRegra,
          g_medicao_pagamento: 'Liquidação após atesto definitivo e pagamento em até 30 dias em ordem cronológica (Art. 141)',
          h_selecao_fornecedor: `${getModalidadeLabel(proc.modalidade)} / ${getCriterioLabel(proc.criterio_julgamento)}`,
          i_estimativas_valor: totalValor,
          j_adequacao_orcamentaria: adequacaoTexto
        },
        feedback_incorporado: feedback || null
      };

      const imrTableHtml = renderStructuredTableHtml(
        ['Indicador de Desempenho (IMR)', 'Meta Exigida', 'Forma de Aferição / Fiscalização', 'Faixa de Glosa / Ajuste no Pagamento'],
        deepSpec.imrIndicadores.map((ind) => [
          { label: ind.indicador, strong: true },
          ind.meta,
          ind.formaAfericao,
          ind.faixaGlosa
        ])
      );

      const gestaoPapeisHtml = renderStructuredTableHtml(
        ['Agente Designado (Art. 117)', 'Natureza da Atribuição', 'Rotinas Obrigatórias de Controle'],
        [
          [
            { label: 'Gestor do Contrato', strong: true },
            'Coordenação administrativo-contratual global',
            'Consolidar relatórios dos fiscais, gerir vigência/aditivos, reajustes, glosas, notificações e instruir processos sancionadores (Art. 156).'
          ],
          [
            { label: 'Fiscal Técnico', strong: true },
            'Aferição material, técnica e operacional do objeto',
            'Emitir termos circunstanciados de recebimento (Art. 140), aferir metas do IMR, registrar desvios em livro próprio (Art. 117, § 1º) e validar assistência técnica.'
          ],
          [
            { label: 'Fiscal Administrativo / Setorial', strong: true },
            'Conformidade fiscal, trabalhista e financeira',
            'Conferir CND Federal/FGTS/CNDT mensalmente (Art. 92, XVI), encargos trabalhistas (Art. 121), retenções tributárias e conformidade documental das faturas.'
          ],
          [
            { label: 'Preposto da Contratada (Art. 118)', strong: true },
            'Representação formal da empresa executora',
            'Receber notificações oficiais, coordenar correções de inconformidades no SLA previsto e responder pela execução integral junto à Administração.'
          ]
        ]
      );

      const fichaTrHtml = renderMetadataGridHtml([
        ['Documento / Referência', `${escapeHtml(numeroTr)} &bull; Catálogo ${escapeHtml(trProfile.catalogType)}`],
        [
          'Processos Vinculados',
          `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
        ],
        [
          'Unidade e Base Legal',
          `${bind('secretaria_nome', secNome)} &bull; Art. 6º, XXIII, Art. 40 e Art. 41 da Lei nº 14.133/2021`
        ],
        [
          'Tipo / Modalidade / Critério',
          `${bind('tipo_contratacao_label', tipoContratacaoLabel)} &bull; ${bind('modalidade_label', getModalidadeLabel(proc.modalidade))} &bull; ${bind('criterio_julgamento_label', getCriterioLabel(proc.criterio_julgamento))} (${bind('formato_lance_label', getFormatoLanceLabel(proc.formato_lance))})`
        ],
        [
          'Regime e Estimativa',
          `${bind('srp_status', proc.usar_srp ? 'Sistema de Registro de Preços (SRP - Art. 82)' : 'Contratação Convencional')} &bull; <strong>${formatCurrencyBRL(totalValor)}</strong>`
        ]
      ]);

      const html = `
        <h2>5. TERMO DE REFERÊNCIA (TR) — ANEXO I DO EDITAL</h2>
        ${fichaTrHtml}
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva do Termo de Referência (Art. 6º, XXIII)',
          `Especificação objetiva vinculante (${escapeHtml(trProfile.catalogType)}) com recebimento bifásico (Art. 140), IMR com glosa gradual e fiscalização segregada (Art. 117). ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}

        <h3>1. Definição do Objeto (Art. 6º, XXIII, "a", Art. 40 e Art. 41)</h3>
        <p><strong>Objeto:</strong> ${escapeHtml(objetoConsolidado)}.</p>
        <p><strong>Natureza do Objeto:</strong> ${escapeHtml(trProfile.naturezaObjeto)}, cujos padrões de desempenho e qualidade estão objetivamente definidos neste Termo de Referência por meio de especificações usuais de mercado, vedado o direcionamento de marca ou exclusividade injustificada (Art. 41).</p>
        <p><strong>Normas Técnicas Aplicáveis e Padrões Mínimos:</strong> ${escapeHtml(deepSpec.normasTecnicas)} Eventual menção referencial nos autos não exclui produtos/soluções equivalentes ou de desempenho superior, mediante comprovação técnica objetiva.</p>
        ${renderItemsTableHtml(baseItems, trProfile.catalogType)}
        <p><strong>Prazo de Vigência e Prorrogação (Arts. 105 a 107):</strong> O prazo de vigência contratual será de <strong>${prazoVigenciaMeses} (doze) meses</strong> contados da assinatura/divulgação no PNCP. ${escapeHtml(prorrogavel)}</p>

        <h3>2. Fundamentação e Descrição da Necessidade da Contratação (Art. 6º, XXIII, "b")</h3>
        <p>A fundamentação da contratação, a justificativa do interesse público, o comparativo do Cenário de Inércia e a memória de cálculo dos quantitativos encontram-se pormenorizados no <strong>Estudo Técnico Preliminar aprovado (${escapeHtml(json.fundamentacao_etp)})</strong>, peça integrante da fase preparatória deste processo, cujas conclusões demonstraram a viabilidade técnica, socioeconômica e ambiental da solução escolhida. O presente Termo de Referência incorpora integralmente as ações preventivas e a matriz de alocação de riscos (Art. 103) definidas no <strong>Mapa de Gerenciamento de Riscos aprovado</strong> (${p4?.total_riscos || 12} riscos mapeados nas 3 fases).</p>

        <h3>3. Descrição da Solução como um Todo (Art. 6º, XXIII, "c")</h3>
        <p>${escapeHtml(p3?.incisos_art18_par1?.VII_solucao_como_todo || objetoConsolidado)} A solução contempla integralmente todo o ciclo de vida do objeto, abrangendo fornecimento/execução dentro dos padrões normativos, entrega técnica, garantia contratual, assistência técnica corretiva, manutenção/substituição de itens defeituosos e diretrizes de destinação/logística reversa ao término da vida útil.</p>

        <h3>4. Requisitos da Contratação (Art. 6º, XXIII, "d")</h3>
        <ul>
          <li><strong>Critérios de Sustentabilidade e Logística Reversa (Art. 5º, Art. 45 e Lei nº 12.305/2010):</strong> ${escapeHtml(trProfile.sustentabilidadeSpec)}</li>
          <li><strong>Exigência de Amostra / Prova de Conceito / Catálogo (Art. 41, II):</strong> ${escapeHtml(trProfile.amostraRegra)}</li>
          <li><strong>Subcontratação (Art. 122):</strong> ${escapeHtml(trProfile.subcontratacaoRegra)}</li>
          <li><strong>Garantia da Contratação (Art. 96):</strong> ${escapeHtml(trProfile.garantiaContratacaoRegra)}</li>
          <li><strong>Tratamento Diferenciado às ME/EPP (Art. 4º da Lei nº 14.133/2021 c/c LC nº 123/2006):</strong> Aplicação integral dos benefícios legais de preferência no empate ficto (até 5% no Pregão / 10% nas demais modalidades), regularidade fiscal tardia (5 dias úteis prorrogáveis) e cota/exclusividade por item quando compatível até o limite legal, ressalvadas as vedações do Art. 4º, § 1º (receita bruta do exercício superior ao teto da EPP).</li>
        </ul>

        <h3>5. Modelo de Execução do Objeto (Art. 6º, XXIII, "e" e Art. 140)</h3>
        <p><strong>Condições, Prazos, Locais e Horários:</strong> ${escapeHtml(trProfile.execucaoPrazoLocal)}</p>
        <p><strong>Recebimento Provisório, Recebimento Definitivo e Garantia Técnica (Art. 140):</strong> ${escapeHtml(trProfile.recebimentoGarantia)}</p>
        <ul>
          <li><strong>Recebimento Provisório:</strong> Formalizado pelo responsável pelo acompanhamento e fiscalização mediante termo detalhado que verifique o cumprimento das exigências de caráter técnico/quantitativo imediato.</li>
          <li><strong>Recebimento Definitivo:</strong> Emitido por servidor ou comissão designada pela autoridade competente mediante termo detalhado que comprove o atendimento integral às especificações contratuais, após conferência qualitativa e testes funcionais.</li>
          <li><strong>Rejeição Formal (Art. 140, § 1º):</strong> O objeto poderá ser rejeitado, no todo ou em parte, quando em desacordo com as especificações deste Termo de Referência e da proposta vencedora, devendo ser substituído/corrigido no prazo máximo de 5 (cinco) dias úteis a contar da notificação formal, às expensas exclusivas da Contratada, sem prejuízo das sanções cabíveis.</li>
        </ul>

        <h3>6. Modelo de Gestão do Contrato e Instrumento de Medição de Resultados — IMR (Art. 6º, XXIII, "f", Art. 117 e Art. 118)</h3>
        <p>A execução contratual será acompanhada e fiscalizada por representantes da Administração especialmente designados na forma dos Arts. 7º e 117 da Lei nº 14.133/2021, com registro obrigatório de todas as ocorrências em relatório próprio (Art. 117, § 1º) e estrita segregação de funções:</p>
        ${gestaoPapeisHtml}
        <p><strong>Instrumento de Medição de Resultados (IMR) — Aferição Objetiva de Qualidade e SLA:</strong> ${escapeHtml(trProfile.imrRegra)} O pagamento observará o cumprimento das metas objetivas abaixo especificadas:</p>
        ${imrTableHtml}

        <h3>7. Critérios de Medição e de Pagamento (Art. 6º, XXIII, "g" e Art. 141)</h3>
        <ul>
          <li><strong>Liquidação e Prazo de Pagamento:</strong> Após o recebimento definitivo, validação do IMR e atesto formal da Nota Fiscal/Fatura pela fiscalização, a despesa será liquidada e paga mediante ordem bancária em até <strong>30 (trinta) dias</strong>, observada estritamente a ordem cronológica para cada fonte diferenciada de recursos (Art. 141).</li>
          <li><strong>Glosa e Retenção Técnica:</strong> Havendo descumprimento de metas do IMR apurado com contraditório prévio no boletim de medição/recebimento, aplicar-se-á o ajuste proporcional diretamente na fatura correspondente.</li>
          <li><strong>Retenções Tributárias:</strong> No ato do pagamento serão efetuadas as retenções tributárias e previdenciárias previstas na legislação vigente (IRRF conforme IN RFB nº 1.234/2012 e Decreto Municipal, ISSQN e INSS, quando cabíveis).</li>
          <li><strong>Atualização Financeira:</strong> Na hipótese de atraso de pagamento imputável exclusivamente à Administração (sem culpa da Contratada e mantida a regularidade fiscal), incidirá atualização monetária pelo IPCA-E (ou índice oficial equivalente) acrescida de juros de mora legais entre a data prevista para adimplemento e a efetiva liquidação (Art. 92, V).</li>
        </ul>

        <h3>8. Forma e Critérios de Seleção do Fornecedor (Art. 6º, XXIII, "h" e Arts. 62 a 69)</h3>
        <p>O fornecedor será selecionado por meio de <strong>${bind('modalidade_label', getModalidadeLabel(proc.modalidade))}</strong>, em modo de disputa <strong>${bind('modo_disputa_label', getModoDisputaLabel(proc.modo_disputa))}</strong>, com critério de julgamento <strong>${bind('criterio_julgamento_label', getCriterioLabel(proc.criterio_julgamento))}</strong> (${bind('formato_lance_label', getFormatoLanceLabel(proc.formato_lance))}). Para habilitação, exigir-se-ão exclusivamente os documentos previstos nos Arts. 62 a 69 da Lei nº 14.133/2021:</p>
        <ul>
          <li><strong>Habilitação Jurídica (Art. 66):</strong> Ato constitutivo, estatuto ou contrato social consolidado vigente e documento de identificação dos representantes legais.</li>
          <li><strong>Habilitação Fiscal, Social e Trabalhista (Art. 68):</strong> Inscrição no CNPJ, regularidade perante as Fazendas Federal/PGFN (INSS), Estadual e Municipal do domicílio, CRF/FGTS, CNDT, declaração de cumprimento do Art. 7º, XXXIII da CF/88 e declaração de reserva de cargos para PcD e reabilitados (Art. 63, IV).</li>
          <li><strong>Habilitação Econômico-Financeira (Art. 69):</strong> Certidão negativa de feitos sobre falência e demonstrações contábeis/balanço patrimonial dos 2 (dois) últimos exercícios sociais. ${escapeHtml(deepSpec.indicesContabeisArt69)}</li>
          <li><strong>Qualificação Técnica (Art. 67 e Súmula nº 263/TCU):</strong> ${escapeHtml(trProfile.qualificacaoTecnicaArt67)} Consideram-se parcelas de maior relevância e valor significativo aquelas que tenham valor individual igual ou superior a <strong>4% (quatro por cento)</strong> do valor total estimado da contratação (Art. 67, § 1º), respeitado o limite máximo de 50% de quantitativos para atestados (Art. 67, § 2º e Súmula nº 263 do TCU).</li>
        </ul>

        <h3>9. Estimativas do Valor da Contratação (Art. 6º, XXIII, "i" e Art. 23)</h3>
        <p>O valor global estimado da contratação é de <strong>${formatCurrencyBRL(totalValor)}</strong>, consolidado na planilha de quantitativos e preços unitários referenciais do item 1, formado em estrita observância ao Art. 23, § 1º da Lei nº 14.133/2021 e à <strong>IN SEGES/ME nº 65/2021</strong>.</p>
        <p><strong>Análise Estratégica de Custos (Curva ABC) e Parâmetros da Pesquisa:</strong> ${escapeHtml(priceAnalytics.summaryText)} ${escapeHtml(pesquisaParametrosTr)}</p>

        <h3>10. Adequação Orçamentária (Art. 6º, XXIII, "j" e Art. 150)</h3>
        <p>${proc.usar_srp
          ? `Tratando-se de contratação processada pelo Sistema de Registro de Preços (SRP - Art. 82 da Lei nº 14.133/2021), fica dispensada a indicação prévia da disponibilidade orçamentária na fase licitatória nos termos do <strong>Art. 17 do Decreto nº 11.462/2023</strong>, sendo a dotação orçamentária exigida obrigatoriamente apenas previamente à formalização do contrato ou emissão de Nota de Empenho. Dotação de referência cadastrada: ${bind('dotacao_completa', dotLinha)}.`
          : `As despesas decorrentes desta contratação correrão à conta da seguinte dotação orçamentária vigente: ${bind('dotacao_completa', dotLinha)}. Declara-se, nos termos do Art. 150 da Lei nº 14.133/2021 e do Art. 16 da LRF, que a despesa possui adequação orçamentária com a <strong>LOA</strong> e compatibilidade com a <strong>LDO</strong> e o <strong>PPA</strong> vigentes.`}</p>

        <p><strong>Elaboração Técnica e Aprovação (Anexo I do Edital):</strong> ${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <table>
          <thead>
            <tr>
              <th>Responsável Técnico / Equipe de Planejamento</th>
              <th>Aprovação da Autoridade Competente / Ordenador de Despesas</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>_________________________________<br/><strong>${escapeHtml(proc.responsavel_requisitante)}</strong><br/>${escapeHtml(proc.cargo_requisitante)} — ${bind('secretaria_nome', secNome)}</td>
              <td>_________________________________<br/><strong>${bind('ordenador_nome', ordenadorNome)}</strong><br/>${bind('ordenador_cargo', ordenadorCargo)} — ${bind('ordenador_portaria', ordenadorPortaria)}</td>
            </tr>
          </tbody>
        </table>
      `.trim();

      return {
        structured_json: json,
        html_content: html,
        legal_alerts: [
          {
            id: 'ag5-alinhamento-tr',
            severity: 'info',
            article: 'Art. 6º, XXIII, Art. 40 e Art. 41 da Lei nº 14.133/2021',
            title: 'Termo de Referência Sincronizado com ETP e Mapa de Riscos',
            message: `Todas as alíneas (a a j) do Art. 6º, XXIII atendidas. Valor total (${formatCurrencyBRL(totalValor)}) e quantitativos conferem integralmente com o ETP.${proc.usar_srp ? ' Aplicada regra de dispensa de dotação prévia no SRP (Art. 17 do Decreto nº 11.462/2023).' : ''}`
          },
          ...certameAlerts
        ]
      };
    }

    // ========================================================
    // AGENTE 06: TERMO DE AUTUAÇÃO (PROTOCOLO FORMAL)
    // ========================================================
    case 6: {
      const pecasIndexadas = [1, 2, 3, 4, 5].map((num, idx) => {
        const piece = piecesByNumber.get(num);
        const flIni = idx * 4 + 2;
        const flFim = flIni + 3;
        return {
          ordem: idx + 1,
          titulo: piece?.title || `Peça ${num}`,
          versao: piece?.current_version || 1,
          status: piece?.status || 'PENDENTE',
          folhas: `fls. ${String(flIni).padStart(2, '0')}–${String(flFim).padStart(2, '0')}`
        };
      });

      const lastPieceEndFl = pecasIndexadas.length * 4 + 1;
      const temPesquisaAnexa = Boolean(proc.pesquisa_preco_arquivo) || (proc.pesquisa_preco_itens?.length ?? 0) > 0;
      const sumarioAutos = [
        {
          ordem: 0,
          titulo: 'Capa de Autuação e Protocolo Oficial do Processo',
          versao: 1,
          folhas: 'fl. 01',
          status: 'AUTUADA'
        },
        ...pecasIndexadas,
        ...(temPesquisaAnexa
          ? [
              {
                ordem: 6,
                titulo: `Pesquisa de Preços e Cotações (Art. 23)${proc.pesquisa_preco_arquivo ? ` — ${proc.pesquisa_preco_arquivo}` : ''}`,
                versao: 1,
                folhas: `fls. ${String(lastPieceEndFl + 1).padStart(2, '0')}–${String(lastPieceEndFl + 2).padStart(2, '0')}`,
                status: 'ANEXADA'
              }
            ]
          : []),
        {
          ordem: temPesquisaAnexa ? 7 : 6,
          titulo: 'Termo de Autuação e Despacho de Encaminhamento',
          versao: 1,
          folhas: `fl. ${String(lastPieceEndFl + (temPesquisaAnexa ? 3 : 1)).padStart(2, '0')}`,
          status: 'LAVRADO'
        }
      ];

      const unapproved = pecasIndexadas.filter((p) => p.status !== 'APROVADO');
      const alerts: LegalAlert[] = [
        {
          id: 'ag6-protocolo',
          severity: 'info',
          article: 'Art. 12, VI e Art. 18 da Lei nº 14.133/2021',
          title: 'Autos Físicos/Digitais Formalmente Autuados',
          message: 'Todos os documentos preparatórios iniciais foram numerados, rubricados e vinculados ao protocolo oficial.'
        }
      ];
      if (unapproved.length > 0) {
        alerts.push({
          id: 'ag6-pecas-pendentes',
          severity: 'warning',
          article: 'Governança Processual',
          title: 'Peças Anteriores Pendentes de Assinatura',
          message: `${unapproved.length} peça(s) inicial(is) ainda não possuem aprovação/assinatura formal no log antes da autuação definitiva.`,
          recommendation: 'Recomenda-se aprovar/assinar as peças 01 a 05 no respectivo painel antes da exportação do Dossiê.'
        });
      }

      const rowsHtml = sumarioAutos
        .map(
          (p) => `
          <tr>
            <td>${String(p.ordem).padStart(2, '0')}</td>
            <td>${escapeHtml(p.titulo)}</td>
            <td>v${p.versao}</td>
            <td>${escapeHtml(p.folhas)}</td>
            <td>${escapeHtml(p.status)}</td>
          </tr>`
        )
        .join('');

      const conferenciaArt18Html = renderStructuredTableHtml(
        ['Requisito Legal da Fase Preparatória', 'Fundamento (Lei nº 14.133/2021)', 'Situação nos Autos'],
        [
          ['Exposição de Demanda & Formalização da Demanda (DFD)', 'Art. 12, VII e Art. 18, caput', 'Instruído e autuado'],
          ['Estudo Técnico Preliminar (13 Incisos + TCO + Memória de Cálculo)', 'Art. 18, § 1º e IN SEGES/ME nº 58/2022', 'Instruído e autuado'],
          ['Mapa de Gerenciamento de Riscos (3 Fases + Alocação Art. 103)', 'Art. 18, X, Art. 22 e Art. 103', 'Instruído e autuado'],
          ['Termo de Referência (10 Alíneas + IMR + Critérios Art. 67/69)', 'Art. 6º, XXIII, Art. 40 e Art. 41', 'Instruído e autuado'],
          ['Pesquisa de Preços Saneada e Orçamento Estimado', 'Art. 23, § 1º e IN SEGES/ME nº 65/2021', temPesquisaAnexa ? `Anexa (${proc.pesquisa_preco_arquivo || 'Planilha estruturada'})` : 'Consolidada nas Peças 01 a 05'],
          [
            proc.usar_srp ? 'Previsão Orçamentária (Regime SRP — Art. 17 Dec. 11.462/2023)' : 'Adequação Orçamentária e LRF (LOA/LDO/PPA)',
            proc.usar_srp ? 'Art. 82 e Art. 17 do Decreto nº 11.462/2023' : 'Art. 150 da Lei nº 14.133/2021',
            proc.usar_srp ? `Dispensado bloqueio prévio até contratação (${dotLinha})` : `Validada (${dotLinha})`
          ]
        ]
      );

      const html = `
        <h2>6. TERMO DE AUTUAÇÃO DE PROCESSO LICITATÓRIO</h2>
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva da Autuação (Art. 12, VI e Art. 18)',
          `Autos formalmente instaurados em ${todayBR} com <strong>${sumarioAutos.length} documentos indexados</strong> (fls. sequenciais rubricadas), sessão pública prevista para <strong>${escapeHtml(sessaoPublicaLabel)}</strong> e montante estimado de <strong>${formatCurrencyBRL(totalValor)}</strong>.`
        )}
        ${feedbackCallout(feedback)}

        <h3>1. Cabeçalho Oficial de Autuação</h3>
        <table class="meta-table">
          <tbody>
            <tr>
              <td><strong>Órgão Promotor</strong></td>
              <td>${bind('orgao_razao_social', inst.razao_social)} (CNPJ: ${bind('orgao_cnpj', formatCnpj(inst.cnpj))})</td>
            </tr>
            <tr>
              <td><strong>Processo Administrativo nº</strong></td>
              <td>${bind('numero_processo_administrativo', proc.numero_processo_administrativo)}</td>
            </tr>
            <tr>
              <td><strong>Processo Licitatório nº</strong></td>
              <td>${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}</td>
            </tr>
            <tr>
              <td><strong>Modalidade</strong></td>
              <td>${bind('modalidade_label', getModalidadeLabel(proc.modalidade))}${proc.usar_srp ? ' — Sistema de Registro de Preços (SRP)' : ''}</td>
            </tr>
            <tr>
              <td><strong>Data / Horário da Sessão</strong></td>
              <td>${bind('sessao_publica_data_hora', sessaoPublicaLabel)}</td>
            </tr>
            <tr>
              <td><strong>Critério de Julgamento</strong></td>
              <td>${bind('criterio_julgamento_label', getCriterioLabel(proc.criterio_julgamento))} (${bind('formato_lance_label', getFormatoLanceLabel(proc.formato_lance))})</td>
            </tr>
            <tr>
              <td><strong>Secretaria de Origem</strong></td>
              <td>${bind('secretaria_nome', secNome)} — ${bind('ordenador_nome', ordenadorNome)} (${bind('ordenador_cargo', ordenadorCargo)})</td>
            </tr>
            <tr>
              <td><strong>Objeto Consolidado (TR)</strong></td>
              <td>${escapeHtml(objetoConsolidado)} — Valor Global Estimado: <strong>${formatCurrencyBRL(totalValor)}</strong></td>
            </tr>
          </tbody>
        </table>

        <h3>2. Certidão de Abertura e Registro</h3>
        <p><strong>CERTIFICO</strong>, na forma do <strong>Art. 12, incisos IV e VI, e Art. 18 da Lei Federal nº 14.133/2021</strong>, que aos <strong>${todayBR}</strong>, na sede administrativa do(a) ${bind('orgao_nome_fantasia', inst.nome_fantasia || inst.razao_social)}, situada à ${bind('orgao_endereco', `${inst.endereco_completo} — CEP ${inst.cep} — ${municipioUf}`)}, procedi à <strong>AUTUAÇÃO FORMAL, NUMERAÇÃO SEQUENCIAL DE FOLHAS E RUBRICA</strong> dos documentos inaugurais que instruem a fase preparatória do processo em epígrafe, assegurando a integridade cronológica, a auditabilidade eletrônica e a preservação documental nos autos oficiais do Município.</p>

        <h3>3. Sumário Inicial dos Autos (Fls.)</h3>
        <table>
          <thead>
            <tr>
              <th>Seq.</th>
              <th>Peça Processual Autuada</th>
              <th>Versão</th>
              <th>Fls.</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
        <p><strong>Quadro de Conferência Documental da Fase Preparatória (Art. 18):</strong></p>
        ${conferenciaArt18Html}

        <h3>4. Encaminhamento Processual</h3>
        <p>Lavrado e encerrado este Termo de Autuação (fls. inaugurais devidamente numeradas e conferidas), determino a imediata <strong>remessa dos autos ao Setor de Licitações e Contratos</strong>, para elaboração das minutas instrumentais vinculadas ao Termo de Referência (Contrato Administrativo — Art. 92, Ata de Registro de Preços — Art. 82, se aplicável, e Edital — Art. 25), e sequencialmente à <strong>Procuradoria Jurídica</strong> para exercício do controle prévio de legalidade nos termos do Art. 53 da Lei nº 14.133/2021.</p>

        <h3>5. Bloco de Assinatura</h3>
        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <p>_________________________________________________________<br/>
        <strong>Agente de Contratação / Presidente da Comissão / Chefe do Setor de Licitações</strong><br/>
        Setor de Protocolo, Licitações e Contratos — ${bind('orgao_razao_social', inst.razao_social)}</p>
      `.trim();

      return {
        structured_json: {
          protocolo_autuacao: `AUT-${proc.numero_processo_administrativo}`,
          data_autuacao: todayBR,
          processo_licitatorio: proc.numero_processo_licitatorio,
          processo_administrativo: proc.numero_processo_administrativo,
          secretaria_origem: secNome,
          modalidade: getModalidadeLabel(proc.modalidade),
          criterio_julgamento: getCriterioLabel(proc.criterio_julgamento),
          objeto: objetoConsolidado,
          pecas_autuadas: pecasIndexadas,
          sumario_autos: sumarioAutos,
          feedback_incorporado: feedback || null
        },
        html_content: html,
        legal_alerts: alerts
      };
    }

    // ========================================================
    // AGENTE 07: MINUTA DO CONTRATO ADMINISTRATIVO (ART. 92)
    // ========================================================
    case 7: {
      return buildAgent07MinutaContrato({
        proc,
        inst,
        dotLinha,
        comarca,
        municipioUf,
        todayBR,
        category,
        baseItems,
        objetoConsolidado,
        trNumberRef: p5?.numero_tr,
        feedback,
        direct
      });
    }

    // ========================================================
    // AGENTE 08: MINUTA DA ATA DE REGISTRO DE PREÇOS - ARP (ART. 82)
    // ========================================================
    case 8: {
      if (!proc.usar_srp) {
        return {
          structured_json: { dispensado: true, motivo: 'Sistema de Registro de Preços (SRP) não selecionado.' },
          html_content: '<p><strong>Agente 08 Dispensado:</strong> Este processo não utiliza o Sistema de Registro de Preços (Art. 82 da Lei nº 14.133/2021).</p>',
          legal_alerts: []
        };
      }

      const anoAtual = new Date().getFullYear();
      const arpRowsHtml = baseItems
        .map(
          (it) => `
          <tr>
            <td>${it.item}</td>
            <td>${escapeHtml(it.descricao)}</td>
            <td>[Marca / Modelo adjudicado]</td>
            <td>${escapeHtml(it.medida || it.unidade)}</td>
            <td>${it.quantidade}</td>
            <td>${formatCurrencyBRL(it.valor_unitario)}</td>
            <td><strong>${formatCurrencyBRL(it.valor_total)}</strong></td>
          </tr>`
        )
        .join('');

      const clausulasArp = [
        'Cláusula Primeira – Do Objeto e Preços Registrados',
        'Cláusula Segunda – Órgão Gerenciador e Participantes (Art. 82, I e II)',
        'Cláusula Terceira – Da Adesão à Ata de Registro de Preços ("Carona" - Art. 86)',
        'Cláusula Quarta – Validade, Formalização da Ata e Cadastro de Reserva (Art. 84)',
        'Cláusula Quinta – Alteração ou Atualização dos Preços Registrados (Equilíbrio Econômico-Financeiro)',
        'Cláusula Sexta – Cancelamento do Registro do Licitante Vencedor e dos Preços Registrados',
        'Cláusula Sétima – Das Penalidades e Disposições Gerais'
      ];

      const json = {
        numero_arp: `ARP-${proc.numero_processo_licitatorio.replace(/[^\w/-]/g, '')}`,
        ano_exercicio: anoAtual,
        orgao_gerenciador: inst.razao_social,
        orgaos_participantes: [secNome],
        vigencia_meses: 12,
        prorrogavel_igual_periodo: true,
        regra_renovacao_quantitativos: 'Prorrogação por igual período (12 + 12 meses) limitada ao saldo quantitativo originalmente registrado ou mediante previsão expressa e justificativa no planejamento (Art. 84 da Lei nº 14.133/2021 e Decreto nº 11.462/2023).',
        permite_adesao_carona: true,
        limite_adesao_individual_percentual: 50,
        limite_adesao_global_multiplicador: 2,
        cadastro_reserva_habilitado: true,
        clausulas_arp: clausulasArp,
        itens_registrados: baseItems,
        valor_total_registrado: totalValor,
        feedback_incorporado: feedback || null
      };

      const adesaoLimitesHtml = renderStructuredTableHtml(
        ['Modalidade de Limite', 'Parâmetro Normativo', 'Fundamento Legal (Lei 14.133/2021)'],
        [
          [
            { label: 'Limite Individual (por Órgão/Entidade Aderente)', strong: true },
            'Máximo de 50% (cinquenta por cento) dos quantitativos registrados por item para o gerenciador e participantes.',
            'Art. 86, § 4º da Lei nº 14.133/2021'
          ],
          [
            { label: 'Limite Global (Soma de Todas as Adesões)', strong: true },
            'Máximo de 200% — o dobro (2x) do quantitativo originalmente registrado por item, independente do número de aderentes.',
            'Art. 86, § 5º da Lei nº 14.133/2021'
          ],
          [
            { label: 'Requisitos Prévios Cumulativos', strong: true },
            'Justificativa de vantagem da adesão + pesquisa de compatibilidade de preços (Art. 23) + anuência prévia do Gerenciador e do Fornecedor.',
            'Art. 86, §§ 2º e 3º da Lei nº 14.133/2021'
          ]
        ]
      );

      const cadastroReservaHtml = renderStructuredTableHtml(
        ['Ordem de Preferência no Cadastro de Reserva', 'Composição de Licitantes', 'Hipóteses de Convocação (Dec. 11.462/2023)'],
        [
          [
            { label: '1º Grupo — Preço Equiparado', strong: true },
            'Licitantes que aceitaram cotar os bens/serviços com preços iguais aos do adjudicatário, na ordem de classificação do certame.',
            'Recusa do adjudicatário em assinar a ARP em 5 dias úteis, ou cancelamento de registro por inadimplemento/reequilíbrio frustrado (Art. 20 e Art. 28).'
          ],
          [
            { label: '2º Grupo — Proposta Original Mantida', strong: true },
            'Licitantes que mantiveram sua proposta original ao final da disputa competitiva, na ordem decrescente de vantagem.',
            'Esgotamento ou recusa integral dos fornecedores integrantes do 1º Grupo, após negociação prévia de redução (Art. 20, § 2º).'
          ]
        ]
      );

      const fichaArpHtml = renderMetadataGridHtml([
        ['Instrumento / Ata nº', `ARP-${proc.numero_processo_licitatorio.replace(/[^\w/-]/g, '')}/${anoAtual}`],
        [
          'Processos Vinculados',
          `Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} &bull; Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}`
        ],
        [
          'Modalidade e Base Legal',
          `${bind('modalidade_label', getModalidadeLabel(proc.modalidade))} &bull; Arts. 82 a 86 da Lei nº 14.133/2021 e Decreto nº 11.462/2023`
        ],
        [
          'Valor Global Registrado',
          `<strong>${formatCurrencyBRL(totalValor)}</strong> (Vigência 1 ano prorrogável por igual período — Art. 84)`
        ]
      ]);

      const html = `
        <h2>8. MINUTA DE ATA DE REGISTRO DE PREÇOS Nº ___/${anoAtual}</h2>
        ${fichaArpHtml}
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva do SRP (Carona 50% / 2x e Cadastro de Reserva)',
          `Ata vinculada ao TR com validade de <strong>1 (um) ano</strong> do 1º dia útil pós-PNCP prorrogável por igual período, limites de adesão carona de <strong>50% individual e dobro (2x) global</strong> (Art. 86, §§ 4º e 5º). ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}

        <h3>Preâmbulo e Qualificação das Partes</h3>
        <p>O(A) <strong>${bind('orgao_razao_social', inst.razao_social)}</strong>, pessoa jurídica de direito público interno, inscrito(a) no CNPJ sob o nº <strong>${bind('orgao_cnpj', formatCnpj(inst.cnpj))}</strong>, com sede administrativa à ${bind('orgao_endereco', `${inst.endereco_completo} — CEP ${inst.cep} — ${municipioUf}`)}, neste ato representado(a) pelo(a) ${prefeitoSpan.inlinePreambuloHtml} e pelo(a) Ordenador(a) de Despesas <strong>${bind('ordenador_nome', ordenadorNome)}</strong> (${bind('ordenador_portaria', ordenadorPortaria)}), na qualidade de <strong>ÓRGÃO GERENCIADOR</strong>, considerando o julgamento da licitação em epígrafe e a respectiva homologação, <strong>RESOLVE registrar os preços</strong> do(s) fornecedor(es) classificado(s) e qualificado(s) abaixo, atendendo às condições previstas no Edital e no Termo de Referência:</p>
        <table>
          <thead>
            <tr>
              <th colspan="2">Qualificação do(s) Fornecedor(es) Registrado(s)</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><strong>Razão Social</strong></td><td>[RAZÃO SOCIAL DO FORNECEDOR REGISTRADO]</td></tr>
            <tr><td><strong>CNPJ / Endereço</strong></td><td>[00.000.000/0001-00] — [Endereço completo, Município/UF, CEP]</td></tr>
            <tr><td><strong>Representante Legal</strong></td><td>[Nome completo, CPF, Telefone e E-mail institucional para Ordens de Fornecimento]</td></tr>
          </tbody>
        </table>

        <h3>Cláusula Primeira – Do Objeto e Preços Registrados</h3>
        <p>1.1. A presente Ata tem por objeto o registro de preços para eventual e futura contratação de: <strong>${escapeHtml(objetoConsolidado)}</strong>, conforme especificações técnicas do Termo de Referência (Anexo I) e proposta(s) vencedora(s), vedada a exigência de quantitativo mínimo por pedido diversa do edital:</p>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Descrição / Especificação Técnica</th>
              <th>Marca / Modelo</th>
              <th>Medida</th>
              <th>Qtd. Máxima Estimada</th>
              <th>Valor Unitário Registrado</th>
              <th>Valor Total Registrado</th>
            </tr>
          </thead>
          <tbody>
            ${arpRowsHtml}
            <tr>
              <td colspan="6"><strong>VALOR GLOBAL MÁXIMO REGISTRADO NA ATA</strong></td>
              <td><strong>${formatCurrencyBRL(totalValor)}</strong></td>
            </tr>
          </tbody>
        </table>

        <h3>Cláusula Segunda – Órgão Gerenciador e Participantes (Art. 82, I e II)</h3>
        <p>2.1. O <strong>Órgão Gerenciador</strong> desta Ata de Registro de Preços é o(a) <strong>${bind('orgao_razao_social', inst.razao_social)}</strong> (Setor de Compras e Licitações), incumbido da condução dos procedimentos, controle de saldos, renegociações, remanejamentos internos (Art. 30 do Decreto nº 11.462/2023) e autorizações de adesão.</p>
        <p>2.2. Figura como <strong>Órgão Participante</strong> inicial a <strong>${bind('secretaria_nome', secNome)}</strong> (além das demais Secretarias Municipais eventualmente consolidadas na Intenção de Registro de Preços — IRP, na forma do Art. 86 da Lei nº 14.133/2021).</p>

        <h3>Cláusula Terceira – Da Adesão à Ata de Registro de Preços ("Carona" - Art. 86)</h3>
        <p>3.1. Durante a vigência da Ata, os órgãos e as entidades da Administração Pública que não participaram do procedimento de IRP poderão aderir à ARP na condição de não participantes ("carona"), observados cumulativamente os requisitos e limites quantitativos estatuídos no Art. 86 da Lei nº 14.133/2021 e Arts. 31 a 33 do Decreto nº 11.462/2023:</p>
        ${adesaoLimitesHtml}
        <p>3.2. <em>Nota Condicional:</em> Caso o Termo de Referência/Edital estabeleça vedação expressa à adesão por órgãos não participantes em razão da especificidade do objeto, prevalecerá a vedação expressa para este certame. Os órgãos aderentes deverão efetivar a aquisição/contratação em até 90 (noventa) dias após a autorização do Gerenciador, observado o prazo de vigência da Ata.</p>

        <h3>Cláusula Quarta – Validade, Formalização da Ata e Cadastro de Reserva (Art. 84)</h3>
        <p>4.1. O prazo de vigência da Ata de Registro de Preços será de <strong>1 (um) ano</strong>, contado do <strong>primeiro dia útil subsequente à data de divulgação no PNCP</strong>, <strong>podendo ser prorrogado por igual período, desde que comprovado o preço vantajoso</strong> mediante pesquisa de mercado atualizada (Art. 84, caput da Lei nº 14.133/2021).</p>
        <p>4.2. <strong>Convocação e Assinatura (Art. 19 do Decreto nº 11.462/2023):</strong> Homologado o resultado da licitação, o fornecedor mais bem classificado será convocado para assinar a ARP no prazo de <strong>5 (cinco) dias úteis</strong>, prorrogável uma única vez por igual período mediante solicitação justificada aceita pela Administração, sob pena de decair do direito sem prejuízo das sanções cabíveis.</p>
        <p>4.3. <strong>Regra sobre Renovação dos Quantitativos e Acréscimos:</strong> É vedado efetuar acréscimos nos quantitativos estabelecidos na ARP (Art. 23 do Decreto Federal nº 11.462/2023). Na hipótese de prorrogação da vigência da Ata por mais 1 (um) ano, permanece utilizado o saldo quantitativo remanescente não consumido no primeiro período — <strong>não se renovando automaticamente novos quantitativos</strong>, salvo previsão editalícia expressa, justificativa técnica de demanda contínua no planejamento e preservação do escopo original. O contrato decorrente da ARP terá sua vigência estabelecida no próprio instrumento contratual (Art. 84, parágrafo único).</p>
        <p>4.4. <strong>Cadastro de Reserva (Art. 82, VII e Art. 83):</strong> A existência de preços registrados implicará compromisso de fornecimento nas condições estabelecidas, mas não obrigará a Administração a contratar, sendo facultada a realização de licitação específica (Art. 83). Integra esta Ata o <strong>Cadastro de Reserva</strong> operacionalizado segundo a ordem abaixo:</p>
        ${cadastroReservaHtml}

        <h3>Cláusula Quinta – Alteração ou Atualização dos Preços Registrados (Equilíbrio Econômico-Financeiro)</h3>
        <p>5.1. Os preços registrados poderão ser alterados ou atualizados em decorrência de eventual redução dos preços praticados no mercado ou de fato superveniente que eleve o custo dos bens, obras ou serviços registrados (Arts. 25 a 27 do Decreto nº 11.462/2023):</p>
        <ul>
          <li><strong>5.1.1. Redução de Mercado (Art. 26 Dec. 11.462/2023):</strong> Quando o preço registrado tornar-se superior ao praticado no mercado, o Órgão Gerenciador convocará o fornecedor para negociar a redução aos valores de mercado. Frustrada a negociação, o fornecedor será liberado do compromisso sem penalidade, convocando-se os integrantes do Cadastro de Reserva para verificar igualdade de condições e atualizando-se o respectivo registro.</li>
          <li><strong>5.1.2. Elevação Comprovada (Art. 27 Dec. 11.462/2023):</strong> Quando o preço de mercado tornar-se superior ao preço registrado e o fornecedor comprovar formalmente, por requerimento protocolado <strong>antes da emissão da Nota de Empenho ou Ordem de Fornecimento</strong>, a impossibilidade de cumprimento mediante notas fiscais e planilhas analíticas, o Órgão Gerenciador poderá: (a) negociar e deferir atualização ou conceder reequilíbrio; ou (b) não havendo êxito, liberar o fornecedor do compromisso assumido sem aplicação de sanção e convocar o Cadastro de Reserva.</li>
        </ul>

        <h3>Cláusula Sexta – Cancelamento do Registro do Licitante Vencedor e dos Preços Registrados</h3>
        <p>6.1. O registro do fornecedor será cancelado pelo Órgão Gerenciador quando este (Art. 28 do Decreto nº 11.462/2023): (I) descumprir as condições da ARP sem motivo justificado; (II) não retirar a nota de empenho ou instrumento equivalente no prazo estabelecido pela Administração sem justificativa aceitável; (III) não aceitar manter seu preço registrado na hipótese prevista no Art. 27, § 2º do referido Decreto; ou (IV) sofrer sanção prevista nos incisos III (impedimento) ou IV (inidoneidade) do caput do Art. 156 da Lei nº 14.133/2021.</p>
        <p>6.2. O cancelamento de registros nas hipóteses previstas assegura o exercício prévio do contraditório e da ampla defesa, formalizado por despacho motivado da autoridade competente.</p>
        <p>6.3. O cancelamento dos preços registrados poderá ocorrer total ou parcialmente pelo Órgão Gerenciador, na forma do Art. 29 do Decreto nº 11.462/2023, por razão de interesse público devidamente justificada, a pedido do fornecedor decorrente de caso fortuito ou força maior comprovados, ou por exaurimento integral dos quantitativos.</p>

        <h3>Cláusula Sétima – Das Penalidades e Disposições Gerais</h3>
        <p>7.1. O descumprimento da Ata de Registro de Preços ensejará aplicação das penalidades previstas no Edital e nos Arts. 155 a 163 da Lei nº 14.133/2021, alcançando inclusive os licitantes do Cadastro de Reserva que, convocados, não honrarem o compromisso assumido sem justificativa aceita.</p>
        <p>7.2. As condições gerais de execução, recebimento, IMR, pagamento (Art. 141) e obrigações das partes constam do Termo de Referência (Anexo I). A indicação da dotação orçamentária somente será exigida para a formalização do contrato ou outro instrumento hábil (Art. 17 do Decreto nº 11.462/2023). A eficácia desta Ata depende de sua divulgação no <strong>PNCP</strong> (Art. 174). Fica eleito o Foro da <strong>${bind('orgao_comarca', comarca)}</strong>.</p>

        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <table>
          <thead>
            <tr>
              <th>Pelo Órgão Gerenciador</th>
              <th>Pelo Fornecedor Registrado</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>_________________________________<br/>${prefeitoSpan.inlinePreambuloHtml} / <strong>${bind('ordenador_nome', ordenadorNome)}</strong><br/>${bind('orgao_razao_social', inst.razao_social)}</td>
              <td>_________________________________<br/><strong>[REPRESENTANTE LEGAL DO FORNECEDOR]</strong><br/>[RAZÃO SOCIAL REGISTRADA]</td>
            </tr>
          </tbody>
        </table>
      `.trim();

      return {
        structured_json: json,
        html_content: html,
        legal_alerts: [
          {
            id: 'ag8-srp-limites',
            severity: 'info',
            article: 'Arts. 82 a 86 da Lei nº 14.133/2021 e Decreto nº 11.462/2023',
            title: 'ARP Completa: Vigência 1+1, Carona 50%/2x e Regras de Revisão',
            message: 'Minuta contempla preâmbulo, tabela com marca/modelo e qtd. máxima, órgão gerenciador/participantes, adesão 50%/dobro, vigência do 1º dia útil pós-PNCP, regra de quantitativos, equilíbrio de preços, cancelamento e penalidades.'
          }
        ]
      };
    }

    // ========================================================
    // AGENTE 09: EDITAL COMPLETO / AVISO DE CONTRATAÇÃO DIRETA
    // ========================================================
    case 9: {
      const anoAtual = new Date().getFullYear();
      const trProfile = DOMAIN_TR_CONFIG[category];
      const modalidadeLabel = getModalidadeLabel(proc.modalidade);
      const modoLabel = getModoDisputaLabel(proc.modo_disputa);
      const criterioLabel = getCriterioLabel(proc.criterio_julgamento);
      const formatoLanceLabel = getFormatoLanceLabel(proc.formato_lance);
      const prazoDivulgacaoArt55 =
        category === 'OBRAS_ENGENHARIA'
          ? '10 (dez) dias úteis para serviços comuns de engenharia (ou 25/35 dias úteis conforme regime/licitação especial — Art. 55, II)'
          : proc.criterio_julgamento === 'TECNICA_E_PRECO' || proc.criterio_julgamento === 'MELHOR_TECNICA'
            ? '35 (trinta e cinco) dias úteis (Art. 55, IV)'
            : category === 'SERVICOS_CONTINUOS'
              ? '10 (dez) dias úteis para serviços comuns (Art. 55, II, "a")'
              : '8 (oito) dias úteis para aquisição de bens comuns (Art. 55, I, "a")';

      const anexos = [
        'Anexo I – Termo de Referência (TR)',
        'Anexo II – Estudo Técnico Preliminar (ETP)',
        'Anexo III – Mapa de Gerenciamento de Riscos',
        ...(proc.usar_srp ? ['Anexo IV – Minuta de Ata de Registro de Preços (ARP)'] : []),
        `${proc.usar_srp ? 'Anexo V' : 'Anexo IV'} – Minuta de Termo de Contrato Administrativo`,
        `${proc.usar_srp ? 'Anexo VI' : 'Anexo V'} – Modelo de Proposta Comercial e Declarações Conjuntas`
      ];

      const modoRegra: Record<string, string> = {
        ABERTO:
          'No modo de disputa ABERTO (Art. 56, I), a etapa de envio de lances na sessão pública durará 10 (dez) minutos e será prorrogada automaticamente pelo sistema eletrônico sempre que houver lance ofertado nos últimos 2 (dois) minutos do período de duração da sessão pública. A prorrogação automática será de 2 (dois) minutos e ocorrerá sucessivamente sempre que houver lances enviados nesse período de prorrogação, inclusive no caso de lances intermediários.',
        FECHADO:
          'No modo de disputa FECHADO (Art. 56, II), as propostas apresentadas pelos licitantes permanecerão em sigilo absoluto até a data e hora designadas para sua divulgação eletrônica, sem etapa aberta de lances sucessivos.',
        ABERTO_FECHADO:
          'No modo de disputa ABERTO E FECHADO (Art. 56, I e II), a etapa de envio de lances terá duração inicial de 15 (quinze) minutos, encerrando-se com encaminhamento de aviso de fechamento iminente e transcurso de período aleatório de até 10 (dez) minutos, seguido da abertura de etapa fechada com duração de até 5 (cinco) minutos para o autor da oferta de menor valor e os autores das ofertas com preços até 10% (dez por cento) superiores ofertarem um lance final e fechado em sigilo.',
        FECHADO_ABERTO:
          'No modo de disputa FECHADO E ABERTO (Art. 56, I e II), iniciar-se-á com propostas fechadas classificando para a etapa aberta o licitante que apresentou a proposta mais vantajosa e aqueles com propostas até 10% (dez por cento) superiores àquela, seguindo-se a disputa aberta de 10 (dez) minutos com prorrogações automáticas sucessivas de 2 (dois) minutos.',
        NAO_APLICAVEL:
          'Procedimento conduzido sob rito de Contratação Direta (Art. 72 da Lei nº 14.133/2021), observando divulgação de aviso eletrônico no PNCP e sítio oficial pelo prazo mínimo de 3 (três) dias úteis para obtenção de propostas adicionais mais vantajosas, quando aplicável (Art. 75, § 3º).'
      };

      const titleDoc = direct
        ? `9. AVISO DE CONTRATAÇÃO DIRETA — ${modalidadeLabel.toUpperCase()} Nº ___/${anoAtual}`
        : `9. EDITAL DE ${modalidadeLabel.toUpperCase()} Nº ___/${anoAtual}`;
      const isPresencial =
        proc.modalidade === 'PREGAO_PRESENCIAL' || proc.modalidade === 'CONCORRENCIA_PRESENCIAL';

      const chapters: { title: string; body: string }[] = [
        {
          title: 'PREÂMBULO OFICIAL',
          body: `
            <p>O(A) <strong>${bind('orgao_razao_social', inst.razao_social)}</strong>, inscrito(a) no CNPJ nº <strong>${bind('orgao_cnpj', formatCnpj(inst.cnpj))}</strong>, com sede à ${bind('orgao_endereco', `${inst.endereco_completo} — CEP ${inst.cep} — ${municipioUf}`)}, por intermédio da <strong>${bind('secretaria_nome', secNome)}</strong> e de seu(sua) Agente de Contratação/Pregoeiro(a), torna público que realizará licitação/procedimento administrativo conforme especificado abaixo:</p>
            <table class="meta-table">
              <tbody>
                <tr><td><strong>Processo Administrativo / Licitatório</strong></td><td>Adm. nº ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} | Licitatório nº ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}</td></tr>
                <tr><td><strong>Modalidade / Regime</strong></td><td>${bind('modalidade_label', modalidadeLabel)} | SRP: ${bind('srp_status', proc.usar_srp ? 'SIM (Arts. 82 a 86)' : 'NÃO')}</td></tr>
                <tr><td><strong>Modo de Disputa</strong></td><td>${bind('modo_disputa_label', modoLabel)}</td></tr>
                <tr><td><strong>Critério de Julgamento</strong></td><td>${bind('criterio_julgamento_label', criterioLabel)} (${bind('formato_lance_label', formatoLanceLabel)})</td></tr>
                <tr><td><strong>${isPresencial ? 'Local da Sessão Pública Presencial' : 'Endereço Eletrônico da Sessão'}</strong></td><td>${
                  isPresencial
                    ? `Sede Administrativa do Órgão — ${escapeHtml(inst.endereco_completo)} (gravação integral em áudio e vídeo — Art. 17, § 5º; divulgação no PNCP e em ${escapeHtml(inst.portal_transparencia_url || 'Portal Oficial')})`
                    : escapeHtml(inst.portal_transparencia_url || 'Portal Nacional de Contratações Públicas (PNCP) / Plataforma de Compras Eletrônicas Oficial')
                }</td></tr>
                <tr><td><strong>Data e Hora de Abertura / Disputa</strong></td><td>${bind('sessao_publica_data_hora', sessaoPublicaLabel)} (observado prazo mínimo legal de divulgação de ${escapeHtml(prazoDivulgacaoArt55)})</td></tr>
                <tr><td><strong>Regime Legal Aplicável</strong></td><td>Lei Federal nº 14.133, de 1º de abril de 2021; Lei Complementar nº 123/2006 (ME/EPP); e regulamentação municipal vigente.</td></tr>
              </tbody>
            </table>`
        },
        {
          title: 'DO OBJETO',
          body: `
            <p>O objeto da presente ${direct ? 'contratação direta' : 'licitação'} é: <strong>${escapeHtml(objetoConsolidado)}</strong>, conforme condições, quantidades, códigos CATMAT/CATSER e exigências técnicas estabelecidas no <strong>Termo de Referência (Anexo I)</strong> e na Pesquisa de Preços (Art. 23).</p>
            ${renderItemsTableHtml(baseItems, trProfile.catalogType)}
            <p>O procedimento será processado em critério <strong>${bind('formato_lance_label', formatoLanceLabel)}</strong>, sob a modalidade <strong>${bind('modalidade_label', modalidadeLabel)}</strong>, sendo o valor máximo global estimado da contratação de <strong>${formatCurrencyBRL(totalValor)}</strong>.</p>`
        },
        ...(proc.usar_srp
          ? [
              {
                title: 'DO REGISTRO DE PREÇOS (ARTS. 82 A 86 DA LEI Nº 14.133/2021)',
                body: `
                  <p>As regras referentes ao Órgão Gerenciador (<strong>${bind('orgao_razao_social', inst.razao_social)}</strong>), aos Órgãos Participantes, ao Cadastro de Reserva, à validade de 1 (um) ano prorrogável por igual período (Art. 84), à revisão/atualização de preços e aos limites de adesão por órgãos não participantes ("carona": 50% individual e dobro global — Art. 86, §§ 4º e 5º) constam expressamente da <strong>Minuta da Ata de Registro de Preços (Anexo IV)</strong>.</p>`
              }
            ]
          : []),
        {
          title: 'DA PARTICIPAÇÃO, CREDENCIAMENTO E VEDAÇÕES (LC 123/2006 E ART. 14)',
          body: `
            <p><strong>Forma de Sessão e Credenciamento (${escapeHtml(modalityGuidance.baseRegime)}):</strong> ${escapeHtml(modalityGuidance.formaSessao)} ${escapeHtml(modalityGuidance.credenRegra)}</p>
            <p><strong>Tratamento Diferenciado ME/EPP (LC nº 123/2006 e Art. 4º da Lei nº 14.133/2021):</strong> Será assegurado às Microempresas e Empresas de Pequeno Porte o direito de preferência no empate ficto (diferença de até 5% no Pregão e 10% nas demais modalidades), regularidade fiscal e trabalhista tardia (5 dias úteis prorrogáveis por igual período) e cota reservada/exclusividade quando aplicável, respeitado o teto anual de enquadramento como EPP (Art. 4º, §§ 1º e 2º).</p>
            <p><strong>Vedações Legais de Participação (Art. 14 da Lei nº 14.133/2021):</strong> Não poderão disputar este certame nem executar o contrato, direta ou indiretamente:</p>
            <ul>
              <li><strong>Incisos I e II (Conflito Técnico):</strong> Autor do anteprojeto, projeto básico ou Termo de Referência, bem como empresa responsável pela elaboração do projeto ou cujo dirigente/sócio seja autor;</li>
              <li><strong>Inciso III (Idoneidade):</strong> Pessoa física ou jurídica impossibilitada de licitar e contratar por sanção vigente (Art. 156, III e IV);</li>
              <li><strong>Inciso IV (Parentesco e Vínculo Funcional):</strong> Aquele que mantenha vínculo técnico, comercial, econômico, financeiro, trabalhista ou civil com dirigente do órgão ou agente atuante na licitação/fiscalização, ou que deles seja cônjuge, companheiro ou parente até o 3º grau;</li>
              <li><strong>Incisos V e VI (Controle Societário e Trabalho Digno):</strong> Empresas controladoras, controladas ou coligadas concorrendo entre si, e condenados judicialmente por exploração de trabalho infantil, trabalho análogo ao de escravo ou contratação irregular de adolescentes.</li>
            </ul>`
        },
        {
          title: 'DA APRESENTAÇÃO DA PROPOSTA E DOS DOCUMENTOS DE HABILITAÇÃO (ARTS. 17 E 63)',
          body: `
            <p><strong>Ordem das Fases (Art. 17):</strong> ${direct ? 'No procedimento de Contratação Direta (Art. 72), verifica-se a compatibilidade da proposta com os preços estimados e exige-se do proponente selecionado a documentação completa de habilitação (Arts. 62 a 68 e 72, V).' : 'Na presente licitação, a fase de julgamento das propostas e lances <strong>antecederá</strong> a fase de habilitação (salvo inversão motivada na forma do Art. 17, § 1º), sendo os documentos de habilitação exigidos apenas do licitante provisoriamente classificado em primeiro lugar (Art. 63, II), após o encerramento da etapa competitiva e negociação.'}</p>
            <p><strong>Declarações Unificadas Obrigatórias (Art. 63 e Art. 68, VI):</strong> No cadastramento/apresentação da proposta inicial, o licitante declarará expressamente sob as penas da lei:</p>
            <ul>
              <li><strong>Ciência e Habilitação (Art. 63, I):</strong> Plena concordância com as condições do Edital e cumprimento dos requisitos de habilitação, bem como inexistência de fatos impeditivos;</li>
              <li><strong>Proibição de Trabalho Infantil (Art. 7º, XXXIII CF/88 e Art. 68, VI):</strong> Não emprego de menor de 18 anos em trabalho noturno, perigoso ou insalubre nem menor de 16 anos, salvo aprendiz a partir de 14 anos;</li>
              <li><strong>Reserva Legal de Cargos (Art. 63, IV):</strong> Cumprimento integral das exigências de reserva de cargos para pessoa com deficiência (PcD), reabilitado da Previdência Social e aprendiz;</li>
              <li><strong>Integralidade Econômica da Proposta (Art. 63, § 1º):</strong> Cobertura de todos os custos diretos, indiretos e direitos trabalhistas constitucionais e convencionais vigentes.</li>
            </ul>`
        },
        {
          title: 'DO PREENCHIMENTO DA PROPOSTA',
          body: `
            <p>${
              isPresencial
                ? 'O licitante deverá apresentar sua proposta comercial escrita em envelope lacrado e rubricado, indicando o valor unitário/global (ou percentual de desconto) com até 2 (duas) casas decimais para cada item/lote de interesse, marca/modelo/fabricante quando aplicável ao fornecimento de bens, observando prazo de validade da proposta não inferior a <strong>60 (sessenta) dias</strong>.'
                : 'O licitante deverá registrar sua proposta mediante preenchimento eletrônico do valor unitário/global (ou percentual de desconto) com até 2 (duas) casas decimais para cada item/lote de interesse, marca/modelo/fabricante quando aplicável ao fornecimento de bens (sem qualquer identificação do proponente antes da fase de lances), observando prazo de validade da proposta não inferior a <strong>60 (sessenta) dias</strong>.'
            }</p>`
        },
        {
          title: 'DA ABERTURA DA SESSÃO, CLASSIFICAÇÃO E FORMULAÇÃO DE LANCES (ARTS. 56, 60 E 61)',
          body: `
            <p><strong>Operação da Modalidade e Modo de Disputa (${escapeHtml(modalidadeLabel)} / ${escapeHtml(modoLabel)}):</strong> ${escapeHtml(modalityGuidance.disputaResumo)} ${escapeHtml(modoRegra[proc.modo_disputa] || modoRegra.ABERTO)}</p>
            <p><strong>Critérios de Desempate em Cascata (Art. 60 da Lei nº 14.133/2021):</strong> Após eventual aplicação do empate ficto da LC nº 123/2006, em caso de empate entre duas ou mais propostas serão utilizados sucessivamente os critérios do Art. 60: I – disputa final, hipótese em que os licitantes empatados poderão apresentar nova proposta em ato contínuo à classificação; II – avaliação do desempenho contratual prévio dos licitantes (registros cadastrais/PNCP); III – desenvolvimento pelo licitante de ações de equidade entre homens e mulheres no ambiente de trabalho; IV – desenvolvimento pelo licitante de programa de integridade. Em igualdade de condições sem desempate, assegura-se preferência sucessiva aos critérios do Art. 60, § 1º (I – empresas no território do Estado do órgão; II – empresas brasileiras; III – empresas que invistam em pesquisa e desenvolvimento de tecnologia no País; IV – empresas que comprovem práticas de mitigação climática) e, persistindo o empate, sorteio público em sessão.</p>
            <p><strong>Negociação com o Primeiro Colocado (Art. 61):</strong> Definido o resultado do julgamento, o Agente de Contratação/Pregoeiro negociará obrigatoriamente condições mais vantajosas com o primeiro colocado ${
              isPresencial
                ? 'por meio de registro direto na ata da sessão pública presencial'
                : 'por meio do sistema eletrônico'
            }, inclusive quando a proposta permaneça abaixo do orçamento estimado, devendo a negociação ser franqueada aos demais licitantes quando frustrada com o primeiro colocado segundo a ordem de classificação.</p>`
        },
        {
          title: 'DA FASE DE JULGAMENTO E EXEQUIBILIDADE (ART. 59)',
          body: `
            <p>Encerrada a negociação, o Agente de Contratação verificará previamente o eventual descumprimento das condições de participação, especialmente quanto à existência de sanção impeditiva mediante <strong>consulta consolidada de idoneidade</strong> nos cadastros oficiais: <strong>TCU (Cadastro de Inidôneos), CNJ (Cadastro Nacional de Condenações Cíveis por Ato de Improbidade Administrativa), CEIS (Cadastro Nacional de Empresas Inidôneas e Suspensas) e CNEP (Cadastro Nacional de Empresas Punidas)</strong>.</p>
            <p>Superada a verificação prévia, examinar-se-á a proposta classificada em primeiro lugar quanto à adequação ao objeto, compatibilidade do preço com o orçamento estimado (Art. 23) e exequibilidade nos termos do <strong>Art. 59 da Lei nº 14.133/2021</strong> (desclassificando-se propostas que contiverem vícios insanáveis, não obedecerem às especificações técnicas do TR, apresentarem preços inexequíveis ou acima do orçamento estimado). Constatados indícios de inexequibilidade (ex.: descontos excessivos ou inferioridade a 75% do valor orçado em obras e serviços de engenharia — Art. 59, § 4º), será realizada <strong>diligência formal (Art. 59, § 2º)</strong> oportunizando ao licitante demonstrar a viabilidade econômica de sua proposta mediante planilha de composição de custos.</p>`
        },
        {
          title: 'DA FASE DE HABILITAÇÃO (ARTS. 62 A 70)',
          body: `
            <p>Os documentos exigidos para habilitação do licitante vencedor restringem-se estritamente aos previstos nos <strong>Arts. 62 a 70 da Lei nº 14.133/2021</strong> e alinhados ao Termo de Referência (Anexo I), <strong>vedada qualquer exigência excessiva, impertinente ou restritiva à ampla competitividade</strong>:</p>
            <ul>
              <li><strong>Habilitação Jurídica (Art. 66):</strong> Ato constitutivo, estatuto ou contrato social consolidado vigente e documentos pessoais dos representantes legais.</li>
              <li><strong>Habilitação Fiscal, Social e Trabalhista (Art. 68):</strong> CNPJ, CND Federal/PGFN, regularidade Estadual e Municipal, CRF/FGTS e CNDT.</li>
              <li><strong>Habilitação Econômico-Financeira (Art. 69):</strong> Certidão negativa de feitos sobre falência e Balanço Patrimonial dos 2 (dois) últimos exercícios sociais (Art. 69, I). ${escapeHtml(deepSpec.indicesContabeisArt69)}</li>
              <li><strong>Qualificação Técnica (Art. 67 e Súmula nº 263/TCU):</strong> ${escapeHtml(trProfile.qualificacaoTecnicaArt67)} Consideram-se parcelas de maior relevância aquelas com valor individual igual ou superior a <strong>4% (quatro por cento)</strong> do valor total estimado, vedada a exigência de quantitativo mínimo superior a 50% (Art. 67, §§ 1º e 2º).</li>
            </ul>
            <p><strong>Saneamento e Diligência Documental (Art. 64 e Acórdão nº 1.211/2021-TCU):</strong> Após a entrega dos documentos de habilitação, não será permitida a substituição ou apresentação de documentos novos, salvo em sede de diligência para complementação de informações acerca de documentos já apresentados ou para juntada de documento ausente que apenas ateste condição pré-existente à abertura da sessão pública, bem como para atualização de certidões vencidas após a apresentação da proposta.</p>`
        },
        {
          title: 'DOS RECURSOS ADMINISTRATIVOS (ART. 165)',
          body: `
            <p>Declarado o vencedor após o julgamento e a habilitação (ou inabilitação), qualquer licitante poderá, ${
              isPresencial
                ? 'verbalmente na própria sessão pública presencial, com registro imediato em ata e na gravação em áudio e vídeo,'
                : 'em campo próprio do sistema eletrônico e de forma <strong>imediata</strong> (no prazo mínimo regulamentar fixado na sessão pública, sob pena de preclusão),'
            } manifestar sua <strong>intenção de recorrer</strong> (Art. 165, § 1º, I).</p>
            <p>As razões do recurso deverão ser apresentadas em <strong>prazo único de 3 (três) dias úteis</strong> contados da data de intimação ou lavratura da ata (Art. 165, I), ficando os demais licitantes intimados para apresentar contrarrazões em igual prazo de 3 (três) dias úteis, com efeito suspensivo automático do ato recorrido até decisão motivada (Art. 168).</p>`
        },
        {
          title: 'DAS INFRAÇÕES ADMINISTRATIVAS E SANÇÕES (ARTS. 155 A 163)',
          body: `
            <p>Comete infração administrativa nos termos do <strong>Art. 155 da Lei nº 14.133/2021</strong> o licitante ou contratado que deixar de entregar documentação exigida, não mantiver a proposta, recusar-se a assinar o instrumento contratual/ARP no prazo estabelecido, fraudar a licitação ou comportar-se de modo inidôneo, sujeitando-se às sanções do <strong>Art. 156</strong>: I – Advertência; II – Multa (0,5% a 30% do valor do contrato licitado); III – Impedimento de licitar e contratar (até 3 anos); e IV – Declaração de inidoneidade (3 a 6 anos), assegurado o devido processo legal com defesa prévia e recurso de 15 (quinze) dias úteis (Arts. 157, 158 e 166).</p>`
        },
        {
          title: 'DA IMPUGNAÇÃO AO EDITAL E DO PEDIDO DE ESCLARECIMENTO (ART. 164)',
          body: `
            <p>Qualquer pessoa é parte legítima para impugnar este Edital por irregularidade na aplicação da Lei nº 14.133/2021 ou para solicitar esclarecimento sobre seus termos, devendo protocolar o pedido até <strong>3 (três) dias úteis antes da data de abertura do certame</strong> (Art. 164, caput).</p>
            <p>A resposta à impugnação ou ao pedido de esclarecimento será divulgada em sítio eletrônico oficial no prazo de até <strong>3 (três) dias úteis</strong>, limitado ao último dia útil anterior à data da abertura do certame (Art. 164, parágrafo único). Acolhida a impugnação contra o Edital, será definida e publicada nova data para realização do certame se a alteração afetar a formulação das propostas (Art. 55, § 1º).</p>`
        },
        {
          title: 'DAS DISPOSIÇÕES GERAIS, HOMOLOGAÇÃO E RELAÇÃO DE ANEXOS (ART. 71)',
          body: `
            <p>Encerradas as fases de julgamento e habilitação, e exauridos os recursos administrativos, o processo licitatório será encaminhado à autoridade superior, que poderá determinar o retorno dos autos para saneamento de irregularidades, revogar a licitação por motivo de conveniência e oportunidade superveniente, proceder à anulação de ofício por ilegalidade insanável, ou <strong>adjudicar o objeto e homologar a licitação</strong> (Art. 71). Aplicam-se as normas de contagem de prazos em dias úteis do Art. 183 e a divulgação obrigatória integral no PNCP (Art. 54). Fica eleito o Foro da Comarca de <strong>${bind('orgao_comarca', comarca)}</strong> para dirimir controvérsias.</p>
            <p><strong>Relação de Anexos Integrantes:</strong></p>
            <ul>
              ${anexos.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
            </ul>
            <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
            <p>_________________________________________________________<br/>
            <strong>${bind('ordenador_nome', ordenadorNome)}</strong> — ${bind('ordenador_cargo', ordenadorCargo)}<br/>
            <strong>Agente de Contratação / Pregoeiro(a) — ${bind('orgao_razao_social', inst.razao_social)}</strong></p>`
        }
      ];

      const chaptersHtml = chapters
        .map((ch, idx) => `<h3>${idx + 1}. ${ch.title}</h3>${ch.body}`)
        .join('\n');

      const html = `
        <h2>${escapeHtml(titleDoc)}</h2>
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva do Instrumento Convocatório (Arts. 25 e 55)',
          `${escapeHtml(modalidadeLabel)} &bull; Modo <strong>${escapeHtml(modoLabel)}</strong> &bull; Sessão Pública: <strong>${escapeHtml(sessaoPublicaLabel)}</strong> (prazo mínimo Art. 55: ${escapeHtml(prazoDivulgacaoArt55)}) &bull; Valor Referencial: <strong>${formatCurrencyBRL(totalValor)}</strong>. ${escapeHtml(priceAnalytics.summaryText)}`
        )}
        ${feedbackCallout(feedback)}
        ${chaptersHtml}
      `.trim();

      return {
        structured_json: {
          numero_edital: proc.numero_processo_licitatorio,
          ano_exercicio: anoAtual,
          tipo_instrumento: direct ? 'Aviso de Contratação Direta' : `Edital de ${modalidadeLabel}`,
          modalidade: proc.modalidade,
          modo_disputa: proc.modo_disputa,
          criterio_julgamento: proc.criterio_julgamento,
          formato_lance: proc.formato_lance,
          usar_srp: proc.usar_srp,
          objeto: objetoConsolidado,
          valor_maximo_estimado: totalValor,
          total_capitulos: chapters.length,
          prazo_divulgacao_art55: prazoDivulgacaoArt55,
          prazo_impugnacao_dias_uteis: 3,
          prazo_recurso_dias_uteis: 3,
          anexos,
          feedback_incorporado: feedback || null
        },
        html_content: html,
        legal_alerts: certameAlerts
      };
    }

    // ========================================================
    // AGENTE 10: PARECER JURÍDICO — CONTROLE PRÉVIO (ART. 53)
    // ========================================================
    case 10: {
      return buildAgent10ParecerJuridico({
        proc,
        inst,
        secNome,
        dot,
        dotLinha,
        municipioUf,
        todayBR,
        category,
        certameAlerts,
        piecesByNumber,
        totalValor,
        objetoConsolidado,
        feedback
      });
    }

    // ========================================================
    // AGENTE 11: COMPILADOR DE DOSSIÊ E AUTORIZAÇÃO FINAL
    // ========================================================
    case 11:
    default: {
      const parecerPiece = piecesByNumber.get(10);
      const parecerStatus = parecerPiece?.structured_json?.conclusao || 'PENDENTE';
      const parecerNumero =
        parecerPiece?.structured_json?.numero_parecer || `PJ-${proc.numero_processo_licitatorio}`;
      const parecerRessalvas = Array.isArray(parecerPiece?.structured_json?.ressalvas)
        ? (parecerPiece!.structured_json.ressalvas as string[])
        : [];
      const modalidadeLabel = getModalidadeLabel(proc.modalidade);
      const modoLabel = getModoDisputaLabel(proc.modo_disputa);
      const criterioLabel = getCriterioLabel(proc.criterio_julgamento);
      const formatoLabel = getFormatoLanceLabel(proc.formato_lance);

      const provenanceList = extractPieceProvenance(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
          .map((n) => piecesByNumber.get(n))
          .filter((p): p is AgentPiece => Boolean(p)),
        auditLogs
      );

      const pieceSummaryRows = provenanceList.map((prov) => ({
        ordem: prov.numero,
        titulo: prov.nome_peca,
        legal_basis: prov.legal_basis,
        status: prov.numero === 11 ? 'EMISSÃO FINAL / ATUAL' : prov.status,
        versao: prov.numero === 11 ? Math.max(1, prov.versao_atual) : prov.versao_atual,
        usuario_criador: prov.usuario_criador,
        data_hora_geracao: formatDateTimeBR(prov.data_hora_geracao),
        edicoes_realizadas: prov.edicoes_realizadas.length,
        aprovado_por:
          prov.usuario_aprovador ||
          (prov.numero === 11 ? 'Submetido à Autoridade Competente' : 'Aguardando assinatura'),
        aprovado_em: prov.timestamp_aprovacao ? formatDateTimeBR(prov.timestamp_aprovacao) : '—',
        hash: prov.content_hash ? prov.content_hash.slice(0, 16) : '—'
      }));

      const indiceRowsHtml = pieceSummaryRows
        .map(
          (r) => `
          <tr>
            <td>${String(r.ordem).padStart(2, '0')}</td>
            <td>${escapeHtml(r.titulo)}</td>
            <td>${escapeHtml(r.legal_basis)}</td>
            <td>v${r.versao} (${escapeHtml(r.status)})</td>
            <td>${escapeHtml(r.aprovado_por)}</td>
            <td>${escapeHtml(r.aprovado_em)}</td>
          </tr>`
        )
        .join('');

      const provenanceRowsHtml = pieceSummaryRows
        .map(
          (r) => `
          <tr>
            <td>${String(r.ordem).padStart(2, '0')} — ${escapeHtml(r.titulo)}</td>
            <td>${escapeHtml(r.usuario_criador)}<br/><small>${escapeHtml(r.data_hora_geracao)}</small></td>
            <td>v${r.versao} (${r.edicoes_realizadas} edição(ões) manual/rest.)</td>
            <td>${escapeHtml(r.aprovado_por)}<br/><small>${escapeHtml(r.aprovado_em)}</small></td>
            <td><code>${escapeHtml(r.hash)}</code></td>
          </tr>`
        )
        .join('');

      const auditRowsHtml = auditLogs
        .slice(0, 25)
        .map(
          (l) => `
          <tr>
            <td>${escapeHtml(formatDateTimeBR(l.created_at))}</td>
            <td>${escapeHtml(l.action)}</td>
            <td>${escapeHtml(l.actor_name)} (${escapeHtml(l.actor_role)})</td>
            <td>${escapeHtml(l.details)}</td>
          </tr>`
        )
        .join('');

      const logoBlockHtml =
        inst.logo_data_url && inst.logo_data_url.startsWith('data:image/')
          ? `<img src="${escapeHtml(inst.logo_data_url)}" alt="Brasão Oficial" style="height:96px;width:auto;max-width:200px;object-fit:contain;" />`
          : '<strong>[BRASÃO OFICIAL DO MUNICÍPIO]</strong>';

      const atendimentoJuridicoTexto =
        parecerRessalvas.length > 0
          ? `Atesto o integral exame e atendimento das recomendações jurídicas apontadas no Parecer Jurídico nº ${escapeHtml(String(parecerNumero))} (Art. 53, § 3º), nos moldes das justificativas e correções acostadas aos autos.`
          : `Atesto a plena conformidade da instrução processual em consonância com o Parecer Jurídico nº ${escapeHtml(String(parecerNumero))} (Art. 53, § 3º), sem pendências impeditivas à publicação.`;

      const totalPecasAprovadas = pieceSummaryRows.filter((r) => r.status === 'APROVADO').length;
      const totalEdicoes = pieceSummaryRows.reduce((acc, r) => acc + r.edicoes_realizadas, 0);

      const quadroSinteseExecutivoHtml = renderStructuredTableHtml(
        ['Parâmetro do Certame Autorizado', 'Especificação Consolidada nos Autos'],
        [
          [{ label: 'Objeto Licitado', strong: true }, objetoConsolidado],
          [{ label: 'Modalidade / Regime', strong: true }, `${modalidadeLabel} — ${proc.usar_srp ? 'Sistema de Registro de Preços (SRP — Arts. 82 a 86)' : 'Contratação Ordinária'}`],
          [{ label: 'Data / Horário da Sessão', strong: true }, sessaoPublicaLabel],
          [{ label: 'Modo de Disputa / Critério', strong: true }, `${modoLabel} | ${criterioLabel} (${formatoLabel})`],
          [{ label: 'Quantidade / Valor Global Estimado', strong: true }, `${baseItems.length} item(ns) consolidado(s) — ${formatCurrencyBRL(totalValor)}`],
          [{ label: 'Base da Pesquisa de Preços (Art. 23)', strong: true }, proc.pesquisa_preco_arquivo ? `Anexo: ${proc.pesquisa_preco_arquivo} — ${pesquisaFonteResumo}` : pesquisaFonteResumo],
          [
            { label: 'Previsão Orçamentária / Financeira', strong: true },
            proc.usar_srp
              ? `Dispensado bloqueio prévio até a contratação (Art. 17 do Decreto nº 11.462/2023). Ref.: ${dotLinha}`
              : `${dotLinha} (Compatibilidade LOA/LDO/PPA declarada — Art. 150)`
          ],
          [{ label: 'Controle Prévio de Legalidade (Art. 53)', strong: true }, `${String(parecerNumero)} — ${parecerPiece?.structured_json?.conclusao_label || 'Parecer Jurídico Emitido'}`]
        ]
      );

      const governancaKpiHtml = renderStructuredTableHtml(
        ['Peças Indexadas', 'Peças Aprovadas nos Autos', 'Total de Edições/Revisões', 'Eventos de Auditoria Logados', 'Conformidade Documental'],
        [
          [
            { label: `${pieceSummaryRows.length} peças (01 a 11)`, strong: true },
            `${totalPecasAprovadas} de ${pieceSummaryRows.length}`,
            `${totalEdicoes} alteração(ões)`,
            `${auditLogs.length} registro(s)`,
            'Integridade SHA-256 e Segregação Art. 7º, § 1º'
          ]
        ]
      );

      const html = `
        <h2>11. FECHAMENTO DO DOSSIÊ — AUTORIZAÇÃO FINAL E AUDITORIA PROCESSUAL</h2>
        ${renderExecutiveCalloutHtml(
          'Síntese Executiva de Governança e Fechamento (Art. 72, VIII e Art. 53, § 3º)',
          `Dossiê consolidado com <strong>${pieceSummaryRows.length} peças</strong> (${totalPecasAprovadas} formalmente aprovadas, ${auditLogs.length} eventos em trilha de auditoria), Parecer Jurídico <strong>${escapeHtml(String(parecerNumero))}</strong> e abertura autorizada sob a modalidade <strong>${escapeHtml(modalidadeLabel)}</strong> (${formatCurrencyBRL(totalValor)}).`
        )}
        ${feedbackCallout(feedback)}

        <h3>BLOCO A: TERMO DE AUTORIZAÇÃO DE ABERTURA DE LICITAÇÃO</h3>
        <table class="meta-table">
          <tbody>
            <tr>
              <td style="width:210px;text-align:center;vertical-align:middle;">${logoBlockHtml}</td>
              <td>
                <strong>${bind('orgao_razao_social', inst.razao_social)}</strong> — CNPJ nº ${bind('orgao_cnpj', formatCnpj(inst.cnpj))}<br/>
                <strong>Processo Administrativo nº:</strong> ${bind('numero_processo_administrativo', proc.numero_processo_administrativo)} | <strong>Processo Licitatório nº:</strong> ${bind('numero_processo_licitatorio', proc.numero_processo_licitatorio)}<br/>
                <strong>Secretaria Requisitante:</strong> ${bind('secretaria_nome', secNome)} | <strong>Parecer Jurídico:</strong> ${escapeHtml(String(parecerNumero))} (${escapeHtml(parecerPiece?.structured_json?.conclusao_label || 'Emitido')})
              </td>
            </tr>
          </tbody>
        </table>

        <h4>Quadro Síntese Executivo do Certame Autorizado</h4>
        ${quadroSinteseExecutivoHtml}

        <h4>Despacho Decisório da Autoridade Competente (Art. 72, VIII e Art. 53, § 3º da Lei nº 14.133/2021)</h4>
        <p>No exercício das competências administrativas conferidas pela legislação municipal vigente, na qualidade de <strong>Autoridade Competente / Ordenador(a) de Despesas</strong> (${bind('ordenador_nome', ordenadorNome)} — ${bind('ordenador_cargo', ordenadorCargo)} / Exmo(a). ${prefeitoSpan.inlinePreambuloHtml}), <strong>DECLARO</strong> que analisei integralmente a instrução processual da fase preparatória deste feito (Exposição de Demanda, DFD, ETP, Mapa de Gerenciamento de Riscos, Termo de Referência, Termo de Autuação, Minuta de Contrato${proc.usar_srp ? ', Minuta de ARP' : ''}, Minuta do Edital/Aviso e Parecer Jurídico prévio).</p>
        <p>${atendimentoJuridicoTexto}</p>
        <p>Diante da regularidade formal e do interesse público devidamente demonstrado, <strong>AUTORIZO</strong> expressamente a abertura da fase externa do procedimento sob a modalidade <strong>${bind('modalidade_label', modalidadeLabel)}</strong>, modo de disputa <strong>${bind('modo_disputa_label', modoLabel)}</strong>, critério de julgamento <strong>${bind('criterio_julgamento_label', criterioLabel)}</strong> (${bind('formato_lance_label', formatoLabel)}), tendo por objeto: <strong>${escapeHtml(objetoConsolidado)}</strong>, no valor global estimado de <strong>${formatCurrencyBRL(totalValor)}</strong>, determinando a publicação integral do Edital/Aviso e anexos no <strong>Portal Nacional de Contratações Públicas (PNCP)</strong> e no <strong>Diário Oficial do Município</strong>, observando os prazos mínimos do Art. 55, na forma do <strong>Art. 54 e Art. 72, inciso VIII, da Lei nº 14.133/2021</strong>.</p>
        <p><strong>Diretriz Formal de Designação de Agentes e Fiscalização (Arts. 7º, 8º e 117):</strong> Determino a atuação do(a) Agente de Contratação/Pregoeiro(a) e Equipe de Apoio regularmente designados em Portaria Municipal para condução da fase externa, bem como a designação tempestiva e segregada de Gestor do Contrato, Fiscal Técnico e Fiscal Administrativo previamente à emissão da Ordem de Fornecimento/Serviço, em estrita observância ao princípio da segregação de funções (Art. 7º, § 1º).</p>

        <p>${bind('orgao_municipio_uf', municipioUf)}, ${todayBR}.</p>
        <table>
          <thead>
            <tr>
              <th>Autoridade Competente / Ordenador(a) de Despesas</th>
              <th>Chefe do Poder Executivo Municipal</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>_________________________________<br/><strong>${bind('ordenador_nome', ordenadorNome)}</strong><br/>${bind('ordenador_cargo', ordenadorCargo)} — ${bind('ordenador_portaria', ordenadorPortaria)}</td>
              <td>_________________________________<br/><strong>${bind('prefeito_nome', prefeitoSpan.displayName)}</strong><br/>${escapeHtml(prefeitoSpan.roleForSignature)} — ${bind('orgao_razao_social', inst.razao_social)}</td>
            </tr>
          </tbody>
        </table>

        <h3>BLOCO B: RELATÓRIO DE TRILHA DE AUDITORIA E ÍNDICE DO DOSSIÊ</h3>

        <h4>1. Sumário Executivo de Governança e Integridade Documental</h4>
        ${governancaKpiHtml}

        <h4>2. Índice Consolidado do Processo (11 Peças em Ordem Cronológica e Processual)</h4>
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th>Título do Documento</th>
              <th>Fundamentação Legal</th>
              <th>Versão / Status</th>
              <th>Signatário</th>
              <th>Data/Hora Assinatura</th>
            </tr>
          </thead>
          <tbody>
            ${indiceRowsHtml}
          </tbody>
        </table>

        <h4>3. Relatório de Rastreabilidade e Governança — Segregação de Funções (Art. 7º, § 1º da Lei nº 14.133/2021)</h4>
        <p>A matriz abaixo comprova integralmente a autoria de geração, o histórico de revisões/edições e a aprovação formal de cada peça constante nos autos digitais, assegurando transparência, auditabilidade e o princípio da <strong>Segregação de Funções (Art. 7º, § 1º da Lei nº 14.133/2021)</strong>:</p>
        <table>
          <thead>
            <tr>
              <th>Peça Processual</th>
              <th>Usuário Criador / Geração</th>
              <th>Versões e Edições Realizadas</th>
              <th>Usuário Aprovador / Timestamp</th>
              <th>Hash SHA-256</th>
            </tr>
          </thead>
          <tbody>
            ${provenanceRowsHtml}
          </tbody>
        </table>

        <h4>4. Trilha Cronológica Detalhada de Logs do Banco de Dados</h4>
        <table>
          <thead>
            <tr>
              <th>Data / Hora</th>
              <th>Evento</th>
              <th>Agente / Responsável</th>
              <th>Detalhamento</th>
            </tr>
          </thead>
          <tbody>
            ${auditRowsHtml || '<tr><td colspan="4">Eventos registrados no log do sistema.</td></tr>'}
          </tbody>
        </table>
      `.trim();

      const alerts: LegalAlert[] = [];
      if (parecerStatus === 'REPROVADO_SANEAMENTO') {
        alerts.push({
          id: 'ag11-parecer-reprovado',
          severity: 'critical',
          article: 'Art. 53 da Lei nº 14.133/2021',
          title: 'Parecer Jurídico aponta necessidade de saneamento prévio',
          message: 'Resolva os apontamentos do Agente 10 antes de assinar a autorização definitiva da fase externa.'
        });
      } else {
        alerts.push({
          id: 'ag11-dossie-pronto',
          severity: 'info',
          article: 'Art. 7º, § 1º, Art. 54 e Art. 72, VIII (PNCP)',
          title: 'Dossiê Auditável Pronto para Exportação Oficial',
          message: 'Bloco A (Autorização PNCP/DOM) e Bloco B (Índice das 11 peças e Trilha de Auditoria) consolidados. Utilize "Exportar PDF Consolidado" ou "Exportar Pacote DOCX/ZIP".'
        });
      }

      return {
        structured_json: {
          termo_autorizacao: `AUTORIZACAO-${proc.numero_processo_licitatorio}`,
          parecer_status: parecerStatus,
          total_pecas_indexadas: pieceSummaryRows.length,
          total_pecas_aprovadas: pieceSummaryRows.filter((r) => r.status === 'APROVADO').length,
          pecas: pieceSummaryRows,
          total_logs_auditoria: auditLogs.length,
          feedback_incorporado: feedback || null
        },
        html_content: html,
        legal_alerts: alerts
      };
    }
  }
}
