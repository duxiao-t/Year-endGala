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
const requesting = ref(false)
const sensorHasData = ref(false)
const sensorSource = ref<'gravity' | 'linear' | ''>('')
const sensorEventCount = ref(0)
const localCount = ref(0)
const permissionError = ref('')
const score = ref(props.summary.shake.score)
const rank = ref<number | null>(props.summary.shake.rank)
const lastBatch = ref(0)
const pulse = ref(false)
const SENSOR_TIMEOUT_MS = 2500
let lastTime = 0
let lastX = 0
let lastY = 0
let lastZ = 0
let sendTimer: number | undefined
let sensorWatchdog: number | undefined
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
    localCount.value = 0
    sensorHasData.value = false
    sensorSource.value = ''
    sensorEventCount.value = 0
    permissionError.value = ''
    tapMode.value = false
    stop()
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
  if (phase.value !== 'running' || requesting.value) return
  requesting.value = true
  try {
    if (!window.isSecureContext) {
      useTapMode('运动传感器需要 HTTPS，已切换为点击模式')
      return
    }
    if (!('DeviceMotionEvent' in window)) {
      useTapMode('当前设备未提供运动传感器，已切换为点击模式')
      return
    }
    const DeviceMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }
    if (typeof DeviceMotion?.requestPermission === 'function') {
      const result = await DeviceMotion.requestPermission()
      if (result !== 'granted') {
        useTapMode('运动权限未开启，已切换为点击模式')
        return
      }
    }
    if (!window.isSecureContext) {
      useTapMode('运动传感器需要 HTTPS，已切换为点击模式')
      return
    }
    motionHandler = (event: DeviceMotionEvent) => {
      sensorEventCount.value += 1
      const linear = event.acceleration
      const gravity = event.accelerationIncludingGravity
      const gravityValues = [gravity?.x, gravity?.y, gravity?.z]
      const linearValues = [linear?.x, linear?.y, linear?.z]
      const hasGravity = gravityValues.some((value) => value !== null && value !== undefined)
      const hasLinear = linearValues.some((value) => value !== null && value !== undefined)
      const acceleration = hasGravity ? gravity : hasLinear ? linear : null
      if (!acceleration) return
      sensorSource.value = hasGravity ? 'gravity' : 'linear'
      const now = performance.now()
      if (!sensorHasData.value) {
        sensorHasData.value = true
        clearSensorWatchdog()
        lastX = acceleration.x || 0
        lastY = acceleration.y || 0
        lastZ = acceleration.z || 0
        lastTime = now
        return
      }
      const delta =
        Math.abs((acceleration.x || 0) - lastX) +
        Math.abs((acceleration.y || 0) - lastY) +
        Math.abs((acceleration.z || 0) - lastZ)
      const elapsed = now - lastTime
      lastX = acceleration.x || 0
      lastY = acceleration.y || 0
      lastZ = acceleration.z || 0
      lastTime = now
      if (elapsed > 30 && delta > (hasGravity ? 7 : 3.5)) {
        lastBatch.value = Math.min(8, lastBatch.value + 1)
        localCount.value += 1
        pulse.value = true
        window.setTimeout(() => (pulse.value = false), 120)
      }
    }
    window.addEventListener('devicemotion', motionHandler, { passive: true })
    enabled.value = true
    requesting.value = false
    startSender()
    armSensorWatchdog()
  } catch {
    useTapMode('无法读取运动传感器，已切换为点击模式')
  }
}

function armSensorWatchdog() {
  clearSensorWatchdog()
  sensorWatchdog = window.setTimeout(() => {
    if (phase.value === 'running' && !tapMode.value && !sensorHasData.value) {
      const hint = /Android/i.test(navigator.userAgent)
        ? '请确认使用 Chrome 并允许运动传感器；'
        : ''
      useTapMode(`${hint}未收到传感器数据，已切换为点击模式`)
    }
  }, SENSOR_TIMEOUT_MS)
}

function clearSensorWatchdog() {
  if (sensorWatchdog) {
    window.clearTimeout(sensorWatchdog)
    sensorWatchdog = undefined
  }
}

function removeMotionHandler() {
  if (motionHandler) {
    window.removeEventListener('devicemotion', motionHandler)
    motionHandler = undefined
  }
}

function useTapMode(reason: string) {
  clearSensorWatchdog()
  removeMotionHandler()
  enabled.value = false
  requesting.value = false
  tapMode.value = true
  permissionError.value = reason
  startSender()
}

function retrySensor() {
  stop()
  tapMode.value = false
  permissionError.value = ''
  sensorHasData.value = false
  sensorSource.value = ''
  sensorEventCount.value = 0
  void enableSensor()
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
  localCount.value += 1
  pulse.value = true
  window.setTimeout(() => (pulse.value = false), 120)
  startSender()
}

function stop() {
  clearSensorWatchdog()
  if (sendTimer) {
    window.clearInterval(sendTimer)
    sendTimer = undefined
  }
  removeMotionHandler()
  enabled.value = false
  requesting.value = false
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
          <button class="btn btn-primary" :disabled="requesting" @click="enableSensor">
            {{ requesting ? '正在请求运动权限…' : '开启运动权限' }}
          </button>
        </div>
        <div v-else-if="tapMode" class="grid" style="margin-top: 18px">
          <button
            class="btn btn-gold"
            data-testid="tap-button"
            style="min-height: 88px; font-size: 22px"
            @mousedown="tap"
            @touchstart.prevent="tap"
          >
            快速点击参与
          </button>
          <button class="btn btn-sm btn-ghost" @click="retrySensor">重新检测摇动</button>
          <p class="small muted" data-testid="tap-count">点击已捕获 {{ localCount }} 次</p>
        </div>
        <div v-if="enabled" class="grid" style="margin-top: 18px">
          <p class="small" data-testid="sensor-status" style="color: var(--teal); margin: 0">
            {{ sensorHasData ? '传感器已连接，摇动手机' : '正在等待传感器数据…' }} ·
            {{ sensorSource === 'gravity' ? '重力向量' : sensorSource === 'linear' ? '线性加速度' : '尚无数据' }}
            · 已捕获 {{ localCount }} 次 · 事件 {{ sensorEventCount }}
          </p>
          <button class="btn btn-sm btn-ghost" @click="useTapMode('已切换到点击模式')">
            摇动没反应？改用点击
          </button>
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
