import { describe, expect, it } from "vitest"

import { base64ToBytes, decryptString, encryptString } from "../aes-gcm"
import {
  KeyMaterialError,
  KeyStoreError,
  getOrCreateEncryptionKey,
  writeKeyFileAtomically,
  type KeyFileIo,
} from "../key-management"
import { createInMemoryKeyStore } from "./in-memory-key-store"

describe("getOrCreateEncryptionKey", () => {
  it("generates and persists a 256-bit key on first use", async () => {
    const store = createInMemoryKeyStore()
    const key = await getOrCreateEncryptionKey(store)

    expect(key).toBeInstanceOf(CryptoKey)
    expect(key.extractable).toBe(false)
    expect(store.writeCount).toBe(1)

    const stored = await store.read()
    expect(stored).not.toBeNull()
    expect(base64ToBytes(stored ?? "")).toHaveLength(32)
  })

  it("is single-flight: concurrent callers share one key and one write", async () => {
    const store = createInMemoryKeyStore()
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateEncryptionKey(store))
    )

    expect(new Set(keys).size).toBe(1)
    expect(store.writeCount).toBe(1)
  })

  it("reuses the cached key on subsequent calls", async () => {
    const store = createInMemoryKeyStore()
    const first = await getOrCreateEncryptionKey(store)
    const second = await getOrCreateEncryptionKey(store)
    expect(second).toBe(first)
    expect(store.writeCount).toBe(1)
  })

  it("reuses persisted material across restarts (new store instance)", async () => {
    const firstLaunch = createInMemoryKeyStore()
    const keyBefore = await getOrCreateEncryptionKey(firstLaunch)
    const stored = await firstLaunch.read()
    expect(stored).not.toBeNull()

    // A "new process": fresh cache, same persisted key material.
    const secondLaunch = createInMemoryKeyStore(stored)
    const keyAfter = await getOrCreateEncryptionKey(secondLaunch)
    expect(firstLaunch).not.toBe(secondLaunch)
    expect(
      await decryptString(keyAfter, await encryptString(keyBefore, "persisted"))
    ).toBe("persisted")
  })

  it("throws KeyMaterialError for stored material that is not base64", async () => {
    const garbage = "!!! definitely not base64 !!!"
    const store = createInMemoryKeyStore(garbage)
    await expect(getOrCreateEncryptionKey(store)).rejects.toThrow(
      KeyMaterialError
    )
  })

  it("throws KeyMaterialError for a key of the wrong length, without leaking material", async () => {
    const shortKey = btoa("0123456789abcdef") // 16 bytes, not 32
    const store = createInMemoryKeyStore(shortKey)
    const failure = await getOrCreateEncryptionKey(store).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(KeyMaterialError)
    expect((failure as Error).message).not.toContain(shortKey)
  })

  it("wraps store failures in KeyStoreError and can retry after they clear", async () => {
    let failing = true
    const store = {
      async read(): Promise<string | null> {
        if (failing) throw new Error("io error")
        return null
      },
      async write(): Promise<void> {
        if (failing) throw new Error("disk full")
      },
    }

    const failure = await getOrCreateEncryptionKey(store).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(KeyStoreError)
    expect((failure as Error).message).not.toMatch(/[A-Za-z0-9+/]{40,}/)

    failing = false
    const key = await getOrCreateEncryptionKey(store)
    expect(key).toBeInstanceOf(CryptoKey)
  })
})

describe("writeKeyFileAtomically", () => {
  /** In-memory file system standing in for the plugin-fs surface. */
  function fakeIo(): KeyFileIo & {
    files: Map<string, string>
  } {
    const files = new Map<string, string>()
    return {
      files,
      async writeTextFile(path, contents) {
        files.set(path, contents)
      },
      async rename(from, to) {
        const contents = files.get(from)
        if (contents === undefined) throw new Error("ENOENT")
        files.delete(from)
        files.set(to, contents)
      },
      async remove(path) {
        files.delete(path)
      },
    }
  }

  it("writes the tmp file first, then renames it over the key file", async () => {
    const io = fakeIo()
    const order: string[] = []
    const originalWrite = io.writeTextFile.bind(io)
    const originalRename = io.rename.bind(io)
    io.writeTextFile = async (path, contents) => {
      order.push(`write:${path}`)
      await originalWrite(path, contents)
    }
    io.rename = async (from, to) => {
      order.push(`rename:${from}->${to}`)
      await originalRename(from, to)
    }

    await writeKeyFileAtomically("key-material", io)

    expect(order).toEqual([
      "write:credentials.key.tmp",
      "rename:credentials.key.tmp->credentials.key",
    ])
    expect(io.files.get("credentials.key")).toBe("key-material")
    // No stray tmp file survives a successful write.
    expect(io.files.has("credentials.key.tmp")).toBe(false)
  })

  it("leaves a previously written key intact when the write crashes mid-file", async () => {
    const io = fakeIo()
    io.files.set("credentials.key", "previous-key")
    io.writeTextFile = async () => {
      throw new Error("crash mid-write")
    }

    await expect(writeKeyFileAtomically("new-key", io)).rejects.toThrow(
      "crash mid-write"
    )
    // The old key file was never touched — stored credentials stay readable.
    expect(io.files.get("credentials.key")).toBe("previous-key")
  })

  it("removes the tmp file best-effort when the rename fails, then rethrows", async () => {
    const io = fakeIo()
    io.rename = async () => {
      throw new Error("rename failed")
    }

    await expect(writeKeyFileAtomically("key", io)).rejects.toThrow(
      "rename failed"
    )
    expect(io.files.has("credentials.key.tmp")).toBe(false)
    expect(io.files.has("credentials.key")).toBe(false)
  })
})
