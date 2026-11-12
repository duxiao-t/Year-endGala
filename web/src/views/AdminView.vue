<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  AdminClaimRow,
  AdminOverview,
  EventSettings,
  Participant,
  Question
} from '@shared/types'
import { api, exportWorkbook, fileToBase64 } from '../api'
import { copyText, dateTime, fen } from '../utils'

type AdminTab = 'control' | 'participants' | 'settings' | 'questions' | 'results'

const authenticated = ref(false)
const loading = ref(true)
const loginError = ref('')
const message = ref('')
const messageError = ref(false)
const tab = ref<AdminTab>('control')
const overview = ref<AdminOverview | null>(null)
const participants = ref<Participant[]>([])
const participantTotal = ref(0)
const participantSearch = ref('')
const claims = ref<AdminClaimRow[]>([])
const claimTotal = ref(0)
const claimSearch = ref('')
const screenToken = ref(localStorage.getItem('gala_screen_token') || '')
const refreshing = ref(false)
const importedBusy = ref(false)
const isDev = import.meta.env.DEV
let pollTimer: number | undefined
let settingsLoaded = false

const loginForm = reactive({ password: '' })
const participantForm = reactive({ employeeNo: '', name: '', department: '' })
const questionForm = reactive({
  text: '',
  a: '',
  b: '',
  c: '',
  d: '',
  correctOption: 0,
  durationSec: 20,
  points: 100
})
const drawForm = reactive({ prizeIndex: 0, count: 1 })

const draft = reactive({
  eventName: '',
  company: '',
  joinCode: '',
  joinMode: 'hybrid' as EventSettings['joinMode'],
  allowSelfRegistration: true,
  requireSelfApproval: false,
  eligibilityPolicy: 'independent' as EventSettings['eligibilityPolicy'],
  displayNameMode: 'masked' as EventSettings['displayNameMode'],
  drawVisualCards: 160,
  shakeDuration: 30,
  shakeWinners: 10,
  shakePrizeName: '摇一摇好礼',
  redpacketDuration: 20,
  redpacketMode: 'random' as 'random' | 'fixed',
  redpacketBudgetYuan: 1000,
  redpacketPacketCount: 500,
  redpacketFixedYuan: 2,
  redpacketMinYuan: 1,
  redpacketMaxYuan: 8.88,
  redpacketMaxClaims: 2,
  redpacketPrizeName: '现金红包',
  quizWinners: 10,
  quizBasePoints: 100,
  quizSpeedBonusMax: 50,
  quizPrizeName: '答题好礼',
  lotteryPrizesJson: '[]'
})

const tabItems: Array<{ key: AdminTab; label: string; icon: string }> = [
  { key: 'control', label: '控场台', icon: '🎛️' },
  { key: 'participants', label: '参与者', icon: '👥' },
  { key: 'settings', label: '规则配置', icon: '⚙️' },
  { key: 'questions', label: '题库', icon: '❓' },
  { key: 'results', label: '结果与兑付', icon: '📊' }
]

const currentView = computed(() => overview.value?.snapshot.view || 'lobby')
const phase = computed(() => ({
  shake: overview.value?.snapshot.shake.phase || 'idle',
  redpacket: overview.value?.snapshot.redpacket.phase || 'idle',
  quiz: overview.value?.snapshot.quiz.phase || 'idle',
  lottery: overview.value?.snapshot.lottery.phase || 'idle'
}))
const joinUrl = computed(() => {
  if (!overview.value) return ''
  const origin = overview.value.snapshot.publicOrigin || window.location.origin
  const code = overview.value.settings.joinCode
  return `${origin.replace(/\/$/, '')}/join${code ? `?code=${encodeURIComponent(code)}` : ''}`
})
const screenUrl = computed(() => {
  const base = `${window.location.origin}/screen`
  return screenToken.value ? `${base}?token=${encodeURIComponent(screenToken.value)}` : base
})

onMounted(async () => {
  await refresh()
  pollTimer = window.setInterval(async () => {
    if (!authenticated.value) return
    try {
      const value = await api.adminOverview()
      overview.value = value
    } catch {
      // Keep the last known control state during a transient network error.
    }
  }, 5000)
})

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})

