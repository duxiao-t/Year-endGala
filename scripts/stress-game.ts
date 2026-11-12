import path from 'node:path'
import { io, type Socket } from 'socket.io-client'
import type { EventSettings } from '../shared/types.ts'
import { openDb, upsertRosterParticipant } from '../server/db.ts'

const baseUrl = (process.argv[2] || '').replace(/\/$/, '')
const count = Math.max(1, Math.min(3000, Number(process.argv[3] || 1000)))
const pathPrefix = String(process.env.LOAD_PATH_PREFIX || '').replace(/\/$/, '')
const joinCode = process.env.JOIN_CODE || 'GALA2026'
const adminPassword = process.env.ADMIN_PASSWORD || ''
const dbPath = process.env.DB_PATH || ''
const connectWaitSeconds = Math.max(10, Number(process.env.LOAD_CONNECT_WAIT_SECONDS || 180))
const ackTimeoutMs = Math.max(5_000, Number(process.env.LOAD_ACK_TIMEOUT_MS || 30_000))

if (!baseUrl) throw new Error('Base URL is required')
if (!adminPassword) throw new Error('ADMIN_PASSWORD is required')
if (!dbPath || path.resolve(dbPath).startsWith('/www/Year-endGala/data/')) {
  throw new Error('DB_PATH must point to an isolated stress-test database')
}

const employeeNo = (index: number) => `LOAD${String(index).padStart(4, '0')}`
const employeeName = (index: number) => `压测员工${String(index).padStart(4, '0')}`

const db = openDb()
db.transaction(() => {
  for (let index = 1; index <= count; index += 1) {
    upsertRosterParticipant(db, {
      employeeNo: employeeNo(index),
      name: employeeName(index),
      department: '压测组'
    })
  }
})()
db.close()

interface PlayerSession {
  socket: Socket
}

interface AckResult<T> {
  result?: T
  latencyMs: number
  timeout?: boolean
}

const sessions: PlayerSession[] = []
let connected = 0
let connectErrors = 0
let snapshotBytes = 0

async function join(index: number): Promise<string> {
  const response = await fetch(`${baseUrl}${pathPrefix}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeNo: employeeNo(index),
      name: employeeName(index),
      department: '压测组',
      joinCode
    })
  })
  if (!response.ok) throw new Error(`join ${index}: ${response.status}`)
  const cookie = (response.headers.getSetCookie?.() || [])
    .map((item) => item.split(';')[0])
    .join('; ')
  if (!cookie) throw new Error(`join ${index}: no cookie`)
  return cookie
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ latencyMs: 0 })
      return
    }
    const started = performance.now()
    const timer = setTimeout(
      () => resolve({ latencyMs: performance.now() - started, timeout: true }),
      ackTimeoutMs
    )
    socket.emit(event, payload, (result: T) => {
      clearTimeout(timer)
      resolve({ result, latencyMs: performance.now() - started })
    })
  })
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0) * 10) / 10
}

function summarizeAcks<T extends { ok?: boolean; reason?: string }>(
  label: string,
  values: AckResult<T>[]
) {
  const latencies = values.filter((value) => !value.timeout).map((value) => value.latencyMs)
  const reasons = new Map<string, number>()
  let ok = 0
  for (const value of values) {
    if (value.timeout) {
      reasons.set('timeout', (reasons.get('timeout') || 0) + 1)
    } else if (value.result?.ok) {
      ok += 1
    } else {
      const reason = value.result?.reason || 'error'
      reasons.set(reason, (reasons.get(reason) || 0) + 1)
    }
  }
  console.log(
    JSON.stringify(
      {
        game: label,
        requests: values.length,
        ok,
        failures: Object.fromEntries(reasons),
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        p99Ms: percentile(latencies, 0.99)
      },
      null,
      2
    )
  )
}

async function adminRequest<T>(
  requestPath: string,
  init: RequestInit = {},
  cookie = ''
): Promise<T> {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('Cookie', cookie)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${baseUrl}${pathPrefix}${requestPath}`, { ...init, headers })
  if (!response.ok) {
    throw new Error(`${requestPath}: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}

async function loginAdmin(): Promise<string> {
  const response = await fetch(`${baseUrl}${pathPrefix}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword })
  })
  if (!response.ok) throw new Error(`admin login: ${response.status}`)
  return (response.headers.getSetCookie?.() || [])
    .map((item) => item.split(';')[0])
    .join('; ')
}

