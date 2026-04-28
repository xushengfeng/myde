<script setup lang="ts">
import { ref, computed } from 'vue'
import { parseLog, type ParsedLine, type ObjInstance } from './parser'
import LogViewer from './components/LogViewer.vue'
import ObjectPanel from './components/ObjectPanel.vue'
import DetailPanel from './components/DetailPanel.vue'

const parsedLines = ref<ParsedLine[]>([])
const objects = ref<Map<string, ObjInstance[]>>(new Map())
const instances = ref<ObjInstance[]>([])
const selectedUid = ref<number>(-1)
const highlightLine = ref<number>(-1)
const showInput = ref(false)
const showObjPanel = ref(false)
const inputText = ref('')
const logFilter = ref('')
const objFilter = ref('')
const onlySelected = ref(false)
const hideDead = ref(false)

const totalInstances = computed(() => instances.value.length)

function doParse(text: string) {
  const result = parseLog(text)
  parsedLines.value = result.lines
  objects.value = result.objects
  instances.value = result.instances
  selectedUid.value = -1
  highlightLine.value = -1
}

function parseInput() {
  if (inputText.value.trim()) {
    doParse(inputText.value)
    showInput.value = false
    inputText.value = ''
  }
}

function loadFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => doParse(ev.target?.result as string)
  reader.readAsText(file)
  input.value = ''
}

function loadSample() {
  fetch('log.txt')
    .then(r => r.text())
    .then(doParse)
    .catch(() => alert('Could not load log.txt'))
}

function selectObj(uid: number) {
  if (selectedUid.value === uid) {
    selectedUid.value = -1
    return
  }
  selectedUid.value = uid
  const inst = instances.value[uid]
  if (inst) {
    highlightLine.value = inst.birthLine
  }
}

function clearSelection() {
  selectedUid.value = -1
  onlySelected.value = false
}

function jumpToLine(idx: number) {
  highlightLine.value = idx
}

function selectObjFromPopup(uid: number) {
  selectObj(uid)
  showObjPanel.value = false
}
</script>

<template>
  <div class="top-bar">
    <h1>Wayland Log Viewer</h1>
    <div class="sep"></div>
    <label @click="showInput = true">Paste Log</label>
    <label>Load File<input type="file" @change="loadFile" accept=".txt,.log"></label>
    <div class="sep"></div>
    <label @click="loadSample">Load Sample</label>
    <div class="sep"></div>
    <label @click="showObjPanel = !showObjPanel">Objects</label>
    <div class="stats" v-if="parsedLines.length">
      {{ parsedLines.length }} lines &middot; {{ objects.size }} types &middot; {{ totalInstances }} instances
    </div>
  </div>

  <div class="main-area">
    <LogViewer
      :lines="parsedLines"
      :instances="instances"
      :selectedUid="selectedUid"
      :highlightLine="highlightLine"
      :logFilter="logFilter"
      :onlySelected="onlySelected"
      @update:highlightLine="highlightLine = $event"
      @update:logFilter="logFilter = $event"
      @update:onlySelected="onlySelected = $event"
      @obj-click="selectObj"
      @clear-selection="clearSelection"
    />
    <DetailPanel
      :instances="instances"
      :lines="parsedLines"
      :selectedUid="selectedUid"
      :highlightLine="highlightLine"
      @jump-to="jumpToLine"
      @obj-click="selectObj"
    />
  </div>

  <!-- Object panel popup -->
  <div class="obj-popup-overlay" v-if="showObjPanel" @click.self="showObjPanel = false">
    <ObjectPanel
      :objects="objects"
      :instances="instances"
      :selectedUid="selectedUid"
      :objFilter="objFilter"
      :hideDead="hideDead"
      @update:objFilter="objFilter = $event"
      @update:hideDead="hideDead = $event"
      @select="selectObjFromPopup"
    />
  </div>

  <div class="input-overlay" v-if="showInput" @click.self="showInput = false">
    <div class="input-box">
      <h2>Paste Wayland Debug Log</h2>
      <textarea v-model="inputText" placeholder="Paste WAYLAND_DEBUG=1 output here..."></textarea>
      <div class="actions">
        <button @click="parseInput">Parse</button>
        <button class="secondary" @click="showInput = false">Cancel</button>
      </div>
    </div>
  </div>
</template>
