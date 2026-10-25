// Unit-test setup: in-memory IndexedDB so the storage code runs in Node/jsdom.
// Nothing here touches the network, PostgreSQL or Azure.
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// In the jsdom environment, Node's structuredClone (used by fake-indexeddb)
// turns jsdom Blobs into empty objects because they are not Node Blobs. Real
// browsers have a single realm and clone Blobs fine, so for jsdom tests we
// clone everything else structurally and carry Blobs over by reference.
if (typeof window !== 'undefined' && typeof Blob !== 'undefined') {
  const nativeClone = globalThis.structuredClone;
  const cloneWithBlobs = (value: unknown, seen = new Map<object, unknown>()): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Blob) return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return nativeClone(value);
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(cloneWithBlobs(item, seen));
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value)) out[k] = cloneWithBlobs(v, seen);
    return out;
  };
  globalThis.structuredClone = cloneWithBlobs as typeof structuredClone;
}

beforeEach(() => {
  // Fresh database per test.
  globalThis.indexedDB = new IDBFactory();
});
