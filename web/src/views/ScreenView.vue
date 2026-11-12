<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LiveSnapshot } from '@shared/types'
import { api } from '../api'
import { useLive } from '../live'
import { fen, useCountdown } from '../utils'
import LotteryDisplay from '../components/LotteryDisplay.vue'

const { snapshot, connected, lastError, connectLive, disconnectLive } = useLive()
const token = ref(new URLSearchParams(window.location.search).get('token') || localStorage.getItem('gala_screen_token') || '')
const tokenInput = ref(token.value)
const authorized = ref(false)
const loading = ref(true)
const error = ref('')
const qrDataUrl = ref('')
const clock = ref(new Date())
let clockTimer: number | undefined
let snapshotTimer: number | undefined
let connectedOnce = false

const view = computed(() => snapshot.value?.view || 'lobby')
const joinUrl = computed(() => {
  if (!snapshot.value) return ''
  const base = snapshot.value.publicOrigin || window.location.origin
  const code = snapshot.value.join.joinCode
  return `${base.replace(/\/$/, '')}/join${code ? `?code=${encodeURIComponent(code)}` : ''}`
})
const quizRemaining = useCountdown(() => snapshot.value?.quiz.question?.endsAt)
const shakeRemaining = useCountdown(() => snapshot.value?.shake.endsAt)
const redpacketRemaining = useCountdown(() => snapshot.value?.redpacket.endsAt)

const games = [
  { key: 'shake', icon: '📳', name: '手机摇一摇', desc: '全场一起摇，冲上大屏榜首' },
  { key: 'redpacket', icon: '🧧', name: '红包雨', desc: '滑动接取，金额实时记账' },
  { key: 'quiz', icon: '🧠', name: '现场答题', desc: '手速与知识，谁是全场最强大脑' },
  { key: 'lottery', icon: '🎁', name: '幸运抽奖', desc: '3D 球体滚动，抽出年度锦鲤' }
]

const clockText = computed(() =>
  clock.value.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai'
  })
)

onMounted(async () => {
  clockTimer = window.setInterval(() => (clock.value = new Date()), 1000)
  await loadScreen()
})

onBeforeUnmount(() => {
  if (clockTimer) window.clearInterval(clockTimer)
  if (snapshotTimer) window.clearInterval(snapshotTimer)
  disconnectLive()
})

watch(
  joinUrl,
  async (value) => {
    if (!value) return
    qrDataUrl.value = await QRCode.toDataURL(value, {
      width: 520,
      margin: 1,
      color: { dark: '#07111f', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    })
  },
  { immediate: true }
)

async function loadScreen() {
  loading.value = true
  error.value = ''
  try {
    const value = await api.screenSnapshot(token.value)
    authorized.value = true
    if (!connectedOnce) {
      connectLive({ screenToken: token.value })
      connectedOnce = true
    }
    if (!snapshot.value) snapshot.value = value
    if (snapshotTimer) window.clearInterval(snapshotTimer)
    snapshotTimer = window.setInterval(async () => {
      try {
        const value = await api.screenSnapshot(token.value)
        if (!connected.value) snapshot.value = value
      } catch {
        // Socket is the primary channel; polling only fills gaps.
      }
    }, 10_000)
  } catch (err) {
    authorized.value = false
    error.value = err instanceof Error ? err.message : '无法连接大屏'
  } finally {
    loading.value = false
  }
}

async function useToken() {
  token.value = tokenInput.value.trim()
  localStorage.setItem('gala_screen_token', token.value)
  connectedOnce = false
  disconnectLive()
  await loadScreen()
}

function goFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()
  else document.exitFullscreen?.()
}

function phaseLabel(phase: string) {
  return {
    idle: '待开始',
    running: '进行中',
    finished: '已结束',
    question: '答题中',
    locked: '已锁题',
    revealed: '已揭晓'
  }[phase] || phase
}
</script>

