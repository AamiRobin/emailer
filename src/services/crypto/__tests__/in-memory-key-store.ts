import type { KeyStore } from "../key-management"

export interface InMemoryKeyStore extends KeyStore {
  /** Number of write() calls — lets tests assert single-flight behavior. */
  writeCount: number
}

/**
 * Test double standing in for createTauriKeyStore(): keeps at most one
 * stored value in memory, mirroring the single `credentials.key` file.
 * Optionally pre-seeded (e.g. to simulate a second launch).
 */
export function createInMemoryKeyStore(
  initial: string | null = null
): InMemoryKeyStore {
  let value = initial
  const store: InMemoryKeyStore = {
    writeCount: 0,
    async read() {
      return value
    },
    async write(next) {
      store.writeCount += 1
      value = next
    },
  }
  return store
}
