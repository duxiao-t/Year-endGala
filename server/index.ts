import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import { Server as SocketServer } from 'socket.io'
import { z } from 'zod'
import type { EventSettings, GameKey, Participant, ViewKey } from '../shared/types.ts'
import {
  ADMIN_COOKIE,
  PARTICIPANT_COOKIE,
  adminPasswordConfigured,
  clearCookie,
  getRequestAdmin,
  getSocketIdentity,
  participantFromRequest,
  requireActiveParticipant,
  requireAdmin,
  requireParticipant,
  screenAuthorized,
  setCookie,
  verifyAdminPassword
} from './auth.ts'
import {
  createAdminSession,
  createParticipant,
  createSession,
  getParticipantByEmployeeNo,
  getSettings,
  getQuestions,
  openDb,
  saveSettings,
  toParticipant
} from './db.ts'
import {
  buildAdminOverview,
  buildPlayerSummary,
  buildSnapshot,
  claimRedPacket,
  drawLottery,
  finishExpired,
  finishRedPacket,
  finishShake,
  flushShakeScores,
  isSamePerson,
  listParticipants,
  listClaims,
  redeemClaim,
  resetGame,
  setView,
  startQuiz,
  startRedPacket,
  startShake,
  answerQuiz,
  quizAction,
  submitShakeBatch,
  updateParticipantStatus,
  voidResult
} from './state.ts'
import { importParticipants, importQuestions, exportWorkbook, addParticipant, addQuestion } from './transfer.ts'
import { audit } from './db.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
if (fs.existsSync('.env')) {
  try {
    process.loadEnvFile('.env')
  } catch {
    // .env is optional.
  }
}

const PORT = Number(process.env.PORT || 3000)
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || ''
const db = openDb()
const app = express()
const server = http.createServer(app)
const io = new SocketServer(server, {
  cors: { origin: process.env.PUBLIC_ORIGIN || true, credentials: true },
  maxHttpBufferSize: 1_000_000,
  pingInterval: 20_000,
  pingTimeout: 20_000
})

app.set('trust proxy', 1)
app.use(express.json({ limit: '10mb' }))

let broadcastScreen = () => {}
let broadcastAll = () => {}

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ error })
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((error: unknown) => {
      console.error(error)
      fail(res, 500, error instanceof Error ? error.message : '服务器错误')
    })
  }
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>()
function loginAllowed(ip: string): boolean {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 })
    return true
  }
  entry.count += 1
  return entry.count <= 20
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: Date.now() })
})

app.get('/api/public', (_req, res) => {
  const settings = getSettings(db)
  const snapshot = buildSnapshot(db)
  res.json({
    eventName: settings.eventName,
    company: settings.company,
    joinMode: settings.joinMode,
    allowSelfRegistration: settings.allowSelfRegistration,
    requireSelfApproval: settings.requireSelfApproval,
    joinCodeRequired: Boolean(settings.joinCode),
    participantCount: snapshot.join.participantCount
  })
})

const joinSchema = z.object({
  employeeNo: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  department: z.string().trim().max(80).optional().default(''),
  joinCode: z.string().trim().max(40).optional().default('')
})

