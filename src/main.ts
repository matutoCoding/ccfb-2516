import './ui/styles.css';
import { library } from './services/store';
import { currentPath, runDispose, startRouter, type Route } from './ui/router';
import { renderLibrary } from './ui/pages/library';
import { renderReader } from './ui/pages/reader';
import { renderEditor } from './ui/pages/editor';
import { renderAnnotations } from './ui/pages/annotations';
import { renderSettings } from './ui/pages/settings';
import { h } from './utils/dom';

async function bootstrap(): Promise<void> {
  await library.load();
  startRouter((root, route) => {
    root.classList.add('app-root');
    root.style.height = '100%';
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.append(buildTopbar(route));
    const main = h('div', { className: 'page-host' });
    main.style.flex = '1';
    main.style.minHeight = '0';
    main.style.display = 'flex';
    main.style.flexDirection = 'column';
    root.append(main);
    const cleanup = dispatch(main, route);
    return () => {
      runDispose(main);
      cleanup?.();
    };
  });
}

function buildTopbar(route: Route): HTMLElement {
  const links: Array<[string, string, string]> = [
    ['library', '书库', '#/library'],
    ['settings', '设置', '#/settings'],
  ];
  const nav = h('nav', { className: 'nav' }, [
    ...links.map(([key, label, href]) =>
      h('a', { href, className: route.name === key ? 'active' : '' }, [label]),
    ),
  ]);
  return h('header', { className: 'topbar' }, [
    h('div', { className: 'brand' }, [
      h('span', { className: 'seal' }, ['芸']),
      '芸编 · 古籍阅藏',
    ]),
    nav,
  ]);
}

function dispatch(main: HTMLElement, route: Route): void | (() => void) {
  // 阅读/编辑/批注页占满宿主高度，不需要 .page 的默认内边距
  const fullHeight = route.name === 'reader' || route.name === 'editor' || route.name === 'annotations';
  main.style.overflow = fullHeight ? 'hidden' : 'auto';
  if (!fullHeight) {
    main.classList.add('page');
  } else {
    main.classList.remove('page');
    main.style.padding = '0';
  }
  switch (route.name) {
    case 'library':
      renderLibrary(main);
      break;
    case 'reader':
      return renderReader(main, route.bookId);
    case 'editor':
      renderEditor(main, route.bookId);
      break;
    case 'annotations':
      return renderAnnotations(main, route.bookId);
    case 'settings':
      renderSettings(main);
      break;
  }
}

void currentPath;
bootstrap().catch((err) => {
  const root = document.getElementById('app')!;
  root.innerHTML = `<pre style="color:#f0c9c9;padding:24px;white-space:pre-wrap">启动失败：${String(err?.stack ?? err)}</pre>`;
});
