import { formatDateBR } from '../../shared/labels.js';
import type {
  ContractChecklistItem,
  ContractExtractedMetadata,
  ContractRiskFinding,
  ContractSuggestedClause,
  ContractVerdict,
  Institution,
  TcuPrecedent
} from '../../shared/types.js';
import { normalizeUtf8Text } from '../../shared/typography.js';
import { tryGenerateWithLlm } from './llmClient.js';
import { formatPrefeitoRoleAndName } from './promptRegistry.js';
import { selectContextualTcuPrecedents } from './tcuJurisprudence.js';

export interface AnalyzeContractInput {
  title?: string;
  contractText: string;
  analysisFocus?: string;
  institution?: Institution | null;
  userId?: string;
  sourceFilename?: string | null;
}

export interface AnalyzeContractOutput {
  title: string;
  verdict: ContractVerdict;
  compliance_score: number;
  summary: string;
  extracted_metadata: ContractExtractedMetadata;
  checklist_art92: ContractChecklistItem[];
  risk_findings: ContractRiskFinding[];
  suggested_clauses: ContractSuggestedClause[];
  tcu_precedents: TcuPrecedent[];
  report_html: string;
  ai_provider_used: string;
}

function escapeHtml(raw: string): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fold(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function cleanSnippet(raw: string | undefined | null, maxLen = 220): string | null {
  if (!raw) return null;
  const cleaned = normalizeUtf8Text(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3).trim()}...` : cleaned;
}

export function extractContractMetadata(
  rawText: string,
  institution?: Institution | null
): ContractExtractedMetadata {
  const text = normalizeUtf8Text(rawText);
  const folded = fold(text);

  const contratoNumMatch = text.match(
    /(?:MINUTA\s+DE\s+)?(?:TERMO\s+DE\s+)?CONTRATO(?:\s+ADMINISTRATIVO)?\s*(?:N[º°o\.]*|\s+n[º°o\.]*)\s*([A-Z0-9._/-]{1,28})/i
  );
  const procMatch = text.match(
    /Processo(?:\s+(?:Licitat[óo]rio|Administrativo))?\s*(?:N[º°o\.]*)\s*([A-Z0-9._/-]{2,28})/i
  );

  const objetoMatch = text.match(
    /(?:tem\s+por\s+objeto|objeto\s*[:\-–])\s*([^\n]{12,260})/i
  );

  const cnpjMatches = [...text.matchAll(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g)].map((m) => m[0]);
  const cnpjContratante = cnpjMatches[0] || (institution?.cnpj || null);
  const cnpjContratada = cnpjMatches.length > 1 ? cnpjMatches[1] : null;

  const contratanteMatch = text.match(
    /(?:CONTRATANTE[\s:;,\-–]*|de\s+um\s+lado\s+o\(?a\)?\s+)([A-ZÀ-Ú][^\n,;]{5,110}?(?:Munic[íi]pio|Prefeitura|Estado|C[âa]mara|Fundo|Autarquia)[^\n,;]{0,60}|(?:PREFEITURA|MUNIC[ÍI]PIO|FUNDO|AUTARQUIA|C[ÂA]MARA)[^\n,;]{4,100})/i
  );
  const contratadaMatch = text.match(
    /(?:raz[ãa]o\s+social\s*[:\-–|]\s*|empresa\s+)([^\n|]{4,110}?)(?=\s*(?:\||CNPJ|inscrit|com\s+sede|,|\n|$))/i
  );

  let representanteContratante: string | null = null;
  let representanteCargo: string | null = null;
  const repPrefeitoMatch = text.match(
    /representad[oa]\s+(?:exclusivamente\s+)?pelo\(?a\)?\s+(?:Exm[oa]\(?a\)?\.?\s*Sr\(?a\)?\.?\s*)?(Prefeit[oa]\(?a\)?\s+Municipal\s+[^,;\n]{3,70}|[^,;\n]{3,70}?(?=,\s*(?:Prefeit[oa]|Chefe\s+do\s+Poder\s+Executivo)))/i
  );
  const repSecMatch = text.match(
    /representad[oa]\s+(?:exclusivamente\s+)?pelo\(?a\)?\s+([^\n,;]{3,80}?(?:Secret[áa]ri[oa]|Ordenador\(?a\)?|Diretor\(?a\)?)[^\n,;]{0,50})/i
  );
  if (repPrefeitoMatch?.[1]) {
    representanteContratante = cleanSnippet(repPrefeitoMatch[1], 90);
    representanteCargo = 'Prefeito(a) Municipal';
  } else if (repSecMatch?.[1]) {
    representanteContratante = cleanSnippet(repSecMatch[1], 90);
    representanteCargo = 'Secretário(a) / Ordenador(a)';
  } else if (/prefeit[oa]/i.test(text) && institution?.prefeito_nome) {
    representanteContratante = formatPrefeitoRoleAndName(institution.prefeito_nome).displayName;
    representanteCargo = 'Prefeito(a) Municipal';
  }

  const valoresEmAberto =
    /valor(?:es)?\s+(?:contratua(?:l|is)\s+)?em\s+aberto|r\$\s*\[?\s*_{3,}|preenchid[oa]\s+(?:na\s+formaliza[çc][ãa]o|p[óo]s[\s-]adjudica[çc][ãa]o)/i.test(
      folded
    );
  const valorGlobalMatch = text.match(
    /(?:valor\s+(?:global|total)(?:\s+do\s+presente\s+contrato)?\s*(?:é\s+de|de|:)?\s*)(R\$\s*[\d.,]+(?:\s*\([^)]+\))?)/i
  );

  const duracaoEmAberto =
    /duracao\s+contratual\s+em\s+aberto|prazo\s+de\s+(?:vigencia|execucao)\s+em\s+aberto|\[\s*_{3,}[^\]]*(?:meses|dias)/i.test(
      folded
    );
  const vigenciaMatch = text.match(
    /(?:prazo\s+de\s+vig[êe]ncia(?:\s+inicial)?(?:\s+deste\s+contrato)?\s*(?:ser[áa]\s+de|é\s+de|de|:)\s*)([^\n.]{4,110})/i
  );

  let indiceReajuste: string | null = null;
  if (/\bIPCA-?E\b/i.test(text)) indiceReajuste = 'IPCA-E/IBGE';
  else if (/\bIPCA\b/i.test(text)) indiceReajuste = 'IPCA/IBGE';
  else if (/\bINPC\b/i.test(text)) indiceReajuste = 'INPC/IBGE';
  else if (/\bINCC\b/i.test(text)) indiceReajuste = 'INCC/FGV';
  else if (/\bSINAPI\b/i.test(text)) indiceReajuste = 'SINAPI';
  else if (/\bIGP-?M\b/i.test(text)) indiceReajuste = 'IGP-M/FGV';

  let dataBaseOrcamento: string | null = null;
  const dataBaseMatch = text.match(
    /data[\s-]base\s+vinculada[^.\n]{0,120}|data\s+do\s+or[çc]amento\s+estimado(?:\s*\(([^)]+)\))?/i
  );
  if (dataBaseMatch) {
    dataBaseOrcamento = cleanSnippet(dataBaseMatch[1] || dataBaseMatch[0], 110);
  }

  const garantiaMatch = text.match(
    /(?:garantia\s+(?:de\s+execu[çc][ãa]o|contratual)[^.\n]{0,140}|\b\d{1,2}(?:,\d+)?%\s*\([^)]+\)\s*(?:do\s+valor\s+(?:inicial|global)\s+do\s+contrato))/i
  );
  const foroMatch = text.match(
    /(?:eleito\s+o\s+foro\s+(?:da\s+)?(?:Comarca\s+d[eoa]\s+)?)([^\n,;.]{3,80})/i
  );

  const has14133 = /14\.?133\s*\/\s*(?:20)?21|lei\s+(?:federal\s+)?n[º°o\.]*\s*14\.?133/i.test(text);
  const has8666or10520 = /8\.?666\s*\/\s*(?:19)?93|10\.?520\s*\/\s*(?:20)?02/i.test(text);
  const regimeLegal: ContractExtractedMetadata['regime_legal_detectado'] =
    has14133 && has8666or10520
      ? 'MISTO_LEGADO'
      : has14133
        ? 'LEI_14133'
        : has8666or10520
          ? 'LEI_8666_LEGADO'
          : 'NAO_IDENTIFICADO';

  return {
    numero_contrato: contratoNumMatch?.[1]?.trim() || null,
    processo_referencia: procMatch?.[1]?.trim() || null,
    objeto: cleanSnippet(objetoMatch?.[1], 220),
    contratante: cleanSnippet(contratanteMatch?.[1], 120) || institution?.razao_social || null,
    cnpj_contratante: cnpjContratante || null,
    contratada: cleanSnippet(contratadaMatch?.[1], 120),
    cnpj_contratada: cnpjContratada,
    representante_contratante: representanteContratante,
    representante_cargo: representanteCargo,
    valor_global: valoresEmAberto ? 'Em aberto (pós-adjudicação)' : cleanSnippet(valorGlobalMatch?.[1], 80),
    valores_em_aberto: valoresEmAberto,
    vigencia_prazo: duracaoEmAberto ? 'Em aberto (formalização)' : cleanSnippet(vigenciaMatch?.[1], 95),
    duracao_em_aberto: duracaoEmAberto,
    indice_reajuste: indiceReajuste,
    data_base_orcamento: dataBaseOrcamento,
    garantia_contratual: cleanSnippet(garantiaMatch?.[0], 130),
    foro: cleanSnippet(foroMatch?.[1], 80),
    regime_legal_detectado: regimeLegal
  };
}

interface ClauseSpec {
  id: string;
  inciso: string;
  item: string;
  artigo: string;
  suggestedClauseTitle: string;
  suggestedClauseText: string;
}

const ART92_CLAUSES: Record<string, ClauseSpec> = {
  objeto_vinculacao: {
    id: 'art92-i-ii',
    inciso: 'Art. 92, I e II',
    item: 'Objeto, Especificações e Vinculação ao Edital/TR e Proposta',
    artigo: 'Art. 92, I e II da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Objeto e Vinculação Instrumento-Editalícia (Art. 92, I e II)',
    suggestedClauseText:
      'CLÁUSULA PRIMEIRA – DO OBJETO E DA VINCULAÇÃO: O presente Contrato tem por objeto a execução fiel dos itens/serviços descritos no Termo de Referência, ficando a ele expressamente vinculados o Edital/Aviso de Contratação Direta, o Termo de Referência, o Estudo Técnico Preliminar e a Proposta Comercial vencedora da Contratada, nos termos do Art. 92, incisos I e II, da Lei Federal nº 14.133/2021.'
  },
  regime_legal_omissos: {
    id: 'art92-iii-191',
    inciso: 'Art. 92, III c/c Art. 191',
    item: 'Fundamentação Exclusiva na Lei nº 14.133/2021 e Casos Omissos',
    artigo: 'Art. 92, III e Art. 191 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Regime Jurídico Exclusivo e Casos Omissos (Art. 92, III)',
    suggestedClauseText:
      'CLÁUSULA DE REGÊNCIA LEGAL E CASOS OMISSOS: Este contrato rege-se exclusivamente pela Lei Federal nº 14.133/2021 e normas regulamentares municipais vigentes, vedada a aplicação combinada das Leis revogadas nº 8.666/1993 e nº 10.520/2002 (Art. 191). Os casos omissos serão decididos pelo Contratante segundo os preceitos de direito público e, supletivamente, pelos princípios da teoria geral dos contratos e pelo Código de Defesa do Consumidor (Art. 92, III).'
  },
  regime_execucao: {
    id: 'art92-iv',
    inciso: 'Art. 92, IV',
    item: 'Regime de Execução ou Forma de Fornecimento',
    artigo: 'Art. 92, IV da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula do Regime de Execução / Fornecimento (Art. 92, IV)',
    suggestedClauseText:
      'CLÁUSULA DO REGIME DE EXECUÇÃO: A execução do objeto observará rigorosamente o modelo de execução, cronograma físico-financeiro e forma de fornecimento parcelado/integral definidos no Termo de Referência, nos termos do Art. 92, inciso IV, da Lei nº 14.133/2021.'
  },
  preco_pagamento_atraso: {
    id: 'art92-v-vi',
    inciso: 'Art. 92, V e VI',
    item: 'Preço, Ordem Cronológica de Pagamento e Atualização por Atraso',
    artigo: 'Art. 92, V e VI c/c Art. 141 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Preço, Ordem Cronológica e Atualização Monetária (Art. 92, V e VI)',
    suggestedClauseText:
      'CLÁUSULA DE PAGAMENTO E ATUALIZAÇÃO MONETÁRIA: O pagamento será efetuado em até 30 (trinta) dias após o recebimento definitivo e atesto da Nota Fiscal, respeitada a ordem cronológica por fonte de recursos (Art. 141). Em caso de eventual atraso de pagamento imputável exclusivamente à Administração, o valor devido será atualizado financeiramente pro rata die pelo IPCA-E/IBGE, acrescido de juros de mora de 0,5% ao mês (Art. 92, V e VI).'
  },
  reajuste_database: {
    id: 'art92-v-par3-art25',
    inciso: 'Art. 92, § 3º c/c Art. 25, § 7º',
    item: 'Critério de Reajuste/Repactuação com Data-Base no Orçamento Estimado',
    artigo: 'Art. 92, V, § 3º e Art. 25, § 7º da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Reajuste com Data-Base no Orçamento Estimado (Art. 25, § 7º)',
    suggestedClauseText:
      'CLÁUSULA DO REAJUSTAMENTO: Os preços inicialmente contratados são fixos e irreajustáveis pelo interregno de 1 (um) ano, com data-base vinculada obrigatoriamente à data do orçamento estimado pela Administração (Art. 25, § 7º e Art. 92, § 3º da Lei nº 14.133/2021), sendo reajustados após a anualidade mediante aplicação do índice IPCA/IBGE (ou índice setorial específico do objeto).'
  },
  prazos_reequilibrio: {
    id: 'art92-x-xi',
    inciso: 'Art. 92, X e XI',
    item: 'Prazos de Resposta a Pedidos de Repactuação e Reequilíbrio',
    artigo: 'Art. 92, X, XI e §§ 6º–7º da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Prazo para Análise de Repactuação e Reequilíbrio (Art. 92, X e XI)',
    suggestedClauseText:
      'CLÁUSULA DE PRAZO PARA REEQUILÍBRIO E REPACTUAÇÃO: A Administração responderá formalmente aos pedidos de repactuação de preços e de restabelecimento do equilíbrio econômico-financeiro no prazo máximo de 30 (trinta) dias corridos, contados da conclusão da instrução documental completa pela Contratada, na forma do Art. 92, incisos X e XI e §§ 6º e 7º, da Lei nº 14.133/2021.'
  },
  prazos_recebimento: {
    id: 'art92-vii',
    inciso: 'Art. 92, VII',
    item: 'Prazos de Vigência, Execução e Recebimento Provisório/Definitivo',
    artigo: 'Art. 92, VII c/c Arts. 105 e 140 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Vigência e Recebimento Provisório/Definitivo (Art. 92, VII)',
    suggestedClauseText:
      'CLÁUSULA DE VIGÊNCIA E RECEBIMENTO: O prazo de vigência contratual reger-se-á pelos Arts. 105 a 111 da Lei nº 14.133/2021, realizando-se o recebimento provisório pelo responsável técnico mediante termo detalhado e o recebimento definitivo por servidor/comissão designada após verificação da conformidade integral com o objeto (Art. 140).'
  },
  dotacao_orcamentaria: {
    id: 'art92-viii',
    inciso: 'Art. 92, VIII',
    item: 'Crédito e Dotação Orçamentária',
    artigo: 'Art. 92, VIII e Art. 150 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Dotação Orçamentária (Art. 92, VIII)',
    suggestedClauseText:
      'CLÁUSULA DA DOTAÇÃO ORÇAMENTÁRIA: As despesas decorrentes desta contratação correrão à conta da respectiva dotação orçamentária consignada no orçamento vigente, mediante emissão prévia de Nota de Empenho (Art. 92, VIII e Art. 150 da Lei nº 14.133/2021).'
  },
  matriz_riscos: {
    id: 'art92-ix',
    inciso: 'Art. 92, IX',
    item: 'Matriz de Alocação de Riscos Contratuais',
    artigo: 'Art. 92, IX e Art. 103 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Alocação de Riscos (Art. 92, IX e Art. 103)',
    suggestedClauseText:
      'CLÁUSULA DE MATRIZ DE RISCOS: Aplicam-se a este Contrato as diretrizes de identificação e repartição objetiva de riscos constantes do Mapa de Riscos da fase preparatória, não cabendo pedido de reequilíbrio por eventos alocados expressamente à álea ordinária da Contratada (Art. 103 da Lei nº 14.133/2021).'
  },
  garantia_execucao: {
    id: 'art92-xii',
    inciso: 'Art. 92, XII',
    item: 'Garantia de Execução Contratual e Limites do Art. 96',
    artigo: 'Art. 92, XII e Art. 96 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Garantia Contratual (Art. 92, XII e Art. 96)',
    suggestedClauseText:
      'CLÁUSULA DA GARANTIA CONTRATUAL: Quando exigida no Termo de Referência/Edital, a Contratada prestará garantia de execução limitada a 5% (cinco por cento) do valor inicial do contrato (salvo justificativa técnica até 10% nos termos do Art. 98), podendo optar livremente por caução em dinheiro ou títulos da dívida pública, seguro-garantia ou fiança bancária (Art. 96, § 1º).'
  },
  habilitacao_reserva_pcd: {
    id: 'art92-xvi-xvii',
    inciso: 'Art. 92, XVI e XVII',
    item: 'Manutenção da Habilitação e Reserva de Cargos PcD / Aprendiz',
    artigo: 'Art. 92, XVI e XVII da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Manutenção da Habilitação e Reserva de Cargos PcD (Art. 92, XVI–XVII)',
    suggestedClauseText:
      'CLÁUSULA OBRIGATÓRIA DE HABILITAÇÃO E RESERVA DE CARGOS: A Contratada obriga-se a manter, durante toda a execução do contrato, todas as condições de habilitação e qualificação exigidas na licitação (Art. 92, XVI), bem como a cumprir rigorosamente as exigências de reserva de cargos prevista em lei para pessoa com deficiência (PcD), para reabilitado da Previdência Social e para aprendiz (Art. 92, XVII).'
  },
  gestao_fiscalizacao: {
    id: 'art92-xviii',
    inciso: 'Art. 92, XVIII',
    item: 'Modelo de Gestão, Fiscalização e Preposto',
    artigo: 'Art. 92, XVIII e Arts. 117–118 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Gestão e Fiscalização Contratual (Art. 92, XVIII)',
    suggestedClauseText:
      'CLÁUSULA DE GESTÃO E FISCALIZAÇÃO: A execução do contrato será acompanhada e fiscalizada por Gestor do Contrato, Fiscal Técnico e Fiscal Administrativo formalmente designados pela Administração, com registro próprio de ocorrências (Art. 117) e interlocução por meio de preposto aceito pela Contratada (Art. 118).'
  },
  sancoes_dosimetria: {
    id: 'art92-xiv-155',
    inciso: 'Art. 92, XIV c/c Arts. 155–163',
    item: 'Infrações, Sanções Administrativas e Teto de Multa (30%)',
    artigo: 'Art. 92, XIV e Arts. 155–163 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Sanções Administrativas e Devido Processo Legal (Arts. 155–163)',
    suggestedClauseText:
      'CLÁUSULA DAS SANÇÕES ADMINISTRATIVAS: O descumprimento total ou parcial sujeita a Contratada às sanções de advertência, multa (limitada ao teto de 30% do valor do contrato licitado — Art. 156, § 3º), impedimento de licitar e contratar (até 3 anos) e declaração de inidoneidade (3 a 6 anos), assegurado prévio contraditório e ampla defesa no prazo de 15 (quinze) dias úteis (Arts. 157 e 158).'
  },
  extincao_pncp_foro: {
    id: 'art92-xix-94',
    inciso: 'Art. 92, XIX, § 1º e Art. 94',
    item: 'Extinção Contratual, Publicação no PNCP e Foro da Administração',
    artigo: 'Art. 92, XIX, § 1º, Arts. 137–139 e Art. 94 da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Extinção, Eficácia no PNCP e Foro (Art. 92, XIX, § 1º e Art. 94)',
    suggestedClauseText:
      'CLÁUSULA DE EXTINÇÃO, PUBLICAÇÃO NO PNCP E FORO: O Contrato poderá ser extinto nas hipóteses dos Arts. 137 a 139 da Lei nº 14.133/2021. Sua eficácia fica expressamente condicionada à divulgação no Portal Nacional de Contratações Públicas (PNCP) no prazo de 20 dias úteis (licitação) ou 10 dias úteis (contratação direta), conforme Art. 94. Fica eleito o Foro da Comarca da sede da Administração Contratante (Art. 92, § 1º).'
  },
  lgpd_integridade: {
    id: 'lgpd-integridade',
    inciso: 'LGPD / Integridade',
    item: 'Proteção de Dados Pessoais (LGPD) e Práticas de Integridade',
    artigo: 'Lei nº 13.709/2018 (LGPD) e Art. 155, VIII–XII da Lei nº 14.133/2021',
    suggestedClauseTitle: 'Cláusula de Conformidade com a LGPD e Integridade',
    suggestedClauseText:
      'CLÁUSULA DE PROTEÇÃO DE DADOS E INTEGRIDADE: As partes comprometem-se a cumprir integralmente a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018) no tratamento de dados vinculados à execução contratual, bem como a observar normas de anticorrupção e integridade administrativa.'
  }
};

function evaluateArt92Checklist(
  rawText: string,
  meta: ContractExtractedMetadata,
  institution?: Institution | null
): {
  checklist: ContractChecklistItem[];
  risks: ContractRiskFinding[];
  suggestedClauses: ContractSuggestedClause[];
} {
  const f = fold(rawText);
  const checklist: ContractChecklistItem[] = [];
  const risks: ContractRiskFinding[] = [];
  const suggestedClauses: ContractSuggestedClause[] = [];

  const addClauseSuggestion = (spec: ClauseSpec, reason: string) => {
    suggestedClauses.push({
      clausula: spec.suggestedClauseTitle,
      artigo: spec.artigo,
      motivo: reason,
      texto_sugerido: spec.suggestedClauseText
    });
  };

  // 1. Objeto e Vinculação (Art. 92, I e II)
  {
    const spec = ART92_CLAUSES.objeto_vinculacao;
    const hasObjeto = /\bobjeto\b|clausula\s+primeira/.test(f);
    const hasVinculacao = /vincul|edital|termo\s+de\s+referencia|proposta/.test(f);
    const status = hasObjeto && hasVinculacao ? 'CONFORME' : hasObjeto ? 'RESSALVA' : 'NAO_CONFORME';
    const obs =
      status === 'CONFORME'
        ? `Cláusula de objeto identificada${meta.objeto ? ` ("${meta.objeto.slice(0, 110)}")` : ''} com vinculação expressa ao instrumento convocatório/TR e à proposta.`
        : hasObjeto
          ? 'Objeto presente, porém sem remissão explícita e vinculante ao Edital/TR e à proposta vencedora (Art. 92, II).'
          : 'Não foi identificada cláusula definidora do objeto e da vinculação ao processo licitatório.';
    checklist.push({
      ...spec,
      status,
      observacao: obs,
      ...(status !== 'CONFORME' ? { recomendacao: 'Inserir vinculação expressa ao Edital, TR e proposta vencedora.' } : {})
    });
    if (status === 'NAO_CONFORME') {
      risks.push({
        id: 'risk-objeto',
        severity: 'critical',
        categoria: 'Objeto e Vinculação',
        artigo: spec.artigo,
        titulo: 'Ausência de Definição Clara do Objeto ou Vinculação',
        descricao: obs,
        recomendacao: 'Delimitar o objeto com precisão e vincular expressamente o TR/Edital e a proposta.'
      });
      addClauseSuggestion(spec, obs);
    } else if (status === 'RESSALVA') {
      addClauseSuggestion(spec, obs);
    }
  }

  // 2. Regime Legal Exclusivo Lei 14.133 e Casos Omissos (Art. 92, III c/c Art. 191)
  {
    const spec = ART92_CLAUSES.regime_legal_omissos;
    const hasOmissos = /casos\s+omissos|omiss[aã]o|teoria\s+geral\s+dos\s+contratos/.test(f);
    if (meta.regime_legal_detectado === 'MISTO_LEGADO' || meta.regime_legal_detectado === 'LEI_8666_LEGADO') {
      const msg =
        meta.regime_legal_detectado === 'MISTO_LEGADO'
          ? 'Contrato cita simultaneamente a Lei nº 14.133/2021 e legislação revogada (Lei nº 8.666/1993 ou nº 10.520/2002), violando a vedação expressa à combinação de regimes do Art. 191.'
          : 'Contrato fundamentado na Lei nº 8.666/1993 ou Lei nº 10.520/2002, normas integralmente revogadas desde 30/12/2023 (Art. 193, II da Lei nº 14.133/2021).';
      checklist.push({
        ...spec,
        status: 'NAO_CONFORME',
        observacao: msg,
        recomendacao: 'Excluir qualquer remissão às Leis nº 8.666/1993 e nº 10.520/2002 e adequar integralmente à Lei nº 14.133/2021.'
      });
      risks.push({
        id: 'risk-regime-legado',
        severity: 'critical',
        categoria: 'Fundamentação Legal',
        artigo: 'Art. 191 e Art. 193, II da Lei nº 14.133/2021',
        titulo: 'Citação de Legislação Revogada ou Combinação de Regimes (Lei 8.666 / 10.520)',
        descricao: msg,
        recomendacao: 'Substituir toda a base normativa por dispositivos exclusivos da Lei nº 14.133/2021.'
      });
      addClauseSuggestion(spec, msg);
    } else if (meta.regime_legal_detectado === 'LEI_14133' && hasOmissos) {
      checklist.push({
        ...spec,
        status: 'CONFORME',
        observacao: 'Regência exclusiva pela Lei Federal nº 14.133/2021, com previsão expressa de disciplina para casos omissos.'
      });
    } else if (meta.regime_legal_detectado === 'LEI_14133') {
      const obs = 'Lei nº 14.133/2021 identificada, porém sem cláusula explícita tratando dos casos omissos (Art. 92, III).';
      checklist.push({ ...spec, status: 'RESSALVA', observacao: obs, recomendacao: 'Adicionar regra expressa para resolução dos casos omissos.' });
      addClauseSuggestion(spec, obs);
    } else {
      const obs = 'Não foi identificada referência expressa à Lei Federal nº 14.133/2021 nem disciplina para casos omissos.';
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Declarar expressamente a regência pela Lei nº 14.133/2021.' });
      risks.push({
        id: 'risk-sem-14133',
        severity: 'critical',
        categoria: 'Fundamentação Legal',
        artigo: spec.artigo,
        titulo: 'Ausência de Fundamentação Expressa na Lei nº 14.133/2021',
        descricao: obs,
        recomendacao: 'Explicitar a aplicação da Lei nº 14.133/2021 no preâmbulo e na cláusula de regência.'
      });
      addClauseSuggestion(spec, obs);
    }
  }

  // 3. Regime de Execução / Forma de Fornecimento (Art. 92, IV)
  {
    const spec = ART92_CLAUSES.regime_execucao;
    const hasExec = /regime\s+de\s+execu|forma\s+de\s+fornecimento|modelo\s+de\s+execu|empreitada|ordem\s+de\s+(?:fornecimento|servico)/.test(f);
    checklist.push({
      ...spec,
      status: hasExec ? 'CONFORME' : 'RESSALVA',
      observacao: hasExec
        ? 'Regime de execução ou forma de fornecimento operacionalmente contemplado.'
        : 'Não foi explicitado de forma destacada o regime de execução ou forma de fornecimento (parcelado, imediato, empreitada, etc.).',
      ...(!hasExec ? { recomendacao: 'Explicitar o regime de execução ou forma de entrega conforme o TR.' } : {})
    });
    if (!hasExec) addClauseSuggestion(spec, 'Ausência de especificação do regime de execução (Art. 92, IV).');
  }

  // 4. Preço, Ordem Cronológica e Atualização Monetária por Atraso (Art. 92, V e VI)
  {
    const spec = ART92_CLAUSES.preco_pagamento_atraso;
    const hasPreco = /preco|valor\s+global|valor\s+contratual|pagamento|liquidacao|nota\s+fiscal/.test(f);
    const hasAtraso = /atualizacao\s+monetaria|atraso\s+de\s+pagamento|juros\s+de\s+mora|pro\s+rata\s+die|correcao\s+monetaria/.test(f);
    const status = hasPreco && hasAtraso ? 'CONFORME' : hasPreco ? 'RESSALVA' : 'NAO_CONFORME';
    const obs =
      status === 'CONFORME'
        ? `Cláusula financeira estruturada (${meta.valores_em_aberto ? 'valores mantidos em aberto para pós-adjudicação' : meta.valor_global || 'valor definido'}), contemplando critérios de pagamento e atualização monetária por atraso da Administração.`
        : hasPreco
          ? 'Cláusula de preço/pagamento presente, mas sem critério explícito de atualização monetária nos atrasos imputáveis à Administração (Art. 92, VI / Súmula TCU).'
          : 'Ausência de cláusula de preço e condições de medição/pagamento.';
    checklist.push({
      ...spec,
      status,
      observacao: obs,
      ...(status !== 'CONFORME' ? { recomendacao: 'Incluir prazo de liquidação/pagamento, ordem cronológica (Art. 141) e índice de atualização em atraso.' } : {})
    });
    if (status !== 'CONFORME') {
      if (status === 'NAO_CONFORME') {
        risks.push({
          id: 'risk-pagamento',
          severity: 'critical',
          categoria: 'Condições Financeiras',
          artigo: spec.artigo,
          titulo: 'Cláusula de Preço e Pagamento Ausente',
          descricao: obs,
          recomendacao: 'Inserir cláusula completa de preço, retenções fiscais e pagamento.'
        });
      }
      addClauseSuggestion(spec, obs);
    }
  }

  // 5. Reajuste / Repactuação e Data-Base no Orçamento Estimado (Art. 92, § 3º + Art. 25, § 7º)
  {
    const spec = ART92_CLAUSES.reajuste_database;
    const hasReajuste = /reajust|repactua/.test(f);
    const hasDataBaseOrcamento = /data[\s-]?base[\s\S]{0,60}orcamento\s+estimado|orcamento\s+estimado[\s\S]{0,60}data[\s-]?base/.test(f);
    const hasWrongDataBase =
      !hasDataBaseOrcamento &&
      /(?:data[\s-]?base|anualidade|contad[oa]s?\s+(?:da|a\s+partir\s+da))\s*(?:data\s+da\s+assinatura|assinatura\s+do\s+contrato|apresentacao\s+da\s+proposta)/.test(f);

    if (!hasReajuste) {
      const obs = 'Não foi detectada cláusula de reajustamento ou repactuação com índice oficial e data-base obrigatória (Art. 92, V e § 3º).';
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Inserir índice oficial (IPCA/INCC) e data-base vinculada ao orçamento estimado.' });
      risks.push({
        id: 'risk-sem-reajuste',
        severity: 'critical',
        categoria: 'Equilíbrio Econômico-Financeiro',
        artigo: spec.artigo,
        titulo: 'Ausência de Cláusula Obrigatória de Reajuste / Repactuação',
        descricao: obs,
        recomendacao: 'Prever critério de reajuste obrigatório mesmo para contratos inferiores a 12 meses (Art. 92, § 3º).'
      });
      addClauseSuggestion(spec, obs);
    } else if (hasWrongDataBase) {
      const obs =
        'Cláusula de reajuste vincula a data-base à assinatura ou à proposta, divergindo do comando cogente do Art. 25, § 7º e Art. 92, § 3º (data do orçamento estimado).';
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Corrigir a data-base do reajuste para a data do orçamento estimado pela Administração.' });
      risks.push({
        id: 'risk-database-incorreta',
        severity: 'warning',
        categoria: 'Equilíbrio Econômico-Financeiro',
        artigo: 'Art. 25, § 7º e Art. 92, § 3º',
        titulo: 'Data-Base de Reajuste em Desacordo com o Art. 25, § 7º',
        descricao: obs,
        recomendacao: 'Substituir referência de data-base para a data do orçamento estimado.'
      });
      addClauseSuggestion(spec, obs);
    } else if (hasDataBaseOrcamento && meta.indice_reajuste) {
      checklist.push({
        ...spec,
        status: 'CONFORME',
        observacao: `Critério de reajuste via índice ${meta.indice_reajuste} com data-base expressamente vinculada ao orçamento estimado (Art. 25, § 7º).`
      });
    } else {
      const obs =
        'Cláusula de reajuste presente, mas recomenda-se explicitar de forma inequívoca o índice oficial e a data-base vinculada ao orçamento estimado (Art. 25, § 7º).';
      checklist.push({ ...spec, status: 'RESSALVA', observacao: obs, recomendacao: 'Especificar índice oficial e data exata do orçamento estimado.' });
      addClauseSuggestion(spec, obs);
    }
  }

  // 6. Prazos de Resposta a Pedidos de Repactuação / Reequilíbrio (Art. 92, X e XI)
  {
    const spec = ART92_CLAUSES.prazos_reequilibrio;
    const hasPrazoResp = /(?:prazo\s+(?:para\s+)?resposta|responder|analis[ea])[\s\S]{0,90}(?:repactuac|reequilib|restabelecimento)/.test(f) ||
      /(?:repactuac|reequilib)[\s\S]{0,90}\b\d+\s*\(?[a-z\s]*\)?\s*dias\b/.test(f);
    const status = hasPrazoResp ? 'CONFORME' : 'RESSALVA';
    const obs = hasPrazoResp
      ? 'Prazo administrativo para apreciação de pedidos de repactuação/reequilíbrio devidamente estipulado (Art. 92, X e XI).'
      : 'Não localizado prazo explícito para decisão da Administração sobre pedidos de repactuação e reequilíbrio econômico-financeiro (exigência expressa dos incisos X e XI do Art. 92).';
    checklist.push({ ...spec, status, observacao: obs, ...(!hasPrazoResp ? { recomendacao: 'Fixar prazo objetivo (ex.: até 30 dias / 1 mês conforme §§ 6º e 7º do Art. 92).' } : {}) });
    if (!hasPrazoResp) addClauseSuggestion(spec, obs);
  }

  // 7. Vigência, Prazos de Execução e Recebimento Provisório/Definitivo (Art. 92, VII)
  {
    const spec = ART92_CLAUSES.prazos_recebimento;
    const hasVigencia = /vigencia|duracao\s+contratual|prazo\s+de\s+execucao|prorrogac/.test(f);
    const hasRecebimento = /recebimento\s+provisorio[\s\S]{0,60}definitivo|art\.?\s*140/.test(f);
    const status = hasVigencia && hasRecebimento ? 'CONFORME' : hasVigencia ? 'RESSALVA' : 'NAO_CONFORME';
    const obs =
      status === 'CONFORME'
        ? `Prazos de vigência/execução (${meta.duracao_em_aberto ? 'em aberto para formalização' : meta.vigencia_prazo || 'definidos'}) e rito de recebimento provisório/definitivo (Art. 140) devidamente previstos.`
        : hasVigencia
          ? 'Cláusula de vigência identificada, porém recomenda-se explicitar o procedimento e prazos de recebimento provisório e definitivo (Art. 140).'
          : 'Não foi identificada cláusula de vigência contratual e prazos de entrega/execução (Art. 92, VII).';
    checklist.push({ ...spec, status, observacao: obs, ...(status !== 'CONFORME' ? { recomendacao: 'Detalhar prazo de vigência/execução e recebimento provisório/definitivo.' } : {}) });
    if (status !== 'CONFORME') addClauseSuggestion(spec, obs);
  }

  // 8. Dotação Orçamentária (Art. 92, VIII)
  {
    const spec = ART92_CLAUSES.dotacao_orcamentaria;
    const hasDotacao = /dotacao\s+orcamentaria|credito\s+orcamentario|elemento\s+de\s+despesa|fonte\s+de\s+recurso|empenho\s+previo/.test(f);
    checklist.push({
      ...spec,
      status: hasDotacao ? 'CONFORME' : 'NAO_CONFORME',
      observacao: hasDotacao
        ? 'Indicação de crédito e dotação orçamentária contemplada no instrumento contratual.'
        : 'Ausência de indicação do crédito orçamentário / dotação pela qual correrá a despesa (Art. 92, VIII e Art. 150).',
      ...(!hasDotacao ? { recomendacao: 'Inserir classificação funcional programática, elemento de despesa e fonte.' } : {})
    });
    if (!hasDotacao) {
      risks.push({
        id: 'risk-sem-dotacao',
        severity: 'critical',
        categoria: 'Disciplina Orçamentária',
        artigo: spec.artigo,
        titulo: 'Ausência de Cláusula de Dotação Orçamentária',
        descricao: 'Todo contrato administrativo deve indicar o crédito orçamentário que suportará a despesa (Art. 92, VIII e Art. 150).',
        recomendacao: 'Incluir a Cláusula de Dotação Orçamentária completa antes da assinatura.'
      });
      addClauseSuggestion(spec, 'Dotação orçamentária omitida no texto contratual.');
    }
  }

  // 9. Matriz de Alocação de Riscos (Art. 92, IX)
  {
    const spec = ART92_CLAUSES.matriz_riscos;
    const hasRisco = /matriz\s+de\s+(?:alocacao\s+de\s+)?riscos|mapa\s+de\s+(?:gerenciamento\s+de\s+)?riscos|art\.?\s*103/.test(f);
    checklist.push({
      ...spec,
      status: hasRisco ? 'CONFORME' : 'RESSALVA',
      observacao: hasRisco
        ? 'Matriz/alocação objetiva de riscos referenciada (Art. 92, IX e Art. 103).'
        : 'Sem menção à matriz de alocação de riscos (obrigatória quando adotada na contratação, recomendada como boa prática pelo TCU).',
      ...(!hasRisco ? { recomendacao: 'Vincular ao Mapa de Riscos do planejamento quando aplicável.' } : {})
    });
    if (!hasRisco) addClauseSuggestion(spec, 'Ausência de referência à Matriz de Alocação de Riscos.');
  }

  // 10. Garantia de Execução e Limites do Art. 96 / Art. 98 (Art. 92, XII)
  {
    const spec = ART92_CLAUSES.garantia_execucao;
    const hasGarantia = /garantia\s+(?:de\s+execucao|contratual)|art\.?\s*96|seguro-garantia|fianca\s+bancaria|caucao/.test(f);
    const highGarantiaMatch = f.match(/garantia[\s\S]{0,80}?(\d{1,2})\s*%/);
    const pct = highGarantiaMatch ? Number(highGarantiaMatch[1]) : 0;
    const excesso = pct > 10 && !/grande\s+vulto|30%|art\.?\s*99|complexidade/.test(f);

    if (excesso) {
      const obs = `Percentual de garantia detectado (${pct}%) acima do limite ordinário de 5% / 10% (Arts. 96 e 98 da Lei nº 14.133/2021) sem justificativa de grande vulto.`;
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Adequar garantia ao limite máximo de 5% (ou 10% devidamente motivado).' });
      risks.push({
        id: 'risk-garantia-excessiva',
        severity: 'warning',
        categoria: 'Garantia Contratual',
        artigo: 'Art. 98 da Lei nº 14.133/2021',
        titulo: `Garantia Contratual Superior ao Limite Ordinário (${pct}%)`,
        descricao: obs,
        recomendacao: 'Reduzir para até 5% do valor inicial do contrato ou formalizar justificativa técnica do Art. 98.'
      });
    } else if (hasGarantia) {
      checklist.push({
        ...spec,
        status: 'CONFORME',
        observacao: 'Cláusula de garantia contratual (ou dispensa fundamentada no TR) disciplinada conforme o Art. 96.'
      });
    } else {
      const obs = 'Não encontrada cláusula sobre exigência ou dispensa de garantia de execução contratual (Art. 92, XII).';
      checklist.push({ ...spec, status: 'RESSALVA', observacao: obs, recomendacao: 'Registrar expressamente a exigência ou dispensa motivada de garantia.' });
      addClauseSuggestion(spec, obs);
    }
  }

  // 11. Manutenção da Habilitação e Reserva de Cargos PcD / Aprendiz (Art. 92, XVI e XVII)
  {
    const spec = ART92_CLAUSES.habilitacao_reserva_pcd;
    const hasHab = /manter[\s\S]{0,60}condicoes\s+de\s+habilitacao|art\.?\s*92,\s*xvi/.test(f);
    const hasPcd = /reserva\s+de\s+cargos|pessoa\s+com\s+deficiencia|\bpcd\b|reabilitado\s+da\s+previdencia|aprendiz|art\.?\s*92,\s*xvii/.test(f);
    const status = hasHab && hasPcd ? 'CONFORME' : 'NAO_CONFORME';
    const obs =
      status === 'CONFORME'
        ? 'Contempla expressamente a obrigação de manter as condições de habilitação (Art. 92, XVI) e o cumprimento da reserva legal de cargos para PcD, reabilitados e aprendizes (Art. 92, XVII).'
        : !hasPcd
          ? 'Omissão grave: cláusula obrigatória de cumprimento da reserva de cargos para Pessoa com Deficiência (PcD), reabilitado e aprendiz (Art. 92, XVII) não localizada no instrumento.'
          : 'Obrigação expressa de manutenção das condições de habilitação durante toda a vigência (Art. 92, XVI) não localizada.';
    checklist.push({ ...spec, status, observacao: obs, ...(status !== 'CONFORME' ? { recomendacao: 'Inserir obrigações dos incisos XVI e XVII do Art. 92.' } : {}) });
    if (status !== 'CONFORME') {
      risks.push({
        id: 'risk-pcd-habilitacao',
        severity: 'critical',
        categoria: 'Cláusula Social e Habilitação',
        artigo: spec.artigo,
        titulo: !hasPcd ? 'Ausência de Cláusula Obrigatória de Reserva de Cargos (PcD/Aprendiz)' : 'Ausência de Cláusula de Manutenção da Habilitação',
        descricao: obs,
        recomendacao: 'Incluir redação expressa do Art. 92, incisos XVI e XVII — item de verificação rotineira por Tribunais de Contas.'
      });
      addClauseSuggestion(spec, obs);
    }
  }

  // 12. Modelo de Gestão e Fiscalização Contratual (Art. 92, XVIII c/c Art. 117)
  {
    const spec = ART92_CLAUSES.gestao_fiscalizacao;
    const hasGestao = /gestor\s+do\s+contrato|fiscal\s+tecnico|fiscal\s+administrativo|fiscalizacao|art\.?\s*117|preposto/.test(f);
    checklist.push({
      ...spec,
      status: hasGestao ? 'CONFORME' : 'NAO_CONFORME',
      observacao: hasGestao
        ? 'Modelo de gestão contratual com fiscalização e indicação de preposto disciplinado (Art. 92, XVIII e Arts. 117–118).'
        : 'Não identificado modelo de gestão e fiscalização do contrato nem indicação de preposto da contratada (Art. 92, XVIII).',
      ...(!hasGestao ? { recomendacao: 'Prever atuação de Gestor, Fiscais Técnico/Administrativo e preposto da contratada.' } : {})
    });
    if (!hasGestao) {
      risks.push({
        id: 'risk-sem-fiscalizacao',
        severity: 'warning',
        categoria: 'Gestão e Fiscalização',
        artigo: spec.artigo,
        titulo: 'Ausência de Modelo de Gestão e Fiscalização Contratual',
        descricao: 'A Lei nº 14.133/2021 exige cláusula prevendo o modelo de gestão do contrato (Art. 92, XVIII).',
        recomendacao: 'Inserir cláusula de gestão e fiscalização vinculada ao Art. 117.'
      });
      addClauseSuggestion(spec, 'Modelo de gestão e fiscalização não localizado.');
    }
  }

  // 13. Infrações, Sanções Administrativas e Teto de 30% (Art. 92, XIV c/c Arts. 155–163)
  {
    const spec = ART92_CLAUSES.sancoes_dosimetria;
    const hasSancoes = /infrac|sancoes|penalidades|advertencia|multa|impedimento\s+de\s+licitar|inidoneidade|art\.?\s*155/.test(f);
    const hasDefesa15 = /15\s*(?:\(\s*quinze\s*\)\s*)?dias\s+uteis|contraditorio\s+e\s+(?:a\s+)?ampla\s+defesa/.test(f);
    const multasMatches = [...f.matchAll(/multa[\s\S]{0,60}?(\d{1,3})\s*%/g)].map((m) => Number(m[1]));
    const multaExcedeTeto = multasMatches.some((v) => v > 30);

    if (multaExcedeTeto) {
      const maxPct = Math.max(...multasMatches);
      const obs = `Identificada multa contratual de ${maxPct}%, excedendo o teto legal absoluto de 30% do valor do contrato imposto pelo Art. 156, § 3º da Lei nº 14.133/2021.`;
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Limitar a multa contratual ao teto legal entre 0,5% e 30%.' });
      risks.push({
        id: 'risk-multa-ilegal',
        severity: 'critical',
        categoria: 'Regime Sancionatório',
        artigo: 'Art. 156, § 3º da Lei nº 14.133/2021',
        titulo: `Multa Sancionatória Acima do Teto Legal de 30% (${maxPct}%)`,
        descricao: obs,
        recomendacao: 'Corrigir os percentuais de dosimetria para respeitar o intervalo de 0,5% a 30%.'
      });
      addClauseSuggestion(spec, obs);
    } else if (!hasSancoes) {
      const obs = 'Não localizada cláusula de infrações e sanções administrativas (Art. 92, XIV e Arts. 155–163).';
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Inserir quadro de dosimetria e sanções do Art. 156.' });
      risks.push({
        id: 'risk-sem-sancoes',
        severity: 'critical',
        categoria: 'Regime Sancionatório',
        artigo: spec.artigo,
        titulo: 'Ausência de Cláusula de Penalidades e Dosimetria',
        descricao: obs,
        recomendacao: 'Detalhar infrações (Art. 155), sanções (Art. 156) e rito de defesa prévia.'
      });
      addClauseSuggestion(spec, obs);
    } else if (!hasDefesa15) {
      const obs = 'Sanções previstas, porém recomenda-se explicitar o prazo legal de 15 dias úteis para defesa prévia e recurso (Arts. 157, 158 e 166).';
      checklist.push({ ...spec, status: 'RESSALVA', observacao: obs, recomendacao: 'Explicitar o prazo de 15 dias úteis para defesa prévia e recurso.' });
      addClauseSuggestion(spec, obs);
    } else {
      checklist.push({
        ...spec,
        status: 'CONFORME',
        observacao: 'Regime sancionatório proporcional conforme Arts. 155 a 163, respeitando o teto de multa de 30% e garantia de defesa em 15 dias úteis.'
      });
    }
  }

  // 14. Extinção, PNCP (Art. 94) e Foro (Art. 92, XIX e § 1º)
  {
    const spec = ART92_CLAUSES.extincao_pncp_foro;
    const hasExtincao = /extincao|rescisao|art\.?\s*137/.test(f);
    const hasPncp = /pncp|portal\s+nacional\s+de\s+contratacoes\s+publicas/.test(f);
    const hasForo = /\bforo\b|comarca/.test(f);
    const hasForoSedeMismatch =
      Boolean(institution?.municipio && meta.foro) &&
      !fold(meta.foro || '').includes(fold(institution!.municipio)) &&
      !/sede\s+da\s+administracao/.test(f);

    if (hasForoSedeMismatch) {
      const obs = `O foro indicado ("${meta.foro}") diverge da comarca da sede da Administração (${institution?.municipio}/${institution?.uf}), contrariando o Art. 92, § 1º.`;
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: `Alterar o foro para a Comarca de ${institution?.municipio}/${institution?.uf}.` });
      risks.push({
        id: 'risk-foro-divergente',
        severity: 'critical',
        categoria: 'Foro e Eficácia',
        artigo: 'Art. 92, § 1º da Lei nº 14.133/2021',
        titulo: 'Foro Contratual Divergente da Sede da Administração',
        descricao: obs,
        recomendacao: `Fixar obrigatoriamente o foro da sede da Administração (${institution?.municipio}/${institution?.uf}).`
      });
      addClauseSuggestion(spec, obs);
    } else if (hasExtincao && hasPncp && hasForo) {
      checklist.push({
        ...spec,
        status: 'CONFORME',
        observacao: 'Prevê hipóteses de extinção (Arts. 137–139), divulgação no PNCP como condição de eficácia (Art. 94) e foro da sede administrativa (Art. 92, § 1º).'
      });
    } else if (!hasPncp) {
      const obs = 'Falta previsão expressa de divulgação no Portal Nacional de Contratações Públicas (PNCP) como condição indispensável de eficácia (Art. 94 da Lei nº 14.133/2021).';
      checklist.push({ ...spec, status: 'NAO_CONFORME', observacao: obs, recomendacao: 'Inserir prazo de divulgação no PNCP (20 dias úteis licitação / 10 dias úteis contratação direta).' });
      risks.push({
        id: 'risk-sem-pncp',
        severity: 'critical',
        categoria: 'Publicidade e Eficácia',
        artigo: 'Art. 94 da Lei nº 14.133/2021',
        titulo: 'Ausência de Condição de Eficácia via Publicação no PNCP',
        descricao: obs,
        recomendacao: 'Incluir menção expressa à divulgação no PNCP sob pena de ineficácia do contrato.'
      });
      addClauseSuggestion(spec, obs);
    } else {
      const obs = 'Necessário assegurar presença conjunta das hipóteses de extinção (Arts. 137–139), publicação PNCP e foro da sede da Administração.';
      checklist.push({ ...spec, status: 'RESSALVA', observacao: obs, recomendacao: 'Complementar cláusulas finais de extinção e foro.' });
      addClauseSuggestion(spec, obs);
    }
  }

  // 15. Governança Municipal (LGPD / Integridade + Representação Executiva se aplicável)
  {
    const spec = ART92_CLAUSES.lgpd_integridade;
    const hasLgpd = /\blgpd\b|13\.?709|protecao\s+de\s+dados/.test(f);
    const mentionsMunicipioContract = /municipio|prefeitura/.test(f);
    const secInPreambulo =
      mentionsMunicipioContract &&
      meta.representante_cargo === 'Secretário(a) / Ordenador(a)' &&
      !/prefeit[oa]/i.test(meta.representante_contratante || '');

    if (secInPreambulo) {
      const obs = `Preâmbulo municipal indica representação contratual por "${meta.representante_contratante}" sem participação exclusiva do(a) Prefeito(a) Municipal.`;
      checklist.push({
        ...spec,
        status: 'RESSALVA',
        observacao: `${obs} ${hasLgpd ? 'Cláusula de LGPD presente.' : 'Cláusula de LGPD não identificada.'}`,
        recomendacao: 'Verificar competência signatária exclusiva do Chefe do Executivo Municipal conforme padrão institucional e incluir LGPD.'
      });
      risks.push({
        id: 'risk-preambulo-signatario',
        severity: 'warning',
        categoria: 'Representação e Governança',
        artigo: 'Art. 89 c/c Lei Orgânica Municipal',
        titulo: 'Representação no Preâmbulo por Secretário/Ordenador em vez do Prefeito',
        descricao: obs,
        recomendacao: 'Adequar qualificação e assinatura do Contratante ao Chefe do Poder Executivo (Prefeito Municipal), salvo decreto expresso de delegação.'
      });
    } else if (hasLgpd) {
      checklist.push({
        ...spec,
        status: 'CONFORME',
        observacao: 'Cláusula de proteção de dados pessoais (LGPD — Lei nº 13.709/2018) e governança institucional adequadamente contemplada.'
      });
    } else {
      const obs = 'Não foi identificada cláusula de proteção de dados pessoais (LGPD — Lei nº 13.709/2018) e integridade.';
      checklist.push({ ...spec, status: 'RESSALVA', observacao: obs, recomendacao: 'Adicionar cláusula padrão de proteção de dados (LGPD).' });
      addClauseSuggestion(spec, obs);
    }
  }

  return { checklist, risks, suggestedClauses };
}

function computeVerdictAndScore(
  checklist: ContractChecklistItem[],
  risks: ContractRiskFinding[]
): { score: number; verdict: ContractVerdict } {
  const total = Math.max(checklist.length, 1);
  const points = checklist.reduce((acc, item) => {
    if (item.status === 'CONFORME') return acc + 1;
    if (item.status === 'RESSALVA') return acc + 0.5;
    return acc;
  }, 0);
  const score = Math.round((points / total) * 100);

  const criticalRisks = risks.filter((r) => r.severity === 'critical').length;
  const naoConformeCount = checklist.filter((c) => c.status === 'NAO_CONFORME').length;
  const ressalvaCount = checklist.filter((c) => c.status === 'RESSALVA').length;

  let verdict: ContractVerdict = 'APROVADO';
  if (criticalRisks > 0 || naoConformeCount >= 3 || score < 60) {
    verdict = 'REPROVADO_SANEAMENTO';
  } else if (naoConformeCount > 0 || ressalvaCount > 0 || risks.some((r) => r.severity === 'warning')) {
    verdict = 'APROVADO_COM_RESSALVAS';
  }

  return { score, verdict };
}

function verdictLabelText(verdict: ContractVerdict): string {
  switch (verdict) {
    case 'APROVADO':
      return 'APROVADO — CONFORMIDADE INTEGRAL COM A LEI Nº 14.133/2021';
    case 'APROVADO_COM_RESSALVAS':
      return 'APROVADO COM RESSALVAS — RECOMENDADO AJUSTE ANTES DA ASSINATURA';
    case 'REPROVADO_SANEAMENTO':
      return 'REPROVADO PARA SANEAMENTO — INCONFORMIDADES CRÍTICAS DETECTADAS';
  }
}

export function buildContractAnalysisReportHtml(params: {
  title: string;
  institution?: Institution | null;
  sourceFilename?: string | null;
  analysisFocus?: string;
  verdict: ContractVerdict;
  complianceScore: number;
  summary: string;
  metadata: ContractExtractedMetadata;
  checklist: ContractChecklistItem[];
  risks: ContractRiskFinding[];
  suggestedClauses: ContractSuggestedClause[];
  tcuPrecedents: TcuPrecedent[];
  aiNarrativeHtml?: string | null;
}): string {
  const {
    title,
    institution,
    sourceFilename,
    analysisFocus,
    verdict,
    complianceScore,
    summary,
    metadata,
    checklist,
    risks,
    suggestedClauses,
    tcuPrecedents,
    aiNarrativeHtml
  } = params;

  const statusBadge: Record<ContractChecklistItem['status'], string> = {
    CONFORME: 'Conforme',
    RESSALVA: 'Ressalva',
    NAO_CONFORME: 'Não Conforme'
  };

  const regimeLabels: Record<ContractExtractedMetadata['regime_legal_detectado'], string> = {
    LEI_14133: 'Lei Federal nº 14.133/2021 (Exclusivo)',
    MISTO_LEGADO: 'HÍBRIDO IRREGULAR (Lei 14.133 + Lei 8.666/10.520 — Vedado pelo Art. 191)',
    LEI_8666_LEGADO: 'LEGISLAÇÃO REVOGADA (Lei 8.666/1993 ou 10.520/2002)',
    NAO_IDENTIFICADO: 'Não identificado expressamente no texto'
  };

  const checklistRows = checklist
    .map(
      (c) => `
      <tr>
        <td><strong>${escapeHtml(c.inciso)}</strong></td>
        <td>${escapeHtml(c.item)}</td>
        <td><strong>${statusBadge[c.status]}</strong></td>
        <td>${escapeHtml(c.observacao)}${c.recomendacao ? ` <em>(Recomendação: ${escapeHtml(c.recomendacao)})</em>` : ''}</td>
      </tr>`
    )
    .join('');

  const risksSectionHtml =
    risks.length === 0
      ? '<p>Nenhum risco jurídico crítico ou moderado identificado na análise do texto contratual.</p>'
      : `<table>
          <thead>
            <tr>
              <th>Severidade</th>
              <th>Categoria / Base Legal</th>
              <th>Achado e Recomendação Saneadora</th>
            </tr>
          </thead>
          <tbody>
            ${risks
              .map(
                (r) => `
              <tr>
                <td><strong>${r.severity === 'critical' ? 'CRÍTICO' : r.severity === 'warning' ? 'ATENÇÃO' : 'INFO'}</strong></td>
                <td>${escapeHtml(r.categoria)}<br/><em>${escapeHtml(r.artigo)}</em></td>
                <td><strong>${escapeHtml(r.titulo)}</strong><br/>${escapeHtml(r.descricao)}<br/><strong>Providência:</strong> ${escapeHtml(r.recomendacao)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`;

  const clausesSectionHtml =
    suggestedClauses.length === 0
      ? '<p>Todas as cláusulas essenciais analisadas encontram-se contempladas sem necessidade de acréscimo corretivo.</p>'
      : suggestedClauses
          .map(
            (sc, i) => `
          <h4>${i + 1}. ${escapeHtml(sc.clausula)} (${escapeHtml(sc.artigo)})</h4>
          <p><strong>Motivo do ajuste:</strong> ${escapeHtml(sc.motivo)}</p>
          <blockquote class="exec-summary">${escapeHtml(sc.texto_sugerido)}</blockquote>`
          )
          .join('\n');

  const tcuRowsHtml = tcuPrecedents
    .map(
      (p) => `
      <tr>
        <td><strong>${escapeHtml(p.numero)} (${escapeHtml(p.colegiado)})</strong></td>
        <td>${escapeHtml(p.tema_label)} — ${escapeHtml(p.artigos_relacionados)}</td>
        <td>${escapeHtml(p.ementa)}</td>
      </tr>`
    )
    .join('');

  return normalizeUtf8Text(`
    <div class="gov-doc">
      <h2>PARECER TÉCNICO-JURÍDICO DE ANÁLISE CONTRATUAL (LEI Nº 14.133/2021)</h2>
      <table class="meta-table">
        <tbody>
          <tr><td><strong>Título da Análise</strong></td><td>${escapeHtml(title)}</td></tr>
          <tr><td><strong>Órgão / Município</strong></td><td>${escapeHtml(institution?.razao_social || metadata.contratante || 'Não especificado')}</td></tr>
          <tr><td><strong>Documento Analisado</strong></td><td>${escapeHtml(sourceFilename || 'Texto contratual submetido diretamente')}</td></tr>
          <tr><td><strong>Índice de Conformidade Art. 92</strong></td><td><strong>${complianceScore}%</strong> — ${escapeHtml(verdictLabelText(verdict))}</td></tr>
          <tr><td><strong>Regime Normativo Detectado</strong></td><td>${escapeHtml(regimeLabels[metadata.regime_legal_detectado])}</td></tr>
          ${analysisFocus ? `<tr><td><strong>Foco Solicitado pelo Gestor</strong></td><td>${escapeHtml(analysisFocus)}</td></tr>` : ''}
        </tbody>
      </table>

      <blockquote class="exec-summary">
        <strong>Síntese Executiva da Auditoria Contratual:</strong> ${escapeHtml(summary)}
      </blockquote>

      <h3>1. Qualificação e Metadados Extraídos do Contrato</h3>
      <table class="meta-table">
        <tbody>
          <tr><td><strong>Contrato / Processo</strong></td><td>Contrato: ${escapeHtml(metadata.numero_contrato || 'Em aberto / Não informado')} &bull; Processo: ${escapeHtml(metadata.processo_referencia || 'Não identificado')}</td></tr>
          <tr><td><strong>Objeto Contratual</strong></td><td>${escapeHtml(metadata.objeto || 'Consultar cláusula primeira do instrumento')}</td></tr>
          <tr><td><strong>Contratante / CNPJ</strong></td><td>${escapeHtml(metadata.contratante || 'Não identificado')} (${escapeHtml(metadata.cnpj_contratante || 'CNPJ não informado')})</td></tr>
          <tr><td><strong>Representante Legal (Contratante)</strong></td><td>${escapeHtml(metadata.representante_contratante || 'Não identificado')} ${metadata.representante_cargo ? `(${escapeHtml(metadata.representante_cargo)})` : ''}</td></tr>
          <tr><td><strong>Contratada / CNPJ</strong></td><td>${escapeHtml(metadata.contratada || 'Em aberto / A preencher')} ${metadata.cnpj_contratada ? `(${escapeHtml(metadata.cnpj_contratada)})` : ''}</td></tr>
          <tr><td><strong>Valor Global</strong></td><td>${escapeHtml(metadata.valor_global || 'Não identificado')}</td></tr>
          <tr><td><strong>Vigência / Duração</strong></td><td>${escapeHtml(metadata.vigencia_prazo || 'Não identificada')}</td></tr>
          <tr><td><strong>Reajuste e Data-Base</strong></td><td>${escapeHtml(metadata.indice_reajuste || 'Não especificado')} ${metadata.data_base_orcamento ? `(${escapeHtml(metadata.data_base_orcamento)})` : ''}</td></tr>
          <tr><td><strong>Garantia / Foro</strong></td><td>${escapeHtml(metadata.garantia_contratual || 'Sem indicação destacada')} &bull; Foro: ${escapeHtml(metadata.foro || 'Não identificado')}</td></tr>
        </tbody>
      </table>

      ${aiNarrativeHtml ? `<h3>2. Análise Crítica Complementar (IA Jurídica)</h3>${aiNarrativeHtml}` : ''}

      <h3>${aiNarrativeHtml ? '3' : '2'}. Riscos Jurídicos e Pontos Críticos Identificados</h3>
      ${risksSectionHtml}

      <h3>${aiNarrativeHtml ? '4' : '3'}. Checklist de Conformidade Legal — Art. 92 da Lei nº 14.133/2021</h3>
      <table>
        <thead>
          <tr>
            <th>Base Legal</th>
            <th>Requisito Contratual</th>
            <th>Status</th>
            <th>Análise e Fundamentação</th>
          </tr>
        </thead>
        <tbody>
          ${checklistRows}
        </tbody>
      </table>

      <h3>${aiNarrativeHtml ? '5' : '4'}. Cláusulas Corretivas Sugeridas para Saneamento</h3>
      ${clausesSectionHtml}

      <h3>${aiNarrativeHtml ? '6' : '5'}. Jurisprudência Aplicável do TCU</h3>
      <table>
        <thead>
          <tr>
            <th>Precedente</th>
            <th>Tema e Base Normativa</th>
            <th>Entendimento Consolidado</th>
          </tr>
        </thead>
        <tbody>
          ${tcuRowsHtml}
        </tbody>
      </table>

      <p>Emitido eletronicamente pelo módulo de Análise de Contratos GOVFLOW 14.133 em ${formatDateBR(new Date())}.</p>
    </div>
  `.trim());
}

export async function analyzeContract(input: AnalyzeContractInput): Promise<AnalyzeContractOutput> {
  const cleanText = normalizeUtf8Text(input.contractText || '').trim();
  if (cleanText.length < 40) {
    throw new Error('Forneça o texto ou arquivo do contrato com pelo menos 40 caracteres para executar a análise jurídica.');
  }

  const metadata = extractContractMetadata(cleanText, input.institution);
  const { checklist, risks, suggestedClauses } = evaluateArt92Checklist(
    cleanText,
    metadata,
    input.institution
  );

  // Seleciona precedentes TCU relevantes ao conteúdo do contrato
  const tcuPrecedents = selectContextualTcuPrecedents({
    proc: {
      titulo_resumido: metadata.objeto || input.title || cleanText.slice(0, 200),
      demanda_bruta: cleanText.slice(0, 1200),
      modalidade: 'PREGAO_ELETRONICO',
      tipo_contratacao: /obra|engenharia|reforma|paviment/i.test(cleanText)
        ? 'OBRAS_ENGENHARIA'
        : /servic|continuo|terceiriz|vigilancia|limpeza/i.test(cleanText)
          ? 'SERVICOS'
          : 'AQUISICAO',
      usar_srp: /ata\s+de\s+registro\s+de\s+precos|\bsrp\b/i.test(cleanText),
      tcu_acordaos_vinculados: []
    }
  }).slice(0, 6);

  let finalRisks = [...risks];
  let finalClauses = [...suggestedClauses];
  let aiNarrativeHtml: string | null = null;
  let aiSummaryOverride: string | null = null;
  let aiProviderUsed = 'Motor Jurídico Auditor 14.133 (Local)';

  // Enriquece via Gemini / OpenAI quando credenciado para o usuário (mantendo blindagem determinística)
  const excerptForLlm = cleanText.length > 26000 ? `${cleanText.slice(0, 26000)}\n\n[...TEXTO TRUNCADO PARA ANÁLISE...]` : cleanText;
  const llmRes = await tryGenerateWithLlm({
    userId: input.userId,
    agentNumber: 10,
    agentTitle: 'Auditor Jurídico de Contratos Administrativos (Art. 92 — Lei nº 14.133/2021)',
    legalBasis: 'Arts. 89 a 95, Art. 92, Art. 25 § 7º e Arts. 155 a 163 da Lei nº 14.133/2021',
    systemPrompt: `Você é um Procurador Jurídico especialista em Contratos Administrativos sob a Lei Federal nº 14.133/2021 e jurisprudência do TCU.
Sua tarefa é auditar o contrato/minuta enviado pelo usuário com rigor forense, identificando cláusulas ilegais, abusivas, omissas, erros de data-base de reajuste, ausência de reserva de cargos PcD, aplicação indevida da revogada Lei 8.666/93 e riscos de execução.`,
    userPrompt: `### CONTRATO SUBMETIDO À AUDITORIA:
${excerptForLlm}

### FOCO ADICIONAL DO GESTOR:
${input.analysisFocus?.trim() || 'Auditoria completa de conformidade com o Art. 92 e controle preventivo TCU.'}

### ACHADOS DETERMINÍSTICOS JÁ DETECTADOS (NÃO OMITA RISCOS CRÍTICOS):
${JSON.stringify({ metadata, checklist_resumo: checklist.map((c) => ({ inciso: c.inciso, status: c.status, observacao: c.observacao })) })}

Retorne JSON com:
- "structured_json": { "resumo_executivo": "texto objetivo em 2-3 frases", "clausulas_sugeridas_extras": [{ "clausula": "...", "artigo": "...", "motivo": "...", "texto_sugerido": "..." }] }
- "html_content": "<div>...parágrafos analíticos objetivos sobre qualidade redacional, riscos de execução e aditivos...</div>"
- "legal_alerts": achados jurídicos relevantes adicionais`
  });

  if (llmRes) {
    aiProviderUsed = llmRes.providerLabel;
    if (typeof llmRes.structured_json?.resumo_executivo === 'string' && llmRes.structured_json.resumo_executivo.trim()) {
      aiSummaryOverride = normalizeUtf8Text(llmRes.structured_json.resumo_executivo.trim());
    }
    if (llmRes.html_content && llmRes.html_content.trim()) {
      aiNarrativeHtml = llmRes.html_content.trim();
    }
    if (Array.isArray(llmRes.legal_alerts) && llmRes.legal_alerts.length > 0) {
      const existingTitles = new Set(finalRisks.map((r) => fold(r.titulo)));
      for (const a of llmRes.legal_alerts) {
        if (!existingTitles.has(fold(a.title))) {
          existingTitles.add(fold(a.title));
          finalRisks.push({
            id: a.id || `llm-risk-${finalRisks.length + 1}`,
            severity: a.severity,
            categoria: 'Análise Jurídica Complementar (IA)',
            artigo: a.article,
            titulo: a.title,
            descricao: a.message,
            recomendacao: a.recommendation || 'Revisar redação contratual junto à Procuradoria Jurídica.'
          });
        }
      }
    }
    if (Array.isArray(llmRes.structured_json?.clausulas_sugeridas_extras)) {
      const seenClauses = new Set(finalClauses.map((c) => fold(c.clausula)));
      for (const extra of llmRes.structured_json.clausulas_sugeridas_extras) {
        if (extra && typeof extra.clausula === 'string' && typeof extra.texto_sugerido === 'string' && !seenClauses.has(fold(extra.clausula))) {
          seenClauses.add(fold(extra.clausula));
          finalClauses.push({
            clausula: normalizeUtf8Text(extra.clausula),
            artigo: normalizeUtf8Text(String(extra.artigo || 'Lei nº 14.133/2021')),
            motivo: normalizeUtf8Text(String(extra.motivo || 'Aprimoramento jurídico recomendado pela IA')),
            texto_sugerido: normalizeUtf8Text(extra.texto_sugerido)
          });
        }
      }
    }
  }

  const { score, verdict } = computeVerdictAndScore(checklist, finalRisks);
  const naoConformes = checklist.filter((c) => c.status === 'NAO_CONFORME').length;
  const ressalvas = checklist.filter((c) => c.status === 'RESSALVA').length;
  const conformes = checklist.filter((c) => c.status === 'CONFORME').length;

  const summary =
    aiSummaryOverride ||
    `Auditoria de ${checklist.length} requisitos da Lei nº 14.133/2021 (Art. 92 e correlatos) obteve índice de conformidade de ${score}%: ${conformes} item(ns) conforme(s), ${ressalvas} ressalva(s) e ${naoConformes} não conformidade(s), com ${finalRisks.filter((r) => r.severity === 'critical').length} alerta(s) crítico(s).`;

  const resolvedTitle =
    (input.title || '').trim() ||
    (metadata.numero_contrato ? `Análise do Contrato nº ${metadata.numero_contrato}` : '') ||
    (input.sourceFilename ? `Análise — ${input.sourceFilename}` : '') ||
    (metadata.objeto ? `Análise — ${metadata.objeto.slice(0, 72)}` : 'Análise de Contrato Administrativo (Lei 14.133/2021)');

  const reportHtml = buildContractAnalysisReportHtml({
    title: resolvedTitle,
    institution: input.institution,
    sourceFilename: input.sourceFilename,
    analysisFocus: input.analysisFocus,
    verdict,
    complianceScore: score,
    summary,
    metadata,
    checklist,
    risks: finalRisks,
    suggestedClauses: finalClauses,
    tcuPrecedents,
    aiNarrativeHtml
  });

  return {
    title: normalizeUtf8Text(resolvedTitle),
    verdict,
    compliance_score: score,
    summary: normalizeUtf8Text(summary),
    extracted_metadata: metadata,
    checklist_art92: checklist,
    risk_findings: finalRisks,
    suggested_clauses: finalClauses,
    tcu_precedents: tcuPrecedents,
    report_html: reportHtml,
    ai_provider_used: aiProviderUsed
  };
}