app.post('/api/join', (req, res) => {
  const parsed = joinSchema.safeParse(req.body)
  if (!parsed.success) return fail(res, 400, '请填写工号、姓名和部门')
  const body = parsed.data
  const settings = getSettings(db)
  if (settings.joinCode && body.joinCode !== settings.joinCode) {
    return fail(res, 403, '入场码不正确')
  }
  const existing = getParticipantByEmployeeNo(db, body.employeeNo)
  let participantRow = existing
  if (existing) {
    if (!isSamePerson({ name: body.name }, { name: existing.name })) {
      return fail(res, 409, '工号与姓名不匹配，请联系主持台')
    }
    if (existing.status === 'excluded' || existing.status === 'absent') {
      return fail(res, 403, '该入场记录已被停用，请联系主持台')
    }
  } else {
    if (settings.joinMode === 'roster') {
      return fail(res, 404, '名单中未找到该工号')
    }
    if (!settings.allowSelfRegistration) {
      return fail(res, 403, '自助登记已关闭，请联系主持台')
    }
    const id = createParticipant(db, {
      employeeNo: body.employeeNo,
      name: body.name,
      department: body.department,
      status: settings.requireSelfApproval ? 'pending' : 'active',
      source: 'self'
    })
    participantRow = getParticipantByEmployeeNo(db, body.employeeNo)
    audit(db, 'participant', 'participant.self_register', String(id))
  }
  if (!participantRow) return fail(res, 500, '创建入场记录失败')
  const token = createSession(db, participantRow.id)
  setCookie(res, PARTICIPANT_COOKIE, token, 12 * 60 * 60)
  const participant = toParticipant(participantRow)
  broadcastScreen()
  res.json({
    participant,
    pending: participant.status === 'pending'
  })
})

app.get('/api/me', requireParticipant(db), (req, res) => {
  const participant = participantFromRequest(req)
  res.json(buildPlayerSummary(db, participant.id))
})

app.get('/api/screen/snapshot', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : undefined
  if (!getRequestAdmin(req, db) && !screenAuthorized(token)) {
    return fail(res, 401, '大屏凭证无效')
  }
  res.json(buildSnapshot(db))
})

app.post('/api/admin/login', (req, res) => {
  if (!loginAllowed(requestIp(req))) return fail(res, 429, '尝试次数过多，请稍后再试')
  if (!adminPasswordConfigured()) return fail(res, 500, '服务端未配置主持台密码')
  const schema = z.object({ password: z.string().min(1).max(200) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success || !verifyAdminPassword(parsed.data.password)) {
    return fail(res, 401, '主持台密码错误')
  }
  loginAttempts.delete(requestIp(req))
  const token = createAdminSession(db)
  setCookie(res, ADMIN_COOKIE, token, 12 * 60 * 60)
  broadcastScreen()
  res.json({ ok: true })
})

app.post('/api/admin/logout', requireAdmin(db), (_req, res) => {
  clearCookie(res, ADMIN_COOKIE)
  res.json({ ok: true })
})

app.get('/api/admin/overview', requireAdmin(db), (_req, res) => {
  res.json(buildAdminOverview(db))
})

function mergeSettings(current: EventSettings, patch: Partial<EventSettings>): EventSettings {
  return {
    ...current,
    ...patch,
    shake: { ...current.shake, ...(patch.shake || {}) },
    redpacket: { ...current.redpacket, ...(patch.redpacket || {}) },
    quiz: { ...current.quiz, ...(patch.quiz || {}) },
    lotteryPrizes: patch.lotteryPrizes || current.lotteryPrizes
  }
}

app.patch('/api/admin/settings', requireAdmin(db), (req, res) => {
  try {
    const next = mergeSettings(getSettings(db), req.body as Partial<EventSettings>)
    const saved = saveSettings(db, next)
    broadcastAll()
    res.json(saved)
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : '配置不合法')
  }
})

app.get('/api/admin/participants', requireAdmin(db), (req, res) => {
  const query = typeof req.query.query === 'string' ? req.query.query : ''
  const limit = Number(req.query.limit || 100)
  const offset = Number(req.query.offset || 0)
  res.json(listParticipants(db, query, limit, offset))
})

app.get('/api/admin/claims', requireAdmin(db), (req, res) => {
  const query = typeof req.query.query === 'string' ? req.query.query : ''
  const limit = Number(req.query.limit || 100)
  const offset = Number(req.query.offset || 0)
  res.json(listClaims(db, query, limit, offset))
})

