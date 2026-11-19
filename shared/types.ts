export type ModalidadeLicitacao =
  | 'PREGAO_ELETRONICO'
  | 'PREGAO_PRESENCIAL'
  | 'CONCORRENCIA_ELETRONICA'
  | 'CONCORRENCIA_PRESENCIAL'
  | 'CONCURSO'
  | 'LEILAO'
  | 'DIALOGO_COMPETITIVO'
  | 'DISPENSA'
  | 'INEXIGIBILIDADE';

export type ModoDisputa =
  | 'ABERTO'
  | 'FECHADO'
  | 'ABERTO_FECHADO'
  | 'FECHADO_ABERTO'
  | 'NAO_APLICAVEL';

export type CriterioJulgamento =
  | 'MENOR_PRECO'
  | 'MAIOR_DESCONTO'
  | 'MELHOR_TECNICA'
  | 'TECNICA_E_PRECO'
  | 'MAIOR_LANCE'
  | 'MAIOR_RETORNO_ECONOMICO';

export type FormatoLance = 'POR_ITEM' | 'POR_LOTE' | 'GLOBAL';

export type TipoContratacao = 'AQUISICAO' | 'OBRAS_ENGENHARIA' | 'SERVICOS';

export type TcuJurisprudenceTheme =
  | 'PESQUISA_PRECOS'
  | 'SEGREGACAO_FUNCOES'
  | 'EXIGENCIAS_RESTRITIVAS'
  | 'PARCELAMENTO_OBJETO'
  | 'HABILITACAO'
  | 'CONTROLE_PREVIO_ART53'
  | 'PLANEJAMENTO_RISCOS'
  | 'SRP';

export interface TcuPrecedent {
  id: string;
  numero: string;
  tipo: 'ACORDAO' | 'SUMULA';
  colegiado: string;
  tema: TcuJurisprudenceTheme;
  tema_label: string;
  artigos_relacionados: string;
  ementa: string;
  aplicacao_pratica: string;
  fonte: 'BASE_CURADA_TCU' | 'DADOS_ABERTOS_TCU';
  url_referencia?: string;
}

export type AgentStatus =
  | 'PENDENTE'
  | 'GERANDO'
  | 'AGUARDANDO_REVISAO'
  | 'APROVADO'
  | 'DESATUALIZADO'
  | 'DISPENSADO';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface LegalAlert {
  id: string;
  severity: AlertSeverity;
  article: string;
  title: string;
  message: string;
  recommendation?: string;
}

export interface Institution {
  id: string;
  owner_user_id?: string | null;
  cnpj: string;
  razao_social: string;
  nome_fantasia: string;
  endereco_completo: string;
  cep: string;
  municipio: string;
  uf: string;
  telefone: string;
  email: string;
  portal_transparencia_url: string;
  logo_data_url: string;
  comarca_foro: string;
  prefeito_nome: string;
  created_at: string;
  updated_at: string;
}

export interface Secretario {
  id: string;
  institution_id: string;
  secretaria: string;
  nome: string;
  cargo: string;
  portaria_nomeacao: string;
  matricula_cpf?: string;
  email?: string;
  source: 'manual' | 'scraping' | 'csv' | 'json';
  created_at: string;
  updated_at: string;
}

export interface Dotacao {
  id: string;
  institution_id: string;
  orgao: string;
  unidade_orcamentaria: string;
  funcao: string;
  subfuncao: string;
  programa: string;
  acao: string;
  elemento_despesa: string;
  fonte_recurso: string;
  codigo_reduzido?: string;
  descricao?: string;
  saldo_disponivel?: number;
  source: 'manual' | 'scraping' | 'csv' | 'json';
  created_at: string;
  updated_at: string;
}

export interface PesquisaPrecoItem {
  item: number;
  descricao: string;
  medida: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
}

export interface ParsedPriceResearchResult {
  filename: string;
  format: 'PDF' | 'EXCEL' | 'WORD';
  itens: PesquisaPrecoItem[];
  valor_total_estimado: number;
  resumo_texto: string;
  diagnostics: string[];
}

