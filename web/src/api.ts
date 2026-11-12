import type {
  AdminOverview,
  AdminClaimRow,
  ClaimResponse,
  EventSettings,
  JoinRequest,
  JoinResponse,
  LiveSnapshot,
  Participant,
  PlayerSummary,
  Question,
  ShakeAck
} from '@shared/types'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers
  })
  const contentType = response.headers.get('content-type') || ''
  const body = contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    const message =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : String(body || '请求失败')
    throw new Error(message)
  }
  return body as T
}

export const api = {
  publicConfig: () =>
    request<{
      eventName: string
      company: string
      joinMode: string
      allowSelfRegistration: boolean
      requireSelfApproval: boolean
      joinCodeRequired: boolean
      participantCount: number
    }>('/api/public'),
  join: (payload: JoinRequest) =>
    request<JoinResponse>('/api/join', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => request<PlayerSummary>('/api/me'),
  screenSnapshot: (token?: string) =>
    request<LiveSnapshot>(
      `/api/screen/snapshot${token ? `?token=${encodeURIComponent(token)}` : ''}`
    ),
  adminLogin: (password: string) =>
    request<{ ok: boolean }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    }),
  adminLogout: () => request<{ ok: boolean }>('/api/admin/logout', { method: 'POST' }),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  updateSettings: (settings: EventSettings) =>
    request<EventSettings>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings)
    }),
  participants: (query = '', limit = 100, offset = 0) =>
    request<{ rows: Participant[]; total: number }>(
      `/api/admin/participants?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`
    ),
  claims: (query = '', limit = 100, offset = 0) =>
    request<{ rows: AdminClaimRow[]; total: number }>(
      `/api/admin/claims?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`
    ),
  addParticipant: (payload: {
    employeeNo: string
    name: string
    department?: string
    status?: string
  }) =>
    request<Participant>('/api/admin/participants', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  updateParticipant: (id: number, status: string) =>
    request<{ ok: boolean }>(`/api/admin/participants/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    }),
  approveParticipant: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/participants/${id}/approve`, { method: 'POST' }),
  importParticipants: (filename: string, dataBase64: string) =>
    request<{ imported: number; skipped: number }>('/api/admin/participants/import', {
      method: 'POST',
      body: JSON.stringify({ filename, dataBase64 })
    }),
  demoParticipants: (count = 1000) =>
    request<{ created: number }>('/api/admin/demo/participants', {
      method: 'POST',
      body: JSON.stringify({ count })
    }),
  questions: () => request<Question[]>('/api/admin/questions'),
  addQuestion: (payload: {
    text: string
    options: string[]
    correctOption: number
    durationSec?: number
    points?: number
  }) =>
    request<Question>('/api/admin/questions', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  deleteQuestion: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/questions/${id}`, { method: 'DELETE' }),
  importQuestions: (filename: string, dataBase64: string) =>
    request<{ imported: number; skipped: number }>('/api/admin/questions/import', {
      method: 'POST',
      body: JSON.stringify({ filename, dataBase64 })
    }),
  switchView: (view: string) =>
    request<{ ok: boolean }>('/api/admin/view', {
      method: 'POST',
      body: JSON.stringify({ view })
    }),
  action: (game: string, action: string, confirm?: string) =>
    request<{ ok: boolean; overview: AdminOverview }>(`/api/admin/games/${game}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, confirm })
    }),
  draw: (prizeIndex: number, count: number) =>
    request<{ ok: boolean; winners: unknown[] }>('/api/admin/lottery/draw', {
      method: 'POST',
      body: JSON.stringify({ prizeIndex, count })
    }),
  voidResult: (id: number, reason: string) =>
    request<{ ok: boolean }>(`/api/admin/results/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }),
  redeemClaim: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/claims/${id}/redeem`, { method: 'POST' }),
  exportUrl: '/api/admin/export'
}

export async function exportWorkbook() {
  const response = await fetch(api.exportUrl, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('导出失败')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `gala-results-${new Date().toISOString().slice(0, 10)}.xlsx`
  link.click()
  URL.revokeObjectURL(url)
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export type { ClaimResponse, ShakeAck }
