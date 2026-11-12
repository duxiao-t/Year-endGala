import type {
  AdminOverview,
  ClaimResponse,
  EventSettings,
  GameKey,
  LeaderboardEntry,
  LiveSnapshot,
  Participant,
  PlayerSummary,
  PublicQuestion,
  RedPacketSnapshot,
  ShakeAck,
  ShakeSnapshot,
  ViewKey,
  Winner
} from '../shared/types.ts'
import type { Db } from './db.ts'
import {
  audit,
  getParticipant,
  getQuestions,
  getSettings,
  toParticipant
} from './db.ts'
import {
  isRedPacketConfigValid,
  nextRedPacketAmount,
  normalizeName,
  parseJson,
  pickRandom,
  publicName,
  randomClaimCode,
  randomToken,
  speedScore
} from './domain.ts'

interface RoundRow {
  id: number
  game: GameKey
  status: string
  starts_at: number | null
  ends_at: number | null
  data: string
  created_at: number
}

interface QuizRoundData {
  questionIds: number[]
  index: number
}

interface ShakeCache {
  roundId: number
  scores: Map<number, { score: number; updatedAt: number }>
  dirty: Set<number>
}

let shakeCache: ShakeCache | null = null

function requireView(value: string): ViewKey {
  if (value === 'lobby') return 'lobby'
  if (value === 'shake' || value === 'redpacket' || value === 'quiz' || value === 'lottery') {
    return value
  }
  return 'lobby'
}

export function getView(db: Db): ViewKey {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'view'").get() as
    | { value: string }
    | undefined
  return requireView(row?.value || 'lobby')
}

export function setView(db: Db, view: ViewKey) {
  requireView(view)
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('view', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(view)
  audit(db, 'admin', 'view.switch', view)
}

export function latestRound(db: Db, game: GameKey): RoundRow | undefined {
  return db
    .prepare('SELECT * FROM rounds WHERE game = ? ORDER BY id DESC LIMIT 1')
    .get(game) as RoundRow | undefined
}

function runningRound(db: Db, game: GameKey): RoundRow | undefined {
  const round = latestRound(db, game)
  return round && ['running', 'question'].includes(round.status) ? round : undefined
}

function createRound(
  db: Db,
  game: GameKey,
  status: string,
  startsAt: number | null,
  endsAt: number | null,
  data: unknown = {}
): number {
  const result = db
    .prepare(
      'INSERT INTO rounds (game, status, starts_at, ends_at, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(game, status, startsAt, endsAt, JSON.stringify(data), Date.now())
  return Number(result.lastInsertRowid)
}

function updateRound(
  db: Db,
  id: number,
  patch: Partial<Pick<RoundRow, 'status' | 'starts_at' | 'ends_at' | 'data'>>
) {
  const current = db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as RoundRow
  db.prepare(
    'UPDATE rounds SET status = ?, starts_at = ?, ends_at = ?, data = ? WHERE id = ?'
  ).run(
    patch.status ?? current.status,
    patch.starts_at === undefined ? current.starts_at : patch.starts_at,
    patch.ends_at === undefined ? current.ends_at : patch.ends_at,
    patch.data ?? current.data,
    id
  )
}

function winnersForRound(
  db: Db,
  game: GameKey,
  roundId: number,
  displayNameMode: EventSettings['displayNameMode'] = 'full'
): Winner[] {
  const rows = db
    .prepare(
      `SELECT r.*, p.name, p.department
       FROM results r JOIN participants p ON p.id = r.participant_id
       WHERE r.game = ? AND r.round_id = ? AND r.voided = 0
       ORDER BY r.rank ASC`
    )
    .all(game, roundId) as Array<{
    id: number
    participant_id: number
    rank: number
    prize_name: string
    amount_fen: number | null
    name: string
    department: string
  }>
  return rows.map((row) => ({
    resultId: row.id,
    participantId: row.participant_id,
    name: publicName(row.name, displayNameMode),
    department: row.department,
    prizeName: row.prize_name,
    rank: row.rank,
    amountFen: row.amount_fen ?? undefined
  }))
}

function shakeSnapshot(db: Db, settings: EventSettings): ShakeSnapshot {
  const round = latestRound(db, 'shake')
  if (!round) {
    return {
      phase: 'idle',
      durationSec: settings.shake.durationSec,
      participantCount: 0,
      top: [],
      winners: []
    }
  }
  const rows = db
    .prepare(
      `SELECT s.participant_id, s.score, p.name, p.department
       FROM shake_scores s JOIN participants p ON p.id = s.participant_id
       WHERE s.round_id = ? AND s.score > 0
       ORDER BY s.score DESC, s.updated_at ASC LIMIT 20`
    )
    .all(round.id) as Array<{
    participant_id: number
    score: number
    name: string
    department: string
  }>
  const top: LeaderboardEntry[] = rows.map((row, index) => ({
    participantId: row.participant_id,
    name: publicName(row.name, settings.displayNameMode),
    department: row.department,
    score: row.score,
    rank: index + 1
  }))
  const phase = round.status === 'running' ? 'running' : round.status === 'finished' ? 'finished' : 'idle'
  return {
    phase,
    startsAt: round.starts_at ?? undefined,
    endsAt: round.ends_at ?? undefined,
    durationSec: settings.shake.durationSec,
    participantCount: Number(
      (db.prepare('SELECT COUNT(*) AS count FROM shake_scores WHERE round_id = ?').get(round.id) as {
        count: number
      }).count
    ),
    top,
    winners: winnersForRound(db, 'shake', round.id, settings.displayNameMode)
  }
}

function redPacketSnapshot(db: Db, settings: EventSettings): RedPacketSnapshot {
  const round = latestRound(db, 'redpacket')
  if (!round) {
    return {
      phase: 'idle',
      durationSec: settings.redpacket.durationSec,
      packetCount: settings.redpacket.packetCount,
      claimedCount: 0,
      claimedAmountFen: 0,
      maxClaims: settings.redpacket.maxClaims,
      recent: []
    }
  }
  const roundConfig =
    parseJson<{ config?: EventSettings['redpacket'] }>(round.data, {}).config ||
    settings.redpacket
  const aggregate = db
    .prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(amount_fen), 0) AS amount FROM packet_claims WHERE round_id = ?'
    )
    .get(round.id) as { count: number; amount: number }
  const recentRows = db
    .prepare(
      `SELECT p.name, c.amount_fen, c.created_at
       FROM packet_claims c JOIN participants p ON p.id = c.participant_id
       WHERE c.round_id = ? ORDER BY c.id DESC LIMIT 8`
    )
    .all(round.id) as Array<{ name: string; amount_fen: number; created_at: number }>
  const phase =
    round.status === 'running' ? 'running' : round.status === 'finished' ? 'finished' : 'idle'
  return {
    phase,
    startsAt: round.starts_at ?? undefined,
    endsAt: round.ends_at ?? undefined,
    durationSec: roundConfig.durationSec,
    packetCount: roundConfig.packetCount,
    claimedCount: aggregate.count,
    claimedAmountFen: aggregate.amount,
    maxClaims: roundConfig.maxClaims,
    recent: recentRows.map((row) => ({
      name: publicName(row.name, settings.displayNameMode),
      amountFen: row.amount_fen,
      at: row.created_at
    }))
  }
}

