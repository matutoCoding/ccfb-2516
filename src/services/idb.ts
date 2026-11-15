// IndexedDB 持久层：books / images / annotations 三个对象仓库
import type { Annotation, Book, PageImage } from '../types';

const DB_NAME = 'yunbian-db';
const DB_VERSION = 1;
const STORE = { books: 'books', images: 'images', annotations: 'annotations' } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.books)) db.createObjectStore(STORE.books, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE.images)) db.createObjectStore(STORE.images, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE.annotations)) db.createObjectStore(STORE.annotations, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T>(store: string, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value));
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key));
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll());
}

export async function idbDelete(store: string, key: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(key));
}

export async function idbClear(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

// ---- 领域专用 API ----

export const db = {
  // books
  putBook: (b: Book) => idbPut(STORE.books, b),
  getBook: (id: string) => idbGet<Book>(STORE.books, id),
  allBooks: () => idbGetAll<Book>(STORE.books),
  deleteBook: async (id: string) => {
    const book = await idbGet<Book>(STORE.books, id);
    await idbDelete(STORE.books, id);
    // 级联清理：仅当没有其它书引用这些图片时才删除
    if (book) {
      const others = await idbGetAll<Book>(STORE.books);
      const used = new Set(others.flatMap((b) => b.leafImageIds).concat(others.map((b) => b.coverImageId).filter(Boolean) as string[]));
      for (const imgId of book.leafImageIds) if (!used.has(imgId)) await idbDelete(STORE.images, imgId);
      if (book.coverImageId && !used.has(book.coverImageId)) await idbDelete(STORE.images, book.coverImageId);
    }
    // 批注级联
    const anns = await idbGetAll<Annotation>(STORE.annotations);
    await Promise.all(anns.filter((a) => a.bookId === id).map((a) => idbDelete(STORE.annotations, a.id)));
  },

  // images
  putImage: (img: PageImage) => idbPut(STORE.images, img),
  getImage: (id: string) => idbGet<PageImage>(STORE.images, id),
  deleteImage: (id: string) => idbDelete(STORE.images, id),

  // annotations
  putAnnotation: (a: Annotation) => idbPut(STORE.annotations, a),
  allAnnotations: () => idbGetAll<Annotation>(STORE.annotations),
  deleteAnnotation: (id: string) => idbDelete(STORE.annotations, id),
  bookAnnotations: async (bookId: string) => (await idbGetAll<Annotation>(STORE.annotations)).filter((a) => a.bookId === bookId),
  clearAll: async () => {
    await idbClear(STORE.books);
    await idbClear(STORE.images);
    await idbClear(STORE.annotations);
  },

  /** 批量写入（导入时使用，单事务） */
  bulkImport: async (books: Book[], images: PageImage[], annotations: Annotation[]) => {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction([STORE.books, STORE.images, STORE.annotations], 'readwrite');
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      const bs = t.objectStore(STORE.books);
      const is = t.objectStore(STORE.images);
      const as = t.objectStore(STORE.annotations);
      for (const b of books) bs.put(b);
      for (const i of images) is.put(i);
      for (const a of annotations) as.put(a);
    });
  },
};