<template>
  <main class="screen-shell">
    <div class="screen-grain" aria-hidden="true"></div>

    <header class="screen-header">
      <div class="brand">
        <div class="brand-mark">G</div>
        <div>
          {{ snapshot?.company || 'GALA LIVE' }}
          <small>ANNUAL GALA · LIVE STAGE</small>
        </div>
      </div>
      <div class="screen-header-center">
        <span class="eyebrow">{{ snapshot?.eventName || '年会互动现场' }}</span>
      </div>
      <div class="row">
        <span class="tag">
          <span class="live-dot" :class="{ offline: !connected }"></span>
          {{ connected ? 'LIVE' : 'SYNCING' }}
        </span>
        <span class="tag">{{ clockText }}</span>
        <button class="screen-icon-btn" title="全屏" @click="goFullscreen">⛶</button>
      </div>
    </header>

    <section v-if="loading && !snapshot" class="screen-loading">
      <div class="orb"></div>
      <p class="eyebrow">CONNECTING TO THE STAGE</p>
    </section>

    <section v-else-if="!authorized" class="screen-auth panel">
      <p class="eyebrow">SCREEN ACCESS</p>
      <h1 class="page-title">需要大屏凭证</h1>
      <p class="muted">{{ error || lastError || '请输入服务端 SCREEN_TOKEN。' }}</p>
      <form class="row" style="margin-top: 18px" @submit.prevent="useToken">
        <input v-model="tokenInput" class="input" placeholder="大屏 token" />
        <button class="btn btn-primary" type="submit">进入大屏</button>
      </form>
    </section>

    <template v-else-if="snapshot">
      <Transition name="screen-swap" mode="out-in">
        <section v-if="view === 'lobby'" key="lobby" class="screen-view lobby-view">
          <div class="lobby-copy">
            <p class="eyebrow">WELCOME TO THE NIGHT</p>
            <h1 class="screen-display">
              {{ snapshot.eventName.split(' ')[0] || '年会' }}
              <em>互动现场</em>
            </h1>
            <p class="screen-lead">
              手机扫码入场，和身边同事一起参与四场互动。<br />
              每一轮结果都会实时汇总到大屏。
            </p>
            <div class="screen-stats">
              <div>
                <strong>{{ snapshot.join.participantCount }}</strong>
                <span>已登记</span>
              </div>
              <div>
                <strong>{{ snapshot.join.activeCount }}</strong>
                <span>有效参与</span>
              </div>
              <div>
                <strong>{{ snapshot.join.pendingCount }}</strong>
                <span>待审核</span>
              </div>
            </div>
          </div>
          <div class="lobby-side">
            <div class="qr-card panel">
              <img v-if="qrDataUrl" :src="qrDataUrl" alt="扫码入场二维码" />
              <p class="eyebrow">SCAN TO JOIN</p>
              <h2 class="page-title" style="font-size: 25px">扫码进入互动</h2>
              <p class="muted small">请用手机相机扫描，使用工号与姓名登记</p>
              <span v-if="snapshot.join.joinCode" class="tag gold">入场码 {{ snapshot.join.joinCode }}</span>
            </div>
            <div class="game-mini-grid">
              <div v-for="game in games" :key="game.key" class="game-mini">
                <span>{{ game.icon }}</span>
                <div>
                  <strong>{{ game.name }}</strong>
                  <small>{{ game.desc }}</small>
                </div>
                <i :class="`dot-${game.key}`"></i>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="view === 'shake'" key="shake" class="screen-view shake-view">
          <div class="screen-main-title">
            <p class="eyebrow">SHAKE · LIVE LEADERBOARD</p>
            <h1 class="screen-display">
              摇动<em>全场</em>
            </h1>
            <p class="screen-lead">手机摇起来，实时积分冲上大屏。</p>
          </div>
          <div class="shake-stage panel">
            <div class="shake-topline">
              <span class="tag teal">{{ phaseLabel(snapshot.shake.phase) }}</span>
              <span class="screen-clock">{{ snapshot.shake.phase === 'running' ? `${shakeRemaining}s` : 'SHAKE IT' }}</span>
            </div>
            <div class="screen-rank-list">
              <div
                v-for="entry in snapshot.shake.top.slice(0, 12)"
                :key="entry.participantId"
                class="screen-rank-row"
                :class="{ first: entry.rank === 1 }"
              >
                <span class="screen-rank">{{ String(entry.rank).padStart(2, '0') }}</span>
                <span class="screen-rank-name">{{ entry.name }}</span>
                <span class="screen-rank-dept">{{ entry.department }}</span>
                <span class="screen-rank-score">{{ entry.score }}</span>
              </div>
              <div v-if="!snapshot.shake.top.length" class="screen-empty">
                {{ snapshot.shake.phase === 'running' ? '等待第一波摇动…' : '等待主持台开始' }}
              </div>
            </div>
            <div v-if="snapshot.shake.winners.length" class="screen-winners-strip">
              <span v-for="winner in snapshot.shake.winners.slice(0, 6)" :key="winner.resultId" class="tag gold">
                #{{ winner.rank }} {{ winner.name }}
              </span>
            </div>
          </div>
        </section>

        <section v-else-if="view === 'redpacket'" key="redpacket" class="screen-view redpacket-view">
          <div class="rain-layer" aria-hidden="true">
            <span v-for="index in 22" :key="index" :style="{ '--i': index }">福</span>
          </div>
          <div class="redpacket-head">
            <p class="eyebrow">RED PACKET RAIN</p>
            <h1 class="screen-display">
              红包<em>落雨</em>
            </h1>
            <p class="screen-lead">打开手机，滑动屏幕接住你的好运。</p>
          </div>
          <div class="redpacket-metrics">
            <div class="metric screen-metric">
              <span>已领取</span>
              <strong>{{ snapshot.redpacket.claimedCount }}</strong>
              <span>/ {{ snapshot.redpacket.packetCount }} 包</span>
            </div>
            <div class="metric screen-metric">
              <span>已发出</span>
              <strong>¥{{ fen(snapshot.redpacket.claimedAmountFen) }}</strong>
              <span>按服务端流水统计</span>
            </div>
            <div class="metric screen-metric">
              <span>倒计时</span>
              <strong>{{ snapshot.redpacket.phase === 'running' ? redpacketRemaining : 0 }}</strong>
              <span>秒</span>
            </div>
          </div>
          <div class="recent-claims panel">
            <div class="row between">
              <span class="eyebrow">RECENT LUCKY MOMENTS</span>
              <span class="tag red">{{ phaseLabel(snapshot.redpacket.phase) }}</span>
            </div>
            <div class="recent-grid">
              <div v-for="(claim, index) in snapshot.redpacket.recent" :key="index" class="recent-claim">
                <span>{{ claim.name }}</span>
                <strong>¥{{ fen(claim.amountFen) }}</strong>
              </div>
            </div>
            <div v-if="!snapshot.redpacket.recent.length" class="screen-empty">
              红包正在路上，准备好你的手指。
            </div>
          </div>
        </section>

        <section v-else-if="view === 'quiz'" key="quiz" class="screen-view quiz-screen">
          <div class="quiz-screen-head">
            <div>
              <p class="eyebrow">LIVE QUIZ · {{ snapshot.quiz.question ? `${snapshot.quiz.question.index} / ${snapshot.quiz.question.total}` : 'WAITING' }}</p>
              <h1 class="screen-display" style="font-size: clamp(40px, 5.2vw, 78px)">
                {{ snapshot.quiz.question ? '现场答题' : '等待出题' }}
              </h1>
            </div>
            <div class="quiz-timer">
              <span>{{ snapshot.quiz.phase === 'question' ? quizRemaining : '—' }}</span>
              <small>SECONDS</small>
            </div>
          </div>
          <div v-if="snapshot.quiz.question" class="quiz-screen-body">
            <div class="quiz-question-panel panel">
              <h2>{{ snapshot.quiz.question.text }}</h2>
              <div class="screen-option-grid">
                <div
                  v-for="(option, index) in snapshot.quiz.question.options"
                  :key="index"
                  class="screen-option"
                  :class="{
                    correct: (snapshot.quiz.phase === 'revealed' || snapshot.quiz.phase === 'finished') && snapshot.quiz.question.correctOption === index
                  }"
                >
                  <span>{{ ['A', 'B', 'C', 'D'][index] }}</span>
                  <strong>{{ option }}</strong>
                  <small
                    v-if="snapshot.quiz.distribution?.length"
                  >{{ snapshot.quiz.distribution[index] }} 票</small>
                </div>
              </div>
              <div class="quiz-answer-line">
                <span>{{ snapshot.quiz.answeredCount }} 人已作答</span>
                <span v-if="snapshot.quiz.phase === 'revealed'">
                  {{ snapshot.quiz.correctCount || 0 }} 人答对
                </span>
              </div>
            </div>
            <aside class="quiz-side panel">
              <p class="eyebrow">TOP PLAYERS</p>
              <div class="screen-rank-list compact">
                <div v-for="entry in snapshot.quiz.top.slice(0, 8)" :key="entry.participantId" class="screen-rank-row">
                  <span class="screen-rank">{{ String(entry.rank).padStart(2, '0') }}</span>
                  <span class="screen-rank-name">{{ entry.name }}</span>
                  <span class="screen-rank-score">{{ entry.score }}</span>
                </div>
                <div v-if="!snapshot.quiz.top.length" class="screen-empty">等待第一份答卷</div>
              </div>
            </aside>
          </div>
          <div v-else class="screen-empty large">
            主持台开始答题后，题目会自动出现在这里。
          </div>
        </section>

        <section v-else key="lottery" class="screen-view lottery-view">
          <LotteryDisplay :snapshot="snapshot" />
        </section>
      </Transition>
    </template>

    <footer class="screen-footer">
      <span><span class="live-dot" :class="{ offline: !connected }"></span> 实时数据由主持台统一控制</span>
      <span v-if="snapshot">有效参与 {{ snapshot.join.activeCount }} 人 · {{ snapshot.eventName }}</span>
      <span>GALA LIVE SYSTEM</span>
    </footer>
  </main>