function quizLeaderboard(db: Db, roundId: number, settings: EventSettings): LeaderboardEntry[] {
  const rows = db
    .prepare(
      `SELECT a.participant_id, SUM(a.score) AS score, MIN(a.answered_at) AS first_at,
              p.name, p.department
       FROM quiz_answers a JOIN participants p ON p.id = a.participant_id
       WHERE a.round_id = ?
       GROUP BY a.participant_id
       ORDER BY score DESC, first_at ASC LIMIT 50`
    )
    .all(roundId) as Array<{
    participant_id: number
    score: number
    first_at: number
    name: string
    department: string
  }>
  return rows.map((row, index) => ({
    participantId: row.participant_id,
    name: publicName(row.name, settings.displayNameMode),
    department: row.department,
    score: row.score,
    rank: index + 1
  }))
}

function quizSnapshot(db: Db, settings: EventSettings): LiveSnapshot['quiz'] {
  const round = latestRound(db, 'quiz')
  if (!round) {
    return {
      phase: 'idle',
      answeredCount: 0,
      top: [],
      winners: []
    }
  }
  const data = parseJson<QuizRoundData>(round.data, { questionIds: [], index: 0 })
  const questions = getQuestions(db)
  const questionById = new Map(questions.map((question) => [question.id, question]))
  const question = questionById.get(data.questionIds[data.index])
  if (!question) {
    return {
      phase: 'finished',
      startsAt: round.starts_at ?? undefined,
      endsAt: round.ends_at ?? undefined,
      answeredCount: 0,
      top: quizLeaderboard(db, round.id, settings),
      winners: winnersForRound(db, 'quiz', round.id, settings.displayNameMode)
    }
  }
  const answeredCount = Number(
    (db.prepare(
      'SELECT COUNT(*) AS count FROM quiz_answers WHERE round_id = ? AND question_id = ?'
    ).get(round.id, question.id) as { count: number }).count
  )
  const phase = ['question', 'locked', 'revealed', 'finished'].includes(round.status)
    ? (round.status as LiveSnapshot['quiz']['phase'])
    : 'idle'
  const publicQuestion: PublicQuestion = {
    id: question.id,
    index: data.index + 1,
    total: data.questionIds.length,
    text: question.text,
    options: question.options,
    durationSec: question.durationSec,
    endsAt: round.ends_at ?? 0,
    correctOption: phase === 'revealed' || phase === 'finished' ? question.correctOption : undefined
  }
  let distribution: number[] | undefined
  let correctCount: number | undefined
  if (phase === 'revealed' || phase === 'finished') {
    distribution = question.options.map((_, index) => {
      return Number(
        (db.prepare(
          'SELECT COUNT(*) AS count FROM quiz_answers WHERE round_id = ? AND question_id = ? AND option_index = ?'
        ).get(round.id, question.id, index) as { count: number }).count
      )
    })
    correctCount = Number(
      (db.prepare(
        'SELECT COUNT(*) AS count FROM quiz_answers WHERE round_id = ? AND question_id = ? AND correct = 1'
      ).get(round.id, question.id) as { count: number }).count
    )
  }
  return {
    phase,
    startsAt: round.starts_at ?? undefined,
    endsAt: round.ends_at ?? undefined,
    question: publicQuestion,
    answeredCount,
    correctCount,
    distribution,
    top: quizLeaderboard(db, round.id, settings),
    winners: winnersForRound(db, 'quiz', round.id, settings.displayNameMode)
  }
}

