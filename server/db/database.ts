import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from '../services/passwordUtils.js';

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

export function getDefaultDbPath(): string {
  return process.env.GOVFLOW_DB_PATH || path.join(getDataDir(), 'govflow.db');
}

export function getDb(customPath?: string): DatabaseSync {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || getDefaultDbPath();
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

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'USER',
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS revoked_sessions (
      sid TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      requester_phone TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'CHAT',
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ABERTO',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      sender_role TEXT NOT NULL DEFAULT 'USER',
      sender_name TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contract_analyses (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      process_id TEXT,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'TEXT',
      source_filename TEXT NOT NULL DEFAULT '',
      source_format TEXT NOT NULL DEFAULT 'TXT',
      contract_text TEXT NOT NULL,
      analysis_focus TEXT NOT NULL DEFAULT '',
      institution_name TEXT NOT NULL DEFAULT '',
      verdict TEXT NOT NULL DEFAULT 'APROVADO_COM_RESSALVAS',
      compliance_score INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      extracted_metadata_json TEXT NOT NULL DEFAULT '{}',
      checklist_art92_json TEXT NOT NULL DEFAULT '[]',
      risk_findings_json TEXT NOT NULL DEFAULT '[]',
      suggested_clauses_json TEXT NOT NULL DEFAULT '[]',
      tcu_precedents_json TEXT NOT NULL DEFAULT '[]',
      report_html TEXT NOT NULL DEFAULT '',
      ai_provider_used TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE SET NULL
    );
  `);

  // Migração segura de colunas adicionadas em bancos já existentes
  const instCols = (
    db.prepare('PRAGMA table_info(institutions)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!instCols.includes('owner_user_id')) {
    db.exec('ALTER TABLE institutions ADD COLUMN owner_user_id TEXT;');
  }

  const processCols = (
    db.prepare('PRAGMA table_info(processes)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  const missingProcessCols: Array<[string, string]> = [
    ['owner_user_id', 'TEXT'],
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
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_institutions_owner ON institutions(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secretarios_inst ON secretarios(institution_id, secretaria);
    CREATE INDEX IF NOT EXISTS idx_dotacoes_inst ON dotacoes(institution_id, orgao, unidade_orcamentaria);
    CREATE INDEX IF NOT EXISTS idx_processes_owner ON processes(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_processes_inst_updated ON processes(institution_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_pieces_proc_num ON agent_pieces(process_id, agent_number);
    CREATE INDEX IF NOT EXISTS idx_piece_versions_piece_ver ON piece_versions(piece_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_proc_created ON audit_logs(process_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_contract_analyses_owner ON contract_analyses(owner_user_id, updated_at DESC);
  `);

  // Remove chaves vazias herdadas para nunca sombrearem variáveis de ambiente/.env
  db.exec(`
    DELETE FROM app_settings WHERE key IN ('openai_api_key', 'gemini_api_key') AND trim(value) = '';
    DELETE FROM user_settings WHERE key IN ('openai_api_key', 'gemini_api_key') AND trim(value) = '';
  `);

  ensureDefaultAdminAndOwnership(db);
}

function ensureDefaultAdminAndOwnership(db: DatabaseSync): void {
  const now = new Date().toISOString();
  let adminRow = db
    .prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;

  if (!adminRow) {
    const adminId = 'admin-01';
    const adminUser = (process.env.GOVFLOW_ADMIN_USERNAME || 'admin').trim();
    const adminPass = process.env.GOVFLOW_ADMIN_PASSWORD || 'GovFlow@14133';
    const adminEmail = (process.env.GOVFLOW_ADMIN_EMAIL || 'rodrigofb@live.com').trim();
    db.prepare(`
      INSERT INTO users (
        id, username, name, email, department, role, password_hash, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ADMIN', ?, 1, ?, ?)
    `).run(
      adminId,
      adminUser,
      'Administrador Geral GovFlow',
      adminEmail,
      'Administração e Governança',
      hashPassword(adminPass),
      now,
      now
    );
    adminRow = { id: adminId };
  }

  db.prepare(
    "UPDATE institutions SET owner_user_id = ? WHERE owner_user_id IS NULL OR owner_user_id = ''"
  ).run(adminRow.id);
  db.prepare(
    "UPDATE processes SET owner_user_id = ? WHERE owner_user_id IS NULL OR owner_user_id = ''"
  ).run(adminRow.id);

  // Copia configurações globais legadas para a conta do administrador caso ainda não possua user_settings
  const adminSettingsCount = db
    .prepare('SELECT COUNT(*) as c FROM user_settings WHERE user_id = ?')
    .get(adminRow.id) as { c: number };
  if (adminSettingsCount.c === 0) {
    const globalRows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const upsertUserSetting = db.prepare(
      'INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)'
    );
    for (const r of globalRows) {
      upsertUserSetting.run(adminRow.id, r.key, r.value, now);
    }
  }
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

  const adminRow = db
    .prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;
  const ownerId = adminRow?.id || 'admin-01';
  seedStarterWorkspaceForUser(db, ownerId, { useCanonicalIds: true });
}

export function seedStarterWorkspaceForUser(
  db: DatabaseSync,
  ownerUserId: string,
  opts?: { useCanonicalIds?: boolean; requesterName?: string }
): void {
  const existing = db
    .prepare('SELECT COUNT(*) as total FROM institutions WHERE owner_user_id = ?')
    .get(ownerUserId) as { total: number };
  if (existing.total > 0) return;

  const now = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 8);
  const instId = opts?.useCanonicalIds ? 'inst-modelo-01' : `inst-${suffix}`;
  const sec1Id = opts?.useCanonicalIds ? 'sec-educacao-01' : `sec-edu-${suffix}`;
  const sec2Id = opts?.useCanonicalIds ? 'sec-saude-01' : `sec-sau-${suffix}`;
  const sec3Id = opts?.useCanonicalIds ? 'sec-admin-01' : `sec-adm-${suffix}`;
  const dot1Id = opts?.useCanonicalIds ? 'dot-educacao-01' : `dot-edu-${suffix}`;
  const dot2Id = opts?.useCanonicalIds ? 'dot-saude-01' : `dot-sau-${suffix}`;
  const dot3Id = opts?.useCanonicalIds ? 'dot-admin-01' : `dot-adm-${suffix}`;

  db.prepare(`
    INSERT INTO institutions (
      id, owner_user_id, cnpj, razao_social, nome_fantasia, endereco_completo, cep, municipio, uf,
      telefone, email, portal_transparencia_url, logo_data_url, comarca_foro, prefeito_nome,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instId,
    ownerUserId,
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
  const procId = opts?.useCanonicalIds ? 'proc-exemplo-045-2026' : `proc-${suffix}`;
  db.prepare(`
    INSERT INTO processes (
      id, owner_user_id, institution_id, secretario_id, dotacao_id,
      numero_processo_licitatorio, numero_processo_administrativo, titulo_resumido,
      modalidade, modo_disputa, criterio_julgamento, formato_lance, usar_srp,
      demanda_bruta, responsavel_requisitante, cargo_requisitante, valor_estimado_global,
      dotacao_ids_json, status_geral, header_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    procId,
    ownerUserId,
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
    opts?.requesterName || 'João Paulo Mendes',
    'Diretor de Tecnologia Educacional',
    420000.0,
    JSON.stringify([dot1Id]),
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