export interface ProcurementProcess {
  id: string;
  owner_user_id?: string | null;
  institution_id: string;
  secretario_id: string | null;
  dotacao_id: string | null;
  dotacao_ids?: string[];
  dotacoes_manuais?: string[];
  tipo_contratacao: TipoContratacao;
  data_certame?: string | null;
  horario_disputa?: string | null;
  numero_processo_licitatorio: string;
  numero_processo_administrativo: string;
  titulo_resumido: string;
  modalidade: ModalidadeLicitacao;
  modo_disputa: ModoDisputa;
  criterio_julgamento: CriterioJulgamento;
  formato_lance: FormatoLance;
  usar_srp: boolean;
  demanda_bruta: string;
  responsavel_requisitante: string;
  cargo_requisitante: string;
  valor_estimado_global: number;
  pesquisa_preco_arquivo?: string | null;
  pesquisa_preco_resumo?: string | null;
  pesquisa_preco_itens?: PesquisaPrecoItem[];
  tcu_acordaos_vinculados?: TcuPrecedent[];
  status_geral: 'EM_ELABORACAO' | 'PARECER_EMITIDO' | 'AUTORIZADO' | 'CONCLUIDO';
  header_version: number;
  created_at: string;
  updated_at: string;
}

export interface AgentPiece {
  id: string;
  process_id: string;
  agent_number: number; // 1 to 11
  agent_key: string;
  title: string;
  legal_basis: string;
  status: AgentStatus;
  structured_json: Record<string, any>;
  html_content: string;
  legal_alerts: LegalAlert[];
  ai_provider_used: string;
  current_version: number;
  approved_by?: string | null;
  approved_role?: string | null;
  approved_at?: string | null;
  content_hash?: string | null;
  stale_reason?: string | null;
  updated_at: string;
}

export interface PieceVersion {
  id: string;
  piece_id: string;
  version_number: number;
  html_content: string;
  structured_json: Record<string, any>;
  change_summary: string;
  feedback_used?: string | null;
  created_by: string;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  process_id: string;
  piece_id?: string | null;
  agent_number?: number | null;
  action:
    | 'PROCESSO_CRIADO'
    | 'PROCESSO_CLONADO'
    | 'CERTAME_ATUALIZADO'
    | 'INSTITUICAO_SINCRONIZADA'
    | 'AGENTE_EXECUTADO'
    | 'PECA_EDITADA'
    | 'PECA_REGENERADA'
    | 'PECA_APROVADA_ASSINADA'
    | 'DOSSIE_EXPORTADO';
  actor_name: string;
  actor_role: string;
  details: string;
  content_hash?: string | null;
  created_at: string;
}

export interface ProcessBundle {
  process: ProcurementProcess;
  institution: Institution;
  secretario: Secretario | null;
  dotacao: Dotacao | null;
  dotacoes_vinculadas?: Dotacao[];
  pieces: AgentPiece[];
  audit_logs: AuditLogEntry[];
  validation_alerts: LegalAlert[];
}

export interface AgentDefinition {
  number: number;
  key: string;
  shortName: string;
  title: string;
  legalBasis: string;
  description: string;
  requiredInputs: string[];
  conditionalOnSrp?: boolean;
}

export type AiProviderMode = 'auto' | 'local' | 'gemini' | 'openai';
export type EffectiveAiProvider = 'local' | 'gemini' | 'openai';
export type GeminiAuthSource =
  | 'none'
  | 'env_gemini_key'
  | 'env_google_key'
  | 'db_api_key'
  | 'adc_authorized_user'
  | 'adc_service_account';
export type AiAuthSource = GeminiAuthSource | 'openai_key';

export interface AiSettings {
  provider: AiProviderMode;
  effectiveProvider: EffectiveAiProvider;
  authSource: AiAuthSource;
  authSourceLabel: string;
  geminiAuthDetail?: string;
  geminiModel: string;
  openaiModel: string;
  openaiBaseUrl: string;
  gemInstructions: string;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
}

export interface AiConnectivityTestResult {
  ok: boolean;
  provider: AiProviderMode;
  effectiveProvider: EffectiveAiProvider;
  authSource: AiAuthSource;
  authSourceLabel: string;
  errorCode?: string;
  message: string;
  hint?: string;
}

export interface AiGeminiResetResult {
  clearedDbKey: boolean;
  envReloaded: boolean;
  settings: AiSettings;
  diagnostic: AiConnectivityTestResult;
}

