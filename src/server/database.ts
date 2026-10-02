import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'libsql';

import type { GameMode, MatchReplay, Outcome } from '../shared/protocol.ts';
import {
  ROLE_NAME,
  isGod,
  isWolfRole,
  type BoardConfig,
  type Camp,
  type Role,
} from '../shared/roles.ts';

const DEFAULT_PASSWORD = '1';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccountUser {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
}

export interface AuthResult {
  token: string;
  user: AccountUser;
}

export interface MatchParticipantInput {
  userId: string | null;
  nickname: string;
  seat: number;
  role: Role;
  camp: Camp;
}

export interface MatchHistoryRow {
  id: string;
  roomId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: Outcome | null;
  day: number | null;
  boardSummary: string;
  seat: number;
  role: Role;
  roleName: string;
  camp: Camp;
  won: boolean | null;
  status: MatchStatus;
  score: number;
  matchNumber: number;
  endedPhase: string | null;
  mode: GameMode;
}

export type MatchStatus = 'PLAYING' | 'COMPLETED' | 'ABORTED';

export interface HallMatchPlayerRow {
  userId: string | null;
  nickname: string;
  seat: number;
  role: Role;
  roleName: string;
  camp: Camp;
  won: boolean | null;
  /** 只有厅主能收到该场积分。 */
  score?: number;
  fakeSeer: boolean;
}

export interface HallMatchRow {
  id: string;
  displayNumber: number;
  status: Exclude<MatchStatus, 'PLAYING'>;
  startedAt: number;
  endedAt: number;
  outcome: Outcome | null;
  day: number | null;
  endedPhase: string | null;
  boardSummary: string;
  mode: GameMode;
  players: HallMatchPlayerRow[];
  /** 旧场次没有回放数据；非参赛者也不会收到隐藏行动。 */
  replay: MatchReplay | null;
}

export interface HallPlayerStats {
  userId: string | null;
  nickname: string;
  wins: number;
  losses: number;
  wolfCount: number;
  godCount: number;
  villagerCount: number;
  /** 厅主、本人或厅主公开最终积分后才会下发。 */
  score?: number;
  rank?: number;
  goodScore?: number;
  wolfScore?: number;
  hexWins: number;
  hexLosses: number;
  hexScore?: number;
  exileCorrect: number;
  exileVotes: number;
  exileAccuracy: number;
  exileEligible: boolean;
}

export interface HallDashboard {
  roomId: string;
  isOwner: boolean;
  scoresRevealed: boolean;
  matches: HallMatchRow[];
  players: HallPlayerStats[];
}

export interface OwnedHallSummary {
  roomId: string;
  createdAt: number;
  updatedAt: number;
  matchCount: number;
  completedCount: number;
}

export interface HallRecordSummary extends OwnedHallSummary {
  relation: 'OWNER' | 'PARTICIPANT';
  ownerName: string;
}

export type AccountReply<T> = { ok: true; value: T } | { ok: false; message: string };

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function passwordDigest(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex');
}

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: passwordDigest(password, salt) };
}