function eligibleParticipantRows(db: Db, settings: EventSettings): Array<{
  id: number
  name: string
  department: string
}> {
  const policy = settings.eligibilityPolicy
  const excludedGame = policy === 'exclude_game_winners_from_lottery' || policy === 'one_prize_per_person'
  const otherGames = policy === 'one_prize_per_person' ? ['shake', 'redpacket', 'quiz'] : ['shake', 'redpacket', 'quiz']
  const params: unknown[] = []
  let sql = `
    SELECT p.id, p.name, p.department
    FROM participants p
    WHERE p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM results r
        WHERE r.participant_id = p.id AND r.voided = 0 AND r.game = 'lottery'
      )
  `
  if (excludedGame) {
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM results r
      WHERE r.participant_id = p.id AND r.voided = 0 AND r.game IN (${otherGames.map(() => '?').join(',')})
    )`
    params.push(...otherGames)
  }
  sql += ' ORDER BY p.id ASC'
  return db.prepare(sql).all(...params) as Array<{
    id: number
    name: string
    department: string
  }>
}

function lotterySnapshot(db: Db, settings: EventSettings): LiveSnapshot['lottery'] {
  const prizeRows = db
    .prepare(
      "SELECT prize_index, COUNT(*) AS count FROM results WHERE game = 'lottery' AND voided = 0 GROUP BY prize_index"
    )
    .all() as Array<{ prize_index: number; count: number }>
  const used = new Map(prizeRows.map((row) => [row.prize_index, row.count]))
  const remaining = settings.lotteryPrizes.map((prize, index) =>
    Math.max(0, prize.count - (used.get(index) || 0))
  )
  const eligible = eligibleParticipantRows(db, settings)
  const visualRows = eligible.slice(0, settings.drawVisualCards)
  const lastRow = db
    .prepare(
      `SELECT draw_id, prize_index, prize_name FROM results
       WHERE game = 'lottery' AND voided = 0 AND draw_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get() as { draw_id: string; prize_index: number; prize_name: string } | undefined
  let lastDraw: LiveSnapshot['lottery']['lastDraw']
  if (lastRow) {
    const drawRows = db
      .prepare(
        `SELECT r.id, r.participant_id, r.rank, r.prize_name, r.amount_fen, p.name, p.department
         FROM results r JOIN participants p ON p.id = r.participant_id
         WHERE r.game = 'lottery' AND r.draw_id = ? AND r.voided = 0
         ORDER BY r.rank ASC`
      )
      .all(lastRow.draw_id) as Array<{
      id: number
      participant_id: number
      rank: number
      prize_name: string
      amount_fen: number | null
      name: string
      department: string
    }>
    lastDraw = {
      drawId: lastRow.draw_id,
      prizeIndex: lastRow.prize_index,
      prizeName: lastRow.prize_name,
      winners: drawRows.map((row) => ({
        resultId: row.id,
        participantId: row.participant_id,
        name: publicName(row.name, settings.displayNameMode),
        department: row.department,
        prizeName: row.prize_name,
        rank: row.rank,
        amountFen: row.amount_fen ?? undefined
      })),
      at: Number(
        (db.prepare('SELECT MAX(created_at) AS at FROM results WHERE draw_id = ?').get(lastRow.draw_id) as {
          at: number
        }).at
      )
    }
  }
  return {
    phase: lastDraw ? 'result' : 'ready',
    prizes: settings.lotteryPrizes.map((prize) => ({ ...prize })),
    remaining,
    eligibleCount: eligible.length,
    visualNames: visualRows.map((row) => publicName(row.name, settings.displayNameMode)),
    lastDraw
  }
}

