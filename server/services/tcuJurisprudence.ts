import type {
  ProcurementProcess,
  TcuJurisprudenceTheme,
  TcuPrecedent
} from '../../shared/types.js';
import { normalizeUtf8Text } from '../../shared/typography.js';

export const TCU_THEME_LABELS: Record<TcuJurisprudenceTheme, string> = {
  PESQUISA_PRECOS: 'Pesquisa de Preços (Art. 23)',
  SEGREGACAO_FUNCOES: 'Segregação de Funções (Art. 7º, § 1º)',
  EXIGENCIAS_RESTRITIVAS: 'Vedação a Restrição e Marca (Arts. 9º e 41)',
  PARCELAMENTO_OBJETO: 'Parcelamento do Objeto (Art. 40, § 2º)',
  HABILITACAO: 'Habilitação Técnica e Econômica (Arts. 62–69)',
  CONTROLE_PREVIO_ART53: 'Controle Prévio Jurídico (Art. 53 / LINDB)',
  PLANEJAMENTO_RISCOS: 'Planejamento, ETP e Matriz de Riscos (Art. 18)',
  SRP: 'Sistema de Registro de Preços (Arts. 82–86)'
};

export const TCU_JURISPRUDENCE_CATALOG: TcuPrecedent[] = [
  {
    id: 'tcu-ac-1875-2021-p',
    numero: 'Acórdão nº 1.875/2021 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'PESQUISA_PRECOS',
    tema_label: TCU_THEME_LABELS.PESQUISA_PRECOS,
    artigos_relacionados: 'Art. 23, § 1º da Lei nº 14.133/2021 e IN SEGES/ME nº 65/2021',
    ementa:
      'A pesquisa de preços para fins de orçamento estimativo deve compor cesta ampla e diversificada de referências (PNCP, Painel de Preços e contratações similares públicas), tratando a pesquisa exclusiva com fornecedores como medida subsidiária e excepcional ante o risco de sobrepreço.',
    aplicacao_pratica:
      'Exige validação da diversidade de fontes da cesta de preços que lastreia o ETP e o Termo de Referência antes da abertura da licitação.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-1712-2025-p',
    numero: 'Acórdão nº 1.712/2025 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'PESQUISA_PRECOS',
    tema_label: TCU_THEME_LABELS.PESQUISA_PRECOS,
    artigos_relacionados: 'Art. 9º, Art. 23, § 1º e Art. 41 da Lei nº 14.133/2021',
    ementa:
      'Reitera o caráter subsidiário da cotação restrita a fornecedores privados na formação do valor referencial e firma a irregularidade de exigir normas técnicas ou certificações específicas no edital sem justificativa técnica prévia e robusta nos autos.',
    aplicacao_pratica:
      'Audita simultaneamente a solidez da pesquisa de preços e a motivação técnica de quaisquer exigências de certificação no Termo de Referência e no Edital.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-1855-2025-p',
    numero: 'Acórdão nº 1.855/2025 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'PESQUISA_PRECOS',
    tema_label: TCU_THEME_LABELS.PESQUISA_PRECOS,
    artigos_relacionados: 'Art. 23 da Lei nº 14.133/2021',
    ementa:
      'Embora lícita a consulta ampla a contratações de outras localidades para robustecer a amostra estatística, o orçamento estimado deve ponderar as peculiaridades do mercado local, custos logísticos, tributários e fretes, evitando valores inexequíveis ou distorcidos.',
    aplicacao_pratica:
      'Orienta a verificação de exequibilidade dos preços de referência à luz da realidade logística municipal e regional.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-318-2026-p',
    numero: 'Acórdão nº 318/2026 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'PESQUISA_PRECOS',
    tema_label: TCU_THEME_LABELS.PESQUISA_PRECOS,
    artigos_relacionados: 'Art. 23 e Art. 141 da Lei nº 14.133/2021',
    ementa:
      'Os valores apurados na pesquisa de preços devem guardar estrita compatibilidade com as condições efetivas de liquidação e pagamento previstas no edital e na minuta contratual (preços à vista vs. pagamento parcelado), evitando encargos financeiros ocultos.',
    aplicacao_pratica:
      'Vincula a coerência entre os prazos de pagamento da Cláusula Quinta do Contrato e a metodologia de apuração do orçamento estimativo.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-2829-2015-p',
    numero: 'Acórdão nº 2.829/2015 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'SEGREGACAO_FUNCOES',
    tema_label: TCU_THEME_LABELS.SEGREGACAO_FUNCOES,
    artigos_relacionados: 'Art. 5º, Art. 7º, § 1º e Art. 41 da Lei nº 14.133/2021',
    ementa:
      'O detalhamento excessivo de especificações técnicas sem comprovação de pluralidade de fabricantes configura direcionamento ilícito; ademais, impõe-se a segregação de funções entre agentes do planejamento interno e a condução da fase externa do certame.',
    aplicacao_pratica:
      'Fundamenta a verificação da neutralidade descritiva no TR e a separação entre equipe de planejamento (Peças 01–05) e pregoeiro/fiscais.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-1264-2019-p',
    numero: 'Acórdão nº 1.264/2019 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'EXIGENCIAS_RESTRITIVAS',
    tema_label: TCU_THEME_LABELS.EXIGENCIAS_RESTRITIVAS,
    artigos_relacionados: 'Art. 9º, I, Art. 41 da Lei nº 14.133/2021 e Art. 28 da LINDB',
    ementa:
      'O direcionamento injustificado de licitação para marca ou modelo específico sem respaldo técnico idôneo, bem como o afastamento imotivado do parecer jurídico, caracterizam erro grosseiro sujeito à responsabilização pessoal do gestor público.',
    aplicacao_pratica:
      'Reforça o dever de vedação absoluta a preferências de marca (salvo padronização tecnicamente motivada no Art. 41, I) e o peso vinculante das ressalvas jurídicas.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-522-2022-p',
    numero: 'Acórdão nº 522/2022 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'EXIGENCIAS_RESTRITIVAS',
    tema_label: TCU_THEME_LABELS.EXIGENCIAS_RESTRITIVAS,
    artigos_relacionados: 'Art. 9º, I, "a", Art. 11 e Art. 40 da Lei nº 14.133/2021',
    ementa:
      'Especificações técnicas excessivas ou desproporcionais às reais necessidades operacionais da Administração restringem indevidamente o universo de licitantes e comprometem a obtenção da proposta mais vantajosa.',
    aplicacao_pratica:
      'Valida se as características técnicas do TR atendem estritamente à funcionalidade pretendida sem barreiras supérfluas.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-1092-2026-p',
    numero: 'Acórdão nº 1.092/2026 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'EXIGENCIAS_RESTRITIVAS',
    tema_label: TCU_THEME_LABELS.EXIGENCIAS_RESTRITIVAS,
    artigos_relacionados: 'Art. 9º, I e Art. 67 da Lei nº 14.133/2021',
    ementa:
      'A exigência editalícia cumulativa de certificações internacionais ou selos de qualidade privados sem demonstração de essencialidade no Estudo Técnico Preliminar viola a isonomia e restringe a competitividade.',
    aplicacao_pratica:
      'Determina o expurgo de certificações não obrigatórias em lei na fase de habilitação, admitindo-as apenas quando motivadas ou como critério objetivo previsto em norma.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-2599-2021-p',
    numero: 'Acórdão nº 2.599/2021 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'CONTROLE_PREVIO_ART53',
    tema_label: TCU_THEME_LABELS.CONTROLE_PREVIO_ART53,
    artigos_relacionados: 'Art. 53, § 3º da Lei nº 14.133/2021 e Art. 28 da LINDB',
    ementa:
      'Configura erro grosseiro passível de multa pessoal a conduta do gestor público que decide contratar ou prosseguir com o certame desconsiderando, sem motivação jurídica ou técnica robusta, parecer jurídico desfavorável ou com ressalvas impeditivas.',
    aplicacao_pratica:
      'Demonstra a força condicionante das recomendações do Parecer Jurídico (Peça 10) frente ao Termo de Autorização (Peça 11).',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-ac-2121-2024-p',
    numero: 'Acórdão nº 2.121/2024 – Plenário',
    tipo: 'ACORDAO',
    colegiado: 'Plenário TCU',
    tema: 'CONTROLE_PREVIO_ART53',
    tema_label: TCU_THEME_LABELS.CONTROLE_PREVIO_ART53,
    artigos_relacionados: 'Art. 53, caput e § 1º da Lei nº 14.133/2021 e STF MS 24.631',
    ementa:
      'O controle prévio de legalidade impõe exame diligente das minutas e da fase preparatória; parecer jurídico protocolar que aprova editais com vícios evidentes ou cláusulas manifestamente restritivas pode atrair responsabilização por erro grosseiro.',
    aplicacao_pratica:
      'Justifica o checklist analítico exaustivo de 7 dimensões do Parecer Jurídico antes da autorização da fase externa.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/jurisprudencia'
  },
  {
    id: 'tcu-sum-247',
    numero: 'Súmula nº 247/TCU',
    tipo: 'SUMULA',
    colegiado: 'Plenário TCU',
    tema: 'PARCELAMENTO_OBJETO',
    tema_label: TCU_THEME_LABELS.PARCELAMENTO_OBJETO,
    artigos_relacionados: 'Art. 40, § 2º e § 3º da Lei nº 14.133/2021',
    ementa:
      'É obrigatória a admissão da adjudicação por item e não por preço global nos editais de objetos divisíveis, salvo comprovado prejuízo técnico ou perda de economia de escala, adequando-se as exigências de habilitação a essa divisibilidade.',
    aplicacao_pratica:
      'Valida o formato de lance selecionado (por item vs. lote/global) com base na justificativa do Inciso VIII do ETP.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/sumulas'
  },
  {
    id: 'tcu-sum-263',
    numero: 'Súmula nº 263/TCU',
    tipo: 'SUMULA',
    colegiado: 'Plenário TCU',
    tema: 'HABILITACAO',
    tema_label: TCU_THEME_LABELS.HABILITACAO,
    artigos_relacionados: 'Art. 67, §§ 1º e 2º da Lei nº 14.133/2021',
    ementa:
      'A exigência de comprovação de capacidade técnico-operacional por quantitativos mínimos deve limitar-se simultaneamente às parcelas de maior relevância técnica e valor significativo do objeto, mantendo proporção com a dimensão contratada.',
    aplicacao_pratica:
      'Baliza os atestados exigidos no Edital (teto legal de até 50% das parcelas com relevância mínima de 4% no Art. 67, §§ 1º e 2º).',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/sumulas'
  },
  {
    id: 'tcu-sum-272',
    numero: 'Súmula nº 272/TCU',
    tipo: 'SUMULA',
    colegiado: 'Plenário TCU',
    tema: 'HABILITACAO',
    tema_label: TCU_THEME_LABELS.HABILITACAO,
    artigos_relacionados: 'Art. 9º, I e Arts. 62 a 70 da Lei nº 14.133/2021',
    ementa:
      'No edital de licitação, é vedada a inclusão de exigências de habilitação e de quesitos de pontuação técnica para cujo atendimento os licitantes tenham de incorrer em custos que não sejam necessários anteriormente à celebração do contrato.',
    aplicacao_pratica:
      'Impede a exigência antecipada de equipe mobilizada, frota própria, alvarás operacionais locais ou garantias prévias à assinatura contratual.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/sumulas'
  },
  {
    id: 'tcu-sum-289',
    numero: 'Súmula nº 289/TCU',
    tipo: 'SUMULA',
    colegiado: 'Plenário TCU',
    tema: 'HABILITACAO',
    tema_label: TCU_THEME_LABELS.HABILITACAO,
    artigos_relacionados: 'Art. 69, § 5º da Lei nº 14.133/2021',
    ementa:
      'A exigência de índices contábeis de capacidade econômico-financeira deve ser justificada no processo licitatório com parâmetros atuais de mercado adequados ao objeto, vedando-se índices de rentabilidade ou lucratividade.',
    aplicacao_pratica:
      'Fundamenta os índices objetivos LG, LC e SG ≥ 1,00 ou patrimônio líquido mínimo alternativo de até 10% previstos no TR e no Edital.',
    fonte: 'BASE_CURADA_TCU',
    url_referencia: 'https://pesquisa.apps.tcu.gov.br/#/pesquisa/sumulas'
  }
];