function passwordMatches(password: string, salt: string, expectedHex: string): boolean {
  try {
    const actual = Buffer.from(passwordDigest(password, salt), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class GameDatabase {
  private readonly db: Database.Database;
  readonly mode: 'local' | 'turso';

  /**
   * 显式传入 path 时始终使用本地数据库（测试会传 :memory:）。
   * 正常启动且配置了 TURSO_DATABASE_URL 时，直接连接远程 Turso；否则回退到本地文件。
   */
  constructor(path?: string) {
    const remoteUrl = path === undefined ? process.env.TURSO_DATABASE_URL?.trim() : undefined;
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

    if (remoteUrl) {
      if (!authToken) {
        throw new Error('已设置 TURSO_DATABASE_URL，但缺少 TURSO_AUTH_TOKEN');
      }
      if (!/^(?:libsql|https):\/\//i.test(remoteUrl)) {
        throw new Error('TURSO_DATABASE_URL 必须是 libsql:// 或 https:// 地址');
      }
      // libsql 0.5 的运行时支持 authToken，但其兼容版类型声明暂未列出该字段。
      const options = { authToken, timeout: 10_000 } as Database.Options & { authToken: string };
      this.db = new Database(remoteUrl, options);
      this.mode = 'turso';
    } else {
      const localPath = path ??
        process.env.WEREWOLF_DB_PATH ??
        resolve(import.meta.dirname, '../../data/werewolf.db');
      if (localPath !== ':memory:') mkdirSync(dirname(localPath), { recursive: true });
      this.db = new Database(localPath);
      this.mode = 'local';
    }

    this.db.exec('PRAGMA foreign_keys = ON');
    if (this.mode === 'local' && path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

      CREATE TABLE IF NOT EXISTS halls (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        scores_revealed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_halls (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hall_id TEXT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        hidden_at INTEGER,
        PRIMARY KEY (user_id, hall_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_halls_user ON user_halls(user_id, hidden_at, last_seen_at);

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        match_number INTEGER,
        board_json TEXT NOT NULL,
        board_summary TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        day INTEGER,
        status TEXT NOT NULL DEFAULT 'PLAYING',
        ended_phase TEXT,
        fake_seer_user_id TEXT,
        replay_json TEXT,
        deleted_at INTEGER,
        deleted_by_user_id TEXT,
        mode TEXT NOT NULL DEFAULT 'STANDARD'
      );

      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        nickname TEXT NOT NULL,
        seat INTEGER NOT NULL,
        role TEXT NOT NULL,
        camp TEXT NOT NULL,
        won INTEGER,
        PRIMARY KEY (match_id, seat)
      );
      CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);

      CREATE TABLE IF NOT EXISTS role_wishes (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        loss_streak INTEGER NOT NULL DEFAULT 0,
        role TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_snapshots (
        room_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 兼容已经创建过旧版 SQLite 的用户：CREATE TABLE IF NOT EXISTS 不会自动补列。
    this.ensureMatchColumn('match_number', 'INTEGER');
    this.ensureMatchColumn('status', "TEXT NOT NULL DEFAULT 'PLAYING'");
    this.ensureMatchColumn('ended_phase', 'TEXT');
    this.ensureMatchColumn('fake_seer_user_id', 'TEXT');
    this.ensureMatchColumn('replay_json', 'TEXT');
    this.ensureMatchColumn('deleted_at', 'INTEGER');
    this.ensureMatchColumn('deleted_by_user_id', 'TEXT');
    this.ensureMatchColumn('mode', "TEXT NOT NULL DEFAULT 'STANDARD'");
    this.ensureColumn('halls', 'scores_revealed', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      UPDATE matches SET status = 'COMPLETED'
      WHERE ended_at IS NOT NULL AND status = 'PLAYING';
      CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id, started_at);

      INSERT OR IGNORE INTO user_halls
        (user_id, hall_id, relation, first_seen_at, last_seen_at)
      SELECT owner_user_id, id, 'OWNER', created_at, created_at
      FROM halls WHERE owner_user_id IS NOT NULL;

      INSERT OR IGNORE INTO user_halls
        (user_id, hall_id, relation, first_seen_at, last_seen_at)
      SELECT p.user_id, m.room_id, 'PARTICIPANT', MIN(m.started_at), MAX(COALESCE(m.ended_at, m.started_at))
      FROM match_players p
      JOIN matches m ON m.id = p.match_id
      -- 旧版本允许场次脱离大厅独立保存。user_halls.hall_id 有外键约束，
      -- 因此只能回填仍然存在的大厅；孤立场次本身继续保留在个人战绩中。
      JOIN halls h ON h.id = m.room_id
      WHERE p.user_id IS NOT NULL
      GROUP BY p.user_id, m.room_id;
    `);
  }

  private ensureMatchColumn(name: string, definition: string): void {
    this.ensureColumn('matches', name, definition);
  }

  private ensureColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  register(usernameInput: unknown): AccountReply<AuthResult> {
    const username = normalizeUsername(usernameInput);
    if (username.length < 2) return { ok: false, message: '用户名至少需要 2 个字符' };
    if (username.length > 12) return { ok: false, message: '用户名最多 12 个字符' };

    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return { ok: false, message: '这个用户名已经被注册' };

    const id = randomUUID();
    const now = Date.now();
    const password = hashPassword(DEFAULT_PASSWORD);
    try {
      this.db
        .prepare(
          `INSERT INTO users
           (id, username, password_hash, password_salt, must_change_password, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(id, username, password.hash, password.salt, now);
    } catch {
      return { ok: false, message: '这个用户名已经被注册' };
    }

    return { ok: true, value: this.createSession(this.userById(id)!) };
  }

  login(usernameInput: unknown, passwordInput: unknown): AccountReply<AuthResult> {
    const username = normalizeUsername(usernameInput);
    const password = typeof passwordInput === 'string' ? passwordInput : '';
    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, password_salt, must_change_password, created_at
         FROM users WHERE username = ?`,
      )
      .get(username) as
      | {
          id: string;
          username: string;
          password_hash: string;
          password_salt: string;
          must_change_password: number;
          created_at: number;
        }
      | undefined;

    if (!row || !passwordMatches(password, row.password_salt, row.password_hash)) {
      return { ok: false, message: '用户名或密码不正确' };
    }

    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
    return { ok: true, value: this.createSession(this.toUser(row)) };
  }

  authenticate(token: string | null | undefined): AccountUser | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.must_change_password, u.created_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, Date.now()) as
      | { id: string; username: string; must_change_password: number; created_at: number }
      | undefined;
    return row ? this.toUser(row) : null;
  }

  changePassword(
    token: string | null | undefined,
    currentInput: unknown,
    nextInput: unknown,
  ): AccountReply<AccountUser> {
    const user = this.authenticate(token);
    if (!user) return { ok: false, message: '登录已过期，请重新登录' };
    const current = typeof currentInput === 'string' ? currentInput : '';
    const next = typeof nextInput === 'string' ? nextInput : '';
    if (next.length < 4 || next.length > 64) {
      return { ok: false, message: '新密码需要 4–64 个字符' };
    }
    if (next === DEFAULT_PASSWORD) return { ok: false, message: '新密码不能继续使用默认密码 1' };

    const row = this.db
      .prepare('SELECT password_hash, password_salt FROM users WHERE id = ?')
      .get(user.id) as { password_hash: string; password_salt: string } | undefined;
    if (!row || !passwordMatches(current, row.password_salt, row.password_hash)) {
      return { ok: false, message: '当前密码不正确' };
    }

    const password = hashPassword(next);
    this.db
      .prepare(
        `UPDATE users
         SET password_hash = ?, password_salt = ?, must_change_password = 0
         WHERE id = ?`,
      )
      .run(password.hash, password.salt, user.id);
    return { ok: true, value: this.userById(user.id)! };
  }

  logout(token: string | null | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }

  createHall(roomId: string, ownerUserId: string | null): void {
    this.db
      .prepare('INSERT OR IGNORE INTO halls (id, owner_user_id, created_at) VALUES (?, ?, ?)')
      .run(roomId, ownerUserId, Date.now());
    if (ownerUserId) this.recordHallVisit(roomId, ownerUserId);
  }

  hallOwnerUserId(roomId: string): string | null {
    const row = this.db.prepare('SELECT owner_user_id FROM halls WHERE id = ?').get(roomId) as
      | { owner_user_id: string | null }
      | undefined;
    return row?.owner_user_id ?? null;
  }

  roleWishState(userId: string): { lossStreak: number; role: Role | null } {
    const row = this.db
      .prepare('SELECT loss_streak, role FROM role_wishes WHERE user_id = ?')
      .get(userId) as { loss_streak: number; role: string | null } | undefined;
    return {
      lossStreak: Number(row?.loss_streak ?? 0),
      role: row?.role ? row.role as Role : null,
    };
  }

  setRoleWish(userId: string, role: Role | null): AccountReply<null> {
    const state = this.roleWishState(userId);
    if (state.lossStreak < 2) return { ok: false, message: '连续输掉两场后才能选择愿望角色' };
    this.db
      .prepare(
        `INSERT INTO role_wishes (user_id, loss_streak, role, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(userId, state.lossStreak, role, Date.now());
    return { ok: true, value: null };
  }

  // ─────────────── 进行中房间快照 ───────────────

  /** 保存（覆盖）一个房间的进行中状态快照。 */
  saveRoomSnapshot(roomId: string, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO room_snapshots (room_id, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(roomId, payload, Date.now());
  }

  loadRoomSnapshots(): Array<{ roomId: string; payload: string; updatedAt: number }> {
    const rows = this.db
      .prepare('SELECT room_id, payload, updated_at FROM room_snapshots')
      .all() as Array<{ room_id: string; payload: string; updated_at: number }>;
    return rows.map((row) => ({
      roomId: row.room_id,
      payload: row.payload,
      updatedAt: Number(row.updated_at),
    }));
  }

  deleteRoomSnapshot(roomId: string): void {
    this.db.prepare('DELETE FROM room_snapshots WHERE room_id = ?').run(roomId);
  }

  setHallScoresRevealed(roomId: string, byUserId: string): AccountReply<null> {
    const result = this.db
      .prepare('UPDATE halls SET scores_revealed = 1 WHERE id = ? AND owner_user_id = ?')
      .run(roomId, byUserId);
    if (Number(result.changes) !== 1) return { ok: false, message: '只有厅主可以公开最终积分' };
    return { ok: true, value: null };
  }

  recordHallVisit(roomId: string, userId: string): void {
    const ownerUserId = this.hallOwnerUserId(roomId);
    if (ownerUserId === null) return;
    const now = Date.now();
    const relation = ownerUserId === userId ? 'OWNER' : 'PARTICIPANT';
    this.db
      .prepare(
        `INSERT INTO user_halls
           (user_id, hall_id, relation, first_seen_at, last_seen_at, hidden_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(user_id, hall_id) DO UPDATE SET
           relation = CASE WHEN excluded.relation = 'OWNER' THEN 'OWNER' ELSE user_halls.relation END,
           last_seen_at = excluded.last_seen_at,
           hidden_at = NULL`,
      )
      .run(userId, roomId, relation, now, now);
  }

  hideHallRecord(roomId: string, userId: string): AccountReply<null> {
    const result = this.db
      .prepare('UPDATE user_halls SET hidden_at = ? WHERE user_id = ? AND hall_id = ? AND hidden_at IS NULL')
      .run(Date.now(), userId, roomId);
    if (Number(result.changes) !== 1) return { ok: false, message: '没有找到这条大厅记录' };
    return { ok: true, value: null };
  }

  nextMatchNumber(roomId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM matches
         WHERE room_id = ? AND deleted_at IS NULL AND status != 'PLAYING'`,
      )
      .get(roomId) as { count: number };
    return Number(row.count) + 1;
  }

  startMatch(
    roomId: string,
    board: BoardConfig,
    boardSummary: string,
    players: MatchParticipantInput[],
    mode: GameMode = 'STANDARD',
  ): string {
    const id = randomUUID();
    const matchNumber = this.nextMatchNumber(roomId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO matches
           (id, room_id, match_number, board_json, board_summary, started_at, status, mode)
           VALUES (?, ?, ?, ?, ?, ?, 'PLAYING', ?)`,
        )
        .run(id, roomId, matchNumber, JSON.stringify(board), boardSummary, Date.now(), mode);
      const insertPlayer = this.db.prepare(
        `INSERT INTO match_players (match_id, user_id, nickname, seat, role, camp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const player of players) {
        insertPlayer.run(
          id,
          player.userId,
          player.nickname,
          player.seat,
          player.role,
          player.camp,
        );
      }
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishMatch(
    id: string,
    outcome: Outcome,
    day: number,
    fakeSeerUserId: string | null,
    finalCamps: ReadonlyArray<{ seat: number; camp: Camp }> = [],
    replay: MatchReplay | null = null,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE matches
           SET ended_at = ?, outcome = ?, day = ?, status = 'COMPLETED',
               ended_phase = 'GAME_OVER', fake_seer_user_id = ?, replay_json = ?
           WHERE id = ? AND ended_at IS NULL`,
        )
        .run(Date.now(), outcome, day, fakeSeerUserId, replay ? JSON.stringify(replay) : null, id);
      const updateCamp = this.db.prepare('UPDATE match_players SET camp = ? WHERE match_id = ? AND seat = ?');
      for (const entry of finalCamps) updateCamp.run(entry.camp, id, entry.seat);
      if (outcome === 'DRAW') {
        this.db.prepare('UPDATE match_players SET won = 0 WHERE match_id = ?').run(id);
      } else {
        this.db
          .prepare('UPDATE match_players SET won = CASE WHEN camp = ? THEN 1 ELSE 0 END WHERE match_id = ?')
          .run(outcome, id);
      }
      this.updateRoleWishesForFinishedMatch(id, outcome);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 普通模式才改变连败；海克斯结果会完整保存，但冻结这条进度。 */
  private updateRoleWishesForFinishedMatch(matchId: string, outcome: Outcome): void {
    if (outcome === 'DRAW') return;
    const match = this.db.prepare('SELECT mode FROM matches WHERE id = ?').get(matchId) as
      | { mode: string }
      | undefined;
    if (!match || match.mode === 'HEX_CHAOS') return;
    const players = this.db
      .prepare('SELECT user_id, role, won FROM match_players WHERE match_id = ? AND user_id IS NOT NULL')
      .all(matchId) as Array<{ user_id: string; role: Role; won: number }>;
    const upsert = this.db.prepare(
      `INSERT INTO role_wishes (user_id, loss_streak, role, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         loss_streak = excluded.loss_streak,
         role = excluded.role,
         updated_at = excluded.updated_at`,
    );
    for (const player of players) {
      const state = this.roleWishState(player.user_id);
      const wishGranted = state.role !== null && state.role === player.role;
      if (Number(player.won) === 1 || wishGranted) {
        upsert.run(player.user_id, 0, null, Date.now());
      } else {
        upsert.run(player.user_id, state.lossStreak + 1, state.role, Date.now());
      }
    }
  }

  abortMatch(id: string, day: number, phase: string, replay: MatchReplay | null = null): void {
    this.db
      .prepare(
        `UPDATE matches
         SET ended_at = ?, day = ?, status = 'ABORTED', ended_phase = ?, outcome = NULL
             , replay_json = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(Date.now(), day, phase, replay ? JSON.stringify(replay) : null, id);
  }

  /** 重新发牌时旧牌局完全作废，不占场次、不进入任何列表。 */
  discardMatch(id: string): void {
    this.db.prepare('DELETE FROM matches WHERE id = ?').run(id);
  }

  history(userId: string, limit = 30): MatchHistoryRow[] {
    return this.db
      .prepare(
        `SELECT m.id, m.room_id, m.match_number, m.started_at, m.ended_at, m.outcome, m.day,
                m.board_summary, m.status, m.ended_phase, m.fake_seer_user_id, m.mode,
                p.user_id, p.seat, p.role, p.camp, p.won
         FROM match_players p
         JOIN matches m ON m.id = p.match_id
         WHERE p.user_id = ? AND m.deleted_at IS NULL AND m.status != 'PLAYING'
         ORDER BY m.started_at DESC
         LIMIT ?`,
      )
      .all(userId, Math.min(Math.max(limit, 1), 100))
      .map((raw) => {
        const row = raw as Record<string, string | number | null>;
        const role = row['role'] as Role;
        return {
          id: String(row['id']),
          roomId: String(row['room_id']),
          startedAt: Number(row['started_at']),
          endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
          outcome: row['outcome'] as Outcome | null,
          day: row['day'] === null ? null : Number(row['day']),
          boardSummary: String(row['board_summary']),
          seat: Number(row['seat']),
          role,
          roleName: ROLE_NAME[role],
          camp: row['camp'] as Camp,
          won: row['won'] === null ? null : Number(row['won']) === 1,
          status: row['status'] as MatchStatus,
          score: this.scoreFor(row, String(row['user_id'])),
          matchNumber: Number(row['match_number'] ?? 0),
          endedPhase: row['ended_phase'] === null ? null : String(row['ended_phase']),
          mode: row['mode'] === 'HEX_CHAOS' ? 'HEX_CHAOS' : 'STANDARD',
        };
      });
  }

  /** 厅主首页：最近创建/进行过游戏的大厅，和实时房间是否还在内存中无关。 */
  ownedHalls(userId: string, limit = 20): OwnedHallSummary[] {
    return (
      this.db
        .prepare(
          `SELECT h.id AS room_id, h.created_at,
                  MAX(COALESCE(m.ended_at, m.started_at, h.created_at)) AS updated_at,
                  COUNT(m.id) AS match_count,
                  SUM(CASE WHEN m.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count
           FROM halls h
           LEFT JOIN matches m
             ON m.room_id = h.id
            AND m.deleted_at IS NULL
            AND m.status != 'PLAYING'
           WHERE h.owner_user_id = ?
           GROUP BY h.id, h.created_at
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(userId, Math.min(Math.max(limit, 1), 20)) as Array<Record<string, string | number | null>>
    ).map((row) => ({
      roomId: String(row['room_id']),
      createdAt: Number(row['created_at']),
      updatedAt: Number(row['updated_at']),
      matchCount: Number(row['match_count']),
      completedCount: Number(row['completed_count'] ?? 0),
    }));
  }

  hallRecords(userId: string, limit = 40): HallRecordSummary[] {
    return (
      this.db
        .prepare(
          `SELECT h.id AS room_id, h.created_at, uh.relation, owner.username AS owner_name,
                  MAX(COALESCE(m.ended_at, m.started_at, uh.last_seen_at, h.created_at)) AS updated_at,
                  COUNT(m.id) AS match_count,
                  SUM(CASE WHEN m.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count
           FROM user_halls uh
           JOIN halls h ON h.id = uh.hall_id
           LEFT JOIN users owner ON owner.id = h.owner_user_id
           LEFT JOIN matches m
             ON m.room_id = h.id
            AND m.deleted_at IS NULL
            AND m.status != 'PLAYING'
           WHERE uh.user_id = ? AND uh.hidden_at IS NULL
           GROUP BY h.id, h.created_at, uh.relation, owner.username, uh.last_seen_at
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(userId, Math.min(Math.max(limit, 1), 40)) as Array<Record<string, string | number | null>>
    ).map((row) => ({
      roomId: String(row['room_id']),
      createdAt: Number(row['created_at']),
      updatedAt: Number(row['updated_at']),
      matchCount: Number(row['match_count']),
      completedCount: Number(row['completed_count'] ?? 0),
      relation: row['relation'] === 'OWNER' ? 'OWNER' : 'PARTICIPANT',
      ownerName: row['owner_name'] === null ? '未知厅主' : String(row['owner_name']),
    }));
  }

  hallDashboard(roomId: string, viewerUserId: string): HallDashboard | null {
    const hall = this.db
      .prepare('SELECT owner_user_id, scores_revealed FROM halls WHERE id = ?')
      .get(roomId) as { owner_user_id: string | null; scores_revealed: number } | undefined;
    if (!hall) return null;
    const isOwner = hall.owner_user_id === viewerUserId;
    const scoresRevealed = Number(hall.scores_revealed) === 1;
    const matchRows = this.db
      .prepare(
        `SELECT id, started_at, ended_at, outcome, day, board_summary, status,
                ended_phase, fake_seer_user_id, replay_json, mode
         FROM matches
         WHERE room_id = ? AND deleted_at IS NULL AND status != 'PLAYING'
         ORDER BY started_at ASC`,
      )
      .all(roomId) as Array<Record<string, string | number | null>>;

    const stats = new Map<string, HallPlayerStats & { rawScore: number; rawHexScore: number }>();
    const matches: HallMatchRow[] = matchRows.map((match, index) => {
      const players = (
        this.db
          .prepare(
            `SELECT user_id, nickname, seat, role, camp, won
             FROM match_players WHERE match_id = ? ORDER BY seat ASC`,
          )
          .all(String(match['id'])) as Array<Record<string, string | number | null>>
      ).map((player): HallMatchPlayerRow => {
        const role = player['role'] as Role;
        const userId = player['user_id'] === null ? null : String(player['user_id']);
        const score = this.scoreFor({ ...match, ...player }, userId);
        const completed = match['status'] === 'COMPLETED' &&
          (match['outcome'] === 'WOLF' || match['outcome'] === 'GOOD');
        if (completed) {
          const key = userId ?? `guest:${String(player['nickname'])}`;
          const current = stats.get(key) ?? {
            userId,
            nickname: String(player['nickname']),
            wins: 0,
            losses: 0,
            wolfCount: 0,
            godCount: 0,
            villagerCount: 0,
            rawScore: 0,
            rawHexScore: 0,
            goodScore: 0,
            wolfScore: 0,
            hexWins: 0,
            hexLosses: 0,
            exileCorrect: 0,
            exileVotes: 0,
            exileAccuracy: 0,
            exileEligible: false,
          };
          const won = Number(player['won']) === 1;
          const hex = match['mode'] === 'HEX_CHAOS';
          if (hex) {
            if (won) current.hexWins += 1;
            else current.hexLosses += 1;
            current.rawHexScore += score;
          } else {
            if (won) current.wins += 1;
            else current.losses += 1;
            current.rawScore += score;
            if (player['camp'] === 'WOLF') current.wolfScore = (current.wolfScore ?? 0) + score;
            else current.goodScore = (current.goodScore ?? 0) + score;
          }
          if (isWolfRole(role)) current.wolfCount += 1;
          else if (role === 'VILLAGER' || role === 'HYBRID') current.villagerCount += 1;
          else if (isGod(role)) current.godCount += 1;
          stats.set(key, current);
        }
        const publicPlayer = {
          userId,
          nickname: String(player['nickname']),
          seat: Number(player['seat']),
          role,
          roleName: ROLE_NAME[role],
          camp: player['camp'] as Camp,
          won: player['won'] === null ? null : Number(player['won']) === 1,
          fakeSeer: match['fake_seer_user_id'] !== null &&
            String(match['fake_seer_user_id']) === userId,
        };
        return isOwner || scoresRevealed || userId === viewerUserId ? { ...publicPlayer, score } : publicPlayer;
      });
      const participated = players.some((player) => player.userId === viewerUserId);
      const replay = this.parseReplay(match['replay_json']);
      if (match['status'] === 'COMPLETED' && match['mode'] !== 'HEX_CHAOS' && replay?.dayVotes) {
        for (const round of replay.dayVotes) {
          for (const vote of round.votes) {
            if (vote.target === null) continue;
            const voter = players.find((player) => player.seat === vote.voter);
            const target = players.find((player) => player.seat === vote.target);
            if (!voter || !target) continue;
            const key = voter.userId ?? `guest:${voter.nickname}`;
            const current = stats.get(key);
            if (!current) continue;
            current.exileVotes += 1;
            if (isWolfRole(target.role)) current.exileCorrect += 1;
          }
        }
      }
      return {
        id: String(match['id']),
        displayNumber: index + 1,
        status: match['status'] as 'COMPLETED' | 'ABORTED',
        startedAt: Number(match['started_at']),
        endedAt: Number(match['ended_at']),
        outcome: match['outcome'] as Outcome | null,
        day: match['day'] === null ? null : Number(match['day']),
        endedPhase: match['ended_phase'] === null ? null : String(match['ended_phase']),
        boardSummary: String(match['board_summary']),
        mode: match['mode'] === 'HEX_CHAOS' ? 'HEX_CHAOS' : 'STANDARD',
        players,
        replay: isOwner || participated ? replay : null,
      };
    });

    const rankedEntries = [...stats.values()]
      .sort((a, b) => b.rawScore - a.rawScore || b.wins - a.wins || a.nickname.localeCompare(b.nickname));
    const ranks = new Map(rankedEntries.map((entry, index) => [entry.userId ?? `guest:${entry.nickname}`, index + 1]));
    // 未公开时绝不能继续按隐藏积分返回，否则仅看 JSON 数组顺序也能推断排行榜。
    const visibleOrder = isOwner || scoresRevealed
      ? rankedEntries
      : [...rankedEntries].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.nickname.localeCompare(b.nickname));
    const players = visibleOrder
      .map((entry): HallPlayerStats => {
        const { rawScore, rawHexScore, ...publicEntry } = entry;
        const canSeeScore = isOwner || scoresRevealed || entry.userId === viewerUserId;
        const base: HallPlayerStats = {
          ...publicEntry,
          exileAccuracy: publicEntry.exileVotes === 0
            ? 0
            : Math.round((publicEntry.exileCorrect / publicEntry.exileVotes) * 10_000) / 100,
          exileEligible: publicEntry.exileVotes >= 3,
        };
        return canSeeScore
          ? {
              ...base,
              score: rawScore,
              rank: ranks.get(entry.userId ?? `guest:${entry.nickname}`),
              goodScore: entry.goodScore,
              wolfScore: entry.wolfScore,
              hexScore: rawHexScore,
            }
          : base;
      });
    return { roomId, isOwner, scoresRevealed, matches, players };
  }

  deleteHallMatch(roomId: string, matchId: string, byUserId: string): AccountReply<null> {
    const hall = this.db
      .prepare('SELECT owner_user_id FROM halls WHERE id = ?')
      .get(roomId) as { owner_user_id: string | null } | undefined;
    if (!hall || hall.owner_user_id !== byUserId) {
      return { ok: false, message: '只有厅主可以删除场次' };
    }
    const result = this.db
      .prepare(
        `UPDATE matches SET deleted_at = ?, deleted_by_user_id = ?
         WHERE id = ? AND room_id = ? AND status != 'PLAYING' AND deleted_at IS NULL`,
      )
      .run(Date.now(), byUserId, matchId, roomId);
    if (Number(result.changes) !== 1) return { ok: false, message: '没有找到可删除的场次' };
    return { ok: true, value: null };
  }

  private scoreFor(row: Record<string, string | number | null>, userId: string | null): number {
    if (row['status'] !== 'COMPLETED') return 0;
    const outcome = row['outcome'] as Outcome | null;
    const camp = row['camp'] as Camp;
    if (outcome === 'WOLF') {
      if (camp !== 'WOLF') return 0;
      const bonus = row['fake_seer_user_id'] !== null &&
        String(row['fake_seer_user_id']) === userId ? 1 : 0;
      return 3 + bonus;
    }
    if (outcome === 'GOOD') return camp === 'GOOD' ? 1.5 : 0.5;
    return 0;
  }

  private parseReplay(value: string | number | null | undefined): MatchReplay | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
      const parsed = JSON.parse(value) as Partial<MatchReplay>;
      if (parsed.version !== 1 || !Array.isArray(parsed.nights)) return null;
      return parsed as MatchReplay;
    } catch {
      // 单条损坏的旧数据不应让整个大厅页面打不开。
      return null;
    }
  }

  private createSession(user: AccountUser): AuthResult {
    const token = `${randomUUID()}${randomBytes(16).toString('hex')}`;
    const now = Date.now();
    this.db
      .prepare('INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, user.id, now, now + SESSION_TTL_MS);
    return { token, user };
  }

  private userById(id: string): AccountUser | null {
    const row = this.db
      .prepare('SELECT id, username, must_change_password, created_at FROM users WHERE id = ?')
      .get(id) as
      | { id: string; username: string; must_change_password: number; created_at: number }
      | undefined;
    return row ? this.toUser(row) : null;
  }

  private toUser(row: {
    id: string;
    username: string;
    must_change_password: number;
    created_at: number;
  }): AccountUser {
    return {
      id: row.id,
      username: row.username,
      mustChangePassword: row.must_change_password === 1,
      createdAt: row.created_at,
    };
  }
}

export { DEFAULT_PASSWORD };