export interface PlatformOnlineStatus {
  online: boolean;
  test_mode: boolean;
  mode_label: string;
  host: string;
  port: number;
  local_url: string;
  network_urls: string[];
  uptime_seconds: number;
  database_ok: boolean;
  ai_effective_provider: EffectiveAiProvider;
  ai_auth_label: string;
  tcu_probe?: {
    ok: boolean;
    latency_ms: number;
    message: string;
  };
  timestamp: string;
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    number: 1,
    key: 'demanda_necessidade',
    shortName: 'Demanda / Problema',
    title: 'Agente 01 — Demanda da Necessidade (Iniciação)',
    legalBasis: 'Art. 11 e Art. 18, I da Lei nº 14.133/2021',
    description:
      'Converte a descrição informal do requisitante em exposição técnica do problema administrativo e interesse público envolvido.',
    requiredInputs: ['Descrição bruta da necessidade', 'Secretaria solicitante', 'Dotação orçamentária']
  },
  {
    number: 2,
    key: 'dfd',
    shortName: 'DFD (Art. 12, VII)',
    title: 'Agente 02 — Documento de Formalização da Demanda (DFD)',
    legalBasis: 'Art. 12, VII e Art. 72, I da Lei nº 14.133/2021',
    description:
      'Formaliza a demanda com área requisitante, justificativa, objeto sucinto, quantidades, estimativa preliminar, prazo e alinhamento ao PCA.',
    requiredInputs: ['Demanda validada (Agente 01)', 'Ordenador de Despesa', 'Dotação orçamentária']
  },
  {
    number: 3,
    key: 'etp',
    shortName: 'ETP (Art. 18, § 1º)',
    title: 'Agente 03 — Estudo Técnico Preliminar (ETP)',
    legalBasis: 'Art. 18, § 1º (Incisos I a XIII) da Lei nº 14.133/2021',
    description:
      'Elabora os 13 elementos obrigatórios do ETP, incluindo memória de cálculo, levantamento de mercado, parcelamento (Súmula 247 TCU) e viabilidade conclusiva.',
    requiredInputs: ['DFD aprovado (Agente 02)']
  },
  {
    number: 4,
    key: 'mapa_riscos',
    shortName: 'Mapa de Riscos',
    title: 'Agente 04 — Mapa de Gerenciamento de Riscos (Art. 18, X e Art. 22)',
    legalBasis: 'Art. 18, inciso X e Art. 22 da Lei nº 14.133/2021',
    description:
      'Estrutura a matriz de riscos das fases de Planejamento, Seleção do Fornecedor e Gestão Contratual com P×I, ações preventivas, contingência e responsáveis.',
    requiredInputs: ['DFD aprovado (Agente 02)', 'ETP aprovado (Agente 03)', 'Modalidade e SRP']
  },
  {
    number: 5,
    key: 'termo_referencia',
    shortName: 'Termo de Referência',
    title: 'Agente 05 — Termo de Referência (TR - Art. 6º, XXIII)',
    legalBasis: 'Art. 6º, XXIII, Art. 40 e Art. 41 da Lei nº 14.133/2021',
    description:
      'Consolida todas as alíneas do Art. 6º, XXIII: objeto (CATMAT/CATSER), ciclo de vida, sustentabilidade, subcontratação, execução, gestão/IMR, medição/pagamento, habilitação e adequação orçamentária.',
    requiredInputs: ['ETP aprovado (Agente 03)', 'Mapa de Riscos aprovado (Agente 04)', 'Critério de Julgamento']
  },
  {
    number: 6,
    key: 'termo_autuacao',
    shortName: 'Termo de Autuação',
    title: 'Agente 06 — Termo de Autuação e Protocolo Formal',
    legalBasis: 'Art. 12, VI e Art. 18 da Lei nº 14.133/2021',
    description:
      'Formaliza a abertura e numeração dos autos do processo administrativo/licitatório, indexando as peças instrutórias iniciais.',
    requiredInputs: ['Dados da Prefeitura', 'Números do Processo', 'Objeto consolidado do TR (Agente 05)']
  },
  {
    number: 7,
    key: 'minuta_contrato',
    shortName: 'Minuta do Contrato',
    title: 'Agente 07 — Minuta do Contrato Administrativo (Art. 92)',
    legalBasis: 'Arts. 89 a 95, 105 a 114, 124 a 139 e 155 a 163 da Lei nº 14.133/2021',
    description:
      'Redige todas as 13 cláusulas obrigatórias do Art. 92 vinculadas ao TR: objeto, vigência, execução/gestão, subcontratação, pagamento, reajuste com data-base, obrigações/PCD, garantia, sanções, extinção, dotação, PNCP e foro.',
    requiredInputs: ['Termo de Referência aprovado (Agente 05)', 'Dados da Prefeitura (Contratante)', 'Comarca']
  },
  {
    number: 8,
    key: 'minuta_arp',
    shortName: 'Minuta da ARP (SRP)',
    title: 'Agente 08 — Minuta da Ata de Registro de Preços (Art. 82)',
    legalBasis: 'Arts. 82 a 86 da Lei nº 14.133/2021 e Decreto Federal nº 11.462/2023',
    description:
      'Peça condicional obrigatória quando SRP estiver ativo: qualificação, preços registrados, órgão gerenciador/participantes, adesão ("carona"), validade 1+1 ano (Art. 84), revisão/reequilíbrio, cancelamento e penalidades.',
    requiredInputs: [
      'Termo de Referência aprovado (Agente 05)',
      'Dados do Certame e da Prefeitura',
      'Sistema de Registro de Preços (SRP) marcado'
    ],
    conditionalOnSrp: true
  },
  {
    number: 9,
    key: 'edital_consolidado',
    shortName: 'Edital Consolidado',
    title: 'Agente 09 — Edital Completo / Aviso de Contratação Direta',
    legalBasis: 'Art. 25, Art. 55, Art. 56, Arts. 62 a 70 e Art. 72 da Lei nº 14.133/2021',
    description:
      'Consolida os 13 capítulos do Edital/Aviso: preâmbulo, objeto, SRP condicional, participação ME/EPP (LC 123/06), inversão de fases (Art. 17), declarações (Art. 63), modo de disputa (Art. 56), desempate (Art. 60), negociação (Art. 61), julgamento (Art. 59), habilitação (Arts. 62-70), recursos/impugnações (Arts. 164-165), sanções e anexos.',
    requiredInputs: [
      'Modalidade, Modo de Disputa, Critério e SRP',
      'Termo de Referência (Agente 05)',
      'Minuta de Contrato (Agente 07)',
      'Minuta de ARP (Agente 08, se SRP)'
    ]
  },
  {
    number: 10,
    key: 'parecer_juridico',
    shortName: 'Parecer Jurídico',
    title: 'Agente 10 — Parecer Jurídico (Controle Prévio - Art. 53)',
    legalBasis: 'Art. 53 (caput e § 1º, I e II) e Art. 18 da Lei nº 14.133/2021',
    description:
      'Auditoria jurídica crítica das Peças 01 a 09: relatório com folhas autuadas, delimitação (Art. 53, § 1º), fase preparatória (Arts. 18/23/29), minutas (Arts. 9º/25/92 e LC 123/06), checklist e conclusão fundamentada.',
    requiredInputs: ['Peças 01 a 09 geradas e autuadas', 'Modalidade, Disputa e Critério do Certame']
  },
  {
    number: 11,
    key: 'dossie_autorizacao',
    shortName: 'Dossiê & Autorização',
    title: 'Agente 11 — Compilador de Dossiê e Autorização Final',
    legalBasis: 'Art. 7º, § 1º, Art. 18, Art. 53, § 3º, Art. 54 e Art. 72, VIII da Lei nº 14.133/2021',
    description:
      'Emite o fechamento da fase interna em dois blocos: (A) Termo de Autorização da Autoridade Competente com publicação PNCP/DOM e (B) Índice das 11 peças + Relatório de Trilha de Auditoria e Segregação de Funções.',
    requiredInputs: [
      'Parecer Jurídico (Agente 10)',
      'Logs de auditoria e revisões do banco de dados',
      'Dados da Prefeitura e Certame'
    ]
  }
];

