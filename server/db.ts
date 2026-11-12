import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type {
  EventSettings,
  Participant,
  Question
} from '../shared/types.ts'
import { normalizeEmployeeNo, normalizeName, randomToken, sha256 } from './domain.ts'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export const defaultSettings: EventSettings = {
  eventName: '2026 年会互动现场',
  company: 'YOUR COMPANY',
  joinCode: process.env.JOIN_CODE || '8888',
  joinMode: 'hybrid',
  allowSelfRegistration: true,
  requireSelfApproval: false,
  eligibilityPolicy: 'independent',
  displayNameMode: 'masked',
  drawVisualCards: 160,
  shake: {
    durationSec: 30,
    winners: 10,
    prizeName: '摇一摇好礼'
  },
  redpacket: {
    durationSec: 20,
    mode: 'random',
    budgetFen: 100_000,
    packetCount: 500,
    fixedFen: 200,
    minFen: 100,
    maxFen: 888,
    maxClaims: 2,
    prizeName: '现金红包'
  },
  quiz: {
    winners: 10,
    basePoints: 100,
    speedBonusMax: 50,
    prizeName: '答题好礼'
  },
  lotteryPrizes: [
    { name: '三等奖', count: 10, each: 5 },
    { name: '二等奖', count: 5, each: 3 },
    { name: '一等奖', count: 2, each: 1 }
  ]
}

const settingsSchema = z.object({
  eventName: z.string().min(1).max(80),
  company: z.string().min(1).max(80),
  joinCode: z.string().max(40),
  joinMode: z.enum(['roster', 'self', 'hybrid']),
  allowSelfRegistration: z.boolean(),
  requireSelfApproval: z.boolean(),
  eligibilityPolicy: z.enum([
    'independent',
    'exclude_game_winners_from_lottery',
    'one_prize_per_person'
  ]),
  displayNameMode: z.enum(['masked', 'full']),
  drawVisualCards: z.number().int().min(40).max(300),
  shake: z.object({
    durationSec: z.number().int().min(5).max(300),
    winners: z.number().int().min(1).max(200),
    prizeName: z.string().min(1).max(80)
  }),
  redpacket: z.object({
    durationSec: z.number().int().min(5).max(300),
    mode: z.enum(['random', 'fixed']),
    budgetFen: z.number().int().min(1),
    packetCount: z.number().int().min(1).max(20_000),
    fixedFen: z.number().int().min(1),
    minFen: z.number().int().min(1),
    maxFen: z.number().int().min(1),
    maxClaims: z.number().int().min(1).max(20),
    prizeName: z.string().min(1).max(80)
  }),
  quiz: z.object({
    winners: z.number().int().min(1).max(200),
    basePoints: z.number().int().min(0).max(10_000),
    speedBonusMax: z.number().int().min(0).max(10_000),
    prizeName: z.string().min(1).max(80)
  }),
  lotteryPrizes: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        count: z.number().int().min(1).max(2000),
        each: z.number().int().min(1).max(500),
        image: z.string().max(500).optional()
      })
    )
    .min(1)
    .max(20)
})

export type Db = Database.Database

const settingsCache = new WeakMap<Db, EventSettings>()

