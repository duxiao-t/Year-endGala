import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { EventSettings, RedPacketSettings } from '../shared/types.ts'

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function randomClaimCode(): string {
  return randomBytes(4).toString('hex').toUpperCase()
}

export function normalizeEmployeeNo(value: string): string {
  return value.trim().toUpperCase()
}

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, '')
}

export function maskName(name: string): string {
  if (!name) return '***'
  if (name.length === 1) return `${name}*`
  return `${name[0]}${'*'.repeat(Math.min(2, name.length - 1))}`
}

export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1)
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

export function pickRandom<T>(items: readonly T[], count: number): T[] {
  return shuffle(items).slice(0, Math.max(0, count))
}

export function isRedPacketConfigValid(config: RedPacketSettings): boolean {
  if (config.packetCount <= 0 || config.durationSec <= 0 || config.maxClaims <= 0) {
    return false
  }
  if (config.mode === 'fixed') {
    return config.fixedFen > 0 && config.budgetFen >= config.fixedFen * config.packetCount
  }
  if (config.minFen <= 0 || config.maxFen < config.minFen) return false
  const minBudget = config.minFen * config.packetCount
  const maxBudget = config.maxFen * config.packetCount
  return config.budgetFen >= minBudget && config.budgetFen <= maxBudget
}

export function nextRedPacketAmount(input: {
  config: RedPacketSettings
  spentFen: number
  claimedCount: number
}): number | null {
  const { config, spentFen, claimedCount } = input
  const remainingPackets = config.packetCount - claimedCount
  if (remainingPackets <= 0) return null

  if (config.mode === 'fixed') {
    const remaining = config.budgetFen - spentFen
    return remaining >= config.fixedFen ? config.fixedFen : null
  }

  const remaining = config.budgetFen - spentFen
  if (remaining < config.minFen) return null
  const lower = Math.max(
    config.minFen,
    remaining - config.maxFen * (remainingPackets - 1)
  )
  const upper = Math.min(
    config.maxFen,
    remaining - config.minFen * (remainingPackets - 1)
  )
  if (lower > upper) return null
  return randomInt(lower, upper + 1)
}

export function speedScore(
  config: Pick<EventSettings['quiz'], 'basePoints' | 'speedBonusMax'>,
  endsAt: number,
  durationSec: number,
  now = Date.now()
): number {
  const totalMs = Math.max(1, durationSec * 1000)
  const remainingRatio = Math.max(0, Math.min(1, (endsAt - now) / totalMs))
  return config.basePoints + Math.round(config.speedBonusMax * remainingRatio)
}

export function publicName(name: string, mode: EventSettings['displayNameMode']): string {
  return mode === 'full' ? name : maskName(name)
}

export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
