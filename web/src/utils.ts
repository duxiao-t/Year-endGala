import { onBeforeUnmount, ref } from 'vue'

export function fen(value: number | null | undefined): string {
  return ((value || 0) / 100).toFixed(2)
}

export function time(value: number | null | undefined): string {
  if (!value) return '--'
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Shanghai'
  })
}

export function dateTime(value: number | null | undefined): string {
  if (!value) return '--'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai'
  })
}

export function useCountdown(endsAt: () => number | undefined) {
  const remaining = ref(0)
  const update = () => {
    const end = endsAt()
    remaining.value = end ? Math.max(0, Math.ceil((end - Date.now()) / 1000)) : 0
  }
  update()
  const timer = window.setInterval(update, 200)
  onBeforeUnmount(() => window.clearInterval(timer))
  return remaining
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

export function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
