<script setup lang="ts">
import * as THREE from 'three'
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LiveSnapshot, Winner } from '@shared/types'

const props = defineProps<{ snapshot: LiveSnapshot }>()
const containerRef = ref<HTMLDivElement | null>(null)
const spinning = ref(false)
const visibleDraw = ref(props.snapshot.lottery.lastDraw)
const showResult = ref(Boolean(props.snapshot.lottery.lastDraw))
const confetti = Array.from({ length: 72 }, (_, index) => ({
  id: index,
  left: Math.random() * 100,
  delay: Math.random() * 0.6,
  duration: 1.8 + Math.random() * 1.8,
  rotate: Math.random() * 360,
  color: ['#f7c948', '#2dd4bf', '#ff6b72', '#ffffff', '#a78bfa'][index % 5]
}))
let scene: THREE.Scene | undefined
let camera: THREE.PerspectiveCamera | undefined
let renderer: CSS3DRenderer | undefined
let group: THREE.Group | undefined
let raf = 0
let resizeObserver: ResizeObserver | undefined
let resultTimer: number | undefined
let spinEnd = 0
let baseSpeed = 0.035
let disposed = false

const prizes = computed(() =>
  props.snapshot.lottery.prizes.map((prize, index) => ({
    ...prize,
    remaining: props.snapshot.lottery.remaining[index] || 0
  }))
)

onMounted(() => {
  setupScene()
  if (props.snapshot.lottery.lastDraw) {
    window.setTimeout(() => {
      showResult.value = true
    }, 900)
  }
})

onBeforeUnmount(() => {
  disposed = true
  if (raf) cancelAnimationFrame(raf)
  if (resultTimer) window.clearTimeout(resultTimer)
  resizeObserver?.disconnect()
  if (containerRef.value && renderer) containerRef.value.innerHTML = ''
})

watch(
  () => props.snapshot.lottery.lastDraw?.drawId,
  (drawId) => {
    if (!drawId) {
      visibleDraw.value = undefined
      showResult.value = false
      return
    }
    if (drawId === visibleDraw.value?.drawId) return
    spinning.value = true
    showResult.value = false
    spinEnd = performance.now() + 2800
    if (resultTimer) window.clearTimeout(resultTimer)
    resultTimer = window.setTimeout(() => {
      visibleDraw.value = props.snapshot.lottery.lastDraw
      spinning.value = false
      showResult.value = true
    }, 2600)
  }
)

function setupScene() {
  const container = containerRef.value
  if (!container) return
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(46, 1, 1, 10000)
  camera.position.set(0, 0, 1750)
  renderer = new CSS3DRenderer()
  container.appendChild(renderer.domElement)
  group = new THREE.Group()
  scene.add(group)

  const names = props.snapshot.lottery.visualNames.length
    ? props.snapshot.lottery.visualNames
    : Array.from({ length: 120 }, (_, index) => `参与者 ${index + 1}`)
  const count = Math.max(80, Math.min(200, names.length))
  for (let index = 0; index < count; index += 1) {
    const element = document.createElement('div')
    element.className = 'lottery-3d-card'
    element.innerHTML = `<small>${escapeHtml(props.snapshot.company)}</small><strong>${escapeHtml(
      names[index % names.length]
    )}</strong>`
    const object = new CSS3DObject(element)
    object.position.set(
      Math.random() * 2600 - 1300,
      Math.random() * 1600 - 800,
      Math.random() * 1600 - 800
    )
    group.add(object)
    const phi = Math.acos(-1 + (2 * index + 1) / count)
    const theta = Math.sqrt(count * Math.PI) * phi
    const radius = 660
    const target = new THREE.Object3D()
    target.position.setFromSphericalCoords(radius, phi, theta)
    const vector = new THREE.Vector3().copy(target.position).multiplyScalar(2)
    target.lookAt(vector)
    object.userData.targetPosition = target.position.clone()
    object.userData.targetQuaternion = target.quaternion.clone()
  }

  resize()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  animate()
}

function resize() {
  const container = containerRef.value
  if (!container || !camera || !renderer) return
  const width = Math.max(1, container.clientWidth)
  const height = Math.max(1, container.clientHeight)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height)
}

