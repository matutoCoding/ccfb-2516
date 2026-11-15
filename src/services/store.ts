// 应用状态：书目仓库（IndexedDB）+ 阅读设置（localStorage），变化时通知视图
import { DEFAULT_SETTINGS, type Annotation, type Book, type PageImage, type ReaderSettings } from '../types';
import { Emitter, uid } from '../utils/dom';
import { db } from './idb';

const SETTINGS_KEY = 'yunbian-settings';

class LibraryStore {
  readonly changed = new Emitter<void>();
  private books: Book[] = [];
  private annotations: Annotation[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.books = (await db.allBooks()).sort((a, b) => b.updatedAt - a.updatedAt);
    this.annotations = await db.allAnnotations();
    this.loaded = true;
  }

  getBooks(): Book[] {
    return this.books;
  }

  getBook(id: string): Book | undefined {
    return this.books.find((b) => b.id === id);
  }

  private touch(book: Book) {
    book.updatedAt = Date.now();
  }

  async createBook(input: { title: string; author?: string; description?: string }): Promise<Book> {
    const now = Date.now();
    const book: Book = {
      id: uid(),
      title: input.title.trim() || '未命名古籍',
      author: input.author?.trim() ?? '',
      description: input.description?.trim() ?? '',
      leafImageIds: [],
      coverImageId: null,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.putBook(book);
    this.books.unshift(book);
    this.changed.emit();
    return book;
  }

  async updateBook(id: string, patch: Partial<Pick<Book, 'title' | 'author' | 'description' | 'aging'>>): Promise<void> {
    const book = this.require(id);
    Object.assign(book, patch);
    this.touch(book);
    await db.putBook(book);
    this.changed.emit();
  }

  async removeBook(id: string): Promise<void> {
    await db.deleteBook(id);
    this.books = this.books.filter((b) => b.id !== id);
    this.annotations = this.annotations.filter((a) => a.bookId !== id);
    this.changed.emit();
  }

  /** 导入一组扫描图作为新的叶（每个 Blob 即一叶的筒子页图像） */
  async appendImages(bookId: string, blobs: Blob[]): Promise<void> {
    const book = this.require(bookId);
    for (const blob of blobs) {
      const img: PageImage = { id: uid(), blob, rotation: 0, createdAt: Date.now() };
      await db.putImage(img);
      book.leafImageIds.push(img.id);
      if (!book.coverImageId) book.coverImageId = img.id;
    }
    this.touch(book);
    await db.putBook(book);
    this.changed.emit();
  }

  async removeLeaf(bookId: string, leafIndex: number): Promise<void> {
    const book = this.require(bookId);
    const [imgId] = book.leafImageIds.splice(leafIndex, 1);
    if (book.coverImageId === imgId) book.coverImageId = book.leafImageIds[0] ?? null;
    book.progress = Math.min(book.progress, Math.max(0, book.leafImageIds.length - 1));
    // 批注索引修正
    for (const a of this.annotations) {
      if (a.bookId !== bookId) continue;
      if (a.leafIndex === leafIndex) await db.deleteAnnotation(a.id);
      else if (a.leafIndex > leafIndex) {
        a.leafIndex -= 1;
        await db.putAnnotation(a);
      }
    }
    this.annotations = this.annotations.filter((a) => !(a.bookId === bookId && a.leafIndex === leafIndex));
    this.touch(book);
    await db.putBook(book);
    this.changed.emit();
  }

  /** 叶顺序调整：把 from 位置的叶移动到 to 位置 */
  async moveLeaf(bookId: string, from: number, to: number): Promise<void> {
    const book = this.require(bookId);
    if (from === to || from < 0 || to < 0 || from >= book.leafImageIds.length || to >= book.leafImageIds.length) return;
    const [id] = book.leafImageIds.splice(from, 1);
    book.leafImageIds.splice(to, 0, id);
    this.touch(book);
    await db.putBook(book);
    this.changed.emit();
  }

  async setRotation(bookId: string, leafIndex: number, rotation: PageImage['rotation']): Promise<void> {
    const book = this.require(bookId);
    const img = await db.getImage(book.leafImageIds[leafIndex]);
    if (!img) return;
    img.rotation = rotation;
    await db.putImage(img);
    this.changed.emit();
  }

  async setCover(bookId: string, leafIndex: number): Promise<void> {
    const book = this.require(bookId);
    book.coverImageId = book.leafImageIds[leafIndex] ?? null;
    this.touch(book);
    await db.putBook(book);
    this.changed.emit();
  }

  async saveProgress(bookId: string, progress: number): Promise<void> {
    const book = this.require(bookId);
    if (book.progress === progress) return;
    book.progress = clampProgress(book, progress);
    await db.putBook(book);
    this.changed.emit();
  }

  // ---- 批注 ----
  annotationsFor(bookId: string): Annotation[] {
    return this.annotations.filter((a) => a.bookId === bookId);
  }

  async addAnnotation(a: Omit<Annotation, 'id' | 'createdAt'>): Promise<Annotation> {
    const ann: Annotation = { ...a, id: uid(), createdAt: Date.now() };
    await db.putAnnotation(ann);
    this.annotations.push(ann);
    this.changed.emit();
    return ann;
  }

  async updateAnnotation(id: string, patch: Partial<Pick<Annotation, 'text' | 'color' | 'x' | 'y' | 'width' | 'height'>>): Promise<void> {
    const ann = this.annotations.find((a) => a.id === id);
    if (!ann) return;
    Object.assign(ann, patch);
    await db.putAnnotation(ann);
    this.changed.emit();
  }

  async removeAnnotation(id: string): Promise<void> {
    await db.deleteAnnotation(id);
    this.annotations = this.annotations.filter((a) => a.id !== id);
    this.changed.emit();
  }

  /** 导入后全量替换内存索引 */
  reloadAfterImport(books: Book[], annotations: Annotation[]): void {
    this.books = books.sort((a, b) => b.updatedAt - a.updatedAt);
    this.annotations = annotations;
    this.changed.emit();
  }

  private require(id: string): Book {
    const b = this.books.find((x) => x.id === id);
    if (!b) throw new Error(`书目不存在: ${id}`);
    return b;
  }
}

function clampProgress(book: Book, p: number): number {
  return Math.max(0, Math.min(p, Math.max(0, book.leafImageIds.length - 1)));
}

// ---- 阅读设置 ----
function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw), aging: { ...DEFAULT_SETTINGS.aging, ...(JSON.parse(raw).aging ?? {}) } };
  } catch {
    /* 损坏的设置回落到默认值 */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

class SettingsStore {
  readonly changed = new Emitter<ReaderSettings>();
  private state: ReaderSettings = loadSettings();

  get(): ReaderSettings {
    return this.state;
  }

  update(patch: Partial<ReaderSettings>): void {
    this.state = { ...this.state, ...patch };
    this.persist();
    this.changed.emit(this.state);
  }

  updateAging(patch: Partial<ReaderSettings['aging']>): void {
    this.state = { ...this.state, aging: { ...this.state.aging, ...patch } };
    this.persist();
    this.changed.emit(this.state);
  }

  reset(): void {
    this.state = structuredClone(DEFAULT_SETTINGS);
    this.persist();
    this.changed.emit(this.state);
  }

  private persist(): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.state));
  }
}

export const library = new LibraryStore();
export const settingsStore = new SettingsStore();
