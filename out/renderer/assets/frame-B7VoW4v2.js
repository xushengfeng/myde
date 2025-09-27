let m = (t) => t instanceof h ? t.text : t;
function b(t, e = () => {
}, r = () => {
}) {
  function o(n) {
    return b(n, e, r);
  }
  const a = {
    el: t,
    style: (n) => {
      for (const [i, c] of Object.entries(n))
        if (i.startsWith("--"))
          t.style.setProperty(i, c);
        else {
          const s = i.split("-").map((l, f) => f === 0 ? l : l.slice(0, 1).toUpperCase() + l.slice(1)).join("");
          t.style[s] = c;
        }
      return o(t);
    },
    on: (n, i, c) => (t.addEventListener(n, (s) => i(s, o(t)), c), o(t)),
    class: (...n) => (t.classList.add(
      ...n.filter((i) => typeof i == "string").map((i) => i.trim()).filter((i) => i !== "" && !i.match(/\s/))
    ), o(t)),
    attr: (n) => {
      for (const i in n)
        t[i] = n[i];
      return o(t);
    },
    data: (n) => {
      for (const i in n) {
        const c = i.startsWith("data-") ? i : `data-${i}`;
        n[i] !== null && n[i] !== void 0 ? t.setAttribute(c, n[i]) : t.removeAttribute(c);
      }
      return o(t);
    },
    add: (n, i, c = 1) => {
      const s = n ? Array.isArray(n) ? n : [n] : [], l = s.filter(Boolean).flatMap((u) => typeof u == "string" || u instanceof h ? document.createTextNode(m(u)) : "el" in u && u.el instanceof HTMLElement ? u.el : u instanceof DocumentFragment || u instanceof HTMLElement ? u : []);
      let f = 0;
      function p(u) {
        if (u === 1)
          t.append(l[f]);
        else {
          const g = Math.min(f + u, l.length), y = document.createDocumentFragment();
          y.append(...l.slice(f, g)), t.append(y);
        }
      }
      if (i) {
        let u = function() {
          requestAnimationFrame(() => {
            f < l.length && (p(c), f += c, u());
          });
        };
        p(i), f += i, u();
      } else
        p(s.length);
      return o(t);
    },
    clear: () => (t.innerHTML = "", o(t)),
    remove: () => {
      t.remove();
    },
    addInto: (n = document.body) => (n instanceof HTMLElement ? n.appendChild(t) : n.add(t), o(t)),
    query: (n) => {
      const i = t.querySelector(n);
      return i ? b(i) : null;
    },
    queryAll: (n) => Array.from(t.querySelectorAll(n)).map(
      (i) => b(i)
    ),
    // @ts-ignore
    bindSet: (n) => b(t, n, r),
    // @ts-ignore
    bindGet: (n) => b(t, e, n),
    sv: (n) => (e(n, t, m), o(t)),
    get gv() {
      return r(t);
    },
    // @ts-ignore
    set svc(n) {
      e(n, t, m);
    }
  };
  return a;
}
function d(t) {
  return b(document.createElement(t));
}
class h {
  constructor(e) {
    this.text = e;
  }
}
function v(t = "", e) {
  return d("span").bindSet((r, o) => {
    o.innerText = r instanceof h ? r.text : m(r);
  }).bindGet((r) => r.innerText).sv(t);
}
v("hello").addInto();
