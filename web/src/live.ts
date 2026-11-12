import { io, type Socket } from 'socket.io-client'
import { ref } from 'vue'
import type { LiveSnapshot, PlayerSummary } from '@shared/types'

const snapshot = ref<LiveSnapshot | null>(null)
const player = ref<PlayerSummary | null>(null)
const connected = ref(false)
const lastError = ref('')
let socket: Socket | null = null

export function connectLive(options: { screenToken?: string } = {}) {
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
  }
  const screenToken =
    options.screenToken ||
    new URLSearchParams(window.location.search).get('token') ||
    localStorage.getItem('gala_screen_token') ||
    ''
  socket = io({
    withCredentials: true,
    transports: ['websocket', 'polling'],
    auth: { screenToken }
  })
  connected.value = false
  lastError.value = ''
  socket.on('connect', () => {
    connected.value = true
    lastError.value = ''
  })
  socket.on('disconnect', () => {
    connected.value = false
  })
  socket.on('connect_error', (error) => {
    connected.value = false
    lastError.value = error.message === 'unauthorized' ? '连接凭证无效' : error.message
  })
  socket.on('state:snapshot', (value: LiveSnapshot) => {
    snapshot.value = value
  })
  socket.on('player:summary', (value: PlayerSummary) => {
    player.value = value
  })
  return socket
}

export function disconnectLive() {
  socket?.disconnect()
  socket = null
  connected.value = false
}

export function emitAck<T>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('实时连接未建立'))
      return
    }
    const timer = window.setTimeout(() => reject(new Error('操作超时')), 8000)
    socket.emit(event, payload, (value: T) => {
      window.clearTimeout(timer)
      resolve(value)
    })
  })
}

export function syncPlayer() {
  if (!socket?.connected) return
  socket.emit('player:sync')
}

export function useLive() {
  return { snapshot, player, connected, lastError, connectLive, disconnectLive, emitAck, syncPlayer }
}
