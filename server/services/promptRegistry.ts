import type {
  AgentPiece,
  AuditLogEntry,
  PesquisaPrecoItem,
  ProcessBundle
} from '../../shared/types.js';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatSessaoPublicaLabel,
  getCriterioLabel,
  getFormatoLanceLabel,
  getModalidadeLabel,
  getModoDisputaLabel,
  getTipoContratacaoLabel
} from '../../shared/labels.js';
import { formatDotacoesSummary } from '../db/repository.js';
import { selectContextualTcuPrecedents } from './tcuJurisprudence.js';

export interface RuntimePromptInputs {
  estimativaPreliminar?: number;
  dataPretendida?: string;
  prioridade?: 'Baixo' | 'Médio' | 'Alto';
  pesquisaMercado?: string;
}

export interface PricePortfolioAnalytics {
  itemCount: number;
  computedTotal: number;
  effectiveTotal: number;
  topItem: {
    item: string;
    descricao: string;
    valorTotal: number;
    sharePct: number;
  } | null;
  classeACount: number;
  classeACumulativePct: number;
  classeBCount: number;
  classeCCount: number;
  dispersionRatio: number;
  summaryText: string;
}

/**
 * Formata o nome e a titulação do(a) Prefeito(a) sem duplicar "Prefeito(a) Municipal"
 * quando o cadastro institucional ainda utiliza o rótulo genérico padrão.
 */
export function formatPrefeitoRoleAndName(rawName?: string | null): {
  displayName: string;
  qualifiedTitle: string;
  isGenericPlaceholder: boolean;
} {
  const clean = (rawName || '').trim();
  const isGeneric =
    !clean ||
    /^prefeit[oa](\(a\))?(\s+municipal)?(\s+a\s+informar)?$/i.test(clean);

  if (isGeneric) {
    const display = clean || 'Prefeito(a) Municipal';
    return {
      displayName: display,
      qualifiedTitle: 'Prefeito(a) Municipal',
      isGenericPlaceholder: true
    };
  }

  const startsWithTitle = /^prefeit[oa]/i.test(clean);
  return {
    displayName: clean,
    qualifiedTitle: startsWithTitle ? clean : `Prefeito(a) Municipal ${clean}`,
    isGenericPlaceholder: false
  };
}

/**
 * Calcula análise estatística e Curva ABC (Pareto) dos itens da pesquisa de preços
 * para enriquecer tanto os prompts de IA quanto as peças determinísticas locais.
 */
export type PricePortfolioInputItem = Omit<PesquisaPrecoItem, 'item' | 'medida'> & {
  item?: number | string;
  medida?: string;
};

export function analyzePricePortfolio(
  items: PricePortfolioInputItem[],
  declaredTotal = 0
): PricePortfolioAnalytics {
  const validItems = (items || []).map((it, idx) => {
    const lineTotal =
      Number(it.valor_total) > 0
        ? Number(it.valor_total)
        : Math.max(0, Number(it.quantidade || 0) * Number(it.valor_unitario || 0));
    return {
      item: String(it.item ?? idx + 1).padStart(2, '0'),
      descricao: (it.descricao || `Item ${idx + 1}`).trim(),
      valorUnitario: Math.max(0, Number(it.valor_unitario || 0)),
      valorTotal: lineTotal
    };
  });

  const computedTotal = validItems.reduce((acc, it) => acc + it.valorTotal, 0);
  const effectiveTotal = computedTotal > 0 ? computedTotal : Math.max(0, Number(declaredTotal || 0));

  if (validItems.length === 0 || effectiveTotal <= 0) {
    return {
      itemCount: validItems.length,
      computedTotal,
      effectiveTotal,
      topItem: null,
      classeACount: 0,
      classeACumulativePct: 0,
      classeBCount: 0,
      classeCCount: 0,
      dispersionRatio: 1,
      summaryText:
        effectiveTotal > 0
          ? `Estimativa global informada de ${formatCurrencyBRL(effectiveTotal)}, sem planilha analítica detalhada importada até o momento.`
          : 'Pesquisa de preços ainda sem itens unitários estruturados; recomenda-se consolidação da cesta de preços na forma do Art. 23.'
    };
  }

  const sortedDesc = [...validItems].sort((a, b) => b.valorTotal - a.valorTotal);
  let cumulative = 0;
  let classeACount = 0;
  let classeACumulativePct = 0;
  let classeBCount = 0;
  let classeCCount = 0;

  for (const it of sortedDesc) {
    const share = (it.valorTotal / effectiveTotal) * 100;
    const prevCumPct = (cumulative / effectiveTotal) * 100;
    cumulative += it.valorTotal;
    const nextCumPct = (cumulative / effectiveTotal) * 100;

    if (prevCumPct < 80 || classeACount === 0) {
      classeACount += 1;
      classeACumulativePct = Number(Math.min(100, nextCumPct).toFixed(1));
    } else if (prevCumPct < 95) {
      classeBCount += 1;
    } else {
      classeCCount += 1;
    }
  }

  const positiveUnits = validItems.map((i) => i.valorUnitario).filter((u) => u > 0);
  const maxUnit = positiveUnits.length > 0 ? Math.max(...positiveUnits) : 0;
  const minUnit = positiveUnits.length > 0 ? Math.min(...positiveUnits) : 0;
  const dispersionRatio =
    maxUnit > 0 && minUnit > 0 ? Number((maxUnit / minUnit).toFixed(2)) : 1;

  const leader = sortedDesc[0];
  const leaderShare = Number(((leader.valorTotal / effectiveTotal) * 100).toFixed(1));
  const topItem = {
    item: leader.item,
    descricao: leader.descricao,
    valorTotal: leader.valorTotal,
    sharePct: leaderShare
  };

  const dispersionNote =
    validItems.length >= 2 && dispersionRatio >= 3
      ? ` Amplitude relevante de preços unitários (${dispersionRatio}x entre menor e maior item), reforçando julgamento por item e controle de sobrepreço individual.`
      : '';

  const summaryText = `Carteira com ${validItems.length} ${validItems.length === 1 ? 'item' : 'itens'} totalizando ${formatCurrencyBRL(effectiveTotal)}. Curva ABC (Pareto): ${classeACount} ${classeACount === 1 ? 'item concentra' : 'itens concentram'} ${classeACumulativePct.toFixed(1)}% do dispêndio (Classe A); item líder "${leader.descricao.slice(0, 70)}" representa ${leaderShare.toFixed(1)}% (${formatCurrencyBRL(leader.valorTotal)}).${dispersionNote}`;

  return {
    itemCount: validItems.length,
    computedTotal,
    effectiveTotal,
    topItem,
    classeACount,
    classeACumulativePct,
    classeBCount,
    classeCCount,
    dispersionRatio,
    summaryText
  };
}