</template>

<style>
.screen-shell {
  position: relative;
  display: flex;
  min-height: 100vh;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(circle at 12% 0%, rgba(45, 212, 191, 0.11), transparent 35%),
    radial-gradient(circle at 86% 8%, rgba(247, 201, 72, 0.1), transparent 28%),
    linear-gradient(145deg, #06101d, #081c2c 55%, #071421);
}

.screen-grain {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.3;
  background-image: radial-gradient(rgba(255, 255, 255, 0.5) 0.6px, transparent 0.7px);
  background-size: 46px 46px;
  mask-image: linear-gradient(to bottom, #000, transparent 90%);
}

.screen-header,
.screen-footer {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 34px;
}

.screen-header {
  border-bottom: 1px solid rgba(148, 211, 219, 0.1);
}

.screen-header-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.screen-header-center .eyebrow {
  color: var(--muted);
  font-size: 10px;
}

.screen-icon-btn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--muted);
  background: transparent;
  font-size: 17px;
}

.screen-view {
  position: relative;
  z-index: 2;
  display: flex;
  width: 100%;
  flex: 1;
  padding: 28px 34px;
  gap: 26px;
}

.screen-loading,
.screen-auth {
  position: relative;
  z-index: 2;
  display: grid;
  width: min(560px, calc(100% - 40px));
  min-height: 50vh;
  margin: 8vh auto 0;
  place-content: center;
  text-align: center;
}