export function sanitizeTcuPrecedents(raw: unknown): TcuPrecedent[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TcuPrecedent[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, any>;
    const numero = normalizeUtf8Text(rec.numero).trim();
    if (!numero) continue;

    const id = normalizeUtf8Text(rec.id).trim() || `custom-${numero.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (seen.has(id) || seen.has(numero.toLowerCase())) continue;
    seen.add(id);
    seen.add(numero.toLowerCase());

    const tema = (
      rec.tema && rec.tema in TCU_THEME_LABELS ? rec.tema : 'CONTROLE_PREVIO_ART53'
    ) as TcuJurisprudenceTheme;

    out.push({
      id,
      numero,
      tipo: rec.tipo === 'SUMULA' ? 'SUMULA' : 'ACORDAO',
      colegiado: normalizeUtf8Text(rec.colegiado).trim() || 'Plenário TCU',
      tema,
      tema_label: normalizeUtf8Text(rec.tema_label).trim() || TCU_THEME_LABELS[tema],
      artigos_relacionados: normalizeUtf8Text(rec.artigos_relacionados).trim() || 'Lei nº 14.133/2021',
      ementa: normalizeUtf8Text(rec.ementa).trim() || 'Precedente jurisprudencial vinculado ao processo.',
      aplicacao_pratica:
        normalizeUtf8Text(rec.aplicacao_pratica).trim() ||
        'Aplicação como referencial jurídico de controle preventivo no parecer conclusivo.',
      fonte: rec.fonte === 'DADOS_ABERTOS_TCU' ? 'DADOS_ABERTOS_TCU' : 'BASE_CURADA_TCU',
      url_referencia: typeof rec.url_referencia === 'string' ? rec.url_referencia : undefined
    });
  }

  return out;
}

/**
 * Seleciona os precedentes fundamentais do TCU pertinentes ao processo atual,
 * dando prioridade aos acórdãos expressamente vinculados pela Procuradoria/Gestor.
 */
export function selectContextualTcuPrecedents(params: {
  proc: Partial<ProcurementProcess>;
  pinned?: TcuPrecedent[];
}): Array<TcuPrecedent & { vinculadoManualmente: boolean }> {
  const pinnedList = sanitizeTcuPrecedents(params.pinned ?? params.proc.tcu_acordaos_vinculados ?? []);
  const pinnedIds = new Set(pinnedList.map((p) => p.id));
  const pinnedNums = new Set(pinnedList.map((p) => p.numero.toLowerCase()));

  const selected: Array<TcuPrecedent & { vinculadoManualmente: boolean }> = pinnedList.map((p) => ({
    ...p,
    vinculadoManualmente: true
  }));

  // Acórdãos e súmulas estruturantes obrigatórios em contratações públicas (Lei nº 14.133/2021)
  const coreIds = [
    'tcu-ac-1875-2021-p', // Pesquisa de preços / cesta ampla
    'tcu-ac-2829-2015-p', // Segregação de funções e especificação técnica neutra
    'tcu-ac-1264-2019-p', // Direcionamento de marca / erro grosseiro
    'tcu-ac-2599-2021-p', // Peso do parecer jurídico para o gestor
    'tcu-ac-2121-2024-p', // Responsabilização / controle prévio Art. 53
    'tcu-sum-247', // Parcelamento do objeto
    'tcu-sum-263', // Atestados proporcionais
    'tcu-sum-272', // Vedação custos prévios
    'tcu-sum-289' // Índices contábeis
  ];

  if (params.proc.pesquisa_preco_itens && params.proc.pesquisa_preco_itens.length > 0) {
    coreIds.push('tcu-ac-1855-2025-p', 'tcu-ac-318-2026-p');
  }
  if (params.proc.tipo_contratacao === 'SERVICOS' || params.proc.tipo_contratacao === 'AQUISICAO') {
    coreIds.push('tcu-ac-1712-2025-p', 'tcu-ac-1092-2026-p');
  }
  if (params.proc.tipo_contratacao === 'OBRAS_ENGENHARIA') {
    coreIds.push('tcu-ac-522-2022-p', 'tcu-ac-1712-2025-p');
  }

  for (const id of coreIds) {
    const item = TCU_JURISPRUDENCE_CATALOG.find((c) => c.id === id);
    if (!item) continue;
    if (pinnedIds.has(item.id) || pinnedNums.has(item.numero.toLowerCase())) continue;
    pinnedIds.add(item.id);
    selected.push({ ...item, vinculadoManualmente: false });
  }

  return selected;
}

interface TcuLiveCacheEntry {
  fetchedAt: number;
  liveApiOk: boolean;
  rows: any[];
  diagnostics: string;
}

const TCU_LIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const TCU_LIVE_BACKOFF_TTL_MS = 2 * 60 * 1000;
let tcuLiveCache: TcuLiveCacheEntry | null = null;

export function clearTcuLiveCache(): void {
  tcuLiveCache = null;
}

export async function searchTcuJurisprudence(
  params?: {
    q?: string;
    tema?: string;
    includeLiveApi?: boolean;
  },
  fetchImpl: typeof fetch = fetch
): Promise<{
  items: TcuPrecedent[];
  total: number;
  themes: Array<{ value: TcuJurisprudenceTheme; label: string }>;
  live_consulted: boolean;
  live_api_ok: boolean;
  live_diagnostics: string;
}> {
  const q = normalizeUtf8Text(params?.q).trim().toLowerCase();
  const temaFilter = String(params?.tema || '').trim();

  const matchesQuery = (p: TcuPrecedent) => {
    if (temaFilter && temaFilter !== 'ALL' && p.tema !== temaFilter) return false;
    if (!q) return true;
    const hay = `${p.numero} ${p.tema_label} ${p.artigos_relacionados} ${p.ementa} ${p.aplicacao_pratica}`.toLowerCase();
    return hay.includes(q);
  };

  const results: TcuPrecedent[] = TCU_JURISPRUDENCE_CATALOG.filter(matchesQuery);
  let liveConsulted = false;
  let liveApiOk = false;
  let liveDiagnostics = 'Base Curada Verificada TCU (offline/determinística) operacional.';

  const appendLiveRows = (rows: any[]): number => {
    let added = 0;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const numAcordao = normalizeUtf8Text(r.numeroAcordao || r.numero || r.key || '').trim();
      const anoAcordao = normalizeUtf8Text(r.anoAcordao || r.ano || '').trim();
      const colegiado = normalizeUtf8Text(r.colegiado || 'Plenário TCU').trim();
      const sumario = normalizeUtf8Text(r.sumario || r.enunciado || r.titulo || '').trim();
      if (!numAcordao || !sumario) continue;

      const label = anoAcordao
        ? `Acórdão nº ${numAcordao}/${anoAcordao} – ${colegiado}`
        : `Acórdão nº ${numAcordao} – ${colegiado}`;
      if (results.some((x) => x.numero.toLowerCase() === label.toLowerCase())) continue;

      const candidate: TcuPrecedent = {
        id: `tcu-live-${numAcordao}-${anoAcordao}`.replace(/[^a-zA-Z0-9-]/g, ''),
        numero: label,
        tipo: 'ACORDAO',
        colegiado,
        tema: 'CONTROLE_PREVIO_ART53',
        tema_label: 'Consulta Dados Abertos TCU',
        artigos_relacionados: 'Lei nº 14.133/2021 / Dados Abertos TCU',
        ementa: sumario.slice(0, 420),
        aplicacao_pratica:
          'Precedente obtido em consulta online ao Portal de Dados Abertos do TCU para exame jurídico complementar.',
        fonte: 'DADOS_ABERTOS_TCU',
        url_referencia: 'https://dados-abertos.apps.tcu.gov.br'
      };
      if (matchesQuery(candidate)) {
        results.push(candidate);
        added++;
      }
    }
    return added;
  };

  if (params?.includeLiveApi) {
    liveConsulted = true;
    const now = Date.now();
    const cacheTtl = tcuLiveCache?.liveApiOk ? TCU_LIVE_CACHE_TTL_MS : TCU_LIVE_BACKOFF_TTL_MS;
    if (tcuLiveCache && now - tcuLiveCache.fetchedAt < cacheTtl) {
      liveApiOk = tcuLiveCache.liveApiOk;
      const added = appendLiveRows(tcuLiveCache.rows);
      liveDiagnostics = tcuLiveCache.liveApiOk
        ? `${tcuLiveCache.diagnostics} [cache 5m, ${added} compatível(is)]`
        : tcuLiveCache.diagnostics;
    } else {
      try {
        const resp = await fetchImpl(
          'https://dados-abertos.apps.tcu.gov.br/api/acordao/recupera-acordaos?inicio=0&quantidade=8',
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'GovFlow-14133/1.0 (+https://gov.br)'
            },
            signal: AbortSignal.timeout(4500)
          }
        );
        if (resp.ok) {
          const rawData = await resp.json();
          const rows = Array.isArray(rawData)
            ? rawData
            : Array.isArray((rawData as any)?.items)
              ? (rawData as any).items
              : [];
          liveApiOk = true;
          const added = appendLiveRows(rows);
          const diagBase = `Portal Dados Abertos TCU consultado online (HTTP ${resp.status}).`;
          liveDiagnostics = `${diagBase} (${added} acórdão(s) compatível(is) retornado(s))`;
          tcuLiveCache = {
            fetchedAt: now,
            liveApiOk: true,
            rows,
            diagnostics: diagBase
          };
        } else {
          liveApiOk = false;
          liveDiagnostics = `Portal Dados Abertos TCU respondeu HTTP ${resp.status}; Base Curada Verificada TCU ativa em fallback.`;
          tcuLiveCache = {
            fetchedAt: now,
            liveApiOk: false,
            rows: [],
            diagnostics: liveDiagnostics
          };
        }
      } catch {
        liveApiOk = false;
        liveDiagnostics =
          'Portal Dados Abertos TCU indisponível nesta rede; mantendo Base Curada Verificada TCU sem perda de funcionalidade.';
        tcuLiveCache = {
          fetchedAt: now,
          liveApiOk: false,
          rows: [],
          diagnostics: liveDiagnostics
        };
      }
    }
  }

  return {
    items: results,
    total: results.length,
    themes: (Object.keys(TCU_THEME_LABELS) as TcuJurisprudenceTheme[]).map((value) => ({
      value,
      label: TCU_THEME_LABELS[value]
    })),
    live_consulted: liveConsulted,
    live_api_ok: liveApiOk,
    live_diagnostics: liveDiagnostics
  };
}
