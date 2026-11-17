import crypto from 'node:crypto';
import { getDb, seedStarterWorkspaceForUser } from './database.js';
import { getPublicAiSettings } from './repository.js';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword
} from '../services/passwordUtils.js';
import type {
  AdminOverview,
  AdminUserSummary,
  SupportChannel,
  SupportMessage,
  SupportTicket,
  SupportTicketStatus,
  UserAccount,
  UserRole
} from '../../shared/types.js';

function mapUserRow(row: any): UserAccount {
  return {
    id: String(row.id),
    username: String(row.username),
    name: String(row.name),
    email: String(row.email || ''),
    department: String(row.department || ''),
    role: row.role === 'ADMIN' ? 'ADMIN' : 'USER',
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at: row.last_login_at || null
  };
}

export function getUserById(id: string): UserAccount | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? mapUserRow(row) : null;
}

export function getUserByUsername(username: string): UserAccount | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1')
    .get(String(username || '').trim());
  return row ? mapUserRow(row) : null;
}

export function authenticateUser(
  username: string,
  password: string
): { ok: true; user: UserAccount } | { ok: false; status: 401 | 403; error: string } {
  const cleanUser = String(username || '').trim();
  if (!cleanUser || !password) {
    return { ok: false, status: 401, error: 'Informe login e senha para acessar o sistema.' };
  }

  const db = getDb();
  const row = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1')
    .get(cleanUser) as any;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return { ok: false, status: 401, error: 'Login ou senha inválidos.' };
  }

  if (!Number(row.is_active)) {
    return {
      ok: false,
      status: 403,
      error:
        'Usuário aguardando ativação pelo Administrador ou desativado. Solicite liberação no painel administrativo.'
    };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
  seedStarterWorkspaceForUser(db, row.id, { requesterName: row.name });

  return { ok: true, user: getUserById(row.id)! };
}