app.post('/api/admin/participants', requireAdmin(db), (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1).max(40),
    name: z.string().min(1).max(40),
    department: z.string().max(80).optional().default(''),
    status: z.enum(['active', 'pending', 'excluded']).optional().default('active')
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 400, '参与者信息不合法')
  try {
    const participant = addParticipant(db, parsed.data)
    broadcastAll()
    res.json(participant)
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : '新增失败')
  }
})

const importSchema = z.object({
  filename: z.string().min(1).max(200),
  dataBase64: z.string().min(10)
})

app.post(
  '/api/admin/participants/import',
  requireAdmin(db),
  asyncRoute(async (req, res) => {
    const parsed = importSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, '导入文件缺失')
    const result = await importParticipants(db, parsed.data.filename, parsed.data.dataBase64)
    broadcastAll()
    res.json(result)
  })
)

app.patch('/api/admin/participants/:id', requireAdmin(db), (req, res) => {
  const schema = z.object({ status: z.enum(['active', 'pending', 'excluded', 'absent']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 400, '状态不合法')
  const ok = updateParticipantStatus(db, Number(req.params.id), parsed.data.status)
  if (!ok) return fail(res, 404, '参与者不存在')
  broadcastAll()
  res.json({ ok: true })
})

app.post('/api/admin/participants/:id/approve', requireAdmin(db), (req, res) => {
  const ok = updateParticipantStatus(db, Number(req.params.id), 'active')
  if (!ok) return fail(res, 404, '参与者不存在')
  broadcastAll()
  res.json({ ok: true })
})

app.post(
  '/api/admin/demo/participants',
  requireAdmin(db),
  (req, res) => {
    const count = Math.max(1, Math.min(3000, Number(req.body?.count) || 1000))
    let created = 0
    const transaction = db.transaction(() => {
      for (let index = 1; index <= count; index += 1) {
        const employeeNo = `DEMO${String(index).padStart(4, '0')}`
        if (getParticipantByEmployeeNo(db, employeeNo)) continue
        createParticipant(db, {
          employeeNo,
          name: `演示员工${String(index).padStart(4, '0')}`,
          department: `第${(index % 12) + 1}组`,
          status: 'active',
          source: 'roster'
        })
        created += 1
      }
    })
    transaction()
    audit(db, 'admin', 'participants.demo', String(created))
    broadcastAll()
    res.json({ created })
  }
)

app.get('/api/admin/questions', requireAdmin(db), (_req, res) => {
  res.json(getQuestions(db))
})

app.post('/api/admin/questions', requireAdmin(db), (req, res) => {
  const schema = z.object({
    text: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(200)).length(4),
    correctOption: z.number().int().min(0).max(3),
    durationSec: z.number().int().min(5).max(120).optional(),
    points: z.number().int().min(1).max(10_000).optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 400, '题目格式不合法')
  try {
    const question = addQuestion(db, parsed.data)
    broadcastAll()
    res.json(question)
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : '新增失败')
  }
})

app.delete('/api/admin/questions/:id', requireAdmin(db), (req, res) => {
  const result = db.prepare('DELETE FROM questions WHERE id = ?').run(Number(req.params.id))
  if (!result.changes) return fail(res, 404, '题目不存在')
  audit(db, 'admin', 'question.delete', req.params.id)
  broadcastAll()
  res.json({ ok: true })
})

app.post(
  '/api/admin/questions/import',
  requireAdmin(db),
  asyncRoute(async (req, res) => {
    const parsed = importSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, '导入文件缺失')
    const result = await importQuestions(db, parsed.data.filename, parsed.data.dataBase64)
    broadcastAll()
    res.json(result)
  })
)

