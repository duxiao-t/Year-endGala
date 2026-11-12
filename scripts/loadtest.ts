import { io } from 'socket.io-client'
import { openDb } from '../server/db.ts'
import { finishShake, latestRound, startShake } from '../server/state.ts'
import { upsertRosterParticipant } from '../server/db.ts'

const baseUrl = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const pathPrefix = String(process.env.LOAD_PATH_PREFIX || '').replace(/\/$/, '')
const count = Math.max(1, Math.min(3000, Number(process.argv[3] || 1000)))
const joinCode = process.env.JOIN_CODE || 'GALA2026'
const durationSeconds = Math.max(3, Math.min(120, Number(process.env.LOAD_SECONDS || 20)))
const intervalMs = Math.max(250, Math.min(5000, Number(process.env.LOAD_INTERVAL_MS || 1000)))
const connectWaitSeconds = Math.max(
  10,
  Math.min(600, Number(process.env.LOAD_CONNECT_WAIT_SECONDS || 90))
)
const drainSeconds = Math.max(0, Math.min(60, Number(process.env.LOAD_DRAIN_SECONDS || 10)))
const db = openDb()

const seed = db.transaction(() => {
  for (let index = 1; index <= count; index += 1) {
    upsertRosterParticipant(db, {
      employeeNo: `LOAD${String(index).padStart(4, '0')}`,
      name: `压测员工${String(index).padStart(4, '0')}`,
      department: '压测组'
    })
  }
})
seed()

db.close()

interface PlayerSession {
  cookie: string
  socket: ReturnType<typeof io>
}

const sessions: PlayerSession[] = []
const latencies: number[] = []
let connectErrors = 0
let ackErrors = 0
let connected = 0

async function join(index: number): Promise<string> {
  const response = await fetch(`${baseUrl}${pathPrefix}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeNo: `LOAD${String(index).padStart(4, '0')}`,
      name: `压测员工${String(index).padStart(4, '0')}`,
      department: '压测组',
      joinCode
    })
  })
  if (!response.ok) throw new Error(`join ${index}: ${response.status}`)
  const cookies = response.headers.getSetCookie?.() || []
  const cookie = cookies.map((item) => item.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`join ${index}: no cookie`)
  return cookie
}

console.log(`Joining ${count} clients against ${baseUrl}${pathPrefix} …`)
for (let index = 1; index <= count; index += 1) {
  try {
    const cookie = await join(index)
    let connectCounted = false
    const socket = io(baseUrl, {
      path: `${pathPrefix}/socket.io`,
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      forceNew: true,
      reconnection: false
    })
    socket.on('connect', () => {
      if (!connectCounted) {
        connectCounted = true
        connected += 1
      }
    })
    socket.on('connect_error', () => {
      connectErrors += 1
    })
    sessions.push({ cookie, socket })
  } catch {
    connectErrors += 1
  }
  if (index % 100 === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.log(`  joined ${index}/${count}`)
  }
}

const connectDeadline = Date.now() + connectWaitSeconds * 1000
while (connected < count && Date.now() < connectDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await new Promise((resolve) => setTimeout(resolve, 500))
const roundDb = openDb()
if (latestRound(roundDb, 'shake')?.status === 'running') {
  finishShake(roundDb)
}
startShake(roundDb)
roundDb.close()
console.log(`Connected ${connected}/${count}. Racing shake batches for ${durationSeconds} seconds …`)
const interval = setInterval(() => {
  for (const { socket } of sessions) {
    if (!socket.connected) continue
    const started = performance.now()
    socket.emit('shake:batch', { delta: 3 }, (result: { ok: boolean }) => {
      if (!result?.ok) ackErrors += 1
      latencies.push(performance.now() - started)
    })
  }
}, intervalMs)

await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000))
clearInterval(interval)
const expectedAcks = connected * Math.floor((durationSeconds * 1000) / intervalMs)
const drainDeadline = Date.now() + drainSeconds * 1000
while (latencies.length < expectedAcks && Date.now() < drainDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
sessions.forEach(({ socket }) => socket.close())
const sorted = latencies.sort((a, b) => a - b)
const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] || 0
console.log(
  JSON.stringify(
    {
      clients: count,
      connected,
      connectErrors,
      ackCount: latencies.length,
      expectedAcks,
      pendingAcks: Math.max(0, expectedAcks - latencies.length),
      completionRate: expectedAcks
        ? Math.round((latencies.length / expectedAcks) * 1000) / 10
        : 100,
      ackErrors,
      p50Ms: Math.round(percentile(0.5) * 10) / 10,
      p95Ms: Math.round(percentile(0.95) * 10) / 10,
      p99Ms: Math.round(percentile(0.99) * 10) / 10
    },
    null,
    2
  )
)
process.exit(ackErrors > 0 || connectErrors > 0 ? 1 : 0)
