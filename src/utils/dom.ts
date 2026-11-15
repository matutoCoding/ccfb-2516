// 通用小工具

export function uid(): string {
  // crypto.randomUUID 在所有现代浏览器与 Node 22 可用
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 平滑起止缓动（翻页动画） */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function readFileAsBlob(file: File): Promise<Blob> {
  // 直接保留原始 Blob，避免任何重编码导致的画质损失
  return Promise.resolve(file.slice(0, file.size, file.type || 'image/png'));
}

/** DOM 元素构造辅助 */
type ElProps<K extends keyof HTMLElementTagNameMap> = {
  [P in keyof Partial<HTMLElementTagNameMap[K]>]?: P extends 'style'
    ? string | Partial<CSSStyleDeclaration>
    : HTMLElementTagNameMap[K][P];
} & { dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k === 'class') {
      el.className = v as string;
    } else if (k === 'style' && typeof v === 'string') {
      el.setAttribute('style', v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (el as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function clearNode(node: HTMLElement): void {
  node.replaceChildren();
}

/** 简单事件发射器，供 store 使用 */
export class Emitter<T> {
  private listeners = new Set<(payload: T) => void>();
  on(fn: (payload: T) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(payload: T): void {
    for (const fn of this.listeners) fn(payload);
  }
}
