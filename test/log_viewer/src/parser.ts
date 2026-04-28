// Wayland debug log parser with object lifecycle tracking

export interface ObjInstance {
  uid: number
  type: string
  id: number
  birthLine: number
  deathLine: number | null
  alive: boolean
  parentUid: number
}

export interface NewIdInfo {
  type: string
  id: number
  uid: number
  start: number
  end: number
}

export interface ArgRefInfo {
  type: string
  id: number
  uid: number
  start: number
  end: number
}

export interface ParsedLine {
  idx: number
  raw: string
  ts: string
  queue: string
  objType: string
  objId: number
  method: string
  args: string
  isReq: boolean
  html: string
  discarded: boolean
  targetUid: number
  refUids: Set<number>
  newUids: number[]
}

export interface ParseResult {
  lines: ParsedLine[]
  objects: Map<string, ObjInstance[]>
  instances: ObjInstance[]
}

const WL_LINE_RE = /^\[\s*([\d.]+)\]\s*(?:\{([^}]*)\}\s*)?(discarded\s+)?(->)?\s*(\S+#\d+)\.(\w+)\((.*)\)\s*$/;
const NON_WL_RE = /^(\([^)]+\)\s*:\s*.+)$/;

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface Token {
  pos: number
  end: number
  uid: number
  cls: string
  displayText?: string
}