async function gameAction(
  cookie: string,
  game: 'redpacket' | 'quiz',
  action: string,
  extra: Record<string, unknown> = {}
) {
  return adminRequest(
    `/api/admin/games/${game}/action`,
    { method: 'POST', body: JSON.stringify({ action, ...extra }) },
    cookie
  )
}

console.log(`Joining ${count} clients against ${baseUrl}${pathPrefix} …`)
for (let index = 1; index <= count; index += 1) {
  try {
    const cookie = await join(index)
    const socket = io(baseUrl, {
      path: `${pathPrefix}/socket.io`,
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      forceNew: true,
      reconnection: false,
      timeout: 20_000
    })
    socket.on('connect', () => {
      connected += 1
    })
    socket.on('connect_error', () => {
      connectErrors += 1
    })
    socket.on('state:snapshot', (snapshot) => {
      if (!snapshotBytes) snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot))
    })
    sessions.push({ socket })
  } catch {
    connectErrors += 1
  }
  if (index % 200 === 0) console.log(`  joined ${index}/${count}`)
}

const connectDeadline = Date.now() + connectWaitSeconds * 1000
while (connected < count && Date.now() < connectDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 200))
}
await new Promise((resolve) => setTimeout(resolve, 1000))
console.log(
  `Connected ${connected}/${count}; connectErrors=${connectErrors}; participantSnapshotBytes=${snapshotBytes}`
)
if (connected < count) {
  sessions.forEach(({ socket }) => socket.close())
  process.exit(1)
}

const adminCookie = await loginAdmin()
const overview = await adminRequest<{ settings: EventSettings }>(
  '/api/admin/overview',
  {},
  adminCookie
)
const settings = overview.settings
await adminRequest(
  '/api/admin/settings',
  {
    method: 'PATCH',
    body: JSON.stringify({
      ...settings,
      redpacket: {
        ...settings.redpacket,
        durationSec: 90,
        mode: 'fixed',
        fixedFen: 100,
        budgetFen: count * 200,
        packetCount: count * 2,
        maxClaims: 2
      }
    })
  },
  adminCookie
)

await gameAction(adminCookie, 'redpacket', 'reset', { confirm: 'RESET' })
await gameAction(adminCookie, 'redpacket', 'start')
await new Promise((resolve) => setTimeout(resolve, 1000))
const claimResults = await Promise.all(
  sessions.map(({ socket }, index) =>
    emitAck<{ ok: boolean; reason?: string; amountFen?: number }>(socket, 'packet:claim', {
      requestId: `stress-claim-${Date.now()}-${index}`
    })
  )
)
summarizeAcks('redpacket', claimResults)
await gameAction(adminCookie, 'redpacket', 'finish')

await gameAction(adminCookie, 'quiz', 'reset', { confirm: 'RESET' })
await gameAction(adminCookie, 'quiz', 'start')
await new Promise((resolve) => setTimeout(resolve, 1000))
const quizResults = await Promise.all(
  sessions.map(({ socket }, index) =>
    emitAck<{ ok: boolean; reason?: string; correct?: boolean }>(socket, 'quiz:answer', {
      optionIndex: index % 4
    })
  )
)
summarizeAcks('quiz', quizResults)
await gameAction(adminCookie, 'quiz', 'finish')

await new Promise((resolve) => setTimeout(resolve, 1000))
sessions.forEach(({ socket }) => socket.close())
