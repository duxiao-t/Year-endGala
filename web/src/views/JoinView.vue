<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import type { Participant } from '@shared/types'

const router = useRouter()
const loading = ref(true)
const submitting = ref(false)
const error = ref('')
const pending = ref(false)
const existing = ref<Participant | null>(null)
const config = ref({
  eventName: '年会互动现场',
  company: 'YOUR COMPANY',
  allowSelfRegistration: true,
  joinCodeRequired: true,
  participantCount: 0
})
const form = reactive({
  employeeNo: '',
  name: '',
  department: '',
  joinCode: ''
})

const canSubmit = computed(
  () => form.employeeNo.trim() && form.name.trim() && form.department.trim()
)
const blocked = computed(
  () => Boolean(existing.value && ['excluded', 'absent'].includes(existing.value.status))
)

onMounted(async () => {
  try {
    config.value = await api.publicConfig()
    form.joinCode = new URLSearchParams(window.location.search).get('code') || ''
    try {
      const me = await api.me()
      existing.value = me.participant
      if (me.participant.status === 'active') router.replace('/play')
      else pending.value = true
    } catch {
      // A new visitor stays on the join form.
    }
  } finally {
    loading.value = false
  }
})

async function submit() {
  if (!canSubmit.value || submitting.value) return
  error.value = ''
  submitting.value = true
  try {
    const result = await api.join({
      employeeNo: form.employeeNo,
      name: form.name,
      department: form.department,
      joinCode: form.joinCode
    })
    pending.value = result.pending
    existing.value = result.participant
    if (!result.pending) router.push('/play')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '入场失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="mobile-shell">
    <header class="row between" style="margin-bottom: 18px">
      <div class="brand">
        <div class="brand-mark">G</div>
        <div>
          {{ config.company }}
          <small>Gala Live</small>
        </div>
      </div>
      <router-link class="tag" to="/">首页</router-link>
    </header>

    <section v-if="loading" class="panel mobile-panel">
      <p class="muted">正在连接现场…</p>
    </section>

    <section v-else-if="blocked" class="panel mobile-panel fade-in" style="text-align: center">
      <div style="font-size: 54px; margin: 16px 0">⛔</div>
      <p class="eyebrow">ACCESS DISABLED</p>
      <h1 class="page-title">入场记录已停用</h1>
      <p class="muted" style="line-height: 1.8">
        当前工号已被主持台排除或标记为缺席，请联系现场工作人员处理。
      </p>
    </section>

    <section v-else-if="pending" class="panel mobile-panel fade-in" style="text-align: center">
      <div style="font-size: 54px; margin: 16px 0">🕐</div>
      <p class="eyebrow">WAITING FOR APPROVAL</p>
      <h1 class="page-title">入场审核中</h1>
      <p class="muted" style="line-height: 1.8">
        {{ existing?.name }}（{{ existing?.employeeNo }}），主持台正在确认您的信息。
        审核通过后刷新本页即可进入互动。
      </p>
      <button class="btn" style="margin-top: 18px" @click="router.push('/play')">刷新状态</button>
    </section>

    <section v-else class="panel mobile-panel fade-in">
      <p class="eyebrow">WELCOME TO THE SHOW</p>
      <h1 class="page-title" style="margin: 8px 0 10px">{{ config.eventName }}</h1>
      <p class="muted small" style="line-height: 1.7">
        用同一份信息进入全部互动。工号会作为唯一身份，请勿代填。
      </p>

      <form class="grid" style="margin-top: 24px" @submit.prevent="submit">
        <label class="field">
          <span class="label">工号</span>
          <input v-model="form.employeeNo" class="input" autocomplete="username" placeholder="例如 A10086" />
        </label>
        <label class="field">
          <span class="label">姓名</span>
          <input v-model="form.name" class="input" autocomplete="name" placeholder="请输入真实姓名" />
        </label>
        <label class="field">
          <span class="label">部门</span>
          <input v-model="form.department" class="input" autocomplete="organization" placeholder="例如 产品研发部" />
        </label>
        <label v-if="config.joinCodeRequired" class="field">
          <span class="label">现场入场码</span>
          <input v-model="form.joinCode" class="input" placeholder="看大屏上的 6 位码" />
        </label>

        <div v-if="error" class="tag red" style="border-radius: 12px; padding: 10px 12px">
          {{ error }}
        </div>

        <button class="btn btn-primary" type="submit" :disabled="!canSubmit || submitting">
          {{ submitting ? '正在入场…' : '进入现场' }}
        </button>
      </form>

      <div class="divider"></div>
      <p class="muted small" style="line-height: 1.7">
        已登记 {{ config.participantCount }} 人。如果工号与系统名单不一致，请联系现场工作人员。
      </p>
    </section>
  </main>
</template>
