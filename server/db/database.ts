import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let dbInstance: DatabaseSync | null = null;

export function isServerlessRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function getDataDir(): string {
  const dir =
    process.env.GOVFLOW_DATA_DIR ||
    (isServerlessRuntime()
      ? path.join(os.tmpdir(), 'govflow-data')
      : path.resolve(process.cwd(), 'data'));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getDb(customPath?: string): DatabaseSync {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || process.env.GOVFLOW_DB_PATH || path.join(getDataDir(), 'govflow.db');
  const dbDir = path.dirname(dbPath);
  if (dbPath !== ':memory:' && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    db.exec('PRAGMA journal_mode = DELETE;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  migrateSchema(db);
  seedInitialDataIfEmpty(db);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

export function resetDbForTests(db: DatabaseSync) {
  dbInstance = db;
}

export function closeDb(): void {
  if (!dbInstance) return;
  try {
    dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // ignore in-memory or read-only close
  }
  try {
    dbInstance.close();
  } catch {
    // ignore already closed
  }
  dbInstance = null;
}

function migrateSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institutions (
      id TEXT PRIMARY KEY,
      cnpj TEXT NOT NULL,
      razao_social TEXT NOT NULL,
      nome_fantasia TEXT NOT NULL DEFAULT '',
      endereco_completo TEXT NOT NULL DEFAULT '',
      cep TEXT NOT NULL DEFAULT '',
      municipio TEXT NOT NULL DEFAULT '',
      uf TEXT NOT NULL DEFAULT '',
      telefone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      portal_transparencia_url TEXT NOT NULL DEFAULT '',
      logo_data_url TEXT NOT NULL DEFAULT '',
      comarca_foro TEXT NOT NULL DEFAULT '',
      prefeito_nome TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secretarios (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      secretaria TEXT NOT NULL,
      nome TEXT NOT NULL,
      cargo TEXT NOT NULL,
      portaria_nomeacao TEXT NOT NULL DEFAULT '',
      matricula_cpf TEXT DEFAULT '',
      email TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dotacoes (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      orgao TEXT NOT NULL,
      unidade_orcamentaria TEXT NOT NULL,
      funcao TEXT NOT NULL,
      subfuncao TEXT NOT NULL,
      programa TEXT NOT NULL,
      acao TEXT NOT NULL,
      elemento_despesa TEXT NOT NULL,
      fonte_recurso TEXT NOT NULL,
      codigo_reduzido TEXT DEFAULT '',
      descricao TEXT DEFAULT '',
      saldo_disponivel REAL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS processes (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      secretario_id TEXT,
      dotacao_id TEXT,
      numero_processo_licitatorio TEXT NOT NULL,
      numero_processo_administrativo TEXT NOT NULL,
      titulo_resumido TEXT NOT NULL DEFAULT '',
      modalidade TEXT NOT NULL,
      modo_disputa TEXT NOT NULL,
      criterio_julgamento TEXT NOT NULL,
      formato_lance TEXT NOT NULL DEFAULT 'POR_ITEM',
      usar_srp INTEGER NOT NULL DEFAULT 0,
      demanda_bruta TEXT NOT NULL DEFAULT '',
      responsavel_requisitante TEXT NOT NULL DEFAULT '',
      cargo_requisitante TEXT NOT NULL DEFAULT '',
      valor_estimado_global REAL NOT NULL DEFAULT 0,
      pesquisa_preco_arquivo TEXT DEFAULT '',
      pesquisa_preco_resumo TEXT DEFAULT '',
      pesquisa_preco_itens_json TEXT NOT NULL DEFAULT '[]',
      tipo_contratacao TEXT NOT NULL DEFAULT 'AQUISICAO',
      dotacao_ids_json TEXT NOT NULL DEFAULT '[]',
      dotacoes_manuais_json TEXT NOT NULL DEFAULT '[]',
      data_certame TEXT DEFAULT '',
      horario_disputa TEXT DEFAULT '',
      tcu_acordaos_json TEXT NOT NULL DEFAULT '[]',
      status_geral TEXT NOT NULL DEFAULT 'EM_ELABORACAO',
      header_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE,
      FOREIGN KEY (secretario_id) REFERENCES secretarios(id) ON DELETE SET NULL,
      FOREIGN KEY (dotacao_id) REFERENCES dotacoes(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_pieces (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      agent_number INTEGER NOT NULL,
      agent_key TEXT NOT NULL,
      title TEXT NOT NULL,
      legal_basis TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDENTE',
      structured_json TEXT NOT NULL DEFAULT '{}',
      html_content TEXT NOT NULL DEFAULT '',
      legal_alerts_json TEXT NOT NULL DEFAULT '[]',
      ai_provider_used TEXT NOT NULL DEFAULT 'Motor Jurídico Local 14.133',
      current_version INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,
      approved_role TEXT,
      approved_at TEXT,
      content_hash TEXT,
      stale_reason TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(process_id, agent_number),
      FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS piece_versions (
      id TEXT PRIMARY KEY,
      piece_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      html_content TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      feedback_used TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (piece_id) REFERENCES agent_pieces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      piece_id TEXT,
      agent_number INTEGER,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      details TEXT NOT NULL,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migração segura de colunas adicionadas em bancos já existentes
  const processCols = (
    db.prepare('PRAGMA table_info(processes)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  const missingProcessCols: Array<[string, string]> = [
    ['pesquisa_preco_arquivo', "TEXT DEFAULT ''"],
    ['pesquisa_preco_resumo', "TEXT DEFAULT ''"],
    ['pesquisa_preco_itens_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['tipo_contratacao', "TEXT NOT NULL DEFAULT 'AQUISICAO'"],
    ['dotacao_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['dotacoes_manuais_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['data_certame', "TEXT DEFAULT ''"],
    ['horario_disputa', "TEXT DEFAULT ''"],
    ['tcu_acordaos_json', "TEXT NOT NULL DEFAULT '[]'"]
  ];
  for (const [col, def] of missingProcessCols) {
    if (!processCols.includes(col)) {
      db.exec(`ALTER TABLE processes ADD COLUMN ${col} ${def};`);
    }
  }

  // Índices operacionais para consultas rápidas em carteiras com centenas de dotações/processos
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_secretarios_inst ON secretarios(institution_id, secretaria);
    CREATE INDEX IF NOT EXISTS idx_dotacoes_inst ON dotacoes(institution_id, orgao, unidade_orcamentaria);
    CREATE INDEX IF NOT EXISTS idx_processes_inst_updated ON processes(institution_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_pieces_proc_num ON agent_pieces(process_id, agent_number);
    CREATE INDEX IF NOT EXISTS idx_piece_versions_piece_ver ON piece_versions(piece_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_proc_created ON audit_logs(process_id, created_at DESC);
  `);
}

// Brasão SVG institucional padrão (editável/substituível pelo upload do usuário)
const DEFAULT_BRASAO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 130">
  <defs>
    <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1351B4"/>
      <stop offset="100%" stop-color="#071D41"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#B45309"/>
    </linearGradient>
  </defs>
  <path d="M60 8 L72 18 L86 14 L82 28 L94 30 L80 38 L40 38 L26 30 L38 28 L34 14 L48 18 Z" fill="url(#goldGrad)" stroke="#78350F" stroke-width="1.5"/>
  <path d="M22 38 H98 V74 C98 99 78 114 60 122 C42 114 22 99 22 74 Z" fill="url(#shieldGrad)" stroke="#D97706" stroke-width="3"/>
  <path d="M30 45 H90 V73 C90 93 74 105 60 112 C46 105 30 93 30 73 Z" fill="none" stroke="#93C5FD" stroke-width="1.5" stroke-opacity="0.6"/>
  <circle cx="60" cy="69" r="16" fill="#16A34A" stroke="#FBBF24" stroke-width="2"/>
  <polygon points="60,56 64,65 73,65 66,71 68,80 60,75 52,80 54,71 47,65 56,65" fill="#FDE047"/>
  <rect x="20" y="96" width="80" height="16" rx="4" fill="#F8FAFC" stroke="#071D41" stroke-width="1.5"/>
  <text x="60" y="107.5" font-family="Arial, sans-serif" font-size="8.5" font-weight="bold" fill="#071D41" text-anchor="middle">GOVFLOW 14.133</text>
</svg>`;

const DEFAULT_LOGO_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(DEFAULT_BRASAO_SVG, 'utf8').toString('base64')}`;

function seedInitialDataIfEmpty(db: DatabaseSync) {
  const countRow = db.prepare('SELECT COUNT(*) as total FROM institutions').get() as { total: number };
  if (countRow.total > 0) return;

  const now = new Date().toISOString();
  const instId = 'inst-modelo-01';
  const sec1Id = 'sec-educacao-01';
  const sec2Id = 'sec-saude-01';
  const sec3Id = 'sec-admin-01';
  const dot1Id = 'dot-educacao-01';
  const dot2Id = 'dot-saude-01';
  const dot3Id = 'dot-admin-01';

  db.prepare(`
    INSERT INTO institutions (
      id, cnpj, razao_social, nome_fantasia, endereco_completo, cep, municipio, uf,
      telefone, email, portal_transparencia_url, logo_data_url, comarca_foro, prefeito_nome,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instId,
    '00.000.000/0001-91',
    'MUNICÍPIO DE HORIZONTE AZUL — PODER EXECUTIVO',
    'Prefeitura Municipal de Horizonte Azul',
    'Praça dos Três Poderes, nº 100, Centro',
    '30140-000',
    'Horizonte Azul',
    'MG',
    '(31) 3300-1413',
    'licitacoes@horizonteazul.mg.gov.br',
    'https://transparencia.horizonteazul.mg.gov.br',
    DEFAULT_LOGO_DATA_URL,
    'Comarca de Horizonte Azul/MG',
    'Dr. Carlos Eduardo Monteiro',
    now,
    now
  );

  const insertSec = db.prepare(`
    INSERT INTO secretarios (
      id, institution_id, secretaria, nome, cargo, portaria_nomeacao, matricula_cpf, email, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSec.run(
    sec1Id,
    instId,
    'Secretaria Municipal de Educação',
    'Profa. Mariana Vasconcelos Silva',
    'Secretária Municipal de Educação e Ordenadora de Despesas',
    'Portaria nº 014/2025',
    'Mat. 10.452-1',
    'educacao@horizonteazul.mg.gov.br',
    'manual',
    now,
    now
  );
  insertSec.run(
    sec2Id,
    instId,
    'Secretaria Municipal de Saúde',
    'Dr. Henrique Nogueira Almeida',
    'Secretário Municipal de Saúde e Gestor do FMS',
    'Portaria nº 018/2025',
    'Mat. 10.489-0',
    'saude@horizonteazul.mg.gov.br',
    'manual',
    now,
    now
  );
  insertSec.run(
    sec3Id,
    instId,
    'Secretaria Municipal de Administração e Planejamento',
    'Adm. Ricardo Teles Ferreira',
    'Secretário Municipal de Administração',
    'Portaria nº 003/2025',
    'Mat. 10.101-5',
    'administracao@horizonteazul.mg.gov.br',
    'manual',
    now,
    now
  );

  const insertDot = db.prepare(`
    INSERT INTO dotacoes (
      id, institution_id, orgao, unidade_orcamentaria, funcao, subfuncao, programa, acao,
      elemento_despesa, fonte_recurso, codigo_reduzido, descricao, saldo_disponivel, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertDot.run(
    dot1Id,
    instId,
    '02 - Poder Executivo',
    '02.05.01 - Fundo Municipal de Educação (FUNDEB)',
    '12 - Educação',
    '361 - Ensino Fundamental',
    '0012 - Educação Transformadora',
    '2.045 - Manutenção do Transporte e Infraestrutura Escolar',
    '3.3.90.30.00 - Material de Consumo / 4.4.90.52.00 - Equipamentos',
    '1.500.000.1001 - Recursos Ordinários / MDE 25%',
    '245',
    'Aquisição de equipamentos, mobiliário e insumos de informática educacional',
    850000.0,
    'manual',
    now,
    now
  );
  insertDot.run(
    dot2Id,
    instId,
    '02 - Poder Executivo',
    '02.06.01 - Fundo Municipal de Saúde (FMS)',
    '10 - Saúde',
    '301 - Atenção Básica',
    '0010 - Saúde Mais Perto',
    '2.062 - Manutenção das Unidades Básicas de Saúde',
    '3.3.90.30.00 - Material de Consumo (Medicamentos e Insumos)',
    '1.600.000.0000 - Transferências SUS / Bloco Manutenção',
    '318',
    'Aquisição contínua de medicamentos da atenção básica e insumos hospitalares',
    1200000.0,
    'manual',
    now,
    now
  );
  insertDot.run(
    dot3Id,
    instId,
    '02 - Poder Executivo',
    '02.03.01 - Secretaria Municipal de Administração',
    '04 - Administração',
    '122 - Administração Geral',
    '0004 - Gestão Eficiente',
    '2.015 - Modernização Administrativa e Serviços Contínuos',
    '3.3.90.39.00 - Outros Serviços de Terceiros - Pessoa Jurídica',
    '1.500.000.0000 - Recursos Não Vinculados de Impostos',
    '112',
    'Contratação de serviços técnicos e locação de soluções corporativas',
    540000.0,
    'manual',
    now,
    now
  );

  // Processo exemplo pronto para iniciar a esteira ou testar imediatamente
  const procId = 'proc-exemplo-045-2026';
  db.prepare(`
    INSERT INTO processes (
      id, institution_id, secretario_id, dotacao_id,
      numero_processo_licitatorio, numero_processo_administrativo, titulo_resumido,
      modalidade, modo_disputa, criterio_julgamento, formato_lance, usar_srp,
      demanda_bruta, responsavel_requisitante, cargo_requisitante, valor_estimado_global,
      status_geral, header_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    procId,
    instId,
    sec1Id,
    dot1Id,
    '045/2026',
    '1.204/2026',
    'Aquisição de equipamentos de informática e estações pedagógicas para escolas municipais',
    'PREGAO_ELETRONICO',
    'ABERTO_FECHADO',
    'MENOR_PRECO',
    'POR_ITEM',
    1,
    'Precisamos resolver a defasagem tecnológica de 12 escolas municipais do ensino fundamental que hoje possuem laboratórios inoperantes ou sem computadores para os alunos e professores utilizarem plataformas pedagógicas digitais, diário eletrônico e avaliações externas. Estimamos necessidade de cerca de 120 estações de trabalho completas e 12 switches gerenciáveis de rede para atender cerca de 2.400 alunos no ano letivo.',
    'João Paulo Mendes',
    'Diretor de Tecnologia Educacional',
    420000.0,
    'EM_ELABORACAO',
    1,
    now,
    now
  );

  // Inicializa as 11 peças do processo exemplo
  const agentDefs = [
    { n: 1, key: 'demanda_necessidade', title: 'Agente 01 — Demanda da Necessidade (Iniciação)', basis: 'Art. 11 e Art. 18, I da Lei nº 14.133/2021' },
    { n: 2, key: 'dfd', title: 'Agente 02 — Documento de Formalização da Demanda (DFD)', basis: 'Art. 12, VII e Art. 72, I da Lei nº 14.133/2021' },
    { n: 3, key: 'etp', title: 'Agente 03 — Estudo Técnico Preliminar (ETP)', basis: 'Art. 18, § 1º (Incisos I a XIII) da Lei nº 14.133/2021' },
    { n: 4, key: 'mapa_riscos', title: 'Agente 04 — Matriz / Mapa de Riscos (Art. 18, X)', basis: 'Art. 18, X da Lei nº 14.133/2021' },
    { n: 5, key: 'termo_referencia', title: 'Agente 05 — Termo de Referência (TR - Art. 6º, XXIII)', basis: 'Art. 6º, XXIII e Art. 40 da Lei nº 14.133/2021' },
    { n: 6, key: 'termo_autuacao', title: 'Agente 06 — Termo de Autuação e Protocolo Formal', basis: 'Art. 12, VI e Art. 18 da Lei nº 14.133/2021' },
    { n: 7, key: 'minuta_contrato', title: 'Agente 07 — Minuta do Contrato Administrativo (Art. 92)', basis: 'Arts. 89 a 95 e Art. 137/155 da Lei nº 14.133/2021' },
    { n: 8, key: 'minuta_arp', title: 'Agente 08 — Minuta da Ata de Registro de Preços (Art. 82)', basis: 'Arts. 82 a 86 da Lei nº 14.133/2021' },
    { n: 9, key: 'edital_consolidado', title: 'Agente 09 — Edital Completo / Aviso de Contratação Direta', basis: 'Art. 25, Art. 56 e Art. 72 da Lei nº 14.133/2021' },
    { n: 10, key: 'parecer_juridico', title: 'Agente 10 — Parecer Jurídico (Controle Prévio - Art. 53)', basis: 'Art. 53 da Lei nº 14.133/2021' },
    { n: 11, key: 'dossie_autorizacao', title: 'Agente 11 — Compilador de Dossiê e Autorização Final', basis: 'Art. 18, Art. 54 e Art. 72, VIII da Lei nº 14.133/2021' }
  ];

  const insertPiece = db.prepare(`
    INSERT INTO agent_pieces (
      id, process_id, agent_number, agent_key, title, legal_basis, status,
      structured_json, html_content, legal_alerts_json, current_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const def of agentDefs) {
    insertPiece.run(
      `${procId}-ag-${def.n}`,
      procId,
      def.n,
      def.key,
      def.title,
      def.basis,
      'PENDENTE',
      '{}',
      '',
      '[]',
      0,
      now
    );
  }

  db.prepare(`
    INSERT INTO audit_logs (
      id, process_id, piece_id, agent_number, action, actor_name, actor_role, details, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    procId,
    null,
    null,
    'PROCESSO_CRIADO',
    'Sistema GovFlow 14.133',
    'Orquestrador Inicial',
    'Processo licitatório 045/2026 (PA 1.204/2026) criado com SRP ativo e esteira de 11 agentes pronta.',
    null,
    now
  );
}
