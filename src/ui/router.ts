// hash 路由：#/library, #/reader/:id, #/editor/:id, #/annotations/:id, #/settings
import { clearNode } from '../utils/dom';

export type Route =
  | { name: 'library' }
  | { name: 'reader'; bookId: string }
  | { name: 'editor'; bookId: string }
  | { name: 'annotations'; bookId: string }
  | { name: 'settings' };

export function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, id] = hash.split('/');
  switch (name) {
    case 'reader':
      return id ? { name: 'reader', bookId: decodeURIComponent(id) } : { name: 'library' };
    case 'editor':
      return id ? { name: 'editor', bookId: decodeURIComponent(id) } : { name: 'library' };
    case 'annotations':
      return id ? { name: 'annotations', bookId: decodeURIComponent(id) } : { name: 'library' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'library' };
  }
}

export function go(path: string): void {
  location.hash = path.startsWith('#') ? path : `#/${path}`;
}

export function currentPath(): string {
  return location.hash.replace(/^#/, '') || '/library';
}

export type PageRenderer = (root: HTMLElement, route: Route) => void | (() => void);

export function startRouter(render: PageRenderer): void {
  const root = document.getElementById('app')!;
  let cleanup: void | (() => void);
  const apply = () => {
    if (typeof cleanup === 'function') cleanup();
    clearNode(root);
    cleanup = render(root, parseHash());
  };
  window.addEventListener('hashchange', apply);
  apply();
}

/** 供页面在内部子宿主上注册销毁回调 */
export function onDispose(host: HTMLElement, fn: () => void): void {
  const slot = host as unknown as { __dispose?: Array<() => void> };
  (slot.__dispose ??= []).push(fn);
}

export function runDispose(host: HTMLElement): void {
  const slot = host as unknown as { __dispose?: Array<() => void> };
  for (const fn of slot.__dispose ?? []) {
    try {
      fn();
    } catch {
      /* 单个清理失败不阻断路由 */
    }
  }
  slot.__dispose = [];
}
