<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const config = ref({
  eventName: '年会互动现场',
  company: 'YOUR COMPANY',
  participantCount: 0
})

onMounted(async () => {
  try {
    config.value = await api.publicConfig()
  } catch {
    // The API status is shown on the operational pages.
  }
})
</script>

<template>
  <main class="page">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">G</div>
        <div>
          {{ config.company }}
          <small>Gala Live System</small>
        </div>
      </div>
      <span class="tag teal"><span class="live-dot"></span> 云端互动现场</span>
    </header>

    <section class="panel hero-panel">
      <p class="eyebrow">ONE TEAM · ONE NIGHT</p>
      <h1 class="display">{{ config.eventName }}</h1>
      <p class="muted" style="max-width: 650px; font-size: 16px; line-height: 1.8">
        手机摇一摇、红包雨、现场答题与 3D 抽奖，统一入场、统一切换、统一汇总。
        扫码进入，跟着大屏一起玩。
      </p>
      <div class="row wrap" style="margin-top: 28px">
        <router-link class="btn btn-primary" to="/join">手机入场</router-link>
        <router-link class="btn" to="/screen">打开大屏</router-link>
        <router-link class="btn btn-ghost" to="/admin">主持台</router-link>
      </div>
    </section>

    <section class="route-grid" style="margin-top: 18px">
      <router-link class="route-card" to="/join">
        <span class="big-icon">📱</span>
        <strong>扫码入场</strong>
        <span>工号、姓名、部门登记，一次入场贯穿全部玩法。</span>
      </router-link>
      <router-link class="route-card" to="/screen">
        <span class="big-icon">🖥️</span>
        <strong>大屏互动</strong>
        <span>排行榜、答题分布、红包雨和 3D 抽奖实时呈现。</span>
      </router-link>
      <router-link class="route-card" to="/admin">
        <span class="big-icon">🎛️</span>
        <strong>主持控制台</strong>
        <span>导入名单、切换玩法、发奖、兑付与导出结果。</span>
      </router-link>
    </section>

    <p class="muted small" style="margin-top: 18px">
      当前已登记 {{ config.participantCount }} 人 · 现场请保持页面打开
    </p>
  </main>
</template>