async function refresh() {
  refreshing.value = true
  try {
    const value = await api.adminOverview()
    overview.value = value
    authenticated.value = true
    if (!settingsLoaded) {
      applySettings(value.settings)
      settingsLoaded = true
    }
    if (tab.value === 'participants') await loadParticipants()
    if (tab.value === 'results') await loadClaims()
  } catch (error) {
    authenticated.value = false
    loginError.value = error instanceof Error ? error.message : '请登录主持台'
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function applySettings(settings: EventSettings) {
  draft.eventName = settings.eventName
  draft.company = settings.company
  draft.joinCode = settings.joinCode
  draft.joinMode = settings.joinMode
  draft.allowSelfRegistration = settings.allowSelfRegistration
  draft.requireSelfApproval = settings.requireSelfApproval
  draft.eligibilityPolicy = settings.eligibilityPolicy
  draft.displayNameMode = settings.displayNameMode
  draft.drawVisualCards = settings.drawVisualCards
  draft.shakeDuration = settings.shake.durationSec
  draft.shakeWinners = settings.shake.winners
  draft.shakePrizeName = settings.shake.prizeName
  draft.redpacketDuration = settings.redpacket.durationSec
  draft.redpacketMode = settings.redpacket.mode
  draft.redpacketBudgetYuan = settings.redpacket.budgetFen / 100
  draft.redpacketPacketCount = settings.redpacket.packetCount
  draft.redpacketFixedYuan = settings.redpacket.fixedFen / 100
  draft.redpacketMinYuan = settings.redpacket.minFen / 100
  draft.redpacketMaxYuan = settings.redpacket.maxFen / 100
  draft.redpacketMaxClaims = settings.redpacket.maxClaims
  draft.redpacketPrizeName = settings.redpacket.prizeName
  draft.quizWinners = settings.quiz.winners
  draft.quizBasePoints = settings.quiz.basePoints
  draft.quizSpeedBonusMax = settings.quiz.speedBonusMax
  draft.quizPrizeName = settings.quiz.prizeName
  draft.lotteryPrizesJson = JSON.stringify(settings.lotteryPrizes, null, 2)
  if (drawForm.prizeIndex >= settings.lotteryPrizes.length) drawForm.prizeIndex = 0
}

function settingsPayload(): EventSettings {
  const lotteryPrizes = JSON.parse(draft.lotteryPrizesJson)
  if (!Array.isArray(lotteryPrizes) || !lotteryPrizes.length) throw new Error('奖品配置必须是非空数组')
  return {
    eventName: draft.eventName,
    company: draft.company,
    joinCode: draft.joinCode,
    joinMode: draft.joinMode,
    allowSelfRegistration: draft.allowSelfRegistration,
    requireSelfApproval: draft.requireSelfApproval,
    eligibilityPolicy: draft.eligibilityPolicy,
    displayNameMode: draft.displayNameMode,
    drawVisualCards: Number(draft.drawVisualCards),
    shake: {
      durationSec: Number(draft.shakeDuration),
      winners: Number(draft.shakeWinners),
      prizeName: draft.shakePrizeName
    },
    redpacket: {
      durationSec: Number(draft.redpacketDuration),
      mode: draft.redpacketMode,
      budgetFen: Math.round(Number(draft.redpacketBudgetYuan) * 100),
      packetCount: Number(draft.redpacketPacketCount),
      fixedFen: Math.round(Number(draft.redpacketFixedYuan) * 100),
      minFen: Math.round(Number(draft.redpacketMinYuan) * 100),
      maxFen: Math.round(Number(draft.redpacketMaxYuan) * 100),
      maxClaims: Number(draft.redpacketMaxClaims),
      prizeName: draft.redpacketPrizeName
    },
    quiz: {
      winners: Number(draft.quizWinners),
      basePoints: Number(draft.quizBasePoints),
      speedBonusMax: Number(draft.quizSpeedBonusMax),
      prizeName: draft.quizPrizeName
    },
    lotteryPrizes
  }
}

async function login() {
  loginError.value = ''
  try {
    await api.adminLogin(loginForm.password)
    loginForm.password = ''
    await refresh()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败'
  }
}

async function logout() {
  await api.adminLogout().catch(() => {})
  authenticated.value = false
  overview.value = null
  settingsLoaded = false
  if (pollTimer) window.clearInterval(pollTimer)
}

function notify(text: string, error = false) {
  message.value = text
  messageError.value = error
  window.setTimeout(() => {
    if (message.value === text) message.value = ''
  }, 4200)
}

async function saveSettings() {
  try {
    const settings = settingsPayload()
    await api.updateSettings(settings)
    await refresh()
    notify('规则已保存')
  } catch (error) {
    notify(error instanceof Error ? error.message : '保存失败', true)
  }
}

async function switchView(view: string) {
  try {
    await api.switchView(view)
    await refresh()
    notify(`已切换到 ${view === 'lobby' ? '互动大厅' : view}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '切换失败', true)
  }
}

async function runAction(game: string, action: string, needsConfirm = false) {
  let confirm: string | undefined
  if (needsConfirm) {
    const text = window.prompt('此操作会清除该玩法数据，输入 RESET 确认')
    if (text !== 'RESET') return
    confirm = text
  }
  try {
    const result = await api.action(game, action, confirm)
    overview.value = result.overview
    notify(`${game}.${action} 完成`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '操作失败', true)
  }
}

async function draw() {
  try {
    const result = await api.draw(Number(drawForm.prizeIndex), Number(drawForm.count))
    await refresh()
    notify(`已抽出 ${result.winners.length} 位中奖者`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '抽奖失败', true)
  }
}

function onPrizeChange() {
  const prize = overview.value?.settings.lotteryPrizes[Number(drawForm.prizeIndex)]
  if (prize) drawForm.count = prize.each
}

async function loadParticipants() {
  try {
    const result = await api.participants(participantSearch.value)
    participants.value = result.rows
    participantTotal.value = result.total
  } catch {
    // Auth/overview already reports the primary error.
  }
}

async function addParticipant() {
  try {
    await api.addParticipant(participantForm)
    participantForm.employeeNo = ''
    participantForm.name = ''
    participantForm.department = ''
    await loadParticipants()
    await refresh()
    notify('参与者已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '新增失败', true)
  }
}

async function changeStatus(participant: Participant, event: Event) {
  const select = event.target as HTMLSelectElement
  try {
    if (select.value === 'active' && participant.status === 'pending') {
      await api.approveParticipant(participant.id)
    } else {
      await api.updateParticipant(participant.id, select.value)
    }
    await loadParticipants()
    notify('状态已更新')
  } catch (error) {
    notify(error instanceof Error ? error.message : '更新失败', true)
  }
}

async function importParticipantFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importedBusy.value = true
  try {
    const data = await fileToBase64(file)
    const result = await api.importParticipants(file.name, data)
    await loadParticipants()
    await refresh()
    notify(`导入 ${result.imported} 人，跳过 ${result.skipped} 行`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '导入失败', true)
  } finally {
    importedBusy.value = false
    input.value = ''
  }
}

async function generateDemo() {
  if (!window.confirm('生成 1000 名演示参与者？工号 DEMO0001 起。')) return
  try {
    const result = await api.demoParticipants(1000)
    await loadParticipants()
    await refresh()
    notify(`已生成 ${result.created} 人`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '生成失败', true)
  }
}

async function addQuestion() {
  try {
    await api.addQuestion({
      text: questionForm.text,
      options: [questionForm.a, questionForm.b, questionForm.c, questionForm.d],
      correctOption: Number(questionForm.correctOption),
      durationSec: Number(questionForm.durationSec),
      points: Number(questionForm.points)
    })
    questionForm.text = ''
    questionForm.a = ''
    questionForm.b = ''
    questionForm.c = ''
    questionForm.d = ''
    await refresh()
    notify('题目已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '添加失败', true)
  }
}

async function deleteQuestion(question: Question) {
  if (!window.confirm(`删除题目“${question.text}”？`)) return
  try {
    await api.deleteQuestion(question.id)
    await refresh()
    notify('题目已删除')
  } catch (error) {
    notify(error instanceof Error ? error.message : '删除失败', true)
  }
}

async function importQuestionFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importedBusy.value = true
  try {
    const data = await fileToBase64(file)
    const result = await api.importQuestions(file.name, data)
    await refresh()
    notify(`导入 ${result.imported} 题，跳过 ${result.skipped} 行`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '导入失败', true)
  } finally {
    importedBusy.value = false
    input.value = ''
  }
}

async function loadClaims() {
  try {
    const result = await api.claims(claimSearch.value)
    claims.value = result.rows
    claimTotal.value = result.total
  } catch {
    // Handled by the main refresh.
  }
}

async function redeem(claim: AdminClaimRow) {
  try {
    await api.redeemClaim(claim.id)
    await loadClaims()
    notify('红包已标记兑付')
  } catch (error) {
    notify(error instanceof Error ? error.message : '兑付失败', true)
  }
}

async function voidResult(id: number) {
  const reason = window.prompt('填写作废原因，例如“中奖人不在现场”')
  if (!reason?.trim()) return
  try {
    await api.voidResult(id, reason)
    await refresh()
    notify('结果已作废，可重新抽奖')
  } catch (error) {
    notify(error instanceof Error ? error.message : '作废失败', true)
  }
}

async function doExport() {
  try {
    await exportWorkbook()
    notify('结果工作簿已开始下载')
  } catch (error) {
    notify(error instanceof Error ? error.message : '导出失败', true)
  }
}

async function copy(value: string) {
  if (await copyText(value)) notify('已复制到剪贴板')
  else notify('复制失败，请手动选择', true)
}

function saveScreenToken() {
  localStorage.setItem('gala_screen_token', screenToken.value)
  notify('大屏 token 已记住')
}

async function openTab(next: AdminTab) {
  tab.value = next
  if (next === 'participants') await loadParticipants()
  if (next === 'results') await loadClaims()
  if (next === 'settings' && overview.value) applySettings(overview.value.settings)
}

function gameName(game: string) {
  return { lottery: '抽奖', shake: '摇一摇', redpacket: '红包雨', quiz: '答题' }[game] || game
}
</script>

<template>
  <main class="page">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">G</div>
        <div>
          主持控制台
          <small>Gala Control Room</small>
        </div>
      </div>
      <div class="row">
        <router-link class="tag" to="/">首页</router-link>
        <router-link class="tag" to="/screen">大屏</router-link>
        <button v-if="authenticated" class="btn btn-sm btn-ghost" @click="logout">退出</button>
      </div>
    </header>

    <section v-if="loading" class="panel pad">
      <p class="muted">正在连接主持台…</p>
    </section>

    <section v-else-if="!authenticated" class="panel pad" style="max-width: 520px; margin: 8vh auto">
      <p class="eyebrow">ADMIN ACCESS</p>
      <h1 class="page-title" style="margin: 8px 0 12px">主持台登录</h1>
      <p class="muted small" style="line-height: 1.8">
        所有玩法切换、名单导入、抽奖和结果导出的操作都在这里。
      </p>
      <form class="grid" style="margin-top: 20px" @submit.prevent="login">
        <input v-model="loginForm.password" class="input" type="password" placeholder="主持台密码" autofocus />
        <button class="btn btn-primary" type="submit">进入主持台</button>
        <p v-if="loginError" class="tag red" style="padding: 10px">{{ loginError }}</p>
        <p v-if="isDev" class="small muted">本地开发默认密码见 README 或服务端启动日志。</p>
      </form>
    </section>

    <div v-else-if="overview" class="admin-shell">
      <aside class="panel admin-menu">
        <button
          v-for="item in tabItems"
          :key="item.key"
          :class="{ active: tab === item.key }"
          @click="openTab(item.key)"
        >
          <span>{{ item.icon }}</span>{{ item.label }}
        </button>
        <div class="divider"></div>
        <span class="small muted" style="padding: 0 12px">
          有效参与 {{ overview.stats.active }} / {{ overview.stats.participants }}
        </span>
      </aside>

      <section class="admin-content">
        <div class="row between" style="margin-bottom: 14px">
          <div>
            <p class="eyebrow" style="margin: 0">CURRENT VIEW</p>
            <h1 class="page-title" style="margin-top: 4px">
              {{ currentView === 'lobby' ? '互动大厅' : gameName(currentView) }}
            </h1>
          </div>
          <div class="row">
            <span class="tag teal"><span class="live-dot"></span> 实时服务在线</span>
            <button class="btn btn-sm" :disabled="refreshing" @click="refresh">
              {{ refreshing ? '刷新中' : '刷新' }}
            </button>
          </div>
        </div>

        <template v-if="tab === 'control'">
          <div class="grid grid-4" style="margin-bottom: 14px">
            <div class="metric">
              <span>已登记</span>
              <strong>{{ overview.stats.participants }}</strong>
              <span>待审核 {{ overview.stats.pending }}</span>
            </div>
            <div class="metric">
              <span>摇一摇</span>
              <strong>{{ overview.snapshot.shake.top[0]?.score || 0 }}</strong>
              <span>当前最高 {{ phase.shake }}</span>
            </div>
            <div class="metric">
              <span>红包雨</span>
              <strong>¥{{ fen(overview.snapshot.redpacket.claimedAmountFen) }}</strong>
              <span>{{ overview.snapshot.redpacket.claimedCount }} 包</span>
            </div>
            <div class="metric">
              <span>答题</span>
              <strong>{{ overview.snapshot.quiz.top[0]?.score || 0 }}</strong>
              <span>{{ phase.quiz }}</span>
            </div>
          </div>

          <section class="panel pad" style="margin-bottom: 14px">
            <div class="row between">
              <div>
                <p class="eyebrow" style="margin: 0">SCREEN SWITCHER</p>
                <h2 style="margin: 5px 0 0; font-size: 20px">切换大屏</h2>
              </div>
              <span class="small muted">手机端会自动跟随当前玩法</span>
            </div>
            <div class="control-grid" style="margin-top: 16px">
              <button class="control-btn" :class="{ active: currentView === 'lobby' }" @click="switchView('lobby')">
                <strong>🏠 互动大厅</strong>
                扫码与总览
              </button>
              <button class="control-btn" :class="{ active: currentView === 'shake' }" @click="switchView('shake')">
                <strong>📳 摇一摇</strong>
                {{ phase.shake }}
              </button>
              <button class="control-btn" :class="{ active: currentView === 'redpacket' }" @click="switchView('redpacket')">
                <strong>🧧 红包雨</strong>
                {{ phase.redpacket }}
              </button>
              <button class="control-btn" :class="{ active: currentView === 'quiz' }" @click="switchView('quiz')">
                <strong>🧠 现场答题</strong>
                {{ phase.quiz }}
              </button>
              <button class="control-btn" :class="{ active: currentView === 'lottery' }" @click="switchView('lottery')">
                <strong>🎁 幸运抽奖</strong>
                {{ phase.lottery }}
              </button>
            </div>
          </section>

          <div class="grid grid-2" style="margin-bottom: 14px">
            <section class="panel pad">
              <p class="eyebrow">SHAKE CONTROL</p>
              <h3 style="margin: 6px 0 12px">摇一摇</h3>
              <div class="row wrap">
                <button class="btn btn-primary" :disabled="phase.shake === 'running'" @click="runAction('shake', 'start')">
                  开始本轮
                </button>
                <button class="btn" :disabled="phase.shake !== 'running'" @click="runAction('shake', 'finish')">
                  立即结束
                </button>
                <button class="btn btn-danger" @click="runAction('shake', 'reset', true)">重置</button>
              </div>
              <p class="small muted" style="line-height: 1.7">
                默认 {{ overview.settings.shake.durationSec }} 秒，Top {{ overview.settings.shake.winners }} 获奖。
              </p>
            </section>
            <section class="panel pad">
              <p class="eyebrow">RED PACKET CONTROL</p>
              <h3 style="margin: 6px 0 12px">红包雨</h3>
              <div class="row wrap">
                <button class="btn btn-primary" :disabled="phase.redpacket === 'running'" @click="runAction('redpacket', 'start')">
                  开始本轮
                </button>
                <button class="btn" :disabled="phase.redpacket !== 'running'" @click="runAction('redpacket', 'finish')">
                  立即结束
                </button>
                <button class="btn btn-danger" @click="runAction('redpacket', 'reset', true)">重置</button>
              </div>
              <p class="small muted" style="line-height: 1.7">
                {{ overview.settings.redpacket.mode === 'fixed' ? '固定金额' : '随机金额' }} ·
                {{ overview.settings.redpacket.packetCount }} 包 · 每人最多
                {{ overview.settings.redpacket.maxClaims }} 个
              </p>
            </section>
          </div>

          <div class="grid grid-2" style="margin-bottom: 14px">
            <section class="panel pad">
              <p class="eyebrow">QUIZ CONTROL</p>
              <h3 style="margin: 6px 0 12px">现场答题</h3>
              <div class="row wrap">
                <button class="btn btn-primary" :disabled="phase.quiz !== 'idle' && phase.quiz !== 'finished'" @click="runAction('quiz', 'start')">开始答题</button>
                <button class="btn" @click="runAction('quiz', 'lock')">锁题</button>
                <button class="btn btn-gold" @click="runAction('quiz', 'reveal')">揭晓</button>
                <button class="btn" @click="runAction('quiz', 'next')">下一题</button>
                <button class="btn" @click="runAction('quiz', 'finish')">结束</button>
                <button class="btn btn-danger" @click="runAction('quiz', 'reset', true)">重置</button>
              </div>
              <p class="small muted" style="line-height: 1.7">
                题库 {{ overview.questions.length }} 题，Top {{ overview.settings.quiz.winners }} 获奖。
              </p>
            </section>
            <section class="panel pad">
              <p class="eyebrow">LOTTERY CONTROL</p>
              <h3 style="margin: 6px 0 12px">幸运抽奖</h3>
              <form class="row wrap" @submit.prevent="draw">
                <select v-model.number="drawForm.prizeIndex" class="select" style="width: auto" @change="onPrizeChange">
                  <option v-for="(prize, index) in overview.settings.lotteryPrizes" :key="index" :value="index">
                    {{ prize.name }}（剩 {{ overview.snapshot.lottery.remaining[index] }}）
                  </option>
                </select>
                <input v-model.number="drawForm.count" class="input" style="width: 84px" type="number" min="1" />
                <button class="btn btn-gold" type="submit">抽取</button>
                <button class="btn btn-danger" type="button" @click="runAction('lottery', 'reset', true)">重置</button>
              </form>
              <p class="small muted" style="line-height: 1.7">
                当前合格候选 {{ overview.snapshot.lottery.eligibleCount }} 人，抽奖结果为服务端加密随机。
              </p>
            </section>
          </div>

          <section class="panel pad">
            <div class="row between wrap">
              <div>
                <p class="eyebrow">LINKS</p>
                <h3 style="margin: 6px 0 0">现场入口</h3>
              </div>
              <div class="row wrap">
                <button class="btn btn-sm" @click="copy(joinUrl)">复制入场链接</button>
                <router-link class="btn btn-sm" :to="`/screen${screenToken ? `?token=${encodeURIComponent(screenToken)}` : ''}`" target="_blank">
                  打开大屏
                </router-link>
              </div>
            </div>
            <div class="grid grid-2" style="margin-top: 14px">
              <label class="field">
                <span class="label">手机入场链接</span>
                <input class="input" :value="joinUrl" readonly />
              </label>
              <label class="field">
                <span class="label">大屏 token（与 SCREEN_TOKEN 一致）</span>
                <input
                  v-model="screenToken"
                  class="input"
                  placeholder="生产环境必填"
                  @change="saveScreenToken"
                />
              </label>
            </div>
          </section>
        </template>

        <template v-else-if="tab === 'participants'">
          <section class="panel pad">
            <div class="row between wrap">
              <div>
                <p class="eyebrow">ROSTER</p>
                <h2 class="page-title" style="font-size: 26px">参与者名单</h2>
                <p class="small muted">导入 Excel/CSV 列：工号、姓名、部门。自助登记会按工号唯一去重。</p>
              </div>
              <div class="row wrap">
                <label class="btn btn-sm">
                  导入名单
                  <input type="file" accept=".xlsx,.xls,.csv" hidden @change="importParticipantFile" />
                </label>
                <button class="btn btn-sm btn-ghost" :disabled="importedBusy" @click="generateDemo">生成 1000 演示名单</button>
              </div>
            </div>

            <form class="row wrap" style="margin-top: 16px" @submit.prevent="addParticipant">
              <input v-model="participantForm.employeeNo" class="input" style="width: 150px" placeholder="工号" required />
              <input v-model="participantForm.name" class="input" style="width: 140px" placeholder="姓名" required />
              <input v-model="participantForm.department" class="input" style="width: 180px" placeholder="部门" />
              <button class="btn btn-primary" type="submit">添加</button>
            </form>

            <form class="row wrap" style="margin-top: 14px" @submit.prevent="loadParticipants">
              <input v-model="participantSearch" class="input" style="min-width: 220px; flex: 1" placeholder="搜索工号、姓名、部门" />
              <button class="btn" type="submit">搜索</button>
              <span class="small muted">{{ participantTotal }} 人</span>
            </form>

            <div class="table-wrap" style="margin-top: 14px; max-height: 55vh">
              <table class="table">
                <thead>
                  <tr><th>工号</th><th>姓名</th><th>部门</th><th>来源</th><th>状态</th><th>登记时间</th></tr>
                </thead>
                <tbody>
                  <tr v-for="participant in participants" :key="participant.id">
                    <td>{{ participant.employeeNo }}</td>
                    <td>{{ participant.name }}</td>
                    <td>{{ participant.department || '—' }}</td>
                    <td>{{ participant.source === 'roster' ? '导入' : '自助' }}</td>
                    <td>
                      <select class="select" style="min-height: 30px; padding: 4px 8px" :value="participant.status" @change="changeStatus(participant, $event)">
                        <option value="active">有效</option>
                        <option value="pending">待审核</option>
                        <option value="excluded">排除</option>
                        <option value="absent">缺席</option>
                      </select>
                    </td>
                    <td>{{ dateTime(participant.createdAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="tab === 'settings'">
          <section class="panel pad">
            <p class="eyebrow">EVENT RULES</p>
            <h2 class="page-title" style="font-size: 26px">规则与配置</h2>
            <p class="small muted">改动保存后立即生效，已产生的历史结果不会被改写。</p>

            <div class="divider"></div>
            <p class="eyebrow">活动与入场</p>
            <div class="grid grid-3" style="margin-top: 10px">
              <label class="field"><span class="label">活动名称</span><input v-model="draft.eventName" class="input" /></label>
              <label class="field"><span class="label">公司标识</span><input v-model="draft.company" class="input" /></label>
              <label class="field"><span class="label">现场入场码</span><input v-model="draft.joinCode" class="input" /></label>
              <label class="field">
                <span class="label">入场模式</span>
                <select v-model="draft.joinMode" class="select">
                  <option value="hybrid">混合：名单 + 自助</option>
                  <option value="roster">仅名单</option>
                  <option value="self">仅自助</option>
                </select>
              </label>
              <label class="field">
                <span class="label">资格策略</span>
                <select v-model="draft.eligibilityPolicy" class="select">
                  <option value="independent">独立奖池，游戏获奖仍可抽奖</option>
                  <option value="exclude_game_winners_from_lottery">游戏获奖者退出抽奖</option>
                  <option value="one_prize_per_person">全局每人限中一次</option>
                </select>
              </label>
              <label class="field">
                <span class="label">大屏姓名</span>
                <select v-model="draft.displayNameMode" class="select">
                  <option value="masked">脱敏（张*）</option>
                  <option value="full">全名</option>
                </select>
              </label>
            </div>
            <div class="row wrap" style="margin-top: 12px">
              <label class="tag"><input v-model="draft.allowSelfRegistration" type="checkbox" /> 允许自助登记</label>
              <label class="tag"><input v-model="draft.requireSelfApproval" type="checkbox" /> 自助登记需审核</label>
              <label class="field" style="width: 150px"><span class="label">抽奖视觉卡片数</span><input v-model.number="draft.drawVisualCards" class="input" type="number" min="40" max="300" /></label>
            </div>

            <div class="divider"></div>
            <p class="eyebrow">玩法参数</p>
            <div class="grid grid-3" style="margin-top: 10px">
              <label class="field"><span class="label">摇一摇时长（秒）</span><input v-model.number="draft.shakeDuration" class="input" type="number" /></label>
              <label class="field"><span class="label">摇一摇获奖人数</span><input v-model.number="draft.shakeWinners" class="input" type="number" /></label>
              <label class="field"><span class="label">摇一摇奖品名</span><input v-model="draft.shakePrizeName" class="input" /></label>
              <label class="field"><span class="label">红包雨时长（秒）</span><input v-model.number="draft.redpacketDuration" class="input" type="number" /></label>
              <label class="field">
                <span class="label">红包金额模式</span>
                <select v-model="draft.redpacketMode" class="select">
                  <option value="random">随机金额</option>
                  <option value="fixed">固定金额</option>
                </select>
              </label>
              <label class="field"><span class="label">红包总预算（元）</span><input v-model.number="draft.redpacketBudgetYuan" class="input" type="number" step="0.01" /></label>
              <label class="field"><span class="label">红包包数</span><input v-model.number="draft.redpacketPacketCount" class="input" type="number" /></label>
              <label class="field"><span class="label">固定金额（元）</span><input v-model.number="draft.redpacketFixedYuan" class="input" type="number" step="0.01" /></label>
              <label class="field"><span class="label">随机下限（元）</span><input v-model.number="draft.redpacketMinYuan" class="input" type="number" step="0.01" /></label>
              <label class="field"><span class="label">随机上限（元）</span><input v-model.number="draft.redpacketMaxYuan" class="input" type="number" step="0.01" /></label>
              <label class="field"><span class="label">每人最多领取</span><input v-model.number="draft.redpacketMaxClaims" class="input" type="number" /></label>
              <label class="field"><span class="label">红包奖品名</span><input v-model="draft.redpacketPrizeName" class="input" /></label>
              <label class="field"><span class="label">答题获奖人数</span><input v-model.number="draft.quizWinners" class="input" type="number" /></label>
              <label class="field"><span class="label">答题基础分</span><input v-model.number="draft.quizBasePoints" class="input" type="number" /></label>
              <label class="field"><span class="label">答题速度分上限</span><input v-model.number="draft.quizSpeedBonusMax" class="input" type="number" /></label>
              <label class="field"><span class="label">答题奖品名</span><input v-model="draft.quizPrizeName" class="input" /></label>
            </div>

            <div class="divider"></div>
            <p class="eyebrow">抽奖奖项</p>
            <p class="small muted">JSON 数组，每项：name、count、each、可选 image。count 是奖项总数，each 是每次抽取人数。</p>
            <textarea v-model="draft.lotteryPrizesJson" class="textarea" rows="9" spellcheck="false"></textarea>
            <div class="row" style="justify-content: flex-end; margin-top: 12px">
              <button class="btn btn-primary" @click="saveSettings">保存全部配置</button>
            </div>
          </section>
        </template>

        <template v-else-if="tab === 'questions'">
          <section class="panel pad">
            <div class="row between wrap">
              <div>
                <p class="eyebrow">QUESTION BANK</p>
                <h2 class="page-title" style="font-size: 26px">题库</h2>
                <p class="small muted">导入列：题目、A、B、C、D、正确答案、时长、分值。</p>
              </div>
              <label class="btn btn-sm">
                导入题库
                <input type="file" accept=".xlsx,.xls,.csv" hidden @change="importQuestionFile" />
              </label>
            </div>
            <form class="grid" style="margin-top: 16px" @submit.prevent="addQuestion">
              <input v-model="questionForm.text" class="input" placeholder="题目内容" required />
              <div class="grid grid-2">
                <input v-model="questionForm.a" class="input" placeholder="A 选项" required />
                <input v-model="questionForm.b" class="input" placeholder="B 选项" required />
                <input v-model="questionForm.c" class="input" placeholder="C 选项" required />
                <input v-model="questionForm.d" class="input" placeholder="D 选项" required />
              </div>
              <div class="row wrap">
                <select v-model.number="questionForm.correctOption" class="select" style="width: auto">
                  <option :value="0">正确答案 A</option>
                  <option :value="1">正确答案 B</option>
                  <option :value="2">正确答案 C</option>
                  <option :value="3">正确答案 D</option>
                </select>
                <input v-model.number="questionForm.durationSec" class="input" style="width: 100px" type="number" title="时长秒数" />
                <input v-model.number="questionForm.points" class="input" style="width: 100px" type="number" title="基础分" />
                <button class="btn btn-primary" type="submit">添加题目</button>
              </div>
            </form>
            <div class="grid" style="margin-top: 18px">
              <div v-for="(question, index) in overview.questions" :key="question.id" class="panel soft pad">
                <div class="row between">
                  <strong>{{ index + 1 }}. {{ question.text }}</strong>
                  <button class="btn btn-sm btn-danger" @click="deleteQuestion(question)">删除</button>
                </div>
                <div class="row wrap" style="margin-top: 10px">
                  <span v-for="(option, optionIndex) in question.options" :key="optionIndex" class="tag" :class="{ teal: optionIndex === question.correctOption }">
                    {{ ['A', 'B', 'C', 'D'][optionIndex] }}. {{ option }}
                  </span>
                  <span class="small muted">{{ question.durationSec }} 秒 · {{ question.points }} 分</span>
                </div>
              </div>
            </div>
          </section>
        </template>

        <template v-else-if="tab === 'results'">
          <section class="panel pad" style="margin-bottom: 14px">
            <div class="row between wrap">
              <div>
                <p class="eyebrow">RESULTS</p>
                <h2 class="page-title" style="font-size: 26px">结果汇总</h2>
                <p class="small muted">导出包含参与人员、中奖与红包流水、答题明细和汇总。</p>
              </div>
              <button class="btn btn-primary" @click="doExport">导出 Excel</button>
            </div>
            <div class="table-wrap" style="margin-top: 16px">
              <table class="table">
                <thead><tr><th>玩法</th><th>奖项</th><th>排名</th><th>姓名</th><th>工号</th><th>时间</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="row in overview.recentResults" :key="row.id">
                    <td>{{ gameName(row.game) }}</td>
                    <td>{{ row.prizeName }}</td>
                    <td>#{{ row.rank }}</td>
                    <td>{{ row.name }}</td>
                    <td>{{ row.employeeNo }}</td>
                    <td>{{ dateTime(row.createdAt) }}</td>
                    <td><span class="tag" :class="row.voided ? 'red' : 'teal'">{{ row.voided ? '作废' : '有效' }}</span></td>
                    <td><button v-if="!row.voided" class="btn btn-sm" @click="voidResult(row.id)">作废</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="panel pad">
            <div class="row between wrap">
              <div>
                <p class="eyebrow">RED PACKET LEDGER</p>
                <h2 class="page-title" style="font-size: 24px">红包兑付</h2>
              </div>
              <form class="row" @submit.prevent="loadClaims">
                <input v-model="claimSearch" class="input" style="min-width: 200px" placeholder="姓名 / 工号 / 兑付码" />
                <button class="btn btn-sm" type="submit">搜索</button>
              </form>
            </div>
            <div class="table-wrap" style="margin-top: 14px; max-height: 50vh">
              <table class="table">
                <thead><tr><th>姓名</th><th>工号</th><th>金额</th><th>兑付码</th><th>领取时间</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="claim in claims" :key="claim.id">
                    <td>{{ claim.name }}</td>
                    <td>{{ claim.employeeNo }}</td>
                    <td>¥{{ fen(claim.amountFen) }}</td>
                    <td><span class="claim-code">{{ claim.claimCode }}</span></td>
                    <td>{{ dateTime(claim.createdAt) }}</td>
                    <td><span class="tag" :class="claim.redeemedAt ? 'teal' : 'gold'">{{ claim.redeemedAt ? '已兑付' : '待兑付' }}</span></td>
                    <td><button v-if="!claim.redeemedAt" class="btn btn-sm" @click="redeem(claim)">标记兑付</button></td>
                  </tr>
                  <tr v-if="!claims.length"><td colspan="7" class="muted">暂无红包流水</td></tr>
                </tbody>
              </table>
            </div>
            <p class="small muted">共 {{ claimTotal }} 条红包记录。</p>
          </section>
        </template>
      </section>
    </div>

    <div v-if="message" class="toast" :class="{ error: messageError }">{{ message }}</div>
  </main>
</template>

<style scoped>
.admin-shell {
  min-height: 70vh;
}

@media (max-width: 900px) {
  .admin-shell {
    gap: 12px;
  }
}
</style>
