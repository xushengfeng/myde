<script setup lang="ts">
import { computed } from 'vue'
import type { ObjInstance } from '../parser'

const props = defineProps<{
  objects: Map<string, ObjInstance[]>
  instances: ObjInstance[]
  selectedUid: number
  objFilter: string
  hideDead: boolean
}>()

const emit = defineEmits<{
  'update:objFilter': [value: string]
  'update:hideDead': [value: boolean]
  'select': [uid: number]
}>()

const filteredObjects = computed(() => {
  let objs: ObjInstance[] = []
  for (const [, insts] of props.objects) {
    objs.push(...insts)
  }
  if (props.hideDead) objs = objs.filter(o => o.alive)
  if (props.objFilter) {
    const q = props.objFilter.toLowerCase()
    objs = objs.filter(o =>
      o.type.toLowerCase().includes(q) || String(o.id).includes(q)
    )
  }
  objs.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    return a.id - b.id
  })
  return objs
})
</script>

<template>
  <div class="obj-panel">
    <div class="toolbar">
      <input
        :value="objFilter"
        @input="emit('update:objFilter', ($event.target as HTMLInputElement).value)"
        @keydown.esc="emit('update:objFilter', '')"
        placeholder="Filter objects..."
      >
      <button
        class="btn"
        :class="{ 'sel-active': hideDead }"
        @click="emit('update:hideDead', !hideDead)"
      >Alive</button>
      <span class="count">{{ filteredObjects.length }}</span>
    </div>
    <div class="obj-list">
      <div
        v-for="obj in filteredObjects"
        :key="obj.uid"
        class="obj-item"
        :class="{ selected: selectedUid === obj.uid }"
        @click="emit('select', obj.uid)"
      >
        <span class="badge" :class="obj.alive ? 'alive' : 'dead'">{{ obj.alive ? 'L' : 'D' }}</span>
        <span class="name">{{ obj.type }}</span>
        <span class="oid">#{{ obj.id }}</span>
        <span class="life">L{{ obj.birthLine + 1 }}<template v-if="obj.deathLine !== null">-{{ obj.deathLine + 1 }}</template></span>
      </div>
    </div>
  </div>
</template>