function ensureDir(filePath: string) {
  if (filePath === ':memory:') return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function initializeSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_no TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'roster',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort INTEGER NOT NULL,
      text TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_option INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 20,
      points INTEGER NOT NULL DEFAULT 100
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      status TEXT NOT NULL,
      starts_at INTEGER,
      ends_at INTEGER,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shake_scores (
      round_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (round_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS packet_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,
      amount_fen INTEGER NOT NULL,
      claim_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      redeemed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS quiz_answers (
      round_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL,
      correct INTEGER NOT NULL,
      score INTEGER NOT NULL,
      answered_at INTEGER NOT NULL,
      PRIMARY KEY (round_id, question_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      prize_name TEXT NOT NULL,
      amount_fen INTEGER,
      draw_id TEXT,
      prize_index INTEGER,
      voided INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rounds_game ON rounds(game, id DESC);
    CREATE INDEX IF NOT EXISTS idx_claims_round ON packet_claims(round_id, id);
    CREATE INDEX IF NOT EXISTS idx_claims_participant ON packet_claims(round_id, participant_id, id);
    CREATE INDEX IF NOT EXISTS idx_shake_rank ON shake_scores(round_id, score DESC);
    CREATE INDEX IF NOT EXISTS idx_answers_round ON quiz_answers(round_id, participant_id);
    CREATE INDEX IF NOT EXISTS idx_results_game ON results(game, round_id);
    CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name);
    CREATE INDEX IF NOT EXISTS idx_participants_employee ON participants(employee_no);
  `)
}

function seedQuestions(db: Db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM questions').get() as { count: number }
  if (count.count > 0) return

  const insert = db.prepare(
    'INSERT INTO questions (sort, text, options, correct_option, duration_sec, points) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const samples = [
    ['今年的主题是什么？', ['同心同行', '乘风破浪', '一路生花', '未来可期'], 1, 20, 100],
    ['年会现场共有多少位同事参与？', ['约100人', '约300人', '约1000人', '约5000人'], 2, 20, 100],
    ['以下哪一项不是今天的互动玩法？', ['摇一摇', '红包雨', '答题', '滑雪'], 3, 20, 100],
    ['幸运抽奖由谁负责？', ['现场主持与系统', '随手一抓', '隔壁桌', '锦鲤本人'], 0, 20, 100],
    ['希望明年大家拥有什么？', ['好运', '健康', '加薪', '以上都要'], 3, 20, 100]
  ] as const
  const insertMany = db.transaction(() => {
    for (const [sort, [text, options, correct, durationSec, points]] of samples.entries()) {
      insert.run(sort, text, JSON.stringify(options), correct, durationSec, points)
    }
  })
  insertMany()
}

export function openDb(dbPath = process.env.DB_PATH || './data/gala.db'): Db {
  ensureDir(dbPath)
  const db = new Database(dbPath)
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 1000')
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -16384')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 67108864')
  initializeSchema(db)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now())
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = 'event'")
    .get() as { value: string } | undefined
  if (!existing) {
    const initialSettings = {
      ...defaultSettings,
      joinCode: process.env.JOIN_CODE || defaultSettings.joinCode
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('event', ?)").run(
      JSON.stringify(initialSettings)
    )
  }
  seedQuestions(db)
  return db
}

export function getSettings(db: Db): EventSettings {
  const cached = settingsCache.get(db)
  if (cached) return cached
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'event'")
    .get() as { value: string } | undefined
  const parsed = row ? JSON.parse(row.value) : {}
  const settings = settingsSchema.parse({
    ...defaultSettings,
    ...parsed,
    shake: { ...defaultSettings.shake, ...(parsed as Partial<EventSettings>).shake },
    redpacket: {
      ...defaultSettings.redpacket,
      ...(parsed as Partial<EventSettings>).redpacket
    },
    quiz: { ...defaultSettings.quiz, ...(parsed as Partial<EventSettings>).quiz }
  })
  settingsCache.set(db, settings)
  return settings
}

export function saveSettings(db: Db, next: unknown): EventSettings {
  const parsed = settingsSchema.parse(next)
  db.prepare("UPDATE settings SET value = ? WHERE key = 'event'").run(JSON.stringify(parsed))
  audit(db, 'admin', 'settings.update', JSON.stringify(parsed))
  settingsCache.set(db, parsed)
  return parsed
}

export function toParticipant(row: {
  id: number
  employee_no: string
  name: string
  department: string
  status: Participant['status']
  source: Participant['source']
  created_at: number
}): Participant {
  return {
    id: row.id,
    employeeNo: row.employee_no,
    name: row.name,
    department: row.department,
    status: row.status,
    source: row.source,
    createdAt: row.created_at
  }
}

export function getParticipantByEmployeeNo(db: Db, employeeNo: string) {
  return db
    .prepare('SELECT * FROM participants WHERE employee_no = ?')
    .get(normalizeEmployeeNo(employeeNo)) as
    | {
        id: number
        employee_no: string
        name: string
        department: string
        status: Participant['status']
        source: Participant['source']
        created_at: number
      }
    | undefined
}

export function getParticipant(db: Db, id: number) {
  return db
    .prepare('SELECT * FROM participants WHERE id = ?')
    .get(id) as
    | {
        id: number
        employee_no: string
        name: string
        department: string
        status: Participant['status']
        source: Participant['source']
        created_at: number
      }
    | undefined
}

export function createParticipant(
  db: Db,
  input: {
    employeeNo: string
    name: string
    department?: string
    status?: Participant['status']
    source?: Participant['source']
  }
) {
  const result = db
    .prepare(
      `INSERT INTO participants (employee_no, name, department, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      normalizeEmployeeNo(input.employeeNo),
      normalizeName(input.name) || input.name.trim(),
      input.department?.trim() || '',
      input.status || 'active',
      input.source || 'self',
      Date.now()
    )
  return Number(result.lastInsertRowid)
}

export function upsertRosterParticipant(
  db: Db,
  input: { employeeNo: string; name: string; department?: string }
) {
  const employeeNo = normalizeEmployeeNo(input.employeeNo)
  const existing = getParticipantByEmployeeNo(db, employeeNo)
  const name = input.name.trim()
  const department = input.department?.trim() || ''
  if (existing) {
    db.prepare(
      'UPDATE participants SET name = ?, department = ?, source = ?, status = ? WHERE id = ?'
    ).run(name, department, 'roster', existing.status === 'excluded' ? 'excluded' : 'active', existing.id)
    return existing.id
  }
  return createParticipant(db, { ...input, status: 'active', source: 'roster' })
}

export function createSession(db: Db, participantId: number): string {
  const token = randomToken()
  const now = Date.now()
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE participant_id = ?').run(participantId)
    db.prepare(
      'INSERT INTO sessions (token_hash, participant_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sha256(token), participantId, now, now + SESSION_TTL_MS)
  })
  transaction()
  return token
}

export function getSessionParticipant(db: Db, token: string | undefined) {
  if (!token) return undefined
  const row = db
    .prepare(
      `SELECT p.* FROM sessions s JOIN participants p ON p.id = s.participant_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(sha256(token), Date.now()) as
    | {
        id: number
        employee_no: string
        name: string
        department: string
        status: Participant['status']
        source: Participant['source']
        created_at: number
      }
    | undefined
  return row
}

export function createAdminSession(db: Db): string {
  const token = randomToken()
  const now = Date.now()
  db.prepare(
    'INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)'
  ).run(sha256(token), now, now + SESSION_TTL_MS)
  return token
}

export function hasAdminSession(db: Db, token: string | undefined): boolean {
  if (!token) return false
  const row = db
    .prepare('SELECT 1 AS ok FROM admin_sessions WHERE token_hash = ? AND expires_at > ?')
    .get(sha256(token), Date.now()) as { ok: number } | undefined
  return Boolean(row)
}

export function getQuestions(db: Db): Question[] {
  return (
    db.prepare('SELECT * FROM questions ORDER BY sort ASC, id ASC').all() as Array<{
      id: number
      sort: number
      text: string
      options: string
      correct_option: number
      duration_sec: number
      points: number
    }>
  ).map((row) => ({
    id: row.id,
    sort: row.sort,
    text: row.text,
    options: JSON.parse(row.options) as string[],
    correctOption: row.correct_option,
    durationSec: row.duration_sec,
    points: row.points
  }))
}

export function getQuestionById(db: Db, id: number): Question | undefined {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
    | {
        id: number
        sort: number
        text: string
        options: string
        correct_option: number
        duration_sec: number
        points: number
      }
    | undefined
  if (!row) return undefined
  return {
    id: row.id,
    sort: row.sort,
    text: row.text,
    options: JSON.parse(row.options) as string[],
    correctOption: row.correct_option,
    durationSec: row.duration_sec,
    points: row.points
  }
}

export function audit(db: Db, actor: string, action: string, detail: string) {
  db.prepare(
    'INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)'
  ).run(actor, action, detail, Date.now())
}

export function nowPlus(seconds: number): number {
  return Date.now() + seconds * 1000
}