export function registerPendingUser(input: {
  username: string;
  name: string;
  email?: string;
  department?: string;
  password: string;
}): UserAccount {
  const username = String(input.username || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim();
  const department = String(input.department || '').trim();
  const password = String(input.password || '');

  if (username.length < 3 || !/^[a-z0-9._-]+$/i.test(username)) {
    throw new Error('O login deve ter ao menos 3 caracteres (letras, números, ponto, hífen ou underline).');
  }
  if (name.length < 2) {
    throw new Error('Informe seu nome completo.');
  }
  if (password.length < 6) {
    throw new Error('A senha deve ter no mínimo 6 caracteres.');
  }
  if (getUserByUsername(username)) {
    throw new Error('Este login já está em uso. Escolha outro identificador.');
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (
      id, username, name, email, department, role, password_hash, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'USER', ?, 0, ?, ?)
  `).run(id, username, name, email, department, hashPassword(password), now, now);

  return getUserById(id)!;
}

export function adminCreateUser(input: {
  username: string;
  name: string;
  email?: string;
  department?: string;
  role?: UserRole;
  is_active?: boolean;
  password: string;
}): UserAccount {
  const username = String(input.username || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim();
  const department = String(input.department || '').trim();
  const role: UserRole = input.role === 'ADMIN' ? 'ADMIN' : 'USER';
  const isActive = input.is_active !== false;
  const password = String(input.password || '');

  if (username.length < 3 || !/^[a-z0-9._-]+$/i.test(username)) {
    throw new Error('O login deve ter ao menos 3 caracteres válidos.');
  }
  if (name.length < 2) {
    throw new Error('Informe o nome completo do usuário.');
  }
  if (password.length < 6) {
    throw new Error('A senha inicial deve ter ao menos 6 caracteres.');
  }
  if (getUserByUsername(username)) {
    throw new Error('Já existe um usuário cadastrado com este login.');
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (
      id, username, name, email, department, role, password_hash, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, name, email, department, role, hashPassword(password), isActive ? 1 : 0, now, now);

  if (isActive) {
    seedStarterWorkspaceForUser(db, id, { requesterName: name });
  }

  return getUserById(id)!;
}

export function adminUpdateUser(
  targetId: string,
  patch: {
    name?: string;
    email?: string;
    department?: string;
    role?: UserRole;
    is_active?: boolean;
    password?: string;
  },
  actingAdminId?: string
): UserAccount {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as any;
  if (!existing) {
    throw new Error('Usuário não encontrado.');
  }

  const nextRole: UserRole =
    patch.role !== undefined ? (patch.role === 'ADMIN' ? 'ADMIN' : 'USER') : existing.role === 'ADMIN' ? 'ADMIN' : 'USER';
  const nextActive = patch.is_active !== undefined ? Boolean(patch.is_active) : Boolean(existing.is_active);

  if (actingAdminId && targetId === actingAdminId) {
    if (!nextActive) {
      throw new Error('Você não pode desativar sua própria conta administrativa logada.');
    }
    if (nextRole !== 'ADMIN') {
      throw new Error('Você não pode remover seu próprio perfil de Administrador.');
    }
  }

  if (existing.role === 'ADMIN' && (nextRole !== 'ADMIN' || !nextActive)) {
    const otherActiveAdmins = db
      .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'ADMIN' AND is_active = 1 AND id != ?")
      .get(targetId) as { c: number };
    if (otherActiveAdmins.c === 0) {
      throw new Error('O sistema exige ao menos um Administrador ativo.');
    }
  }

  const nextName = patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name;
  const nextEmail = patch.email !== undefined ? String(patch.email).trim() : existing.email;
  const nextDept = patch.department !== undefined ? String(patch.department).trim() : existing.department;
  let nextPasswordHash = existing.password_hash;

  if (patch.password && String(patch.password).trim().length > 0) {
    if (String(patch.password).length < 6) {
      throw new Error('A nova senha deve ter no mínimo 6 caracteres.');
    }
    nextPasswordHash = hashPassword(String(patch.password));
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET
      name = ?, email = ?, department = ?, role = ?, password_hash = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(nextName, nextEmail, nextDept, nextRole, nextPasswordHash, nextActive ? 1 : 0, now, targetId);

  if (!nextActive) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  } else {
    seedStarterWorkspaceForUser(db, targetId, { requesterName: nextName });
  }

  return getUserById(targetId)!;
}

export function adminDeleteUser(targetId: string, actingAdminId: string): void {
  if (targetId === actingAdminId) {
    throw new Error('Você não pode excluir a sua própria conta conectada.');
  }
  const db = getDb();
  const target = getUserById(targetId);
  if (!target) {
    throw new Error('Usuário não encontrado.');
  }
  if (target.role === 'ADMIN') {
    const otherAdmins = db
      .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'ADMIN' AND is_active = 1 AND id != ?")
      .get(targetId) as { c: number };
    if (otherAdmins.c === 0) {
      throw new Error('Não é possível excluir o único Administrador ativo do sistema.');
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
}

export function updateOwnProfile(
  userId: string,
  patch: {
    name?: string;
    email?: string;
    department?: string;
    currentPassword?: string;
    newPassword?: string;
  }
): UserAccount {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!existing) {
    throw new Error('Conta não encontrada.');
  }

  let nextPasswordHash = existing.password_hash;
  if (patch.newPassword && String(patch.newPassword).trim().length > 0) {
    if (!patch.currentPassword || !verifyPassword(patch.currentPassword, existing.password_hash)) {
      throw new Error('Senha atual incorreta.');
    }
    if (String(patch.newPassword).length < 6) {
      throw new Error('A nova senha deve ter no mínimo 6 caracteres.');
    }
    nextPasswordHash = hashPassword(String(patch.newPassword));
  }

  const nextName = patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name;
  const nextEmail = patch.email !== undefined ? String(patch.email).trim() : existing.email;
  const nextDept = patch.department !== undefined ? String(patch.department).trim() : existing.department;
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE users SET name = ?, email = ?, department = ?, password_hash = ?, updated_at = ? WHERE id = ?'
  ).run(nextName, nextEmail, nextDept, nextPasswordHash, now, userId);

  return getUserById(userId)!;
}

export function createSession(userId: string, ttlDays = 7): { token: string; expiresAt: string } {
  const db = getDb();
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    userId,
    expiresAt,
    now.toISOString()
  );

  return { token, expiresAt };
}

export function getSessionUser(rawToken: string): UserAccount | null {
  if (!rawToken) return null;
  const db = getDb();
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date().toISOString();
  const row = db
    .prepare(`
      SELECT u.*
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
      LIMIT 1
    `)
    .get(tokenHash, now) as any;

  if (!row || !Number(row.is_active)) return null;
  return mapUserRow(row);
}

export function deleteSession(rawToken: string): void {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function getUserOnlineTestMode(userId?: string): boolean {
  const db = getDb();
  if (userId) {
    const row = db
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'online_test_mode'")
      .get(userId) as { value: string } | undefined;
    if (!row) {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at) VALUES (?, 'online_test_mode', 'true', ?)"
      ).run(userId, now);
      return true;
    }
    return row.value !== 'false';
  }
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'online_test_mode'").get() as
    | { value: string }
    | undefined;
  return row ? row.value !== 'false' : true;
}

export function setUserOnlineTestMode(enabled: boolean, userId?: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  if (userId) {
    db.prepare(
      "INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, 'online_test_mode', ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(userId, enabled ? 'true' : 'false', now);
    return enabled;
  }
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('online_test_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(enabled ? 'true' : 'false');
  return enabled;
}

function mapSupportTicketRow(row: any, messages: SupportMessage[]): SupportTicket {
  return {
    id: String(row.id),
    user_id: row.user_id || null,
    requester_name: String(row.requester_name),
    requester_email: String(row.requester_email),
    requester_phone: String(row.requester_phone || ''),
    channel: row.channel === 'EMAIL' ? 'EMAIL' : 'CHAT',
    subject: String(row.subject),
    status:
      row.status === 'RESOLVIDO'
        ? 'RESOLVIDO'
        : row.status === 'EM_ATENDIMENTO'
          ? 'EM_ATENDIMENTO'
          : 'ABERTO',
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    messages
  };
}

export function listSupportTickets(opts?: { userId?: string; isAdmin?: boolean }): SupportTicket[] {
  const db = getDb();
  const sql = opts?.isAdmin
    ? 'SELECT * FROM support_tickets ORDER BY updated_at DESC'
    : 'SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC';
  const rows = (
    opts?.isAdmin ? db.prepare(sql).all() : db.prepare(sql).all(opts?.userId || '')
  ) as any[];

  const msgStmt = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC');
  return rows.map((r) => {
    const msgs = msgStmt.all(r.id) as unknown as SupportMessage[];
    return mapSupportTicketRow(r, msgs);
  });
}

export function getSupportTicket(ticketId: string): SupportTicket | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId) as any;
  if (!row) return null;
  const msgs = db
    .prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC')
    .all(ticketId) as unknown as SupportMessage[];
  return mapSupportTicketRow(row, msgs);
}

export function createSupportTicket(input: {
  user_id?: string | null;
  requester_name: string;
  requester_email: string;
  requester_phone?: string;
  channel: SupportChannel;
  subject: string;
  message: string;
}): SupportTicket {
  const requesterName = String(input.requester_name || '').trim();
  const requesterEmail = String(input.requester_email || '').trim();
  const subject = String(input.subject || '').trim();
  const message = String(input.message || '').trim();

  if (!requesterName) throw new Error('Informe seu nome para abrir o chamado.');
  if (!requesterEmail) throw new Error('Informe um e-mail de contato para retorno do chamado.');
  if (!subject) throw new Error('Informe o assunto do chamado.');
  if (!message) throw new Error('Descreva sua dúvida ou solicitação.');

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const channel: SupportChannel = input.channel === 'EMAIL' ? 'EMAIL' : 'CHAT';

  db.prepare(`
    INSERT INTO support_tickets (
      id, user_id, requester_name, requester_email, requester_phone, channel, subject, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ABERTO', ?, ?)
  `).run(
    id,
    input.user_id || null,
    requesterName,
    requesterEmail,
    String(input.requester_phone || '').trim(),
    channel,
    subject,
    now,
    now
  );

  db.prepare(`
    INSERT INTO support_messages (id, ticket_id, sender_role, sender_name, message, created_at)
    VALUES (?, ?, 'USER', ?, ?, ?)
  `).run(crypto.randomUUID(), id, requesterName, message, now);

  return getSupportTicket(id)!;
}

export function addSupportMessage(
  ticketId: string,
  input: {
    sender_role: 'USER' | 'ADMIN';
    sender_name: string;
    message: string;
    next_status?: SupportTicketStatus;
  }
): SupportTicket {
  const db = getDb();
  const existing = getSupportTicket(ticketId);
  if (!existing) throw new Error('Chamado não encontrado.');
  const cleanMsg = String(input.message || '').trim();
  if (!cleanMsg) throw new Error('Digite uma mensagem antes de enviar.');

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO support_messages (id, ticket_id, sender_role, sender_name, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), ticketId, input.sender_role, input.sender_name, cleanMsg, now);

  const nextStatus: SupportTicketStatus =
    input.next_status || (input.sender_role === 'ADMIN' ? 'EM_ATENDIMENTO' : existing.status);

  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(
    nextStatus,
    now,
    ticketId
  );

  return getSupportTicket(ticketId)!;
}

export function updateSupportTicketStatus(
  ticketId: string,
  status: SupportTicketStatus
): SupportTicket {
  const db = getDb();
  const existing = getSupportTicket(ticketId);
  if (!existing) throw new Error('Chamado não encontrado.');
  const now = new Date().toISOString();
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    now,
    ticketId
  );
  return getSupportTicket(ticketId)!;
}

export function getAdminOverview(): AdminOverview {
  const db = getDb();
  const userRows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as any[];

  const users: AdminUserSummary[] = userRows.map((u) => {
    const instCount = (
      db.prepare('SELECT COUNT(*) as c FROM institutions WHERE owner_user_id = ?').get(u.id) as { c: number }
    ).c;
    const procCount = (
      db.prepare('SELECT COUNT(*) as c FROM processes WHERE owner_user_id = ?').get(u.id) as { c: number }
    ).c;
    const ai = getPublicAiSettings(u.id);
    return {
      ...mapUserRow(u),
      institutions_count: Number(instCount),
      processes_count: Number(procCount),
      ai_provider: ai.provider,
      ai_model: ai.geminiModel
    };
  });

  const institutions = db
    .prepare(`
      SELECT i.*, u.username as owner_username, u.name as owner_name
      FROM institutions i
      LEFT JOIN users u ON u.id = i.owner_user_id
      ORDER BY i.updated_at DESC
    `)
    .all() as any[];

  const processesRows = db
    .prepare(`
      SELECT p.*,
        i.nome_fantasia as institution_fantasia,
        i.razao_social as institution_razao,
        COALESCE(s.secretaria, 'Não vinculada') as secretaria_nome,
        u.username as owner_username,
        u.name as owner_name,
        (SELECT COUNT(*) FROM agent_pieces ap WHERE ap.process_id = p.id AND ap.status = 'APROVADO') as approved_count,
        (SELECT COUNT(*) FROM agent_pieces ap WHERE ap.process_id = p.id AND ap.status != 'DISPENSADO') as total_active_agents
      FROM processes p
      LEFT JOIN institutions i ON i.id = p.institution_id
      LEFT JOIN secretarios s ON s.id = p.secretario_id
      LEFT JOIN users u ON u.id = p.owner_user_id
      ORDER BY p.updated_at DESC
    `)
    .all() as any[];

  const processes = processesRows.map((r) => ({
    ...r,
    dotacao_ids: JSON.parse(r.dotacao_ids_json || '[]'),
    dotacoes_manuais: JSON.parse(r.dotacoes_manuais_json || '[]'),
    pesquisa_preco_itens: JSON.parse(r.pesquisa_preco_itens_json || '[]'),
    tcu_acordaos_vinculados: JSON.parse(r.tcu_acordaos_json || '[]'),
    usar_srp: Boolean(r.usar_srp),
    valor_estimado_global: Number(r.valor_estimado_global ?? 0),
    header_version: Number(r.header_version ?? 1),
    institution_name: r.institution_fantasia || r.institution_razao || 'Órgão Municipal',
    secretaria_nome: r.secretaria_nome,
    approved_count: Number(r.approved_count ?? 0),
    total_active_agents: Number(r.total_active_agents ?? 11)
  }));

  const auditLogs = db
    .prepare(`
      SELECT al.*, p.numero_processo_licitatorio, u.username as owner_username
      FROM audit_logs al
      LEFT JOIN processes p ON p.id = al.process_id
      LEFT JOIN users u ON u.id = p.owner_user_id
      ORDER BY al.created_at DESC
      LIMIT 100
    `)
    .all() as any[];

  const pieceTotals = db
    .prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'APROVADO' THEN 1 ELSE 0 END) as approved FROM agent_pieces WHERE status != 'DISPENSADO'"
    )
    .get() as { total: number; approved: number };

  const tickets = listSupportTickets({ isAdmin: true });

  return {
    stats: {
      total_users: users.length,
      active_users: users.filter((u) => u.is_active).length,
      pending_users: users.filter((u) => !u.is_active).length,
      total_institutions: institutions.length,
      total_processes: processes.length,
      total_pieces: Number(pieceTotals.total ?? 0),
      approved_pieces: Number(pieceTotals.approved ?? 0),
      total_tickets: tickets.length,
      open_tickets: tickets.filter((t) => t.status !== 'RESOLVIDO').length
    },
    users,
    institutions,
    processes,
    audit_logs: auditLogs,
    tickets
  };
}
