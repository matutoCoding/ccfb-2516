// 共享 UI：Toast、确认框、模态框、缩略图 URL 管理
import { clearNode, h } from '../../utils/dom';

export function toast(message: string, duration = 2200): void {
  const el = h('div', { className: 'toast' }, [message]);
  document.body.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, duration);
}

export function confirmDialog(message: string, title = '请确认'): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = h('div', { className: 'modal-mask' });
    const ok = h('button', {
      className: 'danger',
      onclick: () => {
        mask.remove();
        resolve(true);
      },
    }, ['确认']);
    const cancel = h('button', {
      onclick: () => {
        mask.replaceChildren();
        mask.remove();
        resolve(false);
      },
    }, ['取消']);
    const modal = h('div', { className: 'modal' }, [
      h('h3', {}, [title]),
      h('p', { style: 'line-height:1.8;color:var(--paper-dim)' }, [message]),
      h('div', { className: 'modal-actions' }, [cancel, ok]),
    ]);
    mask.append(modal);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) {
        mask.remove();
        resolve(false);
      }
    });
    document.body.append(mask);
  });
}

export interface ModalHandle {
  close: () => void;
  body: HTMLElement;
}

export function openModal(title: string, content: HTMLElement): ModalHandle {
  const mask = h('div', { className: 'modal-mask' });
  const modal = h('div', { className: 'modal' }, [h('h3', {}, [title]), content]);
  mask.append(modal);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) handle.close();
  });
  const handle: ModalHandle = {
    body: modal,
    close: () => mask.remove(),
  };
  document.body.append(mask);
  return handle;
}

// ---- 缩略图对象 URL 缓存（避免重复 createObjectURL 泄漏） ----
const urlCache = new Map<string, string>();

export async function thumbUrl(getBlob: () => Promise<Blob | undefined>, key: string): Promise<string | null> {
  const cached = urlCache.get(key);
  if (cached) return cached;
  const blob = await getBlob();
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

export function revokeThumb(key: string): void {
  const url = urlCache.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(key);
  }
}

export function emptyText(parent: HTMLElement, text: string): void {
  clearNode(parent);
  parent.append(h('div', { className: 'empty-tip' }, [text]));
}