export type UserRole = 'ADMIN' | 'USER';

export interface UserAccount {
  id: string;
  username: string;
  name: string;
  email: string;
  department: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
}

export type SupportChannel = 'EMAIL' | 'CHAT';
export type SupportTicketStatus = 'ABERTO' | 'EM_ATENDIMENTO' | 'RESOLVIDO';

export interface SupportMessage {
  id: string;
  ticket_id: string;
  sender_role: 'USER' | 'ADMIN' | 'SYSTEM';
  sender_name: string;
  message: string;
  created_at: string;
}

export interface SupportTicket {
  id: string;
  user_id?: string | null;
  requester_name: string;
  requester_email: string;
  requester_phone: string;
  channel: SupportChannel;
  subject: string;
  status: SupportTicketStatus;
  created_at: string;
  updated_at: string;
  messages: SupportMessage[];
}

export interface AppInfo {
  name: string;
  version: string;
  developer: string;
  support_email: string;
  support_whatsapp: string;
  support_whatsapp_digits: string;
}

export interface AdminUserSummary extends UserAccount {
  institutions_count: number;
  processes_count: number;
  ai_provider: AiProviderMode;
  ai_model: string;
}

export interface AdminOverview {
  stats: {
    total_users: number;
    active_users: number;
    pending_users: number;
    total_institutions: number;
    total_processes: number;
    total_pieces: number;
    approved_pieces: number;
    total_tickets: number;
    open_tickets: number;
  };
  users: AdminUserSummary[];
  institutions: Array<
    Institution & {
      owner_username?: string;
      owner_name?: string;
    }
  >;
  processes: Array<
    ProcurementProcess & {
      institution_name: string;
      secretaria_nome: string;
      owner_username?: string;
      owner_name?: string;
      approved_count: number;
      total_active_agents: number;
    }
  >;
  audit_logs: Array<
    AuditLogEntry & {
      numero_processo_licitatorio?: string;
      owner_username?: string;
    }
  >;
  tickets: SupportTicket[];
}

