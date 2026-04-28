import { describe, it, expect } from 'vitest'
import { parseLog, escHtml, escAttr } from './parser'

describe('escHtml', () => {
  it('escapes ampersand, lt, gt', () => {
    expect(escHtml('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d')
  })
  it('returns plain text unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world')
  })
})

describe('escAttr', () => {
  it('escapes double and single quotes', () => {
    expect(escAttr(`a"b'c`)).toBe('a&quot;b&#39;c')
  })
})

describe('parseLog', () => {
  const sample = [
    '[ 766788.221] {Default Queue}  -> wl_display#1.get_registry(new id wl_registry#2)',
    '[ 766788.235] {Default Queue}  -> wl_display#1.sync(new id wl_callback#3)',
    '[ 766795.679] {Display Queue} wl_display#1.delete_id(3)',
    '[ 766795.708] {Default Queue} wl_registry#2.global(1, "wl_compositor", 6)',
    '[ 766795.720] {Default Queue}  -> wl_registry#2.bind(1, "wl_compositor", 6, new id [unknown]#4)',
    '[ 766800.287] {Default Queue}  -> zwp_pointer_gestures_v1#10.get_hold_gesture(new id zwp_pointer_gesture_hold_v1#17, wl_pointer#35)',
    '[ 766902.601] {Default Queue}  -> zwp_linux_dmabuf_feedback_v1#5.destroy()',
    '(gtk4-demo:690264): Gtk-WARNING **: 14:16:58.187: No IM module matching GTK_IM_MODULE=fcitx found',
  ].join('\n')

  it('parses all wayland lines', () => {
    const { lines } = parseLog(sample)
    expect(lines).toHaveLength(8)
  })

  it('parses timestamps', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].ts).toBe('766788.221')
    expect(lines[2].ts).toBe('766795.679')
  })

  it('parses queue names', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].queue).toBe('Default Queue')
    expect(lines[2].queue).toBe('Display Queue')
  })

  it('detects request vs event direction', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].isReq).toBe(true)
    expect(lines[2].isReq).toBe(false)
    expect(lines[4].isReq).toBe(true)
  })

  it('parses object type and id', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].objType).toBe('wl_display')
    expect(lines[0].objId).toBe(1)
    expect(lines[4].objType).toBe('wl_registry')
    expect(lines[4].objId).toBe(2)
  })

  it('parses method names', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].method).toBe('get_registry')
    expect(lines[2].method).toBe('delete_id')
    expect(lines[6].method).toBe('destroy')
  })

  it('extracts new ids with uids', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].newUids).toHaveLength(1)
    expect(lines[1].newUids).toHaveLength(1)
    expect(lines[0].newUids[0]).toBeGreaterThanOrEqual(0)
    expect(lines[1].newUids[0]).toBeGreaterThanOrEqual(0)
  })

  it('tracks refUids for all referenced objects', () => {
    const { lines } = parseLog(sample)
    const ref5 = lines[5].refUids
    expect(ref5.size).toBeGreaterThanOrEqual(2)
  })

  it('tracks object creation', () => {
    const { objects } = parseLog(sample)
    expect(objects.has('wl_display')).toBe(true)
    expect(objects.has('wl_registry')).toBe(true)
    expect(objects.has('wl_callback')).toBe(true)
    expect(objects.has('wl_compositor')).toBe(true)
  })

  it('delete_id does NOT kill object (only ID reuse or destroy does)', () => {
    const { instances } = parseLog(sample)
    const cb3 = instances.find(i => i.type === 'wl_callback' && i.id === 3)
    expect(cb3).toBeDefined()
    // delete_id alone does not end lifecycle
    expect(cb3!.alive).toBe(true)
    expect(cb3!.deathLine).toBeNull()
  })

  it('destroy kills object', () => {
    const { instances } = parseLog(sample)
    const fb5 = instances.find(i => i.type === 'zwp_linux_dmabuf_feedback_v1' && i.id === 5)
    expect(fb5).toBeDefined()
    expect(fb5!.alive).toBe(false)
    expect(fb5!.deathLine).toBe(6)
  })

  it('wl_display#1 stays alive', () => {
    const { instances } = parseLog(sample)
    const disp = instances.find(i => i.type === 'wl_display' && i.id === 1)
    expect(disp).toBeDefined()
    expect(disp!.alive).toBe(true)
    expect(disp!.deathLine).toBeNull()
  })

  it('parses non-wayland lines', () => {
    const { lines } = parseLog(sample)
    const nonWl = lines[7]
    expect(nonWl.objType).toBe('')
    expect(nonWl.objId).toBe(-1)
    expect(nonWl.isReq).toBe(false)
    expect(nonWl.html).toContain('non-wl')
  })

  it('handles empty input', () => {
    const { lines, objects, instances } = parseLog('')
    expect(lines).toHaveLength(0)
    expect(objects.size).toBe(0)
    expect(instances).toHaveLength(0)
  })

  it('handles ID reuse: new id with same number kills old instance', () => {
    const log = [
      '[ 100.000] {Default Queue}  -> wl_display#1.get_registry(new id wl_registry#2)',
      '[ 100.001] {Default Queue}  -> wl_display#1.sync(new id wl_callback#3)',
      '[ 100.002] {Display Queue} wl_display#1.delete_id(3)',
      '[ 100.003] {Default Queue}  -> wl_registry#2.bind(1, "wl_seat", 10, new id [unknown]#3)',
    ].join('\n')

    const { instances } = parseLog(log)
    const cb3 = instances.filter(i => i.type === 'wl_callback' && i.id === 3)
    const seat3 = instances.filter(i => i.type === 'wl_seat' && i.id === 3)
    expect(cb3).toHaveLength(1)
    // killed by ID reuse (new id #3), not by delete_id
    expect(cb3[0].alive).toBe(false)
    expect(cb3[0].deathLine).toBe(3)
    expect(seat3).toHaveLength(1)
    expect(seat3[0].alive).toBe(true)
    expect(cb3[0].uid).not.toBe(seat3[0].uid)
  })

  it('ID reuse without delete_id also kills old instance', () => {
    const log = [
      '[ 100.000] {Default Queue}  -> wl_display#1.get_registry(new id wl_registry#2)',
      '[ 100.001] {Default Queue}  -> wl_display#1.sync(new id wl_callback#3)',
      '[ 100.002] {Default Queue}  -> wl_registry#2.bind(1, "wl_seat", 10, new id [unknown]#3)',
    ].join('\n')

    const { instances } = parseLog(log)
    const cb3 = instances.filter(i => i.type === 'wl_callback' && i.id === 3)
    const seat3 = instances.filter(i => i.type === 'wl_seat' && i.id === 3)
    expect(cb3).toHaveLength(1)
    expect(cb3[0].alive).toBe(false)
    expect(cb3[0].deathLine).toBe(2)
    expect(seat3).toHaveLength(1)
    expect(seat3[0].alive).toBe(true)
  })

  it('handles lines without queue name', () => {
    const log = '[ 767011.584]  -> wl_surface#46.frame(new id wl_callback#105)'
    const { lines, instances } = parseLog(log)
    expect(lines).toHaveLength(1)
    expect(lines[0].objType).toBe('wl_surface')
    expect(lines[0].objId).toBe(46)
    expect(lines[0].method).toBe('frame')
    expect(lines[0].queue).toBe('')
    expect(lines[0].isReq).toBe(true)
    const cb = instances.find(i => i.type === 'wl_callback' && i.id === 105)
    expect(cb).toBeDefined()
  })

  it('new id with same type and ID creates new instance (kills old)', () => {
    const log = [
      '[ 100.000] {Default Queue}  -> wl_display#1.sync(new id wl_callback#3)',
      '[ 100.001] {Default Queue} wl_callback#3.done(100)',
      '[ 100.002] {Default Queue}  -> wl_display#1.sync(new id wl_callback#3)',
      '[ 100.003] {Default Queue} wl_callback#3.done(200)',
    ].join('\n')

    const { instances } = parseLog(log)
    const all3 = instances.filter(i => i.type === 'wl_callback' && i.id === 3)
    expect(all3).toHaveLength(2)
    // First instance killed at line 2 (new id reuses same ID)
    expect(all3[0].alive).toBe(false)
    expect(all3[0].deathLine).toBe(2)
    // Second instance still alive
    expect(all3[1].alive).toBe(true)
    expect(all3[1].birthLine).toBe(2)
    expect(all3[0].uid).not.toBe(all3[1].uid)
  })

  it('resolves [unknown] type from registry bind args', () => {
    const log = '[ 100.000] {Default Queue}  -> wl_registry#2.bind(1, "wl_compositor", 6, new id [unknown]#4)'
    const { lines, instances } = parseLog(log)
    const inst = instances[lines[0].newUids[0]]
    expect(inst.type).toBe('wl_compositor')
    expect(inst.id).toBe(4)
    expect(lines[0].html).toContain('wl_compositor')
    expect(lines[0].html).not.toContain('[unknown]')
  })

  it('HTML contains data-uid and obj-type/obj-id spans', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].html).toContain('data-uid="')
    expect(lines[0].html).toContain('class="obj"')
    expect(lines[0].html).toContain('class="obj-type"')
    expect(lines[0].html).toContain('class="obj-id"')
  })

  it('HTML contains kw-new for new id', () => {
    const { lines } = parseLog(sample)
    expect(lines[0].html).toContain('kw-new')
  })

  it('HTML contains kw-destroy for destroy', () => {
    const { lines } = parseLog(sample)
    expect(lines[6].html).toContain('kw-destroy')
  })

  it('HTML contains kw-delete for delete_id', () => {
    const { lines } = parseLog(sample)
    expect(lines[2].html).toContain('kw-delete')
  })

  it('detects discarded flag', () => {
    const log = '[ 100.000] {Default Queue} discarded xdg_toplevel_icon_manager_v1#22.icon_size(96)'
    const { lines } = parseLog(log)
    expect(lines[0].discarded).toBe(true)
    expect(lines[0].html).toContain('kw-discarded')
  })

  it('new id uid matches the created instance', () => {
    const log = '[ 100.000] {Default Queue}  -> wl_display#1.get_registry(new id wl_registry#2)'
    const { lines, instances } = parseLog(log)
    const newUid = lines[0].newUids[0]
    const inst = instances[newUid]
    expect(inst).toBeDefined()
    expect(inst.type).toBe('wl_registry')
    expect(inst.id).toBe(2)
  })

  it('target uid matches the created instance', () => {
    const log = '[ 100.000] {Default Queue}  -> wl_display#1.get_registry(new id wl_registry#2)'
    const { lines, instances } = parseLog(log)
    const inst = instances[lines[0].targetUid]
    expect(inst).toBeDefined()
    expect(inst.type).toBe('wl_display')
    expect(inst.id).toBe(1)
  })

  it('arg obj#17 refs get data-uid matching the new id uid', () => {
    const log = '[ 100.000] {Default Queue}  -> zwp_pointer_gestures_v1#10.get_hold_gesture(new id zwp_pointer_gesture_hold_v1#17, wl_pointer#35)'
    const { lines } = parseLog(log)
    expect(lines[0].html).toContain(`data-uid="${lines[0].newUids[0]}"`)
  })

  it('tracks parentUid: new id parent is the target object', () => {
    const log = [
      '[ 100.000] {Default Queue}  -> wl_display#1.get_registry(new id wl_registry#2)',
      '[ 100.001] {Default Queue}  -> wl_registry#2.bind(1, "wl_compositor", 6, new id [unknown]#4)',
    ].join('\n')
    const { instances } = parseLog(log)
    const reg = instances.find(i => i.type === 'wl_registry' && i.id === 2)!
    const comp = instances.find(i => i.type === 'wl_compositor' && i.id === 4)!
    const parentOfReg = instances[reg.parentUid]
    expect(parentOfReg.type).toBe('wl_display')
    expect(parentOfReg.id).toBe(1)
    expect(comp.parentUid).toBe(reg.uid)
  })

  it('delete_id arg has clickable data-uid', () => {
    const log = [
      '[ 100.000] {Default Queue}  -> wl_display#1.sync(new id wl_callback#3)',
      '[ 100.001] {Display Queue} wl_display#1.delete_id(3)',
    ].join('\n')
    const { lines, instances } = parseLog(log)
    const cb3 = instances.find(i => i.type === 'wl_callback' && i.id === 3)!
    expect(lines[1].html).toContain(`data-uid="${cb3.uid}"`)
    expect(lines[1].refUids).toContain(cb3.uid)
  })
})
