// 书库页：书目增删改、扫描图导入、书库级导入导出
import type { Book } from '../../types';
import { library } from '../../services/store';
import { exportBooks, importLibrary } from '../../services/libraryIO';
import { db } from '../../services/idb';
import { clearNode, downloadBlob, formatDate, h } from '../../utils/dom';
import { confirmDialog, emptyText, openModal, thumbUrl, toast } from '../components/common';
import { go, onDispose } from '../router';

export function renderLibrary(root: HTMLElement): void {
  const grid = h('div', { className: 'book-grid' });
  const rerender = () => {
    const books = library.getBooks();
    clearNode(grid);
    if (!books.length) {
      emptyText(grid, '书架空空如也 —— 点击右上角「新建书目」，导入第一组扫描页');
      return;
    }
    for (const book of books) grid.append(buildCard(book));
  };
  const off = library.changed.on(rerender);
  const head = h('div', { className: 'page-head' }, [
    h('h2', {}, ['藏书阁']),
    h('span', { className: 'hint' }, [`共 ${library.getBooks().length} 部`]),
    h('div', { className: 'spacer' }),
    h('button', { className: 'ghost', onclick: () => pickImport() }, ['导入书库']),
    h('button', { className: 'ghost', onclick: () => exportAll() }, ['导出书库']),
    h('button', { className: 'primary', onclick: () => bookEditor(null) }, ['＋ 新建书目']),
  ]);
  root.replaceChildren(head, grid);
  rerender();
  onDispose(root, off);
}

function buildCard(book: Book): HTMLElement {
  const cover = h('div', { className: 'book-cover' }, [
    h('span', { className: 'placeholder' }, [book.title.slice(0, 2) || '古籍']),
  ]);
  if (book.coverImageId) {
    void thumbUrl(async () => (await db.getImage(book.coverImageId!))?.blob, `cover-${book.coverImageId}`).then((url) => {
      if (url) cover.replaceChildren(h('img', { src: url, alt: book.title }));
    });
  }
  const card = h('div', { className: 'book-card' }, [
    cover,
    h('div', { className: 'book-meta' }, [
      h('div', { className: 'book-title', title: book.title }, [book.title]),
      h('div', { className: 'book-sub' }, [book.author || '佚名']),
      h('div', { className: 'book-sub' }, [
        `${book.leafImageIds.length} 叶 · ${formatDate(book.updatedAt)}`,
      ]),
    ]),
    h('div', { className: 'book-actions' }, [
      h('button', {
        className: 'primary',
        onclick: () => go(`reader/${encodeURIComponent(book.id)}`),
      }, ['展卷']),
      h('button', { onclick: () => go(`editor/${encodeURIComponent(book.id)}`) }, ['书页']),
      h('button', { onclick: () => go(`annotations/${encodeURIComponent(book.id)}`) }, ['批注']),
      h('button', { onclick: () => bookEditor(book) }, ['编辑']),
      h('button', {
        className: 'danger',
        onclick: async () => {
          if (await confirmDialog(`确定删除《${book.title}》及其全部扫描图与批注？此操作不可恢复。`)) {
            await library.removeBook(book.id);
            toast('已删除');
          }
        },
      }, ['删除']),
    ]),
  ]);
  return card;
}

/** 新建 / 编辑书目元数据的模态框 */
export function bookEditor(book: Book | null): void {
  const titleInput = h('input', { value: book?.title ?? '', placeholder: '书名，如：论语集注' }) as HTMLInputElement;
  const authorInput = h('input', { value: book?.author ?? '', placeholder: '作者 / 版本' }) as HTMLInputElement;
  const descInput = h('textarea', {
    rows: 4,
    placeholder: '内容提要（可选）',
  }, [book?.description ?? '']) as HTMLTextAreaElement;
  const form = h('div', {}, [
    h('div', { className: 'form-row' }, [h('label', {}, ['书名']), titleInput]),
    h('div', { className: 'form-row' }, [h('label', {}, ['作者 / 版本']), authorInput]),
    h('div', { className: 'form-row' }, [h('label', {}, ['提要']), descInput]),
  ]);
  const modal = openModal(book ? '编辑书目' : '新建书目', form);
  const saveBtn = h('button', {
    className: 'primary',
    onclick: async () => {
      const payload = { title: titleInput.value, author: authorInput.value, description: descInput.value };
      if (book) {
        await library.updateBook(book.id, payload);
        toast('书目已更新');
      } else {
        const created = await library.createBook(payload);
        modal.close();
        toast('书目已建，可前往「书页」导入扫描图');
        go(`editor/${encodeURIComponent(created.id)}`);
        return;
      }
      modal.close();
    },
  }, ['保存']);
  form.append(h('div', { className: 'modal-actions' }, [
    h('button', { onclick: () => modal.close() }, ['取消']),
    saveBtn,
  ]));
  setTimeout(() => titleInput.focus(), 0);
}

async function exportAll(): Promise<void> {
  if (!library.getBooks().length) return toast('书库为空，无可导出内容');
  const blob = await exportBooks();
  downloadBlob(blob, `芸编书库-${new Date().toISOString().slice(0, 10)}.json`);
  toast('书库已导出');
}

function pickImport(): void {
  const input = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onchange: async () => {
      const file = (input as HTMLInputElement).files?.[0];
      input.remove();
      if (!file) return;
      try {
        const n = await importLibrary(file);
        toast(`成功导入 ${n} 部书`);
      } catch (err) {
        toast(`导入失败：${(err as Error).message}`, 3600);
      }
    },
  }) as HTMLInputElement;
  document.body.append(input);
  input.click();
}
