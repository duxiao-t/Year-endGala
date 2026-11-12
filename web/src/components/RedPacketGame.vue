<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClaimResponse, LiveSnapshot, PlayerSummary } from '@shared/types'
import { emitAck } from '../live'
import { fen, randomId, useCountdown } from '../utils'

const props = defineProps<{
  snapshot: LiveSnapshot
  summary: PlayerSummary
}>()

const phase = computed(() => props.snapshot.redpacket.phase)
const remaining = useCountdown(() => props.snapshot.redpacket.endsAt)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const wrapperRef = ref<HTMLDivElement | null>(null)
const claims = ref(props.summary.redpacket.claimedCount)
const totalFen = ref(props.summary.redpacket.totalFen)
const message = ref('')
const floats = ref<Array<{ id: string; text: string; left: number; top: number }>>([])
const maxClaims = computed(() => props.snapshot.redpacket.maxClaims)
const isFull = computed(() => claims.value >= maxClaims.value)
let raf = 0
let spawnTimer: number | undefined
let packets: Packet[] = []
let trail: TrailPoint[] = []
let lastFrame = performance.now()
let lastClaimAt = 0
let claiming = false
let canvasWidth = 1
let canvasHeight = 1

interface Packet {
  x: number
  y: number
  vy: number
  size: number
  rotation: number
  spin: number
  phase: number
  caught: boolean
}

interface TrailPoint {
  x: number
  y: number
  at: number
}

watch(
  () => props.summary.redpacket,
  (value) => {
    claims.value = value.claimedCount
    totalFen.value = value.totalFen
  },
  { deep: true }
)

watch(
  () => props.snapshot.redpacket.startsAt,
  () => {
    claims.value = props.summary.redpacket.claimedCount
    totalFen.value = props.summary.redpacket.totalFen
    message.value = ''
    if (phase.value === 'running') start()
    else stop()
  }
)

watch(
  () => phase.value,
  (value) => {
    if (value === 'running') start()
    else stop()
  }
)

onMounted(() => {
  window.addEventListener('resize', resize)
  resize()
  if (phase.value === 'running') start()
})

onBeforeUnmount(() => {
  stop()
  window.removeEventListener('resize', resize)
})

function resize() {
  const canvas = canvasRef.value
  const wrapper = wrapperRef.value
  if (!canvas || !wrapper) return
  const rect = wrapper.getBoundingClientRect()
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvasWidth = Math.max(1, Math.floor(rect.width))
  canvasHeight = Math.max(1, Math.floor(rect.height))
  canvas.width = Math.floor(canvasWidth * dpr)
  canvas.height = Math.floor(canvasHeight * dpr)
  canvas.style.width = `${canvasWidth}px`
  canvas.style.height = `${canvasHeight}px`
  const context = canvas.getContext('2d')
  context?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function start() {
  if (!spawnTimer) {
    spawnTimer = window.setInterval(spawn, 260)
  }
  if (!raf) {
    lastFrame = performance.now()
    raf = requestAnimationFrame(loop)
  }
}

function stop() {
  if (spawnTimer) {
    window.clearInterval(spawnTimer)
    spawnTimer = undefined
  }
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  if (phase.value !== 'running') {
    packets = []
    trail = []
  }
}

function spawn() {
  if (phase.value !== 'running' || packets.length > 28) return
  const size = 46 + Math.random() * 18
  packets.push({
    x: 24 + Math.random() * Math.max(1, canvasWidth - 48),
    y: -size,
    vy: 42 + Math.random() * 46,
    size,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 1.4,
    phase: Math.random() * Math.PI * 2,
    caught: false
  })
}

function loop(now: number) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000)
  lastFrame = now
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  if (!canvas || !context) {
    raf = requestAnimationFrame(loop)
    return
  }
  context.clearRect(0, 0, canvasWidth, canvasHeight)
  drawBackdrop(context, now)
  packets.forEach((packet) => {
    packet.y += packet.vy * dt
    packet.rotation += packet.spin * dt
    packet.phase += dt * 2
    if (!packet.caught) drawPacket(context, packet, now)
  })
  packets = packets.filter((packet) => !packet.caught && packet.y < canvasHeight + packet.size * 2)
  trail = trail.filter((point) => now - point.at < 420)
  drawTrail(context, now)
  raf = requestAnimationFrame(loop)
}

function drawBackdrop(context: CanvasRenderingContext2D, now: number) {
  const gradient = context.createRadialGradient(
    canvasWidth * 0.5,
    canvasHeight * 0.4,
    20,
    canvasWidth * 0.5,
    canvasHeight * 0.5,
    canvasHeight * 0.8
  )
  gradient.addColorStop(0, 'rgba(86, 22, 31, 0.55)')
  gradient.addColorStop(1, 'rgba(4, 17, 29, 0.05)')
  context.fillStyle = gradient
  context.fillRect(0, 0, canvasWidth, canvasHeight)
  context.fillStyle = 'rgba(255,255,255,.12)'
  for (let index = 0; index < 28; index += 1) {
    const x = ((index * 73 + now * 0.01) % (canvasWidth + 40)) - 20
    const y = (index * 47) % (canvasHeight + 40)
    context.beginPath()
    context.arc(x, y, 1.1, 0, Math.PI * 2)
    context.fill()
  }
}