app.post('/api/admin/view', requireAdmin(db), (req, res) => {
  const schema = z.object({
    view: z.enum(['lobby', 'shake', 'redpacket', 'quiz', 'lottery'])
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 400, '视图不合法')
  setView(db, parsed.data.view as ViewKey)
  broadcastAll()
  res.json({ ok: true })
})

app.post('/api/admin/games/:game/action', requireAdmin(db), (req, res) => {
  const game = req.params.game as GameKey
  const action = String(req.body?.action || '')
  try {
    if (game === 'shake') {
      if (action === 'start') startShake(db)
      else if (action === 'finish') finishShake(db)
      else if (action === 'reset') {
        if (req.body?.confirm !== 'RESET') return fail(res, 400, '请输入 RESET 确认重置')
        resetGame(db, 'shake')
      } else return fail(res, 400, '动作不合法')
    } else if (game === 'redpacket') {
      if (action === 'start') startRedPacket(db)
      else if (action === 'finish') finishRedPacket(db)
      else if (action === 'reset') {
        if (req.body?.confirm !== 'RESET') return fail(res, 400, '请输入 RESET 确认重置')
        resetGame(db, 'redpacket')
      } else return fail(res, 400, '动作不合法')
    } else if (game === 'quiz') {
      if (action === 'start') startQuiz(db)
      else if (['lock', 'reveal', 'next', 'finish'].includes(action)) {
        const result = quizAction(db, action as 'lock' | 'reveal' | 'next' | 'finish')
        if (!result.ok) return fail(res, 400, result.message || '操作失败')
      } else if (action === 'reset') {
        if (req.body?.confirm !== 'RESET') return fail(res, 400, '请输入 RESET 确认重置')
        resetGame(db, 'quiz')
      } else return fail(res, 400, '动作不合法')
    } else if (game === 'lottery') {
      if (action === 'show') setView(db, 'lottery')
      else if (action === 'reset') {
        if (req.body?.confirm !== 'RESET') return fail(res, 400, '请输入 RESET 确认重置')
        resetGame(db, 'lottery')
      } else return fail(res, 400, '动作不合法')
    } else {
      return fail(res, 404, '玩法不存在')
    }
    broadcastAll()
    res.json({ ok: true, overview: buildAdminOverview(db) })
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : '操作失败')
  }
})

app.post('/api/admin/lottery/draw', requireAdmin(db), (req, res) => {
  const schema = z.object({
    prizeIndex: z.number().int().min(0).max(30),
    count: z.number().int().min(1).max(100).optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 400, '抽奖参数不合法')
  const result = drawLottery(db, parsed.data.prizeIndex, parsed.data.count || 1)
  if (!result.ok) return fail(res, 400, result.message || '抽奖失败')
  broadcastAll()
  res.json(result)
})

app.post('/api/admin/results/:id/void', requireAdmin(db), (req, res) => {
  const reason = String(req.body?.reason || '').trim()
  if (!reason) return fail(res, 400, '请填写作废原因')
  if (!voidResult(db, Number(req.params.id), reason)) return fail(res, 404, '结果不存在')
  broadcastAll()
  res.json({ ok: true })
})

app.post('/api/admin/claims/:id/redeem', requireAdmin(db), (req, res) => {
  if (!redeemClaim(db, Number(req.params.id))) return fail(res, 404, '红包记录不存在或已兑付')
  broadcastAll()
  res.json({ ok: true })
})

app.get(
  '/api/admin/export',
  requireAdmin(db),
  asyncRoute(async (_req, res) => {
    const buffer = await exportWorkbook(db)
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gala-results-${new Date().toISOString().slice(0, 10)}.xlsx"`
    )
    res.send(buffer)
  })
)

const webDist = path.resolve(__dirname, '../web/dist')
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: '1h', index: false }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(webDist, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send('API is running. Start the web app with `npm run dev:web` or run `npm run build` first.')
  })
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error)
  fail(res, 500, error instanceof Error ? error.message : '服务器错误')
})

type SocketData = {
  participant?: Participant
  admin: boolean
  screen: boolean
}

io.use((socket, next) => {
  const identity = getSocketIdentity(
    db,
    socket.handshake.headers.cookie,
    typeof socket.handshake.auth?.screenToken === 'string'
      ? socket.handshake.auth.screenToken
      : undefined
  )
  if (!identity.participant && !identity.admin && !identity.screen) {
    next(new Error('unauthorized'))
    return
  }
  ;(socket.data as SocketData).participant = identity.participant
  ;(socket.data as SocketData).admin = identity.admin
  ;(socket.data as SocketData).screen = identity.screen
  next()
})

