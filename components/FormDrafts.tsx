'use client';

// Nothing anybody types on Guestlist is lost to a refresh.
//
// One component, mounted once in the root layout, keeps a draft of every form
// on the site in this browser's localStorage and puts it back when the page
// comes back — a refresh, a crash, a closed tab, a phone that dropped the page
// to save memory. No form has to opt in, so a form added next month is covered
// the day it ships.
//
// What counts as a form: any <form>, plus any element marked `data-draft` for
// the editors that are built without one (the article editor, announcements).
//
// What it remembers: only the fields somebody actually changed. An edit form
// arrives filled from the server; saving all of it would pin yesterday's
// values over today's. Saving just the touched fields means the draft is
// exactly the work that would otherwise be lost.
//
// What it never keeps: passwords, card numbers and the like, file pickers,
// hidden fields, search boxes and filters, or anything inside `data-no-draft`.
//
// The forms are React-controlled, so a value can't simply be written into the
// DOM — React would put its own state straight back. Setting the value through
// the native setter and firing the event React listens for runs the form's own
// onChange, so its state updates exactly as if the person had typed it.
//
// A draft is dropped when its form is submitted, after a week, or when the
// member signs out (a shared computer shouldn't hand the next person your
// half-written application). If a submit fails the fields are still on
// screen, and the next keystroke saves the lot again.

import { useEffect, useState } from 'react';

const PREFIX = 'gl-draft:';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const SKIP_TYPES = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image', 'search']);
const SENSITIVE = /(password|passcode|card|cvc|cvv|iban|sort.?code|otp|one.?time)/i;
const ROOTS = 'form, [data-draft]';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Draft = { at: number; fields: Record<string, string | boolean> };

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window or full — nothing to do */ }
}
function safeRemove(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function clearAllFormDrafts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

function isField(el: EventTarget | null): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function rootOf(el: Element): HTMLElement | null {
  // The innermost form-ish container. A `data-draft` editor wins over a
  // search form nested inside it, and the other way round.
  const root = el.closest<HTMLElement>(ROOTS);
  if (!root || root.closest('[data-no-draft]')) return null;
  // Search boxes and filters: coming back to an old query isn't a kindness.
  if (root.matches('[role="search"], form[method="get" i]')) return null;
  return root;
}

function skipped(el: Field): boolean {
  if (el.closest('[data-no-draft]')) return true;
  if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) return true;
  if ((el.getAttribute('autocomplete') ?? '').startsWith('cc-')) return true;
  return SENSITIVE.test(`${el.name} ${el.id} ${el.getAttribute('autocomplete') ?? ''}`);
}

// Where a container's draft lives: the page, then the container's id, or its
// position among this page's forms when it has none.
function rootKey(root: HTMLElement): string {
  const ident = root.id || root.getAttribute('data-draft') || String(Array.from(document.querySelectorAll(ROOTS)).indexOf(root));
  return `${PREFIX}${location.pathname}#${ident}`;
}

// A field's name within its container: its id or name, else its position.
// Radio buttons share a name, so their value rides along to tell them apart.
function fieldKey(root: HTMLElement, el: Field): string {
  const base = el.id || el.name || `@${Array.from(root.querySelectorAll('input, textarea, select')).indexOf(el)}`;
  return el instanceof HTMLInputElement && el.type === 'radio' ? `${base}=${el.value}` : base;
}

function readDraft(key: string): Draft | null {
  const raw = safeGet(key);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Draft;
    if (!d.fields || Date.now() - d.at > MAX_AGE) { safeRemove(key); return null; }
    return d;
  } catch { safeRemove(key); return null; }
}

// Write a value the way a person would, so React's onChange runs.
function applyValue(el: Field, value: string | boolean) {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.checked !== value) el.click();
    return;
  }
  if (typeof value !== 'string' || el.value === value) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

export function FormDrafts() {
  const [restored, setRestored] = useState<string[]>([]);

  useEffect(() => {
    // Fields this visit has changed, per container — kept after a submit so
    // the next keystroke after a failed one saves everything again.
    const touched = new WeakMap<HTMLElement, Set<Field>>();
    // Fields already given back, so a field that re-renders isn't fought over.
    const given = new WeakSet<Field>();
    // True while a value is being put back, so that write isn't saved as an edit.
    let applying = false;

    function save(root: HTMLElement) {
      const set = touched.get(root);
      if (!set?.size) return;
      const fields: Draft['fields'] = {};
      for (const el of set) {
        if (!el.isConnected || skipped(el)) continue;
        fields[fieldKey(root, el)] = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
      }
      safeSet(rootKey(root), JSON.stringify({ at: Date.now(), fields }));
    }

    function onEdit(e: Event) {
      if (applying || !isField(e.target) || skipped(e.target)) return;
      const root = rootOf(e.target);
      if (!root) return;
      if (!touched.has(root)) touched.set(root, new Set());
      touched.get(root)!.add(e.target);
      given.add(e.target); // they've touched it; never overwrite it now
      save(root);
    }

    function onSubmit(e: Event) {
      const form = e.target as HTMLFormElement;
      if (/\/api\/auth\/logout/.test(form.getAttribute('action') ?? '')) { clearAllFormDrafts(); return; }
      const root = rootOf(form);
      if (root) safeRemove(rootKey(root));
    }

    // Give each container back whatever it had. Runs again whenever the page
    // changes, because forms appear late — after a fetch, in a step two, on a
    // client-side navigation — and a field that wasn't there a moment ago may
    // be there now.
    // Values go back one at a time, a tick apart. Plenty of forms here write
    // `setV({ ...v, name })`; several values in one tick would each start from
    // the same stale `v`, and only the last would stick.
    const queue: [Field, string | boolean][] = [];
    let draining = false;
    async function drain() {
      if (draining) return;
      draining = true;
      while (queue.length) {
        const [el, value] = queue.shift()!;
        if (el.isConnected) { applying = true; try { applyValue(el, value); } finally { applying = false; } }
        await new Promise((r) => window.setTimeout(r, 0));
      }
      draining = false;
    }

    function restoreAll() {
      const names: string[] = [];
      for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOTS))) {
        if (rootOf(root) !== root) continue;
        const draft = readDraft(rootKey(root));
        if (!draft) continue;
        let any = false;
        root.querySelectorAll<Field>('input, textarea, select').forEach((el) => {
          if (given.has(el) || skipped(el) || rootOf(el) !== root) return;
          const k = fieldKey(root, el);
          if (!(k in draft.fields)) return;
          given.add(el);
          queue.push([el, draft.fields[k]]);
          if (!touched.has(root)) touched.set(root, new Set());
          touched.get(root)!.add(el);
          any = true;
        });
        if (any) names.push(rootKey(root));
      }
      if (names.length) setRestored((r) => Array.from(new Set([...r, ...names])));
      drain();
    }

    let pending = 0;
    const schedule = () => {
      if (pending) return;
      pending = window.setTimeout(() => { pending = 0; restoreAll(); }, 150);
    };
    // Let hydration settle before touching anything React owns.
    const first = window.setTimeout(restoreAll, 300);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(pending);
      observer.disconnect();
      document.removeEventListener('input', onEdit, true);
      document.removeEventListener('change', onEdit, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, []);

  if (!restored.length) return null;
  return (
    <div className="formDraftNote" role="status">
      <span>We kept what you’d typed here.</span>
      <button type="button" onClick={() => { restored.forEach(safeRemove); location.reload(); }}>Start over</button>
      <button type="button" aria-label="Dismiss" onClick={() => setRestored([])}>×</button>
    </div>
  );
}
