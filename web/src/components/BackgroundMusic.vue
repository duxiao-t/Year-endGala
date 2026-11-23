<script setup lang="ts">
import { onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import type { BackgroundMusicSettings } from '@shared/types'

const props = defineProps<{ music: BackgroundMusicSettings }>()
const audio = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const failed = ref(false)
let pausedLocally = false
let playAttempt = 0

async function playMusic() {
  const element = audio.value
  if (!element) return
  const attempt = ++playAttempt
  if (element.error) element.load()
  failed.value = false
  try {
    await element.play()
  } catch (error) {
    if (attempt !== playAttempt) return
    if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) return
    failed.value = true
  }
}

function toggleMusic() {
  const element = audio.value
  if (!element) return
  if (!playing.value) {
    pausedLocally = false
    void playMusic()
  } else {
    pausedLocally = true
    playAttempt++
    element.pause()
  }
}

watchEffect(() => {
  if (!audio.value) return
  audio.value.volume = props.music.volume / 100
  audio.value.muted = props.music.volume === 0
}, { flush: 'post' })

watch([audio, () => props.music.url], () => {
  if (!pausedLocally) void playMusic()
}, { flush: 'post' })

onBeforeUnmount(() => {
  playAttempt++
  audio.value?.pause()
})
</script>

<template>
  <audio
    ref="audio"
    :src="music.url"
    :loop="music.loop"
    preload="none"
    @playing="playing = true"
    @pause="playing = false"
    @ended="playing = false"
    @error="playing = false; failed = true"
  ></audio>
  <button class="btn btn-sm" type="button" @click="toggleMusic">
    {{ failed ? '音乐加载失败，点击重试' : playing ? '暂停音乐' : '播放音乐' }}
  </button>
</template>