export type ContractVerdict = 'APROVADO' | 'APROVADO_COM_RESSALVAS' | 'REPROVADO_SANEAMENTO';
export type ContractChecklistStatus = 'CONFORME' | 'RESSALVA' | 'NAO_CONFORME';
export type ContractSourceType = 'UPLOAD' | 'TEXT' | 'PROCESS_PIECE';
export type ContractSourceFormat = 'PDF' | 'WORD' | 'TXT' | 'HTML';

export interface ContractChecklistItem {
  id: string;
  inciso: string;
  item: string;
  artigo: string;
  status: ContractChecklistStatus;
  observacao: string;
  recomendacao?: string;
}

export interface ContractExtractedMetadata {
  numero_contrato: string | null;
  processo_referencia: string | null;
  objeto: string | null;
  contratante: string | null;
  cnpj_contratante: string | null;
  contratada: string | null;
  cnpj_contratada: string | null;
  representante_contratante: string | null;
  representante_cargo: string | null;
  valor_global: string | null;
  valores_em_aberto: boolean;
  vigencia_prazo: string | null;
  duracao_em_aberto: boolean;
  indice_reajuste: string | null;
  data_base_orcamento: string | null;
  garantia_contratual: string | null;
  foro: string | null;
  regime_legal_detectado: 'LEI_14133' | 'MISTO_LEGADO' | 'LEI_8666_LEGADO' | 'NAO_IDENTIFICADO';
}

export interface ContractRiskFinding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  categoria: string;
  artigo: string;
  titulo: string;
  descricao: string;
  trecho_identificado?: string;
  recomendacao: string;
}

export interface ContractSuggestedClause {
  clausula: string;
  artigo: string;
  motivo: string;
  texto_sugerido: string;
}

export interface ContractAnalysisRecord {
  id: string;
  owner_user_id: string;
  process_id?: string | null;
  title: string;
  source_type: ContractSourceType;
  source_filename?: string | null;
  source_format?: ContractSourceFormat | null;
  contract_text: string;
  analysis_focus?: string;
  institution_name?: string | null;
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
  created_at: string;
  updated_at: string;
}

export interface ContractExtractionPreview {
  filename: string;
  format: ContractSourceFormat;
  char_count: number;
  extracted_text: string;
  diagnostics: string[];
}