function drawPacket(context: CanvasRenderingContext2D, packet: Packet, now: number) {
  const sway = Math.sin(packet.phase + now * 0.001) * 12
  context.save()
  context.translate(packet.x + sway, packet.y)
  context.rotate(packet.rotation)
  context.shadowColor = 'rgba(255, 66, 88, .65)'
  context.shadowBlur = 18
  const gradient = context.createLinearGradient(-packet.size / 2, -packet.size / 2, packet.size / 2, packet.size / 2)
  gradient.addColorStop(0, '#ff6b72')
  gradient.addColorStop(0.55, '#d51f3b')
  gradient.addColorStop(1, '#8f1028')
  context.fillStyle = gradient
  roundRect(context, -packet.size / 2, -packet.size / 2, packet.size, packet.size * 1.14, 10)
  context.fill()
  context.strokeStyle = 'rgba(255, 224, 138, .65)'
  context.lineWidth = 1.2
  context.stroke()
  context.shadowBlur = 0
  context.fillStyle = '#ffe08a'
  context.font = `800 ${packet.size * 0.34}px "Microsoft YaHei", sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText('福', 0, 2)
  context.fillStyle = 'rgba(255,224,138,.55)'
  context.beginPath()
  context.arc(0, -packet.size * 0.47, packet.size * 0.15, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function drawTrail(context: CanvasRenderingContext2D, now: number) {
  if (trail.length < 2) return
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (let index = 1; index < trail.length; index += 1) {
    const previous = trail[index - 1]
    const current = trail[index]
    const alpha = Math.max(0, 1 - (now - current.at) / 420)
    context.strokeStyle = `rgba(247, 201, 72, ${alpha * 0.8})`
    context.lineWidth = 3 + alpha * 7
    context.beginPath()
    context.moveTo(previous.x, previous.y)
    context.lineTo(current.x, current.y)
    context.stroke()
  }
  context.restore()
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function localPoint(event: PointerEvent): { x: number; y: number } {
  const rect = canvasRef.value?.getBoundingClientRect()
  return {
    x: event.clientX - (rect?.left || 0),
    y: event.clientY - (rect?.top || 0)
  }
}

function pointer(event: PointerEvent) {
  if (phase.value !== 'running') return
  const point = localPoint(event)
  trail.push({ ...point, at: performance.now() })
  if (trail.length > 32) trail.shift()
  const hit = packets.find((packet) => {
    if (packet.caught) return false
    const dx = packet.x - point.x
    const dy = packet.y + packet.size * 0.15 - point.y
    return Math.hypot(dx, dy) < packet.size * 0.7
  })
  if (hit) {
    hit.caught = true
    void claim(hit)
  }
}

async function claim(packet: Packet) {
  if (claiming || isFull.value) return
  const now = performance.now()
  if (now - lastClaimAt < 280) return
  lastClaimAt = now
  claiming = true
  try {
    const result = await emitAck<ClaimResponse>('packet:claim', { requestId: randomId() })
    if (result.ok && result.amountFen) {
      claims.value = result.claimedCount || claims.value + 1
      totalFen.value += result.amountFen
      const rect = wrapperRef.value?.getBoundingClientRect()
      const id = randomId()
      floats.value.push({
        id,
        text: `+¥${fen(result.amountFen)}`,
        left: Math.max(30, Math.min((rect?.width || 300) - 30, packet.x)),
        top: Math.max(40, packet.y)
      })
      window.setTimeout(() => {
        floats.value = floats.value.filter((item) => item.id !== id)
      }, 1000)
    } else if (result.reason === 'limit') {
      message.value = '本轮领取次数已用完'
    } else if (result.reason === 'empty') {
      message.value = '红包已被抢完'
    } else if (result.reason === 'closed') {
      message.value = '本轮红包雨已结束'
    } else if (result.reason === 'rate') {
      message.value = '慢一点，红包正在飞来'
    }
  } catch {
    message.value = '网络波动，请继续滑动'
  } finally {
    window.setTimeout(() => (claiming = false), 220)
  }
}
</script>

<template>
  <section class="game-stage fade-in">
    <div ref="wrapperRef" style="position: relative">
      <canvas
        ref="canvasRef"
        class="redpacket-canvas"
        @pointerdown.prevent="pointer"
        @pointermove.prevent="pointer"
      ></canvas>
      <div class="row between" style="position: absolute; inset: 16px 18px auto; pointer-events: none">
        <span class="tag red">红包雨</span>
        <span class="tag gold">{{ remaining }} 秒</span>
      </div>
      <div style="position: absolute; inset: auto 18px 16px; pointer-events: none">
        <div class="row between">
          <span class="tag">已领 {{ claims }} / {{ maxClaims }}</span>
          <span class="tag gold">¥{{ fen(totalFen) }}</span>
        </div>
        <p v-if="message" class="small" style="color: #ffe5a1; margin: 8px 0 0">{{ message }}</p>
        <p v-else-if="phase === 'running'" class="small muted" style="margin: 8px 0 0">
          手指在屏幕上滑动，碰到的红包都能接
        </p>
      </div>
      <div
        v-for="item in floats"
        :key="item.id"
        class="floating-amount"
        :style="{ left: `${item.left}px`, top: `${item.top}px` }"
      >
        {{ item.text }}
      </div>
    </div>
    <div v-if="phase !== 'running'" class="game-stage-inner" style="text-align: center">
      <div style="font-size: 54px; margin: 6px 0 14px">🧧</div>
      <h2 class="page-title" style="font-size: 25px">
        {{ phase === 'finished' ? '红包雨已结束' : '等待主持台开始红包雨' }}
      </h2>
      <p v-if="phase === 'finished'" class="muted small">
        本轮共领取 {{ claims }} 个，合计 ¥{{ fen(totalFen) }}
      </p>
      <p v-else class="muted small">开始后，屏幕上会落下大量红包。</p>
    </div>
  </section>
</template>