let screenTimer: NodeJS.Timeout | undefined

broadcastScreen = () => {
  if (screenTimer) return
  screenTimer = setTimeout(() => {
    screenTimer = undefined
    io.to('screen').to('admin').emit('state:snapshot', buildSnapshot(db))
  }, 800)
}

broadcastAll = () => {
  if (screenTimer) {
    clearTimeout(screenTimer)
    screenTimer = undefined
  }
  io.emit('state:snapshot', buildSnapshot(db))
}

io.on('connection', (socket) => {
  const data = socket.data as SocketData
  if (data.screen) socket.join('screen')
  if (data.admin) socket.join('admin')
  if (data.participant) socket.join(`participant:${data.participant.id}`)
  socket.emit('state:snapshot', buildSnapshot(db))
  if (data.participant) {
    socket.emit('player:summary', buildPlayerSummary(db, data.participant.id))
  }

  socket.on('player:sync', (ack?: (value: unknown) => void) => {
    if (!data.participant) return
    const summary = buildPlayerSummary(db, data.participant.id)
    ack?.(summary)
    socket.emit('player:summary', summary)
  })

  socket.on('shake:batch', (payload: { delta?: number } | undefined, ack?: (value: unknown) => void) => {
    if (!data.participant) return ack?.({ ok: false, reason: 'unauthorized' })
    const result = submitShakeBatch(db, data.participant.id, Number(payload?.delta || 0))
    ack?.(result)
    if (result.ok) broadcastScreen()
  })

  socket.on(
    'packet:claim',
    (payload: { requestId?: string } | undefined, ack?: (value: unknown) => void) => {
      if (!data.participant) return ack?.({ ok: false, reason: 'closed' })
      const requestId = String(payload?.requestId || '')
      if (!requestId || requestId.length > 80) return ack?.({ ok: false, reason: 'invalid' })
      const result = claimRedPacket(db, data.participant.id, requestId)
      ack?.(result)
      if (result.ok) {
        socket.emit('player:summary', buildPlayerSummary(db, data.participant.id))
        broadcastScreen()
      }
    }
  )

  socket.on(
    'quiz:answer',
    (payload: { optionIndex?: number } | undefined, ack?: (value: unknown) => void) => {
      if (!data.participant) return ack?.({ ok: false, reason: 'unauthorized' })
      const result = answerQuiz(db, data.participant.id, Number(payload?.optionIndex))
      ack?.(result)
      if (result.ok) {
        socket.emit('player:summary', buildPlayerSummary(db, data.participant.id))
        broadcastScreen()
      }
    }
  )
})

setInterval(() => {
  if (finishExpired(db)) {
    broadcastAll()
  }
}, 500).unref()

setInterval(() => {
  flushShakeScores(db)
}, 1000).unref()

if (!adminPasswordConfigured()) {
  console.warn('[gala] ADMIN_PASSWORD or ADMIN_PASSWORD_HASH is required in production.')
}
if (!process.env.SCREEN_TOKEN && process.env.NODE_ENV === 'production') {
  console.warn('[gala] SCREEN_TOKEN is not set; screen snapshot is readable by anyone.')
}
if (process.env.NODE_ENV === 'production' && !adminPasswordConfigured()) {
  console.error('[gala] Refusing to start without ADMIN_PASSWORD or ADMIN_PASSWORD_HASH.')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && !process.env.SCREEN_TOKEN) {
  console.error('[gala] Refusing to start without SCREEN_TOKEN.')
  process.exit(1)
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gala] listening on http://0.0.0.0:${PORT}`)
  console.log(`[gala] public origin: ${PUBLIC_ORIGIN || '(not configured)'}`)
})