.screen-auth {
  padding: 30px;
}

.screen-auth .input {
  min-width: 260px;
}

.orb {
  width: 74px;
  height: 74px;
  margin: 0 auto 22px;
  border: 1px solid rgba(45, 212, 191, 0.35);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(45, 212, 191, 0.4), transparent 66%);
  box-shadow: 0 0 70px rgba(45, 212, 191, 0.28);
  animation: pulse 1.8s infinite;
}

.screen-display {
  margin: 12px 0;
  font-size: clamp(52px, 6.4vw, 108px);
  line-height: 0.98;
  letter-spacing: -0.07em;
  font-weight: 900;
}

.screen-display em {
  display: block;
  color: var(--gold);
  font-style: normal;
}

.screen-lead {
  color: var(--muted);
  font-size: clamp(14px, 1.25vw, 19px);
  line-height: 1.8;
}

.lobby-view {
  align-items: center;
}

.lobby-copy {
  flex: 1;
  padding: 4vh 3vw;
}

.lobby-side {
  display: grid;
  width: min(410px, 34vw);
  gap: 14px;
}

.lobby-side .qr-card {
  padding: 18px;
}

.lobby-side .qr-card img {
  max-width: 210px;
}

.screen-stats {
  display: flex;
  gap: 44px;
  margin-top: 36px;
}

