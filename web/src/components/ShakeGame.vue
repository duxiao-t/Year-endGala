<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { LiveSnapshot, PlayerSummary, ShakeAck } from '@shared/types'
import { emitAck } from '../live'
import { useCountdown } from '../utils'

const props = defineProps<{
  snapshot: LiveSnapshot
  summary: PlayerSummary
}>()

const phase = computed(() => props.snapshot.shake.phase)
const remaining = useCountdown(() => props.snapshot.shake.endsAt)
const enabled = ref(false)
const tapMode = ref(false)
const permissionError = ref('')
const score = ref(props.summary.shake.score)
const rank = ref<number | null>(props.summary.shake.rank)
const lastBatch = ref(0)
const pulse = ref(false)
let lastTime = 0
let lastX = 0
let lastY = 0
let lastZ = 0
let sendTimer: number | undefined
let motionHandler: ((event: DeviceMotionEvent) => void) | undefined
let tapCooldown = 0

watch(
  () => props.summary.shake.score,
  (value) => {
    score.value = value
    rank.value = props.summary.shake.rank
  }
)

watch(
  () => props.summary.shake.rank,
  (value) => {
    rank.value = value
  }
)

watch(
  () => props.snapshot.shake.startsAt,
  () => {
    score.value = props.summary.shake.score
    rank.value = props.summary.shake.rank
    if (phase.value !== 'running') stop()
  }
)

watch(
  () => phase.value,
  (value) => {
    if (value !== 'running') stop()
  }
)

async function enableSensor() {
  permissionError.value = ''
  if (phase.value !== 'running') return
  try {
    const DeviceMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }
    if (typeof DeviceMotion?.requestPermission === 'function') {
      const result = await DeviceMotion.requestPermission()
      if (result !== 'granted') {
        permissionError.value = '运动权限未开启，请允许后重试'
        tapMode.value = true
        return
      }
    }
    if (!('DeviceMotionEvent' in window)) {
      tapMode.value = true
      permissionError.value = '当前设备未提供运动传感器，已切换为点击模式'
      return
    }
    motionHandler = (event: DeviceMotionEvent) => {
      const acceleration = event.accelerationIncludingGravity
      if (!acceleration || acceleration.x === null) return
      const now = performance.now()
      const delta =
        Math.abs((acceleration.x || 0) - lastX) +
        Math.abs((acceleration.y || 0) - lastY) +
        Math.abs((acceleration.z || 0) - lastZ)
      const elapsed = now - lastTime
      lastX = acceleration.x || 0
      lastY = acceleration.y || 0
      lastZ = acceleration.z || 0
      lastTime = now
      if (elapsed > 30 && delta > 14) {
        lastBatch.value = Math.min(8, lastBatch.value + 1)
        pulse.value = true
        window.setTimeout(() => (pulse.value = false), 80)
      }
    }
    window.addEventListener('devicemotion', motionHandler, { passive: true })
    enabled.value = true
    startSender()
  } catch {
    permissionError.value = '无法读取运动传感器，可使用点击模式参与'
    tapMode.value = true
  }
}

function startSender() {
  if (sendTimer) return
  sendTimer = window.setInterval(async () => {
    if (phase.value !== 'running' || lastBatch.value <= 0) return
    const delta = lastBatch.value
    lastBatch.value = 0
    try {
      const result = await emitAck<ShakeAck>('shake:batch', { delta })
      if (result.ok) {
        score.value = result.score || score.value
        rank.value = result.rank ?? rank.value
      }
    } catch {
      // Connection errors are retried by the next batch.
    }
  }, 1000)
}

function tap() {
  if (phase.value !== 'running') return
  const now = performance.now()
  if (now - tapCooldown < 90) return
  tapCooldown = now
  lastBatch.value = Math.min(6, lastBatch.value + 1)
  pulse.value = true
  window.setTimeout(() => (pulse.value = false), 80)
  startSender()
}

function stop() {
  if (sendTimer) {
    window.clearInterval(sendTimer)
    sendTimer = undefined
  }
  if (motionHandler) {
    window.removeEventListener('devicemotion', motionHandler)
    motionHandler = undefined
  }
  enabled.value = false
}

onBeforeUnmount(stop)
</script>

<template>
  <section class="game-stage fade-in">
    <div class="game-stage-inner" style="text-align: center">
      <div class="row between">
        <span class="tag teal">SHAKE IT</span>
        <span class="countdown">
          剩余 <strong>{{ remaining }}</strong> 秒
        </span>
      </div>

      <div v-if="phase === 'running'" class="score-orbit" :class="{ spinning: enabled }">
        <div>
          <div class="score-number">{{ score }}</div>
          <div class="small muted">当前积分</div>
        </div>
      </div>

      <template v-if="phase === 'running'">
        <h2 class="page-title" style="font-size: 28px">摇动手机，冲上榜单</h2>
        <p class="muted small" style="line-height: 1.7">
          摇得越起劲，分数涨得越快。请握稳手机，注意周围同事。
        </p>
        <div v-if="!enabled && !tapMode" class="row" style="justify-content: center; margin-top: 18px">
          <button class="btn btn-primary" @click="enableSensor">开启运动权限</button>
        </div>
        <div v-else-if="tapMode" class="grid" style="margin-top: 18px">
          <button class="btn btn-gold" style="min-height: 88px; font-size: 22px" @mousedown="tap" @touchstart.prevent="tap">
            快速点击参与
          </button>
          <p class="muted small">传感器不可用时的同分参与模式</p>
        </div>
        <p v-if="permissionError" class="tag gold" style="margin-top: 12px">{{ permissionError }}</p>
        <div class="row" style="justify-content: center; margin-top: 16px">
          <span class="tag teal">当前排名 {{ rank ? `#${rank}` : '--' }}</span>
        </div>
      </template>

      <template v-else-if="phase === 'finished'">
        <div class="score-orbit">
          <div>
            <div class="score-number">{{ score }}</div>
            <div class="small muted">最终积分</div>
          </div>
        </div>
        <h2 class="page-title" style="font-size: 28px">
          {{ summary.shake.rank ? `最终排名 #${summary.shake.rank}` : '本轮已结束' }}
        </h2>
        <div v-if="snapshot.shake.winners.length" class="grid" style="margin-top: 16px; text-align: left">
          <div v-for="winner in snapshot.shake.winners" :key="winner.resultId" class="rank-row">
            <span class="rank-index">#{{ winner.rank }}</span>
            <span>{{ winner.name }}</span>
            <span class="rank-points">{{ winner.prizeName }}</span>
          </div>
        </div>
        <p v-else class="muted small" style="margin-top: 14px">本轮没有产生获奖者</p>
      </template>

      <template v-else>
        <div style="font-size: 60px; margin: 26px 0">📳</div>
        <h2 class="page-title" style="font-size: 26px">等待主持台开始</h2>
        <p class="muted small">大屏出现倒数后，回到这里开启摇动。</p>
      </template>
    </div>
  </section>
</template>