export function parseLog(text: string): ParseResult {
  const rawLines = text.split('\n');
  const lines: ParsedLine[] = [];
  const objects = new Map<string, ObjInstance[]>();
  const instances: ObjInstance[] = [];
  const active = new Map<number, number>(); // numericId -> uid

  function ensureInst(type: string, id: number, lineIdx: number, parentUid: number, forceNew = false): ObjInstance {
    const cur = active.get(id);
    if (cur !== undefined) {
      const inst = instances[cur];
      if (inst && inst.alive) {
        // Same type, alive, and NOT a forced new creation → reuse existing
        if (inst.type === type && !forceNew) return inst;
        // Different type or forced new → kill old instance (ID reuse)
        inst.alive = false;
        inst.deathLine = lineIdx;
      }
    }
    const puid = instances.length;
    const inst: ObjInstance = { uid: puid, type, id, birthLine: lineIdx, deathLine: null, alive: true, parentUid };
    instances.push(inst);
    active.set(id, puid);
    if (!objects.has(type)) objects.set(type, []);
    objects.get(type)!.push(inst);
    return inst;
  }

  function killInst(id: number, lineIdx: number): void {
    const uid = active.get(id);
    if (uid === undefined) return;
    const inst = instances[uid];
    if (inst && inst.alive) {
      inst.alive = false;
      inst.deathLine = lineIdx;
    }
  }

  function uidForId(id: number): number {
    const u = active.get(id);
    return u !== undefined ? u : -1;
  }

  function resolveUnknownType(method: string, args: string): string | null {
    if (method === 'bind') {
      const m = args.match(/,\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw.trim()) continue;

    const m = raw.match(WL_LINE_RE);
    if (m) {
      const [, ts, queueRaw, discardedStr, arrow, objRef, method, args] = m;
      const queue = queueRaw ?? '';
      const isReq = arrow === '->';
      const dotPos = objRef.indexOf('#');
      const objType = objRef.substring(0, dotPos);
      const objId = parseInt(objRef.substring(dotPos + 1));
      const discarded = !!discardedStr;

      const targetInst = ensureInst(objType, objId, i, -1);

      const newIds: NewIdInfo[] = [];
      const nmRe = /new id (\[?[^\]#\s]+\]?)#(\d+)/g;
      let nm: RegExpExecArray | null;
      while ((nm = nmRe.exec(args)) !== null) {
        let nType = nm[1];
        if (nType === '[unknown]') {
          const resolved = resolveUnknownType(method, args);
          if (resolved) nType = resolved;
        }
        const nInst = ensureInst(nType, parseInt(nm[2]), i, targetInst.uid, true);
        newIds.push({ type: nType, id: parseInt(nm[2]), uid: nInst.uid, start: nm.index, end: nm.index + nm[0].length });
      }

      const argRefs: ArgRefInfo[] = [];
      const refRe = /(\w+)#(\d+)/g;
      let rm: RegExpExecArray | null;
      while ((rm = refRe.exec(args)) !== null) {
        if (newIds.some(n => rm!.index >= n.start && rm!.index < n.end)) continue;
        const rId = parseInt(rm[2]);
        argRefs.push({ type: rm[1], id: rId, uid: uidForId(rId), start: rm.index, end: rm.index + rm[0].length });
      }

      let deleteIdUid = -1;
      if (method === 'delete_id') {
        const delId = parseInt(args);
        if (!isNaN(delId)) {
          deleteIdUid = uidForId(delId);
          // delete_id is a destructor signal, NOT a lifecycle end.
          // Object lifecycle ends only when ID is reused or destroy() is called.
        }
      }

      if (method === 'destroy') killInst(objId, i);

      const html = buildLineHtml({ objType, objId, targetUid: targetInst.uid, method, args, newIds, argRefs, discarded, deleteIdUid });

      const refUids = new Set<number>([targetInst.uid]);
      for (const n of newIds) refUids.add(n.uid);
      for (const r of argRefs) if (r.uid >= 0) refUids.add(r.uid);
      if (deleteIdUid >= 0) refUids.add(deleteIdUid);

      lines.push({
        idx: i, raw, ts, queue, objType, objId, method, args,
        isReq, html, discarded,
        targetUid: targetInst.uid, refUids, newUids: newIds.map(n => n.uid),
      });
    } else {
      const nm = raw.match(NON_WL_RE);
      if (nm) {
        lines.push({
          idx: i, raw, ts: '', queue: '', objType: '', objId: -1,
          method: '', args: '', isReq: false,
          html: `<span class="non-wl">${escHtml(raw)}</span>`,
          discarded: false, targetUid: -1, refUids: new Set(), newUids: [],
        });
      }
    }
  }

  return { lines, objects, instances };
}

function buildLineHtml(opts: {
  objType: string; objId: number; targetUid: number;
  method: string; args: string;
  newIds: NewIdInfo[]; argRefs: ArgRefInfo[];
  discarded: boolean; deleteIdUid: number;
}): string {
  const { objType, objId, targetUid, method, args, newIds, argRefs, discarded, deleteIdUid } = opts;
  let h = '';
  if (discarded) h += `<span class="kw-discarded">discarded </span>`;

  h += `<span class="obj" data-uid="${targetUid}">`;
  h += `<span class="obj-type">${escHtml(objType)}</span>`;
  h += `<span class="obj-id">#${objId}</span>`;
  h += `</span>.`;

  if (method === 'destroy') {
    h += `<span class="kw-destroy">destroy</span>`;
  } else if (method === 'delete_id') {
    h += `<span class="kw-delete">delete_id</span>`;
  } else {
    h += `<span class="method">${escHtml(method)}</span>`;
  }
  h += `(`;

  const tokens: Token[] = [];
  for (const n of newIds) tokens.push({ pos: n.start, end: n.end, uid: n.uid, cls: 'kw-new', displayText: `new id ${n.type}#${n.id}` });
  for (const r of argRefs) tokens.push({ pos: r.start, end: r.end, uid: r.uid, cls: 'obj' });
  if (method === 'delete_id' && deleteIdUid >= 0) {
    const numMatch = args.match(/^\s*(\d+)\s*$/);
    if (numMatch && numMatch.index !== undefined) {
      tokens.push({ pos: numMatch.index, end: numMatch.index + numMatch[0].length, uid: deleteIdUid, cls: 'obj' });
    }
  }
  tokens.sort((a, b) => a.pos - b.pos);

  let cursor = 0;
  for (const tok of tokens) {
    if (tok.pos > cursor) h += highlightGaps(args.substring(cursor, tok.pos));
    const txt = tok.displayText ?? args.substring(tok.pos, tok.end);
    // If this is an obj ref inside args, also split type/id
    if (tok.cls === 'obj' && !tok.displayText) {
      const sharpPos = txt.indexOf('#');
      if (sharpPos >= 0) {
        h += `<span class="obj" data-uid="${tok.uid}">`;
        h += `<span class="obj-type">${escHtml(txt.substring(0, sharpPos))}</span>`;
        h += `<span class="obj-id">${escHtml(txt.substring(sharpPos))}</span>`;
        h += `</span>`;
      } else {
        h += `<span class="obj" data-uid="${tok.uid}">${escHtml(txt)}</span>`;
      }
    } else {
      h += `<span class="${tok.cls}" data-uid="${tok.uid}">${escHtml(txt)}</span>`;
    }
    cursor = tok.end;
  }
  if (cursor < args.length) h += highlightGaps(args.substring(cursor));

  h += `)`;
  return h;
}

function highlightGaps(s: string): string {
  return s.replace(
    /("(?:[^"\\]|\\.)*")|(\b\d+\b)|(array\[\d+\])|(fd \d+)/g,
    (m, str: string | undefined, num: string | undefined, arr: string | undefined, fd: string | undefined) => {
      if (str) return `<span class="str">${escHtml(str)}</span>`;
      if (num) return `<span class="num">${escHtml(num)}</span>`;
      if (arr) return `<span class="kw-array">${escHtml(arr)}</span>`;
      if (fd) return `<span class="kw-fd">${escHtml(fd)}</span>`;
      return escHtml(m);
    }
  );
}