function stripHtmlBasic(html: string): string {
  return (html || '')
    .replace(/<\/(p|h1|h2|h3|h4|li|tr|div|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizePriorPieceForPrompt(html?: string | null, fallback = '', maxChars = 2600): string {
  const plain = html ? stripHtmlBasic(html) : fallback;
  if (!plain) return fallback;
  if (plain.length <= maxChars) return plain;

  const truncated = plain.slice(0, maxChars);
  const lastBreak = Math.max(truncated.lastIndexOf('\n'), truncated.lastIndexOf('. '));
  const cut = lastBreak > maxChars * 0.6 ? truncated.slice(0, lastBreak + 1) : truncated;
  return `${cut.trim()}\n[... conteúdo complementar da peça preservado nos registros JSON ...]`;
}

export const BASE_CONTEXT_TEMPLATE = `[CONTEXTO INSTITUCIONAL E PROCESSUAL]
Órgão: {{prefeitura.razao_social}} | CNPJ: {{prefeitura.cnpj}}
Endereço: {{prefeitura.endereco_completo}} | Município/UF: {{prefeitura.municipio_uf}}
Chefia do Executivo (Prefeito/a): {{prefeitura.prefeito_qualificado}}
Processo Administrativo nº: {{certame.numero_processo_adm}}
Processo Licitatório nº: {{certame.numero_processo_licitatorio}}
Secretaria Requisitante: {{secretaria.nome}} | Ordenador(a): {{secretaria.secretario_nome}} ({{secretaria.portaria}})
Dotação Orçamentária: {{dotacao.codigo_completo}} - Fonte: {{dotacao.fonte}}
Tipo da Contratação: {{certame.tipo_contratacao}} | Data e Horário da Sessão Pública: {{certame.sessao_publica}}
Modalidade: {{certame.modalidade}} | Modo de Disputa: {{certame.modo_disputa}} | Critério de Julgamento: {{certame.criterio_julgamento}}
Formato de Lance / Adjudicação: {{certame.formato_lance}} | Sistema de Registro de Preços (SRP): {{certame.is_srp}}
Objeto Resumido Informado: {{certame.objeto_resumido}}
Servidor Requisitante: {{certame.responsavel_requisitante}} ({{certame.cargo_requisitante}})
Pesquisa de Preço Anexada: {{pesquisa_preco.arquivo}} | Valor Global Apurado: {{pesquisa_preco.valor_total}}
Análise Analítica da Cesta de Preços (Curva ABC): {{pesquisa_preco.analise_abc}}
Itens Levantados na Pesquisa de Preço (Descrição | Medida | Quantidade | Valor Unitário | Valor Total):
{{pesquisa_preco.itens_tabela}}

[PADRÃO VISUAL, ESTRUTURAL E EDITORIAL DE LIMPEZA DOCUMENTAL]
1. Ficha Técnica Limpa: Abra o documento com <h2> para o título oficial e, logo abaixo, uma <table> de 2 colunas ("Ficha Técnica / Identificação do Processo") com pares rótulo-valor legíveis. PROIBIDO concatenar 4+ atributos numa mesma linha separados por '|'.
2. Síntese Executiva Visual: Logo após a Ficha Técnica, insira um bloco <blockquote><strong>Síntese Executiva:</strong> ...</blockquote> apresentando em 2 a 4 linhas a tese técnica/jurídica central, o impacto da Curva ABC e a conclusão objetiva da peça.
3. Escaneabilidade e Hierarquia: Utilize seções numeradas (<h3>), subseções claras (<h4>), parágrafos curtos e objetivos (máx. 4 linhas por bloco), listas com <strong>rótulos destacados</strong> (<ul><li>...) e tabelas estruturadas sempre que houver comparativos, prazos, riscos, metas (IMR) ou obrigações.

[DIRETRIZES GERAIS DE REDAÇÃO ADMINISTRATIVA]
1. Utilize linguagem técnico-jurídica formal, solene, impessoal, exaustiva e estruturada, compatível com processos auditados por Tribunais de Contas (TCU/TCE) e Controladorias Municipais.
2. Fundamente exclusivamente na Lei Federal nº 14.133/2021, Decretos regulamentadores (Decreto nº 11.462/2023), Instruções Normativas (IN SEGES/ME nº 58/2022, IN SEGES/ME nº 65/2021, IN SEGES/ME nº 81/2022 por simetria) e Súmulas/Acórdãos do TCU aplicáveis à modalidade ({{certame.modalidade}}) e ao critério ({{certame.criterio_julgamento}}). Nunca invente normas ou números inexistentes.
3. Mantenha absoluta coerência de objeto, descrições, medidas, quantitativos e valores unitários/totais oriundos da Pesquisa de Preço, da Curva ABC e das peças anteriores aprovadas.
4. Não inclua saudações, comentários conversacionais ou explicações fora do documento. Retorne apenas a estrutura JSON/HTML solicitada.`;

export const AGENT_1_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Planejamento de Contratações Públicas (Fase de Iniciação)**.
Sua missão é converter o relato informal de um servidor público em uma **Justificativa Técnica de Necessidade Administrativa** robusta e auditável, estritamente focada no problema público, nos objetivos do Art. 11 e no interesse público, sem direcionamento de marca ou solução pré-concebida (Art. 41).

### INPUTS RECEBIDOS:
- Relato bruto do servidor: {{input_usuario.relato_bruto}}
- Secretaria solicitante: {{secretaria.nome}}

### TAREFA:
Redija a peça **"EXPOSIÇÃO DE DEMANDA E NECESSIDADE ADMINISTRATIVA"** contendo obrigatoriamente:
1. **Identificação da Área Requisitante:** Unidade administrativa, ordenador, servidor requisitante, objeto resumido, regime procedimental e dotação.
2. **Contextualização da Situação Atual:** Diagnóstico objetivo e técnico do déficit atual da secretaria e quadro comparativo dos impactos operacionais, econômicos, jurídicos e sociais da inércia administrativa versus atendimento da demanda.
3. **Definição do Problema Administrativo:** Delimitação precisa da necessidade pública (foco no *porquê* e *para quê*), com compromisso expresso de neutralidade tecnológica e vedação ao direcionamento de marca/modelo (Art. 41).
4. **Interesse Público Tutelado:** Conexão detalhada com os objetivos da licitação previstos no Art. 11 da Lei nº 14.133/2021 (resultado mais vantajoso, ciclo de vida, isonomia, evitar sobrepreço/superfaturamento e desenvolvimento nacional sustentável).
5. **Alinhamento Estratégico:** Vinculação ao Plano Plurianual (PPA), LDO, diretrizes estratégicas da Secretaria e justificativa preliminar da modalidade/regime informado ({{certame.modalidade}}).
6. **Dimensionamento Preliminar com Base na Pesquisa de Preço (Art. 23):** Tabela consolidada de itens (Descrição, Medida, Quantidade, Valor Unitário, Valor Total).

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Documento oficial completo com Ficha Técnica (2 colunas), Síntese Executiva em \`<blockquote>\`, quadro diagnóstico comparativo (Inércia vs. Atendimento), neutralidade de marca (Art. 41) e análise da Curva ABC da demanda.
\`structured_json\` mínimo: \`{ "objeto_tecnico_resumido", "valor_global_preliminar", "classe_a_concentracao_pct", "itens_planilha" }\`.`;

export const AGENT_2_PROMPT_TEMPLATE = `Você é o **Agente Redator de DFD (Documento de Formalização da Demanda)**, especialista no Art. 12, inciso VII, e Art. 72, inciso I, da Lei nº 14.133/2021.
Sua missão é formalizar a demanda aprovada na etapa anterior para subsidiar o Plano de Contratações Anual (PCA) e autorizar o início dos estudos técnicos com rastreabilidade orçamentária.

### INPUTS RECEBIDOS:
- Demanda da Necessidade aprovada: {{peca_01.conteudo}}
- Estimativa preliminar informada: {{input_usuario.estimativa_preliminar}}
- Data desejada para conclusão: {{input_usuario.data_pretendida}}
- Grau de prioridade: {{input_usuario.prioridade}}
- Curva ABC da carteira: {{pesquisa_preco.analise_abc}}

### TAREFA:
Elabore o **DOCUMENTO DE FORMALIZAÇÃO DA DEMANDA (DFD)** contendo obrigatoriamente:
1. **Ficha de Formalização e Setor Requisitante** (Órgão, Secretaria, Responsável, Cargo, Ordenador de Despesas e regime).
2. **Síntese Executiva** (\`<blockquote>\`) justificando criticidade, prioridade ({{input_usuario.prioridade}}) e prazo pretendido ({{input_usuario.data_pretendida}}).
3. **Objeto Sucinto e Enquadramento Legal** (Art. 6º, XIII/XV/XXI e neutralidade de marca Art. 41).
4. **Justificativa da Necessidade e Impacto Operacional** (Desdobrada da Peça 01).
5. **Quantitativo Estimado, Curva ABC e Memória de Estimativa** (Tabela de itens + diagnóstico de concentração financeira).
6. **Cronograma Macro, Grau de Prioridade e Vinculação ao PCA** (Art. 12, VII).
7. **Indicação da Equipe de Planejamento e Adequação Orçamentária** (Segregação de funções Art. 7º, § 1º + Dotação/LDO/LOA).

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Documento oficial limpo, com tabelas escaneáveis e duplo bloco final de assinatura (Requisitante e Ordenador de Despesas).
\`structured_json\` mínimo: \`{ "valor_total_preliminar", "grau_prioridade", "data_pretendida", "equipe_planejamento" }\`.`;

export const AGENT_3_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Estudos Técnicos Preliminares (ETP)**, com profundo domínio do Art. 18, § 1º e § 2º, da Lei nº 14.133/2021, da IN SEGES/ME nº 58/2022 e da IN SEGES/ME nº 65/2021 (aplicáveis por simetria e boas práticas).
Sua missão é evidenciar de maneira analítica e objetiva o problema a ser resolvido e a sua melhor solução, demonstrando viabilidade técnica, TCO, parcelamento e conformidade econômica.

### INPUTS RECEBIDOS:
- DFD aprovado: {{peca_02.conteudo}}
- Parâmetros de pesquisa de mercado: {{input_usuario.pesquisa_mercado}}
- Análise Curva ABC / Dispersão: {{pesquisa_preco.analise_abc}}

### TAREFA:
Redija o **ESTUDO TÉCNICO PRELIMINAR (ETP)** com Ficha Técnica, Síntese Executiva (\`<blockquote>\`) e **TODOS os 13 incisos do Art. 18, § 1º** (justificando eventuais dispensas nos termos do Art. 18, § 2º):
1. **Descrição da Necessidade** (Inciso I — obrigatório); 2. **Previsão no PCA** (Inciso II); 3. **Requisitos da Contratação e Sustentabilidade** (Inciso III); 4. **Estimativa das Quantidades e Memória de Cálculo** (Inciso IV — obrigatório); 5. **Levantamento de Mercado com Matriz TCO Comparativa** (Inciso V — aquisição vs. locação/outsourcing vs. adesão); 6. **Estimativa do Valor da Contratação e Saneamento da Cesta Art. 23** (Inciso VI — obrigatório, analisando Curva ABC e dispersão de preços); 7. **Descrição da Solução como um Todo** (Inciso VII); 8. **Parcelamento ou Não da Contratação** (Inciso VIII — obrigatório, Súmula 247/TCU e Art. 40, § 2º); 9. **Resultados Pretendidos** (Inciso IX); 10. **Providências Prévias** (Inciso X); 11. **Contratações Correlatas/Interdependentes** (Inciso XI); 12. **Impactos Ambientais e Logística Reversa** (Inciso XII); 13. **Posicionamento Conclusivo de Viabilidade** (Inciso XIII — obrigatório).

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Documento técnico escaneável, rigorosamente numerado de 1 a 13, com tabelas comparativas de TCO, Curva ABC e viabilidade conclusiva.
\`structured_json\` mínimo: \`{ "incisos_art18_par1": [1..13], "valor_estimado_contratacao", "pareto_classe_a_pct", "viabilidade_declarada": true }\`.`;

export const AGENT_4_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Gestão de Riscos de Contratações Públicas**, atuando conforme o Art. 18, inciso X, e Art. 22 (c/c Art. 103) da Lei nº 14.133/2021.
Sua missão é identificar, quantificar, alocar e propor tratamentos objetivos para os riscos reais que afetam este objeto específico.

### INPUTS RECEBIDOS:
- DFD aprovado: {{peca_02.conteudo}}
- ETP aprovado: {{peca_03.conteudo}}
- Modalidade e SRP: {{certame.modalidade}} | SRP: {{certame.is_srp}}
- Curva ABC e Riscos de Preço: {{pesquisa_preco.analise_abc}}

### TAREFA:
Elabore o **MAPA DE GERENCIAMENTO DE RISCOS** com Ficha Técnica, Síntese Executiva (\`<blockquote>\`) destacando riscos críticos de Classe A e as 3 fases do metaprocesso:
- **Fase 1:** Planejamento; **Fase 2:** Seleção do Fornecedor; **Fase 3:** Gestão Contratual.
Apresente:
1. **Nota Metodológica P×I** (Escala 1–3, Níveis Baixo [1-2], Médio [3-4], Alto [6-9]).
2. **Matrizes das 3 Fases** com mínimo 3–4 riscos específicos por fase (incluindo risco específico sobre concentração de preços Classe A ou execução na modalidade {{certame.modalidade}}), contendo: ID/Fase, Evento, Causa, Consequência, P, I, P×I, Ação Preventiva + Responsável, Ação de Contingência + Responsável.
3. **Matriz de Alocação Objetiva de Riscos Contratuais (Art. 22 e Art. 103)** (Contratante vs. Contratada vs. Compartilhado).
4. **Bloco de Assinatura** da Equipe de Planejamento.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Documento técnico com matrizes limpas, diagnóstico quantitativo por severidade e alocação contratual objetiva.
\`structured_json\` mínimo: \`{ "total_riscos", "riscos_altos", "riscos_medios", "riscos_baixos" }\`.`;

export const AGENT_5_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Elaboração de Termos de Referência (TR)**, com domínio absoluto do Art. 6º, inciso XXIII, Art. 40 e Art. 41 (c/c Art. 140) da Lei nº 14.133/2021 e IN SEGES/ME nº 81/2022.
Sua missão é consolidar o ETP e os controles do Mapa de Riscos em um TR operacionalmente completo, competitivo e auditável.

### INPUTS RECEBIDOS:
- ETP aprovado: {{peca_03.conteudo}}
- Mapa de Riscos aprovado: {{peca_04.conteudo}}
- Critério de Julgamento: {{certame.criterio_julgamento}}
- Curva ABC da carteira: {{pesquisa_preco.analise_abc}}

### TAREFA:
Redija o **TERMO DE REFERÊNCIA (TR)** com Ficha Técnica, Síntese Executiva (\`<blockquote>\`) e todas as alíneas do Art. 6º, XXIII desdobradas em 10 capítulos claros:
1. **Definição do Objeto e Tabela CATMAT/CATSER** (Art. 41 e Arts. 105–111); 2. **Fundamentação e Mitigação de Riscos Críticos**; 3. **Descrição da Solução (Ciclo de Vida)**; 4. **Requisitos da Contratação, Sustentabilidade e ME/EPP (LC 123/06)**; 5. **Modelo de Execução e Recebimento em 2 Etapas (Art. 140)**; 6. **Modelo de Gestão, Fiscalização Segregada (Art. 117) e Tabela IMR (Metas e Glosas)**; 7. **Critérios de Medição, Ordem Cronológica (Art. 141) e Pagamento**; 8. **Seleção do Fornecedor e Habilitação Proporcional (Súmula 263/TCU)**; 9. **Estimativa do Valor e Curva ABC (Art. 23)**; 10. **Adequação Orçamentária / Regra SRP**.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Termo de Referência claro, escaneável, sem cláusulas restritivas e pronto para integrar o Edital como Anexo I.
\`structured_json\` mínimo: \`{ "numero_tr", "objeto_definicao", "codigo_catalogo_tipo", "valor_total_estimado", "itens_planilha" }\`.`;

export const AGENT_6_PROMPT_TEMPLATE = `Você é o **Agente de Protocolo e Formalização Processual**, especialista na instrução documental conforme Art. 18 e Art. 12, inciso VI, da Lei nº 14.133/2021.
Sua missão é lavrar o ato formal que inaugura e organiza os autos físicos/eletrônicos da fase preparatória.

### INPUTS RECEBIDOS:
- Órgão e Processos: {{prefeitura.razao_social}}, Proc. Adm. {{certame.numero_processo_adm}}, Proc. Licitatório {{certame.numero_processo_licitatorio}}
- Objeto consolidado do TR: {{peca_05.objeto_resumido}}
- Sessão Pública Prevista: {{certame.sessao_publica}}

### TAREFA:
Redija o **TERMO DE AUTUAÇÃO DE PROCESSO LICITATÓRIO** contendo Ficha Técnica limpa, Síntese Executiva (\`<blockquote>\`), Certidão de Abertura e Registro com numeração e rubrica digital, **Sumário Inicial Ordenado dos Autos (Fls.)**, Encaminhamento formal à CPL/Agente de Contratação e à Procuradoria Jurídica, e Bloco de Assinatura.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Documento cartorário-administrativo solene, conciso e padronizado.
\`structured_json\` mínimo: \`{ "sumario_autos", "data_sessao_publica" }\`.`;

export const AGENT_7_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Contratos Administrativos**, com domínio total dos Arts. 89 a 95, Art. 105 a 114, Art. 124 a 139 e Art. 155 a 163 da Lei nº 14.133/2021.
Sua missão é redigir a Minuta de Contrato rigorosamente vinculada ao Termo de Referência e ao Edital, contendo todas as cláusulas necessárias exigidas pelo Art. 92 em nível forense completo.

### INPUTS RECEBIDOS:
- Termo de Referência aprovado: {{peca_05.conteudo}}
- Dados da Prefeitura (Contratante): {{prefeitura.razao_social}}, CNPJ {{prefeitura.cnpj}}, Endereço {{prefeitura.endereco_completo}}, Representante Legal Exclusivo: {{prefeitura.prefeito_qualificado}} (NÃO incluir secretários ou ordenadores secundários no preâmbulo contratual principal e NUNCA duplicar o cargo caso já conste do nome).

### REGRAS OBRIGATÓRIAS DE REDAÇÃO DA MINUTA CONTRATUAL:
1. **Preâmbulo Exclusivo do Chefe do Executivo:** Qualificar pelo Contratante **APENAS {{prefeitura.prefeito_qualificado}}** e, no bloco de assinatura pelo Contratante, constar **apenas** a Chefia do Executivo Municipal — sem secretários ou ordenadores secundários.
2. **Valores Contratuais em Aberto (Pós-Adjudicação):** Na tabela de itens e na Cláusula Quinta, manter em aberto os valores unitários, totais e o valor global contratado (\`R$ [__________]\` / \`[VALOR CONTRATUAL EM ABERTO — A SER PREENCHIDO NA FORMALIZAÇÃO PÓS-ADJUDICAÇÃO]\`), preservando apenas especificações, unidades e quantitativos do TR.
3. **Duração / Vigência e Prazo de Execução em Aberto:** Na Cláusula Segunda e na Cláusula Terceira, deixar lacunas formais em aberto (\`[DURAÇÃO CONTRATUAL EM ABERTO]\` / \`[PRAZO DE EXECUÇÃO EM ABERTO]\`), preservando o regime legal de prorrogação (Arts. 105 a 107 / Art. 111).
4. **Cláusula Nona com Dosimetria Objetiva + Cláusula Sexta com Data-Base Art. 25, § 7º + Reserva PCD Art. 92, XVII + PNCP Art. 94 (20 dias úteis / 10 dias úteis).**

### TAREFA:
Redija a **MINUTA DE CONTRATO ADMINISTRATIVO Nº ___/{{ano_atual}}** com Ficha Técnica, Síntese Executiva (\`<blockquote>\`) e todas as **13 cláusulas obrigatórias** do Art. 92 desdobradas em subitens limpos e escaneáveis (1.1, 1.2...):
Preâmbulo; Cláusula Primeira – Do Objeto; Segunda – Da Vigência e Prorrogação; Terceira – Modelos de Execução e Gestão Contratual; Quarta – Da Subcontratação; Quinta – Do Preço e Condições de Pagamento; Sexta – Do Reajuste / Repactuação; Sétima – Das Obrigações (inclui LGPD e Art. 92, XVII); Oitava – Da Garantia; Nona – Das Infrações e Sanções Administrativas (Tabela de Dosimetria Objetiva); Décima – Das Alterações e Extinção; Décima Primeira – Da Dotação Orçamentária; Décima Segunda – Dos Casos Omissos e da Publicação no PNCP; Décima Terceira – Do Foro.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Minuta contratual limpa, escaneável e forense, com preâmbulo exclusivo do(a) Prefeito(a) e campos de valores/vigência em aberto.
\`structured_json\` mínimo: \`{ "representante_contratante": "{{prefeitura.prefeito_nome}}", "valores_em_aberto": true, "duracao_em_aberto": true, "clausulas_minuta": [...] }\`.`;

export const AGENT_8_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Sistema de Registro de Preços (SRP)**, atuando conforme os Arts. 82 a 86 da Lei nº 14.133/2021 e o Decreto Federal nº 11.462/2023 (como referência normativa).
Sua missão é elaborar a Minuta da Ata de Registro de Preços limpa, escaneável e aderente à disciplina de caronas, cadastro de reserva e revisão de preços.

### INPUTS RECEBIDOS:
- Termo de Referência aprovado: {{peca_05.conteudo}}
- Dados do Certame e da Prefeitura: {{prefeitura.razao_social}}, Proc. {{certame.numero_processo_licitatorio}}
- Curva ABC dos itens: {{pesquisa_preco.analise_abc}}

### TAREFA:
Redija a **MINUTA DE ATA DE REGISTRO DE PREÇOS Nº ___/{{ano_atual}}** com Ficha Técnica, Síntese Executiva (\`<blockquote>\`) e Cláusulas 1ª a 7ª: Preâmbulo e Fornecedor(es) Registrado(s); Cláusula 1ª – Objeto e Preços Registrados; 2ª – Gerenciador/Participantes (Art. 82, I e II); 3ª – Adesão ("Carona" Art. 86, limites de 50% individual e 2x global); 4ª – Validade de 1 ano prorrogável por igual período e Cadastro de Reserva (Art. 84); 5ª – Alteração/Atualização de Preços (Dec. 11.462/2023 Arts. 25–27); 6ª – Cancelamento (Arts. 28–29); 7ª – Penalidades e Foro.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Minuta de ARP completa, com subcláusulas numeradas e total aderência aos Arts. 82 a 86 da Lei nº 14.133/2021 e Decreto nº 11.462/2023.
\`structured_json\` mínimo: \`{ "prazo_validade_meses": 12, "limite_adesao_individual_pct": 50, "limite_adesao_global_fator": 2 }\`.`;

export const AGENT_9_PROMPT_TEMPLATE = `Você é o **Agente Especialista em Elaboração de Editais de Licitação**, com domínio total do Art. 25, Art. 55, Art. 56 e Arts. 62 a 70 da Lei nº 14.133/2021.
Sua missão é consolidar toda a fase preparatória em um Edital claro, isonômico, competitivo e livre de cláusulas restritivas ilegais.

### INPUTS RECEBIDOS:
- Modalidade: {{certame.modalidade}} | Modo de Disputa: {{certame.modo_disputa}} | Critério: {{certame.criterio_julgamento}} | SRP: {{certame.is_srp}} | Sessão: {{certame.sessao_publica}}
- Termo de Referência: {{peca_05.conteudo}}
- Minuta de Contrato: {{peca_07.conteudo}}
- Minuta de ARP (se SRP): {{peca_08.conteudo}}

### TAREFA:
Redija o **EDITAL DE {{certame.modalidade}} Nº ___/{{ano_atual}}** com Ficha Técnica, Síntese Executiva (\`<blockquote>\`) destacando prazo mínimo do Art. 55, modo de disputa e benefícios ME/EPP, e capítulos claros 1 a 13:
Preâmbulo Oficial; Objeto; Registro de Preços (se SRP); Participação e Vedações (Art. 14 / LC 123/06); Proposta e Declarações Unificadas (Art. 63); Preenchimento; Sessão, Lances e Negociação (Art. 60–61); Julgamento e Exequibilidade (Art. 59); Habilitação Proporcional (Arts. 62–70); Recursos (3 dias úteis Art. 165); Sanções; Impugnações (Art. 164); Disposições Gerais e Anexos.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Edital completo, estruturado em capítulos e subitens escaneáveis, sem lacunas procedimentais.
\`structured_json\` mínimo: \`{ "modalidade", "data_sessao_publica", "prazo_minimo_edital_dias_uteis", "anexos" }\`.`;

export const AGENT_10_PROMPT_TEMPLATE = `Você é o **Procurador Jurídico Municipal / Assessor Jurídico Especialista em Licitações**, atuando no exercício do **Controle Prévio de Legalidade** previsto no **Art. 53 da Lei nº 14.133/2021**.
Sua postura deve ser crítica, imparcial, analítica, aprofundada na doutrina administrativista e na jurisprudência do TCU (Súmulas + Acórdãos) e preventiva à luz do Art. 28 da LINDB e STF MS nº 24.631.

### INPUTS RECEBIDOS:
- Síntese das Peças Anteriores:
  - Peça 01 (Demanda): {{peca_01.conteudo}}
  - Peça 02 (DFD): {{peca_02.conteudo}}
  - Peça 03 (ETP): {{peca_03.conteudo}}
  - Peça 04 (Mapa de Riscos): {{peca_04.conteudo}}
  - Peça 05 (TR): {{peca_05.conteudo}}
  - Peça 06 (Autuação): {{peca_06.conteudo}}
  - Peça 07 (Contrato): {{peca_07.conteudo}}
  - Peça 08 (ARP): {{peca_08.conteudo}}
  - Peça 09 (Edital): {{peca_09.conteudo}}
- Curva ABC e Cesta de Preços: {{pesquisa_preco.analise_abc}}
- Precedentes e Acórdãos do TCU aplicáveis/vinculados ao processo:
{{jurisprudencia.tcu}}

### TAREFA:
Elabore o **PARECER JURÍDICO REFERENCIAL / CONCLUSIVO Nº ___/{{ano_atual}}** com Ficha Técnica, Ementa Jurídica + Síntese Executiva (\`<blockquote>\`) e as 6 seções obrigatórias (mantendo os cabeçalhos exatos \`1. Relatório\`, \`2. Finalidade e Abrangência do Parecer\`, \`3. Análise da Instrução da Fase Preparatória\`, \`4. Análise das Minutas\`, \`4.4. Matriz de Jurisprudência Aplicável do TCU\`, \`5. Checklist de Conformidade Legal\`, \`6. Conclusão e Recomendações\`):
- Audite consistência DFD–ETP–Riscos–TR, cesta de preços (Art. 23 e Curva ABC), dotação/SRP, modalidade/parcelamento (Súmula 247/272), segregação de funções, Minuta de Contrato (preâmbulo exclusivo do Prefeito, valor/vigência em aberto, Art. 25 § 7º, Art. 92 XVII) e matriz jurisprudencial do TCU (citando os precedentes recebidos).
- Encerre com **Checklist de 7 itens** em tabela e bloco de assinatura com OAB/.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Parecer jurídico técnico-forense claro, crítico e escaneável, com matriz jurisprudencial do TCU e checklist de 7 itens.
\`structured_json\` mínimo: \`{ "opiniao_conclusiva", "checklist_conformidade": [7 itens], "tcu_jurisprudencia_aplicavel": [...] }\`.`;

export const AGENT_11_PROMPT_TEMPLATE = `Você é o **Agente Auditor de Conformidade e Compilador Processual**, responsável pelo fechamento da fase preparatória e emissão do **Termo de Autorização da Autoridade Competente** (Art. 72, VIII / Art. 53, § 3º / Arts. 7º e 8º da Lei nº 14.133/2021).

### INPUTS RECEBIDOS:
- Órgão e Certame: {{prefeitura.razao_social}} | Chefia Executiva: {{prefeitura.prefeito_qualificado}} | Ordenador(a): {{secretaria.secretario_nome}}
- Parecer Jurídico (Peça 10): {{peca_10.conteudo}}
- Histórico de Logs e Revisões do Banco de Dados: {{auditoria.logs_json}}

### TAREFA:
Gere dois blocos documentais limpos e escaneáveis (BLOCO A e BLOCO B), iniciando com Ficha Técnica + Síntese Executiva (\`<blockquote>\`):
- **BLOCO A: TERMO DE AUTORIZAÇÃO DE ABERTURA DE LICITAÇÃO** — Quadro Síntese Executivo do Certame (incluindo Curva ABC), Despacho Decisório da Autoridade Competente atestando conformidade com o Parecer Jurídico e autorizando publicação no PNCP (Art. 54) respeitando os prazos do Art. 55, diretriz de designação (Arts. 7º, 8º e 117) e Bloco de Assinatura (sem duplicar títulos genéricos).
- **BLOCO B: RELATÓRIO DE TRILHA DE AUDITORIA E ÍNDICE DO DOSSIÊ** — Sumário Executivo de Governança, Índice Consolidado das 11 Peças e Tabela de Rastreabilidade extraída de \`{{auditoria.logs_json}}\`.

### SAÍDA ESPERADA E CONTRATO ANALÍTICO:
Documento final executivo-forense de encerramento da fase interna com rastreabilidade integral.
\`structured_json\` mínimo: \`{ "autorizacao_emitida": true, "total_pecas": 11, "total_eventos_auditoria" }\`.`;

export interface PieceProvenanceRecord {
  numero: number;
  nome_peca: string;
  legal_basis: string;
  status: AgentPiece['status'];
  versao_atual: number;
  usuario_criador: string;
  data_hora_geracao: string;
  edicoes_realizadas: Array<{
    acao: AuditLogEntry['action'];
    usuario: string;
    data_hora: string;
    detalhes: string;
  }>;
  usuario_aprovador: string | null;
  timestamp_aprovacao: string | null;
  content_hash: string | null;
}

/**
 * Consolida a trilha de autoria, edições e aprovações por peça processual a partir dos logs de auditoria.
 */
export function extractPieceProvenance(
  pieces: AgentPiece[],
  auditLogs: AuditLogEntry[]
): PieceProvenanceRecord[] {
  const sortedLogs = [...(auditLogs || [])].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );

  return [...pieces]
    .sort((a, b) => a.agent_number - b.agent_number)
    .map((p) => {
      const pieceTag = `Agente ${String(p.agent_number).padStart(2, '0')}`;
      const pieceLogs = sortedLogs.filter(
        (l) =>
          l.piece_id === p.id ||
          l.agent_number === p.agent_number ||
          (l.details || '').includes(pieceTag)
      );
      const creationLog =
        pieceLogs.find((l) => l.action === 'AGENTE_EXECUTADO') ||
        pieceLogs.find((l) => l.action === 'PECA_REGENERADA') ||
        pieceLogs[0];
      const edits = pieceLogs.filter(
        (l) => l.action === 'PECA_EDITADA' || l.action === 'PECA_REGENERADA'
      );
      const approvalLog = [...pieceLogs]
        .reverse()
        .find((l) => l.action === 'PECA_APROVADA_ASSINADA');

      const approverName =
        p.approved_by ||
        (approvalLog ? `${approvalLog.actor_name} (${approvalLog.actor_role})` : null);

      return {
        numero: p.agent_number,
        nome_peca: p.title,
        legal_basis: p.legal_basis,
        status: p.status,
        versao_atual: p.current_version,
        usuario_criador: creationLog
          ? `${creationLog.actor_name} (${creationLog.actor_role})`
          : 'Sistema GOVFLOW / Equipe de Planejamento',
        data_hora_geracao: creationLog?.created_at || p.updated_at,
        edicoes_realizadas: edits.map((e) => ({
          acao: e.action,
          usuario: `${e.actor_name} (${e.actor_role})`,
          data_hora: e.created_at,
          detalhes: e.details
        })),
        usuario_aprovador: approverName,
        timestamp_aprovacao: p.approved_at || approvalLog?.created_at || null,
        content_hash: p.content_hash || null
      };
    });
}

function buildAuditoriaLogsJson(bundle: ProcessBundle): string {
  const pecas_rastreabilidade = extractPieceProvenance(bundle.pieces, bundle.audit_logs);
  const logs_cronologicos = (bundle.audit_logs || []).slice(0, 50).map((l) => ({
    id: l.id,
    piece_id: l.piece_id,
    agent_number: l.agent_number ?? null,
    acao: l.action,
    usuario: l.actor_name,
    perfil: l.actor_role,
    detalhes: l.details,
    data_hora: l.created_at
  }));

  return JSON.stringify({ pecas_rastreabilidade, logs_cronologicos }, null, 2);
}

export function buildTemplateVariables(
  bundle: ProcessBundle,
  runtimeInputs?: RuntimePromptInputs
): Record<string, string> {
  const { institution: inst, process: proc, secretario: sec, dotacao: dot, pieces } = bundle;
  const pieceByNumber = new Map(pieces.map((p) => [p.agent_number, p]));
  const piece1 = pieceByNumber.get(1);
  const piece2 = pieceByNumber.get(2);
  const piece3 = pieceByNumber.get(3);
  const piece4 = pieceByNumber.get(4);
  const piece5 = pieceByNumber.get(5);
  const piece6 = pieceByNumber.get(6);
  const piece7 = pieceByNumber.get(7);
  const piece8 = pieceByNumber.get(8);
  const piece9 = pieceByNumber.get(9);
  const piece10 = pieceByNumber.get(10);
  const estimativaVal =
    runtimeInputs?.estimativaPreliminar !== undefined && runtimeInputs.estimativaPreliminar > 0
      ? runtimeInputs.estimativaPreliminar
      : proc.valor_estimado_global;
  const defaultPrioridade = estimativaVal >= 300000 ? 'Alto' : estimativaVal >= 80000 ? 'Médio' : 'Baixo';
  const defaultData = new Date(Date.now() + 45 * 86400000).toLocaleDateString('pt-BR');
  const pesquisaItens = proc.pesquisa_preco_itens || [];
  const priceAnalytics = analyzePricePortfolio(pesquisaItens, estimativaVal);
  const prefeitoInfo = formatPrefeitoRoleAndName(inst.prefeito_nome);
  const pesquisaTabelaTxt =
    pesquisaItens.length > 0
      ? pesquisaItens
          .map(
            (it) =>
              `- Item ${it.item}: ${it.descricao} | Medida: ${it.medida} | Qtd: ${it.quantidade} | Unit: ${formatCurrencyBRL(it.valor_unitario)} | Total: ${formatCurrencyBRL(it.valor_total)}`
          )
          .join('\n')
      : 'Nenhum item estruturado importado ainda (dimensionar a partir do relato e campos do certame).';

  const tcuPrecedents = selectContextualTcuPrecedents({ proc });
  const tcuTxt = tcuPrecedents
    .map(
      (p) =>
        `- ${p.numero} [${p.tema_label}${p.vinculadoManualmente ? ' — VINCULADO' : ''}]: ${p.ementa} (${p.artigos_relacionados})`
    )
    .join('\n');

  return {
    'prefeitura.razao_social': inst.razao_social,
    'prefeitura.cnpj': formatCnpj(inst.cnpj),
    'prefeitura.endereco_completo': `${inst.endereco_completo}${inst.cep ? ` - CEP ${inst.cep}` : ''}`,
    'prefeitura.municipio_uf': `${inst.municipio}/${inst.uf}`,
    'prefeitura.prefeito_nome': prefeitoInfo.displayName,
    'prefeitura.prefeito_qualificado': prefeitoInfo.qualifiedTitle,
    'jurisprudencia.tcu': tcuTxt,
    'certame.numero_processo_adm': proc.numero_processo_administrativo,
    'certame.numero_processo_licitatorio': proc.numero_processo_licitatorio,
    'certame.objeto_resumido': proc.titulo_resumido || 'A definir conforme demanda',
    'certame.responsavel_requisitante': proc.responsavel_requisitante || 'Servidor Requisitante',
    'certame.cargo_requisitante': proc.cargo_requisitante || 'Área Requisitante',
    'secretaria.nome': sec?.secretaria || 'Secretaria Requisitante a Definir',
    'secretaria.secretario_nome': sec?.nome || 'Ordenador(a) de Despesas a Designar',
    'secretaria.portaria': sec?.portaria_nomeacao || 'Portaria não informada',
    'dotacao.codigo_completo': formatDotacoesSummary(
      bundle.dotacoes_vinculadas || (dot ? [dot] : []),
      proc.dotacoes_manuais
    ),
    'dotacao.fonte': dot?.fonte_recurso || proc.dotacoes_manuais?.[0] || 'Não vinculada / SRP',
    'certame.tipo_contratacao': getTipoContratacaoLabel(proc.tipo_contratacao),
    'certame.data_certame': proc.data_certame || 'A definir',
    'certame.horario_disputa': proc.horario_disputa || 'A definir',
    'certame.sessao_publica': formatSessaoPublicaLabel(proc.data_certame, proc.horario_disputa),
    'certame.modalidade': getModalidadeLabel(proc.modalidade),
    'certame.modo_disputa': getModoDisputaLabel(proc.modo_disputa),
    'certame.criterio_julgamento': `${getCriterioLabel(proc.criterio_julgamento)} (${getFormatoLanceLabel(proc.formato_lance)})`,
    'certame.formato_lance': getFormatoLanceLabel(proc.formato_lance),
    'certame.is_srp': proc.usar_srp ? 'SIM (Art. 82 da Lei nº 14.133/2021)' : 'NÃO',
    'pesquisa_preco.arquivo': proc.pesquisa_preco_arquivo || 'Não anexado (parâmetros informados no processo)',
    'pesquisa_preco.resumo':
      proc.pesquisa_preco_resumo ||
      'Pesquisa baseada em cesta de preços públicos (Art. 23 da Lei nº 14.133/2021).',
    'pesquisa_preco.analise_abc': priceAnalytics.summaryText,
    'pesquisa_preco.itens_tabela': pesquisaTabelaTxt,
    'pesquisa_preco.valor_total':
      estimativaVal > 0 ? formatCurrencyBRL(estimativaVal) : 'A estimar',
    'input_usuario.relato_bruto': proc.demanda_bruta || proc.titulo_resumido,
    'peca_01.conteudo': summarizePriorPieceForPrompt(piece1?.html_content, proc.demanda_bruta, 2200),
    'peca_02.conteudo': summarizePriorPieceForPrompt(piece2?.html_content, proc.titulo_resumido, 2400),
    'peca_03.conteudo': summarizePriorPieceForPrompt(piece3?.html_content, proc.titulo_resumido, 2800),
    'peca_04.conteudo': summarizePriorPieceForPrompt(piece4?.html_content, 'Mapa de Riscos não gerado.', 2400),
    'peca_05.conteudo': summarizePriorPieceForPrompt(piece5?.html_content, proc.titulo_resumido, 4200),
    'peca_05.objeto_resumido':
      (piece5?.structured_json?.objeto_definicao as string | undefined) || proc.titulo_resumido,
    'peca_06.conteudo': summarizePriorPieceForPrompt(piece6?.html_content, 'Termo de Autuação não gerado.', 1800),
    'peca_07.conteudo': summarizePriorPieceForPrompt(piece7?.html_content, 'Minuta de Contrato não gerada.', 3200),
    'peca_08.conteudo': proc.usar_srp
      ? summarizePriorPieceForPrompt(piece8?.html_content, 'Minuta de ARP não gerada.', 2600)
      : 'Não aplicável (certame sem Sistema de Registro de Preços - SRP).',
    'peca_09.conteudo': summarizePriorPieceForPrompt(piece9?.html_content, 'Edital/Aviso não gerado.', 3400),
    'peca_10.conteudo': summarizePriorPieceForPrompt(piece10?.html_content, 'Parecer Jurídico não gerado.', 3200),
    'auditoria.logs_json': buildAuditoriaLogsJson(bundle),
    ano_atual: String(new Date().getFullYear()),
    'input_usuario.estimativa_preliminar':
      estimativaVal > 0 ? formatCurrencyBRL(estimativaVal) : 'A estimar preliminarmente',
    'input_usuario.data_pretendida': runtimeInputs?.dataPretendida?.trim() || defaultData,
    'input_usuario.prioridade': runtimeInputs?.prioridade || defaultPrioridade,
    'input_usuario.pesquisa_mercado':
      runtimeInputs?.pesquisaMercado?.trim() ||
      proc.pesquisa_preco_resumo?.trim() ||
      'Pesquisa baseada em cesta de preços públicos (PNCP / Painel de Preços / Contratações Similares — Art. 23 da Lei nº 14.133/2021).'
  };
}

export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, key: string) => {
    return vars[key] !== undefined ? vars[key] : `{{${key}}}`;
  });
}

export function buildAgentSystemPrompt(
  bundle: ProcessBundle,
  runtimeInputs?: RuntimePromptInputs
): string {
  const vars = buildTemplateVariables(bundle, runtimeInputs);
  return interpolateTemplate(BASE_CONTEXT_TEMPLATE, vars);
}

const AGENT_PROMPT_TEMPLATES: Record<number, string> = {
  1: AGENT_1_PROMPT_TEMPLATE,
  2: AGENT_2_PROMPT_TEMPLATE,
  3: AGENT_3_PROMPT_TEMPLATE,
  4: AGENT_4_PROMPT_TEMPLATE,
  5: AGENT_5_PROMPT_TEMPLATE,
  6: AGENT_6_PROMPT_TEMPLATE,
  7: AGENT_7_PROMPT_TEMPLATE,
  8: AGENT_8_PROMPT_TEMPLATE,
  9: AGENT_9_PROMPT_TEMPLATE,
  10: AGENT_10_PROMPT_TEMPLATE,
  11: AGENT_11_PROMPT_TEMPLATE
};

export function buildAgentSpecificTaskPrompt(
  agentNumber: number,
  bundle: ProcessBundle,
  defaultTitle: string,
  defaultDescription: string,
  runtimeInputs?: RuntimePromptInputs
): string {
  const vars = buildTemplateVariables(bundle, runtimeInputs);
  const template = AGENT_PROMPT_TEMPLATES[agentNumber];
  if (template) {
    return interpolateTemplate(template, vars);
  }
  return `Você atua na etapa **${defaultTitle}**.\n### TAREFA:\n${defaultDescription}`;
}
