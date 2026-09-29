import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Outcome } from '../shared/protocol.ts';
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
  players: HallMatchPlayerRow[];
}

export interface HallPlayerStats {
  userId: string | null;
  nickname: string;
  wins: number;
  losses: number;
  wolfCount: number;
  godCount: number;
  villagerCount: number;
  /** 只有厅主能收到积分与排名。 */
  score?: number;
  rank?: number;
}

export interface HallDashboard {
  roomId: string;
  isOwner: boolean;
  matches: HallMatchRow[];
  players: HallPlayerStats[];
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
  private readonly db: DatabaseSync;

  constructor(path = process.env.WEREWOLF_DB_PATH ?? resolve(import.meta.dirname, '../../data/werewolf.db')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
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
        created_at INTEGER NOT NULL
      );

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
        deleted_at INTEGER,
        deleted_by_user_id TEXT
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
    `);

    // 兼容已经创建过旧版 SQLite 的用户：CREATE TABLE IF NOT EXISTS 不会自动补列。
    this.ensureMatchColumn('match_number', 'INTEGER');
    this.ensureMatchColumn('status', "TEXT NOT NULL DEFAULT 'PLAYING'");
    this.ensureMatchColumn('ended_phase', 'TEXT');
    this.ensureMatchColumn('fake_seer_user_id', 'TEXT');
    this.ensureMatchColumn('deleted_at', 'INTEGER');
    this.ensureMatchColumn('deleted_by_user_id', 'TEXT');
    this.db.exec(`
      UPDATE matches SET status = 'COMPLETED'
      WHERE ended_at IS NOT NULL AND status = 'PLAYING';
      CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id, started_at);
    `);
  }

  private ensureMatchColumn(name: string, definition: string): void {
    const columns = this.db.prepare('PRAGMA table_info(matches)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE matches ADD COLUMN ${name} ${definition}`);
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
  ): string {
    const id = randomUUID();
    const matchNumber = this.nextMatchNumber(roomId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO matches
           (id, room_id, match_number, board_json, board_summary, started_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'PLAYING')`,
        )
        .run(id, roomId, matchNumber, JSON.stringify(board), boardSummary, Date.now());
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
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE matches
           SET ended_at = ?, outcome = ?, day = ?, status = 'COMPLETED',
               ended_phase = 'GAME_OVER', fake_seer_user_id = ?
           WHERE id = ? AND ended_at IS NULL`,
        )
        .run(Date.now(), outcome, day, fakeSeerUserId, id);
      const updateCamp = this.db.prepare('UPDATE match_players SET camp = ? WHERE match_id = ? AND seat = ?');
      for (const entry of finalCamps) updateCamp.run(entry.camp, id, entry.seat);
      if (outcome === 'DRAW') {
        this.db.prepare('UPDATE match_players SET won = 0 WHERE match_id = ?').run(id);
      } else {
        this.db
          .prepare('UPDATE match_players SET won = CASE WHEN camp = ? THEN 1 ELSE 0 END WHERE match_id = ?')
          .run(outcome, id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  abortMatch(id: string, day: number, phase: string): void {
    this.db
      .prepare(
        `UPDATE matches
         SET ended_at = ?, day = ?, status = 'ABORTED', ended_phase = ?, outcome = NULL
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(Date.now(), day, phase, id);
  }

  /** 重新发牌时旧牌局完全作废，不占场次、不进入任何列表。 */
  discardMatch(id: string): void {
    this.db.prepare('DELETE FROM matches WHERE id = ?').run(id);
  }

  history(userId: string, limit = 30): MatchHistoryRow[] {
    return this.db
      .prepare(
        `SELECT m.id, m.room_id, m.match_number, m.started_at, m.ended_at, m.outcome, m.day,
                m.board_summary, m.status, m.ended_phase, m.fake_seer_user_id,
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
        };
      });
  }

  hallDashboard(roomId: string, viewerUserId: string): HallDashboard | null {
    const hall = this.db
      .prepare('SELECT owner_user_id FROM halls WHERE id = ?')
      .get(roomId) as { owner_user_id: string | null } | undefined;
    if (!hall) return null;
    const isOwner = hall.owner_user_id === viewerUserId;
    const matchRows = this.db
      .prepare(
        `SELECT id, started_at, ended_at, outcome, day, board_summary, status,
                ended_phase, fake_seer_user_id
         FROM matches
         WHERE room_id = ? AND deleted_at IS NULL AND status != 'PLAYING'
         ORDER BY started_at ASC`,
      )
      .all(roomId) as Array<Record<string, string | number | null>>;

    const stats = new Map<string, HallPlayerStats & { rawScore: number }>();
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
          };
          const won = Number(player['won']) === 1;
          if (won) current.wins += 1;
          else current.losses += 1;
          if (isWolfRole(role)) current.wolfCount += 1;
          else if (role === 'VILLAGER' || role === 'HYBRID') current.villagerCount += 1;
          else if (isGod(role)) current.godCount += 1;
          current.rawScore += score;
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
        return isOwner ? { ...publicPlayer, score } : publicPlayer;
      });
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
        players,
      };
    });

    const players = [...stats.values()]
      .sort((a, b) => b.rawScore - a.rawScore || b.wins - a.wins || a.nickname.localeCompare(b.nickname))
      .map((entry, index) => {
        const { rawScore, ...publicEntry } = entry;
        return isOwner ? { ...publicEntry, score: rawScore, rank: index + 1 } : publicEntry;
      });
    return { roomId, isOwner, matches, players };
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