export function buildSnapshot(db: Db): LiveSnapshot {
  const settings = getSettings(db)
  const participantStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM participants`
    )
    .get() as { total: number; active: number | null; pending: number | null }
  return {
    now: Date.now(),
    view: getView(db),
    eventName: settings.eventName,
    company: settings.company,
    publicOrigin: process.env.PUBLIC_ORIGIN || '',
    join: {
      joinMode: settings.joinMode,
      allowSelfRegistration: settings.allowSelfRegistration,
      requireSelfApproval: settings.requireSelfApproval,
      joinCodeRequired: Boolean(settings.joinCode),
      joinCode: settings.joinCode,
      participantCount: participantStats.total,
      activeCount: participantStats.active || 0,
      pendingCount: participantStats.pending || 0
    },
    shake: shakeSnapshot(db, settings),
    redpacket: redPacketSnapshot(db, settings),
    quiz: quizSnapshot(db, settings),
    lottery: lotterySnapshot(db, settings),
    displayNameMode: settings.displayNameMode
  }
}

export function buildPlayerSummary(db: Db, participantId: number): PlayerSummary {
  const participantRow = getParticipant(db, participantId)
  if (!participantRow) throw new Error('participant not found')
  const participant = toParticipant(participantRow)
  const settings = getSettings(db)
  const shakeRound = latestRound(db, 'shake')
  let shakeScore = 0
  let shakeRank: number | null = null
  if (shakeRound) {
    const own = db
      .prepare('SELECT score FROM shake_scores WHERE round_id = ? AND participant_id = ?')
      .get(shakeRound.id, participantId) as { score: number } | undefined
    shakeScore = own?.score || 0
    shakeRank = shakeScore
      ? Number(
          (db.prepare(
            'SELECT COUNT(*) AS count FROM shake_scores WHERE round_id = ? AND score > ?'
          ).get(shakeRound.id, shakeScore) as { count: number }).count
        ) + 1
      : null
  }
  const redpacketRound = latestRound(db, 'redpacket')
  const claims = redpacketRound
    ? (db.prepare(
        'SELECT amount_fen, claim_code, created_at, redeemed_at FROM packet_claims WHERE round_id = ? AND participant_id = ? ORDER BY id DESC'
      ).all(redpacketRound.id, participantId) as Array<{
        amount_fen: number
        claim_code: string
        created_at: number
        redeemed_at: number | null
      }>)
    : []
  const quizRound = latestRound(db, 'quiz')
  let quizScore = 0
  let quizRank: number | null = null
  let quizAnswer: PlayerSummary['quiz']['answer']
  if (quizRound) {
    const own = db
      .prepare('SELECT COALESCE(SUM(score), 0) AS score FROM quiz_answers WHERE round_id = ? AND participant_id = ?')
      .get(quizRound.id, participantId) as { score: number }
    quizScore = own.score
    quizRank = quizScore
      ? Number(
          (db.prepare(
            `SELECT COUNT(*) AS count FROM (
               SELECT participant_id, SUM(score) AS total FROM quiz_answers WHERE round_id = ?
               GROUP BY participant_id HAVING total > ?
             )`
          ).get(quizRound.id, quizScore) as { count: number }).count
        ) + 1
      : null
    const data = parseJson<QuizRoundData>(quizRound.data, { questionIds: [], index: 0 })
    const currentQuestionId = data.questionIds[data.index]
    if (currentQuestionId) {
      const answer = db
        .prepare(
          'SELECT question_id, option_index, correct, score FROM quiz_answers WHERE round_id = ? AND question_id = ? AND participant_id = ?'
        )
        .get(quizRound.id, currentQuestionId, participantId) as {
        question_id: number
        option_index: number
        correct: number
        score: number
      } | undefined
      if (answer) {
        quizAnswer = {
          questionId: answer.question_id,
          optionIndex: answer.option_index,
          correct: Boolean(answer.correct),
          score: answer.score
        }
      }
    }
  }
  const lotteryRows = db
    .prepare(
      `SELECT r.id, r.participant_id, r.rank, r.prize_name, r.amount_fen, p.name, p.department
       FROM results r JOIN participants p ON p.id = r.participant_id
       WHERE r.game = 'lottery' AND r.participant_id = ? AND r.voided = 0
       ORDER BY r.id DESC`
    )
    .all(participantId) as Array<{
    id: number
    participant_id: number
    rank: number
    prize_name: string
    amount_fen: number | null
    name: string
    department: string
  }>
  return {
    participant,
    view: getView(db),
    shake: {
      score: shakeScore,
      rank: shakeRank,
      phase: shakeSnapshot(db, settings).phase
    },
    redpacket: {
      claimedCount: claims.length,
      totalFen: claims.reduce((sum, claim) => sum + claim.amount_fen, 0),
      claims: claims.map((claim) => ({
        amountFen: claim.amount_fen,
        claimCode: claim.claim_code,
        createdAt: claim.created_at,
        redeemedAt: claim.redeemed_at
      }))
    },
    quiz: {
      score: quizScore,
      rank: quizRank,
      answer: quizAnswer
    },
    lottery: {
      won: lotteryRows.length > 0,
      results: lotteryRows.map((row) => ({
        resultId: row.id,
        participantId: row.participant_id,
        name: row.name,
        department: row.department,
        prizeName: row.prize_name,
        rank: row.rank,
        amountFen: row.amount_fen ?? undefined
      }))
    }
  }
}

export function startShake(db: Db): { roundId: number; endsAt: number } {
  const settings = getSettings(db)
  if (!settings.shake.durationSec) throw new Error('摇一摇时长未配置')
  ensureGameCanStart(db, 'shake')
  ensureNoRunningGame(db, 'shake')
  const now = Date.now()
  const roundId = createRound(db, 'shake', 'running', now, now + settings.shake.durationSec * 1000)
  shakeCache = { roundId, scores: new Map(), dirty: new Set() }
  setView(db, 'shake')
  audit(db, 'admin', 'shake.start', String(roundId))
  return { roundId, endsAt: now + settings.shake.durationSec * 1000 }
}

export function finishShake(db: Db): boolean {
  const round = latestRound(db, 'shake')
  if (!round || round.status !== 'running') return false
  flushShakeScores(db)
  const settings = getSettings(db)
  const rows = db
    .prepare(
      `SELECT s.participant_id, s.score
       FROM shake_scores s JOIN participants p ON p.id = s.participant_id
       WHERE s.round_id = ? AND s.score > 0 AND p.status = 'active'
       ORDER BY s.score DESC, s.updated_at ASC LIMIT ?`
    )
    .all(round.id, settings.shake.winners) as Array<{
    participant_id: number
    score: number
  }>
  const insert = db.prepare(
    `INSERT INTO results (game, round_id, participant_id, rank, prize_name, created_at)
     VALUES ('shake', ?, ?, ?, ?, ?)`
  )
  const finish = db.transaction(() => {
    updateRound(db, round.id, { status: 'finished', ends_at: Date.now() })
    const exists = (db.prepare("SELECT COUNT(*) AS count FROM results WHERE game = 'shake' AND round_id = ?").get(round.id) as { count: number }).count
    if (!exists) {
      rows.forEach((row, index) => {
        insert.run(round.id, row.participant_id, index + 1, settings.shake.prizeName, Date.now())
      })
    }
  })
  finish()
  audit(db, 'system', 'shake.finish', String(round.id))
  return true
}

export function submitShakeBatch(
  db: Db,
  participantId: number,
  delta: number
): ShakeAck {
  const participant = getParticipant(db, participantId)
  if (!participant || participant.status !== 'active') {
    return { ok: false, reason: 'invalid' }
  }
  const round = runningRound(db, 'shake')
  if (!round || !round.ends_at || Date.now() > round.ends_at) {
    return { ok: false, reason: 'closed' }
  }
  const safeDelta = Math.max(0, Math.min(12, Math.floor(delta)))
  if (safeDelta === 0) {
    return { ok: false, reason: 'invalid' }
  }
  ensureShakeCache(db, round.id)
  const existing = shakeCache?.scores.get(participantId)
  const elapsedSec = Math.max(0, (Date.now() - (round.starts_at || Date.now())) / 1000)
  const maxScore = Math.floor(elapsedSec * 24) + 12
  const nextScore = Math.min(maxScore, (existing?.score || 0) + safeDelta)
  shakeCache?.scores.set(participantId, { score: nextScore, updatedAt: Date.now() })
  shakeCache?.dirty.add(participantId)
  return { ok: true, score: nextScore, rank: null }
}

function ensureShakeCache(db: Db, roundId: number) {
  if (shakeCache?.roundId === roundId) return
  const rows = db
    .prepare('SELECT participant_id, score, updated_at FROM shake_scores WHERE round_id = ?')
    .all(roundId) as Array<{ participant_id: number; score: number; updated_at: number }>
  shakeCache = {
    roundId,
    scores: new Map(
      rows.map((row) => [row.participant_id, { score: row.score, updatedAt: row.updated_at }])
    ),
    dirty: new Set()
  }
}

export function flushShakeScores(db: Db) {
  if (!shakeCache || shakeCache.dirty.size === 0) return
  const statement = db.prepare(
    `INSERT INTO shake_scores (round_id, participant_id, score, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(round_id, participant_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
  )
  const roundId = shakeCache.roundId
  const dirtyIds = [...shakeCache.dirty]
  const scores = shakeCache.scores
  const transaction = db.transaction(() => {
    for (const participantId of dirtyIds) {
      const entry = scores.get(participantId)
      if (entry) statement.run(roundId, participantId, entry.score, entry.updatedAt)
    }
  })
  transaction()
  shakeCache.dirty.clear()
}

export function startRedPacket(db: Db): { roundId: number; endsAt: number } {
  const settings = getSettings(db)
  if (!isRedPacketConfigValid(settings.redpacket)) {
    throw new Error('红包预算与包数配置不合法')
  }
  ensureGameCanStart(db, 'redpacket')
  ensureNoRunningGame(db, 'redpacket')
  const now = Date.now()
  const endsAt = now + settings.redpacket.durationSec * 1000
  const roundId = createRound(db, 'redpacket', 'running', now, endsAt, {
    config: settings.redpacket
  })
  setView(db, 'redpacket')
  audit(db, 'admin', 'redpacket.start', String(roundId))
  return { roundId, endsAt }
}

export function finishRedPacket(db: Db): boolean {
  const round = latestRound(db, 'redpacket')
  if (!round || round.status !== 'running') return false
  updateRound(db, round.id, { status: 'finished', ends_at: Date.now() })
  audit(db, 'system', 'redpacket.finish', String(round.id))
  return true
}

export function claimRedPacket(
  db: Db,
  participantId: number,
  requestId: string
): ClaimResponse {
  const participant = getParticipant(db, participantId)
  if (!participant || participant.status !== 'active') {
    return { ok: false, reason: 'closed' }
  }
  const round = runningRound(db, 'redpacket')
  if (!round || !round.ends_at || Date.now() > round.ends_at) {
    return { ok: false, reason: 'closed' }
  }
  const settings = getSettings(db)
  const config =
    parseJson<{ config?: EventSettings['redpacket'] }>(round.data, {}).config ||
    settings.redpacket
  const existingRequest = db
    .prepare('SELECT amount_fen, claim_code FROM packet_claims WHERE request_id = ? AND round_id = ?')
    .get(requestId, round.id) as { amount_fen: number; claim_code: string } | undefined
  if (existingRequest) {
    return {
      ok: true,
      amountFen: existingRequest.amount_fen,
      claimCode: existingRequest.claim_code
    }
  }
  const countRow = db
    .prepare('SELECT COUNT(*) AS count FROM packet_claims WHERE round_id = ?')
    .get(round.id) as { count: number }
  if (countRow.count >= config.packetCount) {
    return { ok: false, reason: 'empty' }
  }
  const ownCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM packet_claims WHERE round_id = ? AND participant_id = ?')
      .get(round.id, participantId) as { count: number }).count
  )
  if (ownCount >= config.maxClaims) {
    return { ok: false, reason: 'limit', claimedCount: ownCount, maxClaims: config.maxClaims }
  }
  const lastClaim = db
    .prepare('SELECT created_at FROM packet_claims WHERE round_id = ? AND participant_id = ? ORDER BY id DESC LIMIT 1')
    .get(round.id, participantId) as { created_at: number } | undefined
  if (lastClaim && Date.now() - lastClaim.created_at < 250) {
    return { ok: false, reason: 'rate' }
  }
  const spentRow = db
    .prepare('SELECT COALESCE(SUM(amount_fen), 0) AS amount FROM packet_claims WHERE round_id = ?')
    .get(round.id) as { amount: number }
  const amount = nextRedPacketAmount({
    config,
    spentFen: spentRow.amount,
    claimedCount: countRow.count
  })
  if (!amount) return { ok: false, reason: 'empty' }
  const claimCode = randomClaimCode()
  try {
    db.prepare(
      `INSERT INTO packet_claims (round_id, participant_id, request_id, amount_fen, claim_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(round.id, participantId, requestId, amount, claimCode, Date.now())
  } catch (error) {
    const duplicate = db
      .prepare('SELECT amount_fen, claim_code FROM packet_claims WHERE request_id = ?')
      .get(requestId) as { amount_fen: number; claim_code: string } | undefined
    if (duplicate) {
      return { ok: true, amountFen: duplicate.amount_fen, claimCode: duplicate.claim_code }
    }
    throw error
  }
  return {
    ok: true,
    amountFen: amount,
    claimCode,
    claimedCount: ownCount + 1,
    maxClaims: config.maxClaims
  }
}

export function startQuiz(db: Db): { roundId: number; endsAt: number } {
  const questions = getQuestions(db)
  if (questions.length === 0) throw new Error('题库为空，请先导入题目')
  ensureGameCanStart(db, 'quiz')
  ensureNoRunningGame(db, 'quiz')
  const now = Date.now()
  const first = questions[0]
  const roundId = createRound(
    db,
    'quiz',
    'question',
    now,
    now + first.durationSec * 1000,
    { questionIds: questions.map((question) => question.id), index: 0 }
  )
  setView(db, 'quiz')
  audit(db, 'admin', 'quiz.start', String(roundId))
  return { roundId, endsAt: now + first.durationSec * 1000 }
}

function finishQuiz(db: Db): boolean {
  const round = latestRound(db, 'quiz')
  if (!round || round.status === 'finished') return false
  const settings = getSettings(db)
  const rows = quizLeaderboard(db, round.id, settings).slice(0, settings.quiz.winners)
  const insert = db.prepare(
    `INSERT INTO results (game, round_id, participant_id, rank, prize_name, created_at)
     VALUES ('quiz', ?, ?, ?, ?, ?)`
  )
  const transaction = db.transaction(() => {
    updateRound(db, round.id, { status: 'finished', ends_at: Date.now() })
    const exists = (db.prepare("SELECT COUNT(*) AS count FROM results WHERE game = 'quiz' AND round_id = ?").get(round.id) as { count: number }).count
    if (!exists) {
      rows.forEach((row, index) => {
        insert.run(round.id, row.participantId, index + 1, settings.quiz.prizeName, Date.now())
      })
    }
  })
  transaction()
  audit(db, 'system', 'quiz.finish', String(round.id))
  return true
}

export function quizAction(
  db: Db,
  action: 'lock' | 'reveal' | 'next' | 'finish'
): { ok: boolean; message?: string } {
  const round = latestRound(db, 'quiz')
  if (!round) return { ok: false, message: '答题尚未开始' }
  if (round.status === 'finished') return { ok: false, message: '答题已结束' }
  const data = parseJson<QuizRoundData>(round.data, { questionIds: [], index: 0 })
  if (action === 'lock') {
    updateRound(db, round.id, { status: 'locked', ends_at: Date.now() })
  } else if (action === 'reveal') {
    updateRound(db, round.id, { status: 'revealed', ends_at: Date.now() })
  } else if (action === 'finish') {
    finishQuiz(db)
  } else {
    if (round.status !== 'revealed') {
      return { ok: false, message: '请先揭晓本题' }
    }
    const questions = getQuestions(db)
    const nextIndex = data.index + 1
    if (nextIndex >= questions.length) {
      finishQuiz(db)
      return { ok: true, message: '答题结束' }
    }
    const next = questions[nextIndex]
    const now = Date.now()
    updateRound(db, round.id, {
      status: 'question',
      starts_at: now,
      ends_at: now + next.durationSec * 1000,
      data: JSON.stringify({ ...data, index: nextIndex })
    })
  }
  audit(db, 'admin', `quiz.${action}`, String(round.id))
  return { ok: true }
}

export function answerQuiz(
  db: Db,
  participantId: number,
  optionIndex: number
): { ok: boolean; reason?: string; correct?: boolean; score?: number } {
  const participant = getParticipant(db, participantId)
  if (!participant || participant.status !== 'active') {
    return { ok: false, reason: 'closed' }
  }
  const round = runningRound(db, 'quiz')
  if (!round || round.status !== 'question' || !round.ends_at) {
    return { ok: false, reason: 'closed' }
  }
  if (Date.now() > round.ends_at) return { ok: false, reason: 'closed' }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 5) {
    return { ok: false, reason: 'invalid' }
  }
  const data = parseJson<QuizRoundData>(round.data, { questionIds: [], index: 0 })
  const questions = getQuestions(db)
  const question = questions.find((item) => item.id === data.questionIds[data.index])
  if (!question || optionIndex >= question.options.length) {
    return { ok: false, reason: 'invalid' }
  }
  const settings = getSettings(db)
  const correct = optionIndex === question.correctOption
  const basePoints = Math.max(
    1,
    Math.round((settings.quiz.basePoints * question.points) / 100)
  )
  const score = correct
    ? speedScore(
        { basePoints, speedBonusMax: settings.quiz.speedBonusMax },
        round.ends_at,
        question.durationSec
      )
    : 0
  try {
    db.prepare(
      `INSERT INTO quiz_answers (round_id, question_id, participant_id, option_index, correct, score, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(round.id, question.id, participantId, optionIndex, correct ? 1 : 0, score, Date.now())
  } catch {
    return { ok: false, reason: 'duplicate' }
  }
  return { ok: true, correct, score }
}

export function lockExpiredQuiz(db: Db): boolean {
  const round = latestRound(db, 'quiz')
  if (round?.status !== 'question' || !round.ends_at || Date.now() < round.ends_at) return false
  updateRound(db, round.id, { status: 'locked', ends_at: Date.now() })
  audit(db, 'system', 'quiz.auto_lock', String(round.id))
  return true
}

function ensureGameCanStart(db: Db, game: GameKey) {
  const round = latestRound(db, game)
  if (round && round.status !== 'finished') {
    throw new Error('该玩法已有未结束的轮次，请先结束或重置')
  }
}

function ensureNoRunningGame(db: Db, starting: GameKey) {
  for (const game of ['shake', 'redpacket', 'quiz'] as GameKey[]) {
    if (game === starting) continue
    const round = latestRound(db, game)
    if (round && round.status !== 'finished') {
      throw new Error('已有其他游戏进行中，请先结束')
    }
  }
}

export function drawLottery(
  db: Db,
  prizeIndex: number,
  requestedCount: number
): { ok: boolean; message?: string; drawId?: string; winners?: Winner[] } {
  const settings = getSettings(db)
  const prize = settings.lotteryPrizes[prizeIndex]
  if (!prize) return { ok: false, message: '奖项不存在' }
  const used = Number(
    (db.prepare(
      "SELECT COUNT(*) AS count FROM results WHERE game = 'lottery' AND prize_index = ? AND voided = 0"
    ).get(prizeIndex) as { count: number }).count
  )
  const remaining = prize.count - used
  if (remaining <= 0) return { ok: false, message: '该奖项已抽完' }
  const count = Math.min(Math.max(1, requestedCount), prize.each, remaining)
  const eligible = eligibleParticipantRows(db, settings)
  if (eligible.length === 0) return { ok: false, message: '没有可抽取的参与者' }
  const chosen = pickRandom(eligible, count)
  const drawId = randomToken(12)
  const now = Date.now()
  const drawRound = createRound(db, 'lottery', 'result', now, now, {
    prizeIndex,
    prizeName: prize.name,
    drawId
  })
  const insert = db.prepare(
    `INSERT INTO results
      (game, round_id, participant_id, rank, prize_name, amount_fen, draw_id, prize_index, created_at)
     VALUES ('lottery', ?, ?, ?, ?, NULL, ?, ?, ?)`
  )
  const transaction = db.transaction(() => {
    chosen.forEach((participant, index) => {
      insert.run(drawRound, participant.id, index + 1, prize.name, drawId, prizeIndex, now)
    })
  })
  transaction()
  setView(db, 'lottery')
  audit(db, 'admin', 'lottery.draw', JSON.stringify({ drawId, prizeIndex, count }))
  return {
    ok: true,
    drawId,
    winners: chosen.map((participant, index) => ({
      resultId: 0,
      participantId: participant.id,
      name: participant.name,
      department: participant.department,
      prizeName: prize.name,
      rank: index + 1
    }))
  }
}

export function voidResult(db: Db, resultId: number, reason: string): boolean {
  const result = db
    .prepare('SELECT * FROM results WHERE id = ? AND voided = 0')
    .get(resultId) as
    | { id: number; participant_id: number; game: string }
    | undefined
  if (!result) return false
  const transaction = db.transaction(() => {
    db.prepare('UPDATE results SET voided = 1 WHERE id = ?').run(resultId)
    if (result.game === 'lottery') {
      db.prepare("UPDATE participants SET status = 'absent' WHERE id = ?").run(result.participant_id)
    }
  })
  transaction()
  audit(db, 'admin', 'result.void', JSON.stringify({ resultId, reason: reason.slice(0, 200) }))
  return true
}

export function redeemClaim(db: Db, claimId: number): boolean {
  const result = db
    .prepare('UPDATE packet_claims SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL')
    .run(Date.now(), claimId)
  if (result.changes > 0) {
    audit(db, 'admin', 'packet.redeem', String(claimId))
    return true
  }
  return false
}

export function resetGame(db: Db, game: GameKey): boolean {
  if (game === 'shake') shakeCache = null
  const table =
    game === 'shake'
      ? 'shake_scores'
      : game === 'redpacket'
        ? 'packet_claims'
        : game === 'quiz'
          ? 'quiz_answers'
          : null
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM results WHERE game = ?').run(game)
    if (table) {
      db.prepare(
        `DELETE FROM ${table} WHERE round_id IN (SELECT id FROM rounds WHERE game = ?)`
      ).run(game)
    }
    db.prepare('DELETE FROM rounds WHERE game = ?').run(game)
  })
  transaction()
  if (getView(db) === game) setView(db, 'lobby')
  audit(db, 'admin', `${game}.reset`, 'all')
  return true
}

