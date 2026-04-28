<script setup lang="ts">
import { computed } from 'vue'
import type { ParsedLine, ObjInstance } from '../parser'

const props = defineProps<{
  instances: ObjInstance[]
  lines: ParsedLine[]
  selectedUid: number
  highlightLine: number
}>()

const emit = defineEmits<{
  'jump-to': [idx: number]
  'obj-click': [uid: number]
}>()

const inst = computed<ObjInstance | null>(() => {
  if (props.selectedUid < 0) return null
  return props.instances[props.selectedUid] ?? null
})

const relatedLines = computed<ParsedLine[]>(() => {
  if (!inst.value) return []
  const uid = inst.value.uid
  return props.lines.filter(l => l.refUids.has(uid))
})

const creationChain = computed<ObjInstance[]>(() => {
  if (!inst.value) return []
  const chain: ObjInstance[] = []
  let cur: ObjInstance | null = inst.value
  const visited = new Set<number>()
  while (cur && !visited.has(cur.uid)) {
    visited.add(cur.uid)
    chain.unshift(cur)
    cur = cur.parentUid >= 0 ? props.instances[cur.parentUid] : null
  }
  return chain
})

const children = computed<ObjInstance[]>(() => {
  if (!inst.value) return []
  const uid = inst.value.uid
  return props.instances.filter(i => i.parentUid === uid)
})

function lineSummary(line: ParsedLine): string {
  let s = `${line.objType}#${line.objId}.${line.method}`
  if (line.args) {
    const a = line.args.length > 60 ? line.args.substring(0, 57) + '...' : line.args
    s += `(${a})`
  }
  return s
}

function highlightObj(text: string, target: ObjInstance): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const pattern = new RegExp(`(${escapeRegex(target.type)}#${target.id})`, 'g')
  return esc.replace(pattern, '<span class="hl-obj">$1</span>')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
</script>

<template>
  <div class="detail-panel" v-if="inst">
    <div class="detail-header">
      <div class="obj-title">{{ inst.type }}#{{ inst.id }}</div>
      <div class="obj-meta">
        <span class="badge" :class="inst.alive ? 'alive' : 'dead'">{{ inst.alive ? 'ALIVE' : 'DEAD' }}</span>
        <span>uid: {{ inst.uid }}</span>
        <span>born: L{{ inst.birthLine + 1 }}</span>
        <span v-if="inst.deathLine !== null">died: L{{ inst.deathLine + 1 }}</span>
      </div>
    </div>

    <div class="detail-section-title">Creation Chain</div>
    <div class="creation-tree">
      <div
        v-for="(node, idx) in creationChain"
        :key="node.uid"
        class="tree-node"
        :class="{ current: node.uid === inst.uid }"
        :style="{ paddingLeft: (idx * 16 + 8) + 'px' }"
        @click="emit('obj-click', node.uid)"
      >
        <span class="tree-branch" v-if="idx > 0">└─ </span>
        <span class="tree-type">{{ node.type }}</span>
        <span class="tree-id">#{{ node.id }}</span>
        <span class="tree-badge" :class="node.alive ? 'alive' : 'dead'">{{ node.alive ? 'L' : 'D' }}</span>
      </div>
    </div>

    <div class="detail-section-title" v-if="children.length">Children ({{ children.length }})</div>
    <div class="children-list" v-if="children.length">
      <div
        v-for="child in children"
        :key="child.uid"
        class="tree-node"
        @click="emit('obj-click', child.uid)"
      >
        <span class="tree-branch">└─ </span>
        <span class="tree-type">{{ child.type }}</span>
        <span class="tree-id">#{{ child.id }}</span>
        <span class="tree-badge" :class="child.alive ? 'alive' : 'dead'">{{ child.alive ? 'L' : 'D' }}</span>
      </div>
    </div>

    <div class="detail-section-title">Related Lines ({{ relatedLines.length }})</div>
    <div class="detail-lines">
      <div
        v-for="line in relatedLines"
        :key="line.idx"
        class="detail-line"
        :class="{ current: line.idx === highlightLine }"
        @click="emit('jump-to', line.idx)"
      >
        <span class="dl-idx">{{ line.idx + 1 }}</span>
        <span class="dl-ts">{{ line.ts }}</span>
        <span class="dl-arrow" :class="line.isReq ? 'req' : 'evt'">{{ line.isReq ? '→' : '◁' }}</span>
        <span class="dl-method" v-html="highlightObj(lineSummary(line), inst!)"></span>
      </div>
    </div>
  </div>
  <div class="detail-panel" v-else>
    <div class="detail-empty">Select an object to view its lifecycle</div>
  </div>
</template>
