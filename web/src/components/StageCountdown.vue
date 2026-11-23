<script setup lang="ts">
import { computed } from 'vue'
import type { StageCountdown } from '@shared/types'
import { formatCountdown, useCountdown } from '../utils'

const props = defineProps<{ countdown: StageCountdown; serverNow: number; eventName: string }>()
const remaining = useCountdown(() => props.countdown.endsAt, () => props.serverNow)
const seconds = computed(() => props.countdown.endsAt ? remaining.value : props.countdown.durationSec)
const finished = computed(() => Boolean(props.countdown.endsAt) && remaining.value === 0)
const finalSeconds = computed(() => Boolean(props.countdown.endsAt) && remaining.value > 0 && remaining.value <= 10)
const progress = computed(() => 100 * Math.min(1, seconds.value / props.countdown.durationSec))
</script>

<template>
  <div class="stage-countdown" :class="{ 'final-seconds': finalSeconds, 'has-finished': finished }">
    <div class="countdown-dial" :style="{ '--countdown-progress': `${progress}%` }" aria-hidden="true">
      <div class="countdown-track"></div>
      <div class="countdown-ticks"></div>
      <div v-if="finished || finalSeconds" :key="seconds" class="countdown-wave"></div>
    </div>
    <div class="countdown-content">
      <p class="eyebrow countdown-event">{{ eventName }}</p>
      <template v-if="finished">
        <h1 class="countdown-finale" role="status">正式开场</h1>
      </template>
      <template v-else>
        <h1 class="countdown-heading">开场倒计时</h1>
        <div :key="seconds" class="countdown-digits" :class="{ 'is-ticking': finalSeconds }" role="timer">
          {{ formatCountdown(seconds) }}
        </div>
        <p v-if="!countdown.endsAt" class="countdown-ready">等待主持台开始</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.stage-countdown {
  --countdown-gold: #ffcf79;
  --dial-size: min(70vh, 82vw, 740px);
  position: relative;
  isolation: isolate;
  display: grid;
  width: 100%;
  min-height: min(74vh, 800px);
  place-items: center;
  text-align: center;
}

.countdown-dial {
  position: absolute;
  z-index: -1;
  display: grid;
  width: var(--dial-size);
  aspect-ratio: 1;
  place-items: center;
  border-radius: 50%;
  background: radial-gradient(circle, #2d0915 15%, rgba(95, 16, 34, 0.82) 54%, transparent 72%);
  pointer-events: none;
}

.countdown-dial::after {
  content: '';
  position: absolute;
  inset: -2%;
  border-radius: inherit;
  background: conic-gradient(transparent 0 46%, rgba(255, 216, 150, 0.66) 61%, transparent 62% 86%, rgba(255, 172, 97, 0.48) 97%, transparent 98%);
  mask-image: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
  animation: countdown-rotate 9s linear infinite reverse;
}

.countdown-track,
.countdown-ticks,
.countdown-wave {
  position: absolute;
  border-radius: 50%;
}

.countdown-track {
  inset: 4%;
  background: conic-gradient(var(--countdown-gold) var(--countdown-progress), rgba(246, 206, 131, 0.16) 0);
  mask-image: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
}

.countdown-ticks {
  inset: 0;
  background: repeating-conic-gradient(from -1deg, rgba(255, 221, 161, 0.5) 0 0.65deg, transparent 0.65deg 6deg);
  mask-image: radial-gradient(farthest-side, transparent calc(100% - 11px), #000 calc(100% - 10px));
  animation: countdown-rotate 36s linear infinite;
}

.countdown-wave {
  inset: 7%;
  border: 2px solid var(--countdown-gold);
  box-shadow: 0 0 32px rgba(255, 168, 89, 0.55), inset 0 0 22px rgba(255, 168, 89, 0.35);
  animation: countdown-wave 900ms ease-out both;
}

.countdown-content {
  position: relative;
  max-width: min(88vw, 760px);
  padding: 20px;
}

.countdown-event {
  margin: 0 0 14px;
  color: #fff0c8;
  font-size: clamp(12px, 1.2vw, 20px);
  letter-spacing: 0.2em;
  text-wrap: balance;
}

.countdown-heading {
  margin: 0 0 6px;
  color: var(--countdown-gold);
  font-size: clamp(16px, 2vw, 32px);
  letter-spacing: 0.18em;
}

.countdown-digits {
  margin: 8px 0;
  color: #fff6d9;
  font-size: clamp(56px, 14vmin, 190px);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.045em;
  line-height: 1;
  text-shadow: 0 0 18px rgba(255, 181, 82, 0.65), 0 8px 35px rgba(21, 2, 8, 0.85);
}

.final-seconds .countdown-digits {
  font-size: clamp(72px, 22vmin, 290px);
}

.is-ticking {
  animation: countdown-hit 560ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.countdown-ready {
  margin: 12px 0 0;
  color: var(--muted);
}

.countdown-finale {
  margin: 10px 0 0;
  color: #fff0b8;
  font-size: clamp(42px, 11vmin, 140px);
  font-weight: 900;
  line-height: 1.12;
  text-shadow: 0 0 26px rgba(255, 188, 89, 0.72), 0 10px 48px #591321;
  animation: countdown-hit 720ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.has-finished .countdown-dial {
  background: radial-gradient(circle, #771b29 6%, rgba(128, 37, 36, 0.9) 48%, transparent 72%);
}

.has-finished .countdown-track {
  background: var(--countdown-gold);
}

.has-finished .countdown-wave {
  animation-duration: 1.35s;
}

@keyframes countdown-rotate {
  to { transform: rotate(1turn); }
}

@keyframes countdown-hit {
  from { transform: scale(0.82); }
  to { transform: scale(1); }
}

@keyframes countdown-wave {
  from { transform: scale(0.82); opacity: 0.88; }
  to { transform: scale(1.24); opacity: 0; }
}
</style>
