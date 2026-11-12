<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { useLive } from '../live'
import { fen } from '../utils'
import ShakeGame from '../components/ShakeGame.vue'
import RedPacketGame from '../components/RedPacketGame.vue'
import QuizGame from '../components/QuizGame.vue'

const router = useRouter()
const { snapshot, player, connected, lastError, connectLive, disconnectLive, syncPlayer } = useLive()
const loading = ref(true)
const fatal = ref('')
const SYNC_INTERVAL_MS = 30_000
let refreshTimer: number | undefined

function syncWhenVisible() {
  if (document.visibilityState === 'visible') syncPlayer()
}

const view = computed(() => snapshot.value?.view || player.value?.view || 'lobby')
const currentGameLabel = computed(() => {
  return {
    lobby: '互动大厅',
    shake: '手机摇一摇',
    redpacket: '红包雨',
    quiz: '现场答题',
    lottery: '幸运抽奖'
  }[view.value]
})
onMounted(async () => {
  refreshTimer = window.setInterval(syncWhenVisible, SYNC_INTERVAL_MS)
  document.addEventListener('visibilitychange', syncWhenVisible)
  try {
    const me = await api.me()
    if (me.participant.status === 'pending') {
      router.replace('/join')
      return
    }
    connectLive()
  } catch (error) {
    router.replace('/join')
  } finally {
    loading.value = false
  }
})

watch(
  () => snapshot.value?.view,
  (value, previous) => {
    if (value && value !== previous) syncPlayer()
  }
)

watch(
  () => [
    snapshot.value?.shake.phase,
    snapshot.value?.redpacket.phase,
    snapshot.value?.quiz.phase,
    snapshot.value?.lottery.lastDraw?.drawId
  ],
  () => syncPlayer()
)

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
  document.removeEventListener('visibilitychange', syncWhenVisible)
  disconnectLive()
})

async function refreshMe() {
  try {
    const me = await api.me()
    if (me.participant.status === 'excluded' || me.participant.status === 'absent') {
      fatal.value = '您的入场记录已被停用，请联系主持台。'
    }
  } catch {
    // Keep the current screen; socket reconnect status is visible.
  }
}
</script>

<template>
  <main class="mobile-shell">
    <header class="row between" style="margin-bottom: 16px">
      <div class="brand">
        <div class="brand-mark">G</div>
        <div>
          {{ snapshot?.eventName || '年会互动现场' }}
          <small>{{ snapshot?.company || 'GALA LIVE' }}</small>
        </div>
      </div>
      <div class="row" style="gap: 8px">
        <span class="tag" :class="{ red: !connected }">
          <span class="live-dot" :class="{ offline: !connected }"></span>
          {{ connected ? '在线' : '重连中' }}
        </span>
        <button class="btn btn-sm btn-ghost" @click="refreshMe">刷新</button>
      </div>
    </header>

    <div v-if="fatal" class="panel mobile-panel" style="border-color: rgba(255,107,107,.4)">
      {{ fatal }}
    </div>
    <div v-else-if="loading" class="panel mobile-panel">
      <p class="muted">正在确认入场信息…</p>
    </div>
    <template v-else>
      <div class="row between" style="margin-bottom: 10px">
        <div>
          <p class="eyebrow" style="margin: 0">LIVE NOW</p>
          <h1 class="page-title" style="margin-top: 4px">{{ currentGameLabel }}</h1>
        </div>
        <div style="text-align: right">
          <div class="small muted">{{ player?.participant.name }}</div>
          <div class="small muted">{{ player?.participant.employeeNo }}</div>
        </div>
      </div>

      <div v-if="lastError" class="tag red" style="border-radius: 12px; padding: 10px; margin-bottom: 10px">
        {{ lastError }}
      </div>

      <ShakeGame
        v-if="view === 'shake' && snapshot && player"
        :snapshot="snapshot"
        :summary="player"
      />
      <RedPacketGame
        v-else-if="view === 'redpacket' && snapshot && player"
        :snapshot="snapshot"
        :summary="player"
      />
      <QuizGame
        v-else-if="view === 'quiz' && snapshot && player"
        :snapshot="snapshot"
        :summary="player"
      />

      <section v-else-if="view === 'lottery'" class="panel mobile-panel">
        <p class="eyebrow">LUCKY DRAW</p>
        <h1 class="page-title">请看向大屏</h1>
        <p class="muted" style="line-height: 1.8">
          抽奖由主持台发起，结果实时同步。中奖名单也会显示在大屏上。
        </p>
        <div v-if="player?.lottery.won" class="grid" style="margin-top: 18px">
          <div v-for="result in player.lottery.results" :key="result.resultId" class="claim-card">
            <div>
              <strong>{{ result.prizeName }}</strong>
              <div class="small muted">第 {{ result.rank }} 位</div>
            </div>
            <span class="tag gold">已中奖</span>
          </div>
        </div>
        <div v-else class="empty" style="margin-top: 18px">本轮暂未中奖，继续关注大屏</div>
      </section>

      <section v-else class="grid fade-in">
        <div class="panel mobile-panel">
          <p class="eyebrow">YOU ARE IN</p>
          <h1 class="page-title" style="margin: 8px 0 10px">
            {{ player?.participant.name }}，欢迎入场
          </h1>
          <p class="muted small" style="line-height: 1.8">
            当前有 {{ snapshot?.join.activeCount || 0 }} 位同事在线登记。
            手机保持亮屏，主持台切换玩法后页面会自动进入。
          </p>
        </div>
        <div class="grid grid-2">
          <div class="metric">
            <span>摇一摇</span>
            <strong>{{ player?.shake.score || 0 }}</strong>
            <span class="small">当前积分</span>
          </div>
          <div class="metric">
            <span>红包雨</span>
            <strong>{{ player?.redpacket.claimedCount || 0 }}</strong>
            <span class="small">已领取 · ¥{{ fen(player?.redpacket.totalFen) }}</span>
          </div>
          <div class="metric">
            <span>答题</span>
            <strong>{{ player?.quiz.score || 0 }}</strong>
            <span class="small">累计得分</span>
          </div>
          <div class="metric">
            <span>抽奖</span>
            <strong>{{ player?.lottery.won ? 'YES' : '—' }}</strong>
            <span class="small">中奖状态</span>
          </div>
        </div>
        <div class="panel soft pad">
          <p class="eyebrow">HOW TO PLAY</p>
          <p class="muted small" style="line-height: 1.9; margin-bottom: 0">
            摇一摇需要允许手机运动权限；红包雨用手指在屏幕上滑动接取；
            答题时在倒计时结束前选择答案。所有结果以服务端记录为准。
          </p>
        </div>
      </section>

      <footer class="row between small muted" style="margin-top: 18px">
        <span>编号 {{ player?.participant.employeeNo }}</span>
        <span>数据实时同步</span>
      </footer>
    </template>
  </main>
</template>
