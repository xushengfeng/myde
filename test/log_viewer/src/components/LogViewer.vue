<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue'
import type { ParsedLine, ObjInstance } from '../parser'

const props = defineProps<{
  lines: ParsedLine[]
  instances: ObjInstance[]
  selectedUid: number
  highlightLine: number
  logFilter: string
  onlySelected: boolean
}>()

const emit = defineEmits<{
  'update:highlightLine': [value: number]
  'update:logFilter': [value: string]
  'update:onlySelected': [value: boolean]
  'obj-click': [uid: number]
  'clear-selection': []
}>()

const logListEl = ref<HTMLElement | null>(null)
let prevSelEls: Element[] = []

const filteredLines = computed<ParsedLine[]>(() => {
  let ls = props.lines
  if (props.onlySelected && props.selectedUid >= 0) {
    const inst = props.instances[props.selectedUid]
    if (inst) {
      ls = ls.filter(l =>
        l.refUids.has(inst.uid) &&
        l.idx >= inst.birthLine &&
        (inst.deathLine === null || l.idx <= inst.deathLine)
      )
    }
  }
  if (props.logFilter) {
    try {
      const re = new RegExp(props.logFilter, 'i')
      ls = ls.filter(l => re.test(l.raw))
    } catch {
      const q = props.logFilter.toLowerCase()
      ls = ls.filter(l => l.raw.toLowerCase().includes(q))
    }
  }
  return ls
})

const relatedUids = computed<Set<number>>(() => {
  if (props.selectedUid < 0) return new Set()
  const inst = props.instances[props.selectedUid]
  if (!inst) return new Set()
  const s = new Set<number>()
  for (const l of props.lines) {
    if (l.refUids.has(inst.uid)) s.add(l.idx)
  }
  return s
})

watch(() => props.highlightLine, (newIdx: number) => {
  if (newIdx < 0 || !logListEl.value) return
  nextTick(() => {
    const el = logListEl.value!.querySelector(`.log-line[data-idx="${newIdx}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
})

function applySelHighlight(uid: number) {
  for (const el of prevSelEls) el.classList.remove('sel')
  prevSelEls = []
  if (uid < 0 || !logListEl.value) return
  const els = logListEl.value.querySelectorAll(`[data-uid="${uid}"]`)
  for (const el of els) {
    el.classList.add('sel')
    prevSelEls.push(el)
  }
}

watch(() => props.selectedUid, (u: number) => {
  nextTick(() => applySelHighlight(u))
}, { immediate: true })

watch(filteredLines, () => {
  nextTick(() => applySelHighlight(props.selectedUid))
})

function onLogClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const el = target.closest<HTMLElement>('[data-uid]')
  if (el) {
    const uid = parseInt(el.dataset.uid ?? '-1')
    if (uid >= 0) emit('obj-click', uid)
    return
  }
  const lineEl = target.closest<HTMLElement>('.log-line')
  if (lineEl) {
    const idx = parseInt(lineEl.dataset.idx ?? '-1')
    if (!isNaN(idx)) emit('update:highlightLine', idx)
  }
}
</script>

<template>
  <div class="log-panel">
    <div class="toolbar">
      <input
        :value="logFilter"
        @input="emit('update:logFilter', ($event.target as HTMLInputElement).value)"
        @keydown.esc="emit('update:logFilter', '')"
        placeholder="Filter log lines... (regex)"
      >
      <button
        class="btn"
        :class="{ active: onlySelected }"
        @click="emit('update:onlySelected', !onlySelected)"
      >{{ onlySelected ? 'Show All' : 'Selected Only' }}</button>
      <button class="btn" v-if="selectedUid >= 0" @click="emit('clear-selection')">Clear</button>
    </div>
    <div class="log-list" ref="logListEl" v-if="lines.length" @click="onLogClick">
      <div
        v-for="line in filteredLines"
        :key="line.idx"
        class="log-line"
        :class="{ hl: line.idx === highlightLine, related: relatedUids.has(line.idx) }"
        :data-idx="line.idx"
      >
        <span class="ln">{{ line.idx + 1 }}</span>
        <span class="ts">{{ line.ts }}</span>
        <span class="queue" :title="line.queue">{{ line.queue }}</span>
        <span class="arrow" :class="line.isReq ? 'req' : 'evt'">{{ line.isReq ? '→' : '◁' }}</span>
        <span class="content" v-html="line.html"></span>
      </div>
    </div>
    <div class="log-empty" v-else>Paste a Wayland debug log or load a file to begin</div>
  </div>
</template>
