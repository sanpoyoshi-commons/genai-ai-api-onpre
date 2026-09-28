/**
 * 取り出し結果のメモ化。
 *
 * web は毎ターン、過去ターンの添付も base64 で再送する（`formatMessageProperties` が列の全体に掛かる）。
 * 同じ添付の解析を毎回やり直さないよう、base64 の SHA-256 を鍵に LRU で持つ。
 * 件数の上限は必須（利用者の入力で無限に育つ経路にしない）。プロセス内・揮発でよい。
 */

export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    // 参照したものを末尾へ移して「最近使った」にする。
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.maxEntries <= 0) {
      return;
    }
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) {
        break;
      }
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
