<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LiveSnapshot, PlayerSummary } from '@shared/types'
import { emitAck } from '../live'
import { useCountdown } from '../utils'

const props = defineProps<{
  snapshot: LiveSnapshot
  summary: PlayerSummary
}>()

const remaining = useCountdown(() => props.snapshot.quiz.question?.endsAt)
const selected = ref<number | null>(null)
const submitted = ref(false)
const feedback = ref('')
const submitting = ref(false)
const phase = computed(() => props.snapshot.quiz.phase)
const question = computed(() => props.snapshot.quiz.question)
const answer = computed(() => props.summary.quiz.answer)
const distributionTotal = computed(() =>
  (props.snapshot.quiz.distribution || []).reduce((sum, value) => sum + value, 0)
)

watch(
  () => question.value?.id,
  () => {
    selected.value = null
    submitted.value = false
    feedback.value = ''
    if (answer.value && answer.value.questionId === question.value?.id) {
      selected.value = answer.value.optionIndex
      submitted.value = true
    }
  },
  { immediate: true }
)

watch(
  () => answer.value,
  (value) => {
    if (value && value.questionId === question.value?.id) {
      selected.value = value.optionIndex
      submitted.value = true
    }
  },
  { immediate: true }
)

async function choose(index: number) {
  if (phase.value !== 'question' || remaining.value <= 0 || submitted.value || submitting.value) return
  submitting.value = true
  try {
    const result = await emitAck<{
      ok: boolean
      reason?: string
      correct?: boolean
      score?: number
    }>('quiz:answer', { optionIndex: index })
    if (result.ok) {
      selected.value = index
      submitted.value = true
      feedback.value = '已提交，等待大屏揭晓'
    } else if (result.reason === 'duplicate') {
      submitted.value = true
      feedback.value = '本题只能作答一次'
    } else {
      feedback.value = '本题已关闭'
    }
  } catch {
    feedback.value = '网络波动，请重试'
  } finally {
    submitting.value = false
  }
}

function optionClass(index: number) {
  const revealed = phase.value === 'revealed' || phase.value === 'finished'
  if (revealed && question.value?.correctOption === index) return 'correct'
  if (revealed && selected.value === index) return 'wrong'
  return selected.value === index ? 'selected' : ''
}
</script>

<template>
  <section class="panel mobile-panel fade-in">
    <div class="row between">
      <span class="tag teal">QUIZ</span>
      <span v-if="question" class="tag">
        {{ question.index }} / {{ question.total }}
      </span>
    </div>

    <template v-if="question">
      <div class="row between" style="margin-top: 16px">
        <span class="small muted">{{ snapshot.quiz.answeredCount }} 人已作答</span>
        <span class="countdown">
          <strong>{{ remaining }}</strong> 秒
        </span>
      </div>
      <div class="progress" style="margin: 10px 0 18px">
        <span
          :style="{
            width: `${Math.max(0, Math.min(100, (remaining / question.durationSec) * 100))}%`
          }"
        ></span>
      </div>
      <h2 class="page-title" style="font-size: clamp(22px, 6vw, 30px); line-height: 1.35">
        {{ question.text }}
      </h2>
      <div class="option-grid" style="margin-top: 20px">
        <button
          v-for="(option, index) in question.options"
          :key="index"
          class="option-button"
          :class="optionClass(index)"
          :disabled="submitted || phase !== 'question' || remaining <= 0"
          @click="choose(index)"
        >
          <span class="option-letter">{{ ['A', 'B', 'C', 'D'][index] }}</span>{{ option }}
        </button>
      </div>
      <p v-if="feedback" class="small" style="margin: 14px 0 0; color: var(--gold)">
        {{ feedback }}
      </p>
      <template v-if="phase === 'revealed' || phase === 'finished'">
        <div class="divider"></div>
        <p class="eyebrow">ANSWER</p>
        <p style="font-size: 18px; font-weight: 800">
          正确答案：{{ ['A', 'B', 'C', 'D'][question.correctOption || 0] }}.
          {{ question.options[question.correctOption || 0] }}
        </p>
        <div class="grid" style="margin-top: 12px">
          <div v-for="(count, index) in snapshot.quiz.distribution || []" :key="index" class="row">
            <span class="small muted" style="width: 20px">{{ ['A', 'B', 'C', 'D'][index] }}</span>
            <div class="progress" style="flex: 1">
              <span
                :style="{
                  width: `${distributionTotal ? (count / distributionTotal) * 100 : 0}%`,
                  background: index === question.correctOption ? 'var(--green)' : 'var(--teal)'
                }"
              ></span>
            </div>
            <span class="small muted" style="width: 30px; text-align: right">{{ count }}</span>
          </div>
        </div>
      </template>
      <p v-if="phase === 'finished'" class="muted small" style="margin-top: 14px">
        答题已结束，当前总分 {{ summary.quiz.score }}，排名
        {{ summary.quiz.rank ? `#${summary.quiz.rank}` : '--' }}。
      </p>
    </template>
    <template v-else>
      <div style="font-size: 58px; text-align: center; margin: 26px 0">🧠</div>
      <h2 class="page-title" style="text-align: center; font-size: 26px">
        {{ phase === 'finished' ? '本轮答题已结束' : '等待主持台开始答题' }}
      </h2>
      <p v-if="phase === 'finished'" class="muted small" style="text-align: center">
        你的总分 {{ summary.quiz.score }}，排名
        {{ summary.quiz.rank ? `#${summary.quiz.rank}` : '--' }}
      </p>
      <p v-else class="muted small" style="text-align: center">题目会同步显示在手机和大屏上。</p>
    </template>
  </section>
</template>