function animate() {
  if (disposed || !renderer || !scene || !camera || !group) return
  const now = performance.now()
  let speed = baseSpeed
  if (now < spinEnd) {
    const remaining = (spinEnd - now) / 2800
    speed = 0.035 + 0.22 * Math.max(0.15, remaining)
  } else if (spinning.value) {
    spinning.value = false
  }
  group.rotation.y += speed
  group.rotation.x = Math.sin(now * 0.00015) * 0.08
  group.children.forEach((child) => {
    const target = child.userData.targetPosition as THREE.Vector3 | undefined
    const targetQuaternion = child.userData.targetQuaternion as THREE.Quaternion | undefined
    if (target && child.position.distanceTo(target) > 0.2) {
      child.position.lerp(target, 0.055)
    }
    if (targetQuaternion && !child.quaternion.equals(targetQuaternion)) {
      child.quaternion.slerp(targetQuaternion, 0.055)
    }
  })
  renderer.render(scene, camera)
  raf = requestAnimationFrame(animate)
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char
  })
}

function winnerLabel(winner: Winner) {
  return winner.name
}
</script>

<template>
  <div class="lottery-stage">
    <aside class="lottery-prizes">
      <div>
        <p class="eyebrow">PRIZE POOL</p>
        <h1 class="screen-display" style="font-size: clamp(38px, 4vw, 62px)">
          LUCKY<em>DRAW</em>
        </h1>
        <p class="screen-lead">从 {{ snapshot.lottery.eligibleCount }} 位有效参与者中抽取</p>
      </div>
      <div class="prize-stack">
        <div v-for="(prize, index) in prizes" :key="index" class="prize-row">
          <span class="prize-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <div>
            <strong>{{ prize.name }}</strong>
            <small>每轮 {{ prize.each }} 人</small>
          </div>
          <span class="prize-remain">{{ prize.remaining }}</span>
        </div>
      </div>
      <div class="row">
        <span class="tag gold">{{ spinning ? 'DRAWING' : visibleDraw ? 'RESULT' : 'READY' }}</span>
        <span class="tag">{{ snapshot.join.activeCount }} 人现场参与</span>
      </div>
    </aside>

    <div class="lottery-ball-wrap">
      <div ref="containerRef" class="lottery-ball"></div>
      <div class="ball-halo" aria-hidden="true"></div>
      <div v-if="!showResult" class="ball-caption">
        <p class="eyebrow">3D LUCKY SPHERE</p>
        <h2>{{ spinning ? '正在抽取…' : '等待主持台启动' }}</h2>
      </div>
      <div v-if="showResult && visibleDraw" class="draw-result">
        <div class="draw-result-head">
          <p class="eyebrow">CONGRATULATIONS</p>
          <h2>{{ visibleDraw.prizeName }}</h2>
          <p>恭喜以下同事</p>
        </div>
        <div class="winner-grid">
          <div
            v-for="(winner, index) in visibleDraw.winners"
            :key="`${winner.name}-${index}`"
            class="winner-card"
            :style="{ animationDelay: `${index * 0.08}s` }"
          >
            <span class="winner-rank">{{ String(winner.rank).padStart(2, '0') }}</span>
            <strong>{{ winnerLabel(winner) }}</strong>
            <small>{{ winner.department }}</small>
          </div>
        </div>
      </div>
      <div v-if="showResult" class="confetti-layer" aria-hidden="true">
        <span
          v-for="piece in confetti"
          :key="piece.id"
          :style="{
            left: `${piece.left}%`,
            animationDelay: `${piece.delay}s`,
            animationDuration: `${piece.duration}s`,
            background: piece.color,
            transform: `rotate(${piece.rotate}deg)`
          }"
        ></span>
      </div>
    </div>
  </div>
</template>

<style>
.lottery-stage {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  grid-template-columns: minmax(260px, 24%) minmax(0, 1fr);
  overflow: hidden;
}

.lottery-prizes {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 24px;
  padding: 42px 34px;
  border-right: 1px solid rgba(148, 211, 219, 0.1);
  background: linear-gradient(90deg, rgba(5, 17, 29, 0.9), rgba(5, 17, 29, 0.2));
}

.lottery-prizes .screen-display em {
  display: block;
  color: var(--gold);
}