export function finishExpired(db: Db): boolean {
  let changed = false
  const shake = latestRound(db, 'shake')
  if (shake?.status === 'running' && shake.ends_at && Date.now() >= shake.ends_at) {
    changed = finishShake(db) || changed
  }
  const redpacket = latestRound(db, 'redpacket')
  if (
    redpacket?.status === 'running' &&
    redpacket.ends_at &&
    Date.now() >= redpacket.ends_at
  ) {
    changed = finishRedPacket(db) || changed
  }
  changed = lockExpiredQuiz(db) || changed
  return changed
}

export function buildAdminOverview(db: Db): AdminOverview {
  const snapshot = buildSnapshot(db)
  const settings = getSettings(db)
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS participants,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM participants`
    )
    .get() as { participants: number; active: number | null; pending: number | null }
  const claims = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_fen), 0) AS amount FROM packet_claims')
    .get() as { count: number; amount: number }
  const completedGames = Number(
    (db.prepare("SELECT COUNT(DISTINCT game) AS count FROM results").get() as {
      count: number
    }).count
  )
  const recentResults = db
    .prepare(
      `SELECT r.id, r.game, r.prize_name, r.rank, r.amount_fen, r.created_at, r.voided,
              p.name, p.employee_no
       FROM results r JOIN participants p ON p.id = r.participant_id
       ORDER BY r.id DESC LIMIT 30`
    )
    .all() as Array<{
    id: number
    game: GameKey
    prize_name: string
    rank: number
    amount_fen: number | null
    created_at: number
    voided: number
    name: string
    employee_no: string
  }>
  return {
    snapshot,
    settings,
    questions: getQuestions(db),
    stats: {
      participants: stats.participants,
      active: stats.active || 0,
      pending: stats.pending || 0,
      completedGames,
      totalClaims: claims.count,
      totalClaimedFen: claims.amount
    },
    recentResults: recentResults.map((row) => ({
      id: row.id,
      game: row.game,
      name: row.name,
      employeeNo: row.employee_no,
      prizeName: row.prize_name,
      rank: row.rank,
      amountFen: row.amount_fen,
      createdAt: row.created_at,
      voided: Boolean(row.voided)
    }))
  }
}

export function listParticipants(
  db: Db,
  query = '',
  limit = 100,
  offset = 0
): { rows: Participant[]; total: number } {
  const normalized = query.trim()
  const pattern = `%${normalized}%`
  const where = normalized
    ? 'WHERE employee_no LIKE ? OR name LIKE ? OR department LIKE ?'
    : ''
  const params = normalized ? [pattern, pattern, pattern] : []
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM participants ${where}`).get(...params) as {
      count: number
    }).count
  )
  const rows = db
    .prepare(
      `SELECT * FROM participants ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as Array<{
    id: number
    employee_no: string
    name: string
    department: string
    status: Participant['status']
    source: Participant['source']
    created_at: number
  }>
  return { rows: rows.map(toParticipant), total }
}

export function listClaims(
  db: Db,
  query = '',
  limit = 100,
  offset = 0
): { rows: Array<import('../shared/types.ts').AdminClaimRow>; total: number } {
  const normalized = query.trim()
  const pattern = `%${normalized}%`
  const where = normalized
    ? 'WHERE p.employee_no LIKE ? OR p.name LIKE ? OR c.claim_code LIKE ?'
    : ''
  const params = normalized ? [pattern, pattern, pattern] : []
  const total = Number(
    (db.prepare(
      `SELECT COUNT(*) AS count FROM packet_claims c JOIN participants p ON p.id = c.participant_id ${where}`
    ).get(...params) as { count: number }).count
  )
  const rows = db
    .prepare(
      `SELECT c.*, p.employee_no, p.name, p.department
       FROM packet_claims c JOIN participants p ON p.id = c.participant_id
       ${where}
       ORDER BY c.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as Array<{
    id: number
    employee_no: string
    name: string
    department: string
    amount_fen: number
    claim_code: string
    created_at: number
    redeemed_at: number | null
  }>
  return {
    total,
    rows: rows.map((row) => ({
      id: row.id,
      employeeNo: row.employee_no,
      name: row.name,
      department: row.department,
      amountFen: row.amount_fen,
      claimCode: row.claim_code,
      createdAt: row.created_at,
      redeemedAt: row.redeemed_at
    }))
  }
}

export function updateParticipantStatus(
  db: Db,
  id: number,
  status: Participant['status']
): boolean {
  const result = db.prepare('UPDATE participants SET status = ? WHERE id = ?').run(status, id)
  if (result.changes) audit(db, 'admin', 'participant.status', `${id}:${status}`)
  return result.changes > 0
}

export function approveParticipant(db: Db, id: number): boolean {
  return updateParticipantStatus(db, id, 'active')
}

export function isSamePerson(input: { name: string }, existing: { name: string }): boolean {
  return normalizeName(input.name) === normalizeName(existing.name)
}
