import { scryptSync, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { Participant } from '../shared/types.ts'
import type { Db } from './db.ts'
import { getSessionParticipant, hasAdminSession } from './db.ts'
import { toParticipant } from './db.ts'

export const PARTICIPANT_COOKIE = 'gala_player'
export const ADMIN_COOKIE = 'gala_admin'

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  return header.split(';').reduce<Record<string, string>>((cookies, part) => {
    const index = part.indexOf('=')
    if (index < 0) return cookies
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) cookies[key] = decodeURIComponent(value)
    return cookies
  }, {})
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  maxAgeSeconds: number
) {
  const secure =
    process.env.NODE_ENV === 'production' || String(process.env.PUBLIC_ORIGIN || '').startsWith('https://')
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
  )
}

export function clearCookie(res: Response, name: string) {
  res.setHeader(
    'Set-Cookie',
    `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  )
}

export function verifyAdminPassword(input: string): boolean {
  const hash = process.env.ADMIN_PASSWORD_HASH
  if (hash) {
    const [algorithm, salt, expected] = hash.split('$')
    if (algorithm !== 'scrypt' || !salt || !expected) return false
    const actual = scryptSync(input, salt, 64)
    const expectedBuffer = Buffer.from(expected, 'hex')
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer)
  }
  const password = process.env.ADMIN_PASSWORD
  if (!password) return false
  const actual = Buffer.from(input)
  const expected = Buffer.from(password)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function adminPasswordConfigured(): boolean {
  if (process.env.ADMIN_PASSWORD_HASH) return true
  if (process.env.ADMIN_PASSWORD) return true
  return false
}

export function screenAuthorized(token: string | undefined): boolean {
  const expected = process.env.SCREEN_TOKEN
  if (!expected) return true
  return token === expected
}

export function getRequestParticipant(req: Request, db: Db): Participant | undefined {
  const token = parseCookies(req.headers.cookie)[PARTICIPANT_COOKIE]
  const row = getSessionParticipant(db, token)
  return row ? toParticipant(row) : undefined
}

export function getRequestAdmin(req: Request, db: Db): boolean {
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE]
  return hasAdminSession(db, token)
}

export function requireParticipant(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const participant = getRequestParticipant(req, db)
    if (!participant) {
      res.status(401).json({ error: '请先扫码入场' })
      return
    }
    ;(req as Request & { participant?: Participant }).participant = participant
    next()
  }
}

export function requireActiveParticipant(db: Db) {
  const middleware = requireParticipant(db)
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, () => {
      const participant = (req as Request & { participant?: Participant }).participant
      if (!participant || participant.status !== 'active') {
        res.status(403).json({ error: '您的入场状态尚未生效，请联系主持台' })
        return
      }
      next()
    })
  }
}

export function requireAdmin(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!getRequestAdmin(req, db)) {
      res.status(401).json({ error: '主持台未登录' })
      return
    }
    next()
  }
}

export function participantFromRequest(req: Request): Participant {
  return (req as Request & { participant: Participant }).participant
}

export function getSocketIdentity(
  db: Db,
  cookies: string | undefined,
  screenToken: string | undefined
): {
  participant?: Participant
  admin: boolean
  screen: boolean
} {
  const parsed = parseCookies(cookies)
  const participantRow = getSessionParticipant(db, parsed[PARTICIPANT_COOKIE])
  const admin = hasAdminSession(db, parsed[ADMIN_COOKIE])
  const screen = screenAuthorized(screenToken)
  return {
    participant: participantRow ? toParticipant(participantRow) : undefined,
    admin,
    screen
  }
}