.prize-stack {
  display: grid;
  gap: 8px;
}

.prize-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 12px;
  border: 1px solid rgba(148, 211, 219, 0.12);
  border-radius: 12px;
  background: rgba(5, 18, 30, 0.4);
}

.prize-index {
  color: var(--muted);
  font-size: 11px;
  font-weight: 800;
}

.prize-row strong,
.prize-row small {
  display: block;
}

.prize-row strong {
  font-size: 14px;
}

.prize-row small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 10px;
}

.prize-remain {
  color: var(--gold);
  font-size: 22px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

.lottery-ball-wrap {
  position: relative;
  min-width: 0;
  overflow: hidden;
}

.lottery-ball {
  position: absolute;
  inset: 0;
}

.lottery-ball > div {
  width: 100% !important;
  height: 100% !important;
}

.lottery-ball canvas {
  display: none;
}

.ball-halo {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 54%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(45, 212, 191, 0.15);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(45, 212, 191, 0.1), transparent 58%);
  box-shadow: 0 0 140px rgba(45, 212, 191, 0.12);
  pointer-events: none;
}

.ball-caption {
  position: absolute;
  left: 50%;
  bottom: 7%;
  z-index: 4;
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
}

.ball-caption h2 {
  margin: 6px 0 0;
  font-size: clamp(22px, 2.1vw, 34px);
  letter-spacing: -0.04em;
}

.lottery-3d-card {
  display: flex;
  width: 128px;
  height: 66px;
  flex-direction: column;
  justify-content: center;
  padding: 8px 12px;
  border: 1px solid rgba(94, 234, 212, 0.38);
  border-radius: 10px;
  color: #eafffa;
  background: linear-gradient(135deg, rgba(13, 148, 136, 0.55), rgba(3, 32, 38, 0.72));
  box-shadow: 0 0 24px rgba(45, 212, 191, 0.12);
  text-align: center;
  white-space: nowrap;
}

.lottery-3d-card small {
  color: rgba(247, 201, 72, 0.8);
  font-size: 7px;
  letter-spacing: 0.12em;
}

.lottery-3d-card strong {
  overflow: hidden;
  margin-top: 3px;
  font-size: 12px;
  text-overflow: ellipsis;
}

.draw-result {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: grid;
  place-content: center;
  padding: 6%;
  background: radial-gradient(circle, rgba(4, 20, 29, 0.88), rgba(4, 14, 24, 0.94));
  text-align: center;
  animation: fadeIn 0.5s ease both;
}

.draw-result-head h2 {
  margin: 8px 0 4px;
  color: var(--gold);
  font-size: clamp(42px, 5vw, 78px);
  letter-spacing: -0.06em;
}

.draw-result-head p {
  margin: 0 0 24px;
  color: var(--muted);
}

.winner-grid {
  display: flex;
  max-width: 980px;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

.winner-card {
  display: grid;
  min-width: 154px;
  min-height: 88px;
  place-content: center;
  padding: 14px 20px;
  border: 1px solid rgba(247, 201, 72, 0.36);
  border-radius: 14px;
  background: linear-gradient(145deg, rgba(86, 64, 16, 0.56), rgba(7, 26, 38, 0.75));
  box-shadow: 0 0 40px rgba(247, 201, 72, 0.08);
  animation: winnerIn 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.winner-rank {
  color: var(--teal);
  font-size: 10px;
  font-weight: 800;
}

.winner-card strong {
  margin: 4px 0;
  font-size: clamp(18px, 1.7vw, 25px);
}

.winner-card small {
  color: var(--muted);
  font-size: 10px;
}

.confetti-layer {
  position: absolute;
  inset: 0;
  z-index: 9;
  overflow: hidden;
  pointer-events: none;
}

.confetti-layer span {
  position: absolute;
  top: -12px;
  width: 8px;
  height: 14px;
  animation: confettiFall 2.2s linear both;
}

@keyframes winnerIn {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.94);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes confettiFall {
  to {
    transform: translateY(105vh) rotate(720deg);
  }
}

@media (max-width: 900px) {
  .lottery-stage {
    grid-template-columns: 1fr;
  }
  .lottery-prizes {
    display: none;
  }
}
</style>