.screen-stats strong {
  display: block;
  font-size: clamp(28px, 3vw, 48px);
  letter-spacing: -0.06em;
  font-weight: 900;
}

.screen-stats span {
  color: var(--muted);
  font-size: 12px;
}

.game-mini-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.game-mini {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 82px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(5, 18, 30, 0.45);
}

.game-mini > span {
  font-size: 22px;
}

.game-mini strong,
.game-mini small {
  display: block;
}

.game-mini strong {
  font-size: 12px;
}

.game-mini small {
  margin-top: 4px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
}

.game-mini i {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--teal);
}

.dot-lottery {
  background: var(--gold) !important;
}

.dot-redpacket {
  background: var(--coral) !important;
}

.dot-quiz {
  background: #a78bfa !important;
}

.shake-view {
  flex-direction: column;
}

.screen-main-title {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.screen-main-title .screen-display {
  font-size: clamp(40px, 5vw, 78px);
}

.screen-main-title .screen-display em {
  display: inline;
  margin-left: 0.12em;
}

.shake-stage {
  flex: 1;
  min-height: 0;
  padding: 20px 24px;
}

.shake-topline {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.screen-clock {
  color: var(--gold);
  font-size: clamp(30px, 4vw, 60px);
  font-weight: 900;
  letter-spacing: -0.06em;
}

.screen-rank-list {
  display: grid;
  gap: 6px;
}

.screen-rank-list.compact {
  gap: 4px;
}

.screen-rank-row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  min-height: 45px;
  padding: 7px 14px;
  border: 1px solid rgba(148, 211, 219, 0.1);
  border-radius: 10px;
  background: rgba(5, 18, 30, 0.38);
}

.screen-rank-row.first {
  border-color: rgba(247, 201, 72, 0.35);
  background: linear-gradient(90deg, rgba(247, 201, 72, 0.09), rgba(5, 18, 30, 0.38));
}

.screen-rank {
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.screen-rank-row.first .screen-rank {
  color: var(--gold);
}

.screen-rank-name {
  overflow: hidden;
  font-size: clamp(13px, 1.2vw, 17px);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.screen-rank-dept {
  display: none;
  color: var(--muted);
  font-size: 11px;
}

.screen-rank-score {
  color: var(--teal);
  font-size: clamp(16px, 1.6vw, 23px);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

.screen-winners-strip {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.screen-empty {
  padding: 26px 14px;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
}

.screen-empty.large {
  display: grid;
  flex: 1;
  place-items: center;
  font-size: 18px;
}

.redpacket-view {
  flex-direction: column;
}

.rain-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: 0.38;
}

.rain-layer span {
  position: absolute;
  top: -10%;
  left: calc((var(--i) * 4.7%) - 4%);
  display: grid;
  width: 38px;
  height: 48px;
  place-items: center;
  border-radius: 7px;
  color: #ffe08a;
  background: linear-gradient(145deg, #ed4258, #97162e);
  font-size: 15px;
  font-weight: 800;
  animation: rainFall calc(5s + var(--i) * 0.18s) linear infinite;
  animation-delay: calc(var(--i) * -0.7s);
}

.redpacket-head {
  text-align: center;
}

.redpacket-head .screen-display em {
  display: inline;
  margin-left: 0.1em;
}

.redpacket-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  width: min(1000px, 100%);
  margin: 0 auto;
}

.screen-metric {
  padding: 18px;
  border-color: rgba(247, 201, 72, 0.18);
}

.recent-claims {
  width: min(1000px, 100%);
  margin: 0 auto;
  padding: 20px;
}

.recent-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 14px;
}

.recent-claim {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(247, 201, 72, 0.18);
  border-radius: 10px;
  background: rgba(72, 18, 30, 0.28);
  font-size: 12px;
}

.recent-claim strong {
  color: var(--gold);
}

.quiz-screen {
  flex-direction: column;
}

.quiz-screen-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.quiz-timer {
  display: grid;
  text-align: right;
}

.quiz-timer span {
  color: var(--gold);
  font-size: clamp(50px, 6vw, 90px);
  font-weight: 900;
  line-height: 0.9;
  letter-spacing: -0.08em;
}

.quiz-timer small {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.16em;
}

.quiz-screen-body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  min-height: 0;
}

.quiz-question-panel {
  display: flex;
  flex-direction: column;
  padding: clamp(22px, 3vw, 42px);
}

.quiz-question-panel h2 {
  margin: 0 0 22px;
  font-size: clamp(24px, 2.5vw, 38px);
  line-height: 1.35;
}

.screen-option-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.screen-option {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 70px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: rgba(5, 18, 30, 0.45);
}

.screen-option > span {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 9px;
  color: #04201f;
  background: var(--teal);
  font-size: 12px;
  font-weight: 900;
}

.screen-option strong {
  flex: 1;
  font-size: clamp(14px, 1.35vw, 19px);
}

.screen-option small {
  color: var(--muted);
}

.screen-option.correct {
  border-color: rgba(74, 222, 128, 0.6);
  background: rgba(74, 222, 128, 0.12);
}

.screen-option.correct > span {
  color: #05210d;
  background: var(--green);
}

.quiz-answer-line {
  display: flex;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 16px;
  color: var(--muted);
  font-size: 12px;
}

.quiz-side {
  padding: 18px;
}

.lottery-view {
  height: calc(100vh - 88px);
  padding: 0;
}

.screen-footer {
  z-index: 6;
  border-top: 1px solid rgba(148, 211, 219, 0.08);
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.06em;
}

.screen-swap-enter-active,
.screen-swap-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}

.screen-swap-enter-from,
.screen-swap-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@keyframes rainFall {
  to {
    transform: translateY(120vh) rotate(25deg);
  }
}

@media (max-width: 1000px) {
  .screen-header,
  .screen-footer {
    padding-left: 20px;
    padding-right: 20px;
  }
  .screen-view {
    padding: 20px;
  }
  .quiz-screen-body {
    grid-template-columns: 1fr;
  }
  .quiz-side {
    display: none;
  }
  .recent-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 700px) {
  .screen-header-center {
    display: none;
  }
  .lobby-view {
    flex-direction: column;
  }
  .lobby-side {
    width: 100%;
  }
  .screen-view {
    padding: 16px;
  }
  .screen-stats {
    gap: 20px;
  }
  .screen-option-grid {
    grid-template-columns: 1fr;
  }
  .redpacket-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
