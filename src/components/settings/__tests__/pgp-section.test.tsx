import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Encryption (PGP) settings section tests (task 18.7). Same
 * executor-injection pattern as the other settings suites: the executor
 * module is mocked to hand every consumer a seeded node:sqlite executor
 * (the REAL preferences module runs against it, so the per-account
 * mail.pgpEnabled:<accountId> round-trip is exercised for real), and the
 * account store is seeded directly.
 *
 * The key service (crypto/pgp-keys) is mocked, and its first list call
 * can be parked on a deferred promise — which holds the section in the
 * async state between the manager mounting and the first data arriving,
 * pinning the lazy boundary end to end: with the feature off the section
 * never touches the mocked module at all, and while its first load is in
 * flight the unloaded state renders. (Vitest instantiates mock factories
 * eagerly at file setup, so the import() call itself is not observable —
 * the static-graph guarantee lives in pgp-lazy-loading.test.ts.) sonner
 * and the save dialog are mocked (sonner renders nothing under jsdom;
 * the Tauri save dialog cannot run there).
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

const pgpKeysHolder = vi.hoisted(() => {
  const fns = {
    listPrivateKeys: vi.fn(),
    listPublicKeys: vi.fn(),
    generateKey: vi.fn(),
    importPrivateKey: vi.fn(),
    importPublicKey: vi.fn(),
    setDefaultPrivateKey: vi.fn(),
    deletePrivateKey: vi.fn(),
    deletePublicKey: vi.fn(),
    getPublicKeyArmor: vi.fn(),
  }
  return {
    ...fns,
    /** How often the section has USED the key service (any module call).
     * Vitest instantiates mock factories eagerly at file setup, so the
     * factory itself cannot observe the section's dynamic import — what
     * is observable is that with the feature off the section never touches
     * the module at all (the manager that drives every call is mounted
     * only past the enable toggle; the static-graph guarantee lives in
     * pgp-lazy-loading.test.ts). */
    get touches(): number {
      return Object.values(fns).reduce(
        (count, fn) => count + fn.mock.calls.length,
        0
      )
    },
  }
})

const clipboardWrite = vi.fn(async () => {})

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

vi.mock("@/services/crypto/pgp-keys", () => ({
  listPrivateKeys: pgpKeysHolder.listPrivateKeys,
  listPublicKeys: pgpKeysHolder.listPublicKeys,
  generateKey: pgpKeysHolder.generateKey,
  importPrivateKey: pgpKeysHolder.importPrivateKey,
  importPublicKey: pgpKeysHolder.importPublicKey,
  setDefaultPrivateKey: pgpKeysHolder.setDefaultPrivateKey,
  deletePrivateKey: pgpKeysHolder.deletePrivateKey,
  deletePublicKey: pgpKeysHolder.deletePublicKey,
  getPublicKeyArmor: pgpKeysHolder.getPublicKeyArmor,
}))

vi.mock("@/services/attachments/file-actions", () => ({
  saveAttachmentAs: vi.fn(async () => "/tmp/0xdeadbeef.asc"),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import { saveAttachmentAs } from "@/services/attachments/file-actions"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  getPgpEnabled,
  setPgpEnabledPreference,
} from "@/services/settings/preferences"
import { useAccountStore } from "@/stores/account-store"
import { PgpSection } from "../pgp-section"

const PUBLIC_ARMOR = [
  "-----BEGIN PGP PUBLIC KEY BLOCK-----",
  "mock public armor",
  "-----END PGP PUBLIC KEY BLOCK-----",
].join("\n")

const PRIVATE_ARMOR = [
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "mock private armor",
  "-----END PGP PRIVATE KEY BLOCK-----",
].join("\n")

const accountId = "acc-1"

function privateKeySummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Ada Lovelace",
    email: "one@example.com",
    createdAt: 1_700_000_000,
    isDefault: false,
    ...overrides,
  }
}

function publicKeySummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "Grace Hopper",
    email: "grace@example.com",
    source: "imported" as const,
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

let executor: TestExecutor

function seedActiveAccount(): void {
  useAccountStore.setState({
    accounts: [
      {
        id: accountId,
        type: "gmail",
        email: "one@example.com",
        displayName: null,
        status: "active",
        unreadCount: 0,
        lastSyncAt: null,
      },
    ],
    activeAccountId: accountId,
    loaded: true,
  })
}

function stubClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  })
}

function resetClipboardStub(): void {
  Reflect.deleteProperty(navigator, "clipboard")
}

/** Base UI Select ignores synthetic clicks that did not start with a
 * pointerdown on the item (drag-select guard), so send both. */
function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

/** Enable the account through the REAL preferences module (exactly what a
 * previous session's toggle would have persisted). */
async function seedEnabled(): Promise<void> {
  await setPgpEnabledPreference(executor, accountId, true)
}

beforeEach(() => {
  for (const mock of [
    pgpKeysHolder.listPrivateKeys,
    pgpKeysHolder.listPublicKeys,
    pgpKeysHolder.generateKey,
    pgpKeysHolder.importPrivateKey,
    pgpKeysHolder.importPublicKey,
    pgpKeysHolder.setDefaultPrivateKey,
    pgpKeysHolder.deletePrivateKey,
    pgpKeysHolder.deletePublicKey,
    pgpKeysHolder.getPublicKeyArmor,
    clipboardWrite,
  ]) {
    mock.mockReset()
  }
  // Empty key lists are the common default.
  pgpKeysHolder.listPrivateKeys.mockResolvedValue([])
  pgpKeysHolder.listPublicKeys.mockResolvedValue([])

  executor = createTestExecutor()
  executorHolder.current = executor
  stubClipboard()
  seedActiveAccount()
})

afterEach(() => {
  cleanup()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: true,
  })
  resetClipboardStub()
  executorHolder.current = null
  executor.close()
})

describe("PgpSection enable toggle", () => {
  it("shows the no-account state without touching PGP", async () => {
    useAccountStore.setState({ activeAccountId: null, loaded: true })
    render(<PgpSection />)

    expect(
      await screen.findByText(/Add an account to manage its encryption keys/)
    ).toBeTruthy()
    expect(screen.queryByRole("switch", { name: "Enable OpenPGP" })).toBeNull()
    expect(pgpKeysHolder.touches).toBe(0)
  })

  it("renders the off state and never requests the PGP module", async () => {
    render(<PgpSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Enable OpenPGP",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    // No key manager, no loading state, and — the load-bearing assertion —
    // no module use: the section never calls into the key service while
    // the toggle is off.
    expect(screen.queryByText(/Loading encryption keys/)).toBeNull()
    expect(screen.queryByTestId("pgp-private-key-row")).toBeNull()
    expect(pgpKeysHolder.touches).toBe(0)
  })

  it("persists the per-account opt-in and reveals the key manager", async () => {
    render(<PgpSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Enable OpenPGP",
    })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await waitFor(async () => {
      expect(await getPgpEnabled(executor, accountId)).toBe(true)
    })

    // The manager only now pulls the PGP module through the dynamic
    // import, and lands on the empty state.
    expect(await screen.findByText(/No keys yet/)).toBeTruthy()
    expect(pgpKeysHolder.touches).toBeGreaterThan(0)

    // Turning it off hides the manager again (the flag persists).
    fireEvent.click(screen.getByRole("switch", { name: "Enable OpenPGP" }))
    await waitFor(async () => {
      expect(await getPgpEnabled(executor, accountId)).toBe(false)
    })
    expect(screen.queryByText(/No keys yet/)).toBeNull()
  })
})

describe("PgpSection lazy boundary", () => {
  it("shows the unloaded state until the first key-service load resolves", async () => {
    // Park the module's first list call: the section has reached through
    // the dynamic import, the data is still in flight.
    let releaseLists: (() => void) | null = null
    const listsPending = new Promise<void>((resolve) => {
      releaseLists = resolve
    })
    pgpKeysHolder.listPrivateKeys.mockReturnValue(
      listsPending.then(() => [privateKeySummary({ isDefault: true })])
    )
    await seedEnabled()

    render(<PgpSection />)

    // The enable flag resolved, the manager mounted, and its first render
    // is the unloaded state — no key rows yet.
    expect(await screen.findByText(/Loading encryption keys/)).toBeTruthy()
    expect(screen.queryByTestId("pgp-private-key-row")).toBeNull()

    // Releasing the load renders the lists.
    await act(async () => {
      releaseLists!()
    })

    expect(await screen.findByTestId("pgp-private-key-row")).toBeTruthy()
    expect(screen.getByText("one@example.com")).toBeTruthy()
    // Fingerprint in 4-char groups and the created date on the row.
    expect(
      screen.getByText(/aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa/)
    ).toBeTruthy()
  })

  it("fails toward the empty lists when the key service errors", async () => {
    pgpKeysHolder.listPrivateKeys.mockRejectedValue(new Error("no database"))
    await seedEnabled()

    render(<PgpSection />)
    expect(await screen.findByText(/No keys yet/)).toBeTruthy()
  })
})

describe("PgpSection generate flow", () => {
  const generated = privateKeySummary({ isDefault: true })

  it("requires a confirmed passphrase, then shows the backup step", async () => {
    await seedEnabled()
    pgpKeysHolder.listPrivateKeys.mockResolvedValueOnce([]) // initial load
    pgpKeysHolder.listPrivateKeys.mockResolvedValueOnce([generated]) // reload
    pgpKeysHolder.generateKey.mockResolvedValue(generated)
    pgpKeysHolder.getPublicKeyArmor.mockResolvedValue(PUBLIC_ARMOR)

    render(<PgpSection />)
    // Wait out the initial load: the manager's buttons start disabled.
    expect(await screen.findByText(/No keys yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Generate Key Pair" }))
    // The identity fields are prefilled from the account.
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
      "one@example.com"
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ada Lovelace" },
    })
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "s3cret passphrase" },
    })

    // The submit stays locked until the confirmation matches — the
    // design's "forced passphrase confirmation".
    const submit = screen.getByRole("button", {
      name: "Generate",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "wrong" },
    })
    expect(screen.getByRole("alert").textContent).toMatch(/do not match/)
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "s3cret passphrase" },
    })

    fireEvent.click(submit)
    expect(await screen.findByText("Save your public key")).toBeTruthy()
    expect(pgpKeysHolder.generateKey).toHaveBeenCalledWith(
      executor,
      accountId,
      {
        name: "Ada Lovelace",
        email: "one@example.com",
        passphrase: "s3cret passphrase",
      }
    )

    // The backup/export step: public armor, copy + export, and the
    // unrecoverable-key warning.
    expect(
      (screen.getByLabelText("Public key") as HTMLTextAreaElement).value
    ).toBe(PUBLIC_ARMOR)
    expect(
      screen.getByText(/cannot be recovered without its passphrase/)
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Copy Public Key" }))
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(PUBLIC_ARMOR)
    })

    fireEvent.click(screen.getByRole("button", { name: "Export key file" }))
    await waitFor(() => {
      expect(saveAttachmentAs).toHaveBeenCalled()
    })
    expect(vi.mocked(saveAttachmentAs).mock.calls[0]?.[0]).toEqual({
      filename: `0x${generated.id.slice(-8)}.asc`,
    })

    // Done closes the dialog and the fresh list shows the new key.
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(await screen.findByTestId("pgp-private-key-row")).toBeTruthy()
    expect(screen.queryByText("Save your public key")).toBeNull()
  })

  it("surfaces service errors instead of storing anything", async () => {
    await seedEnabled()
    pgpKeysHolder.generateKey.mockRejectedValue(
      new Error("a passphrase is required to protect the key")
    )

    render(<PgpSection />)
    // Wait out the initial load: the manager's buttons start disabled.
    expect(await screen.findByText(/No keys yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Generate Key Pair" }))
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ada Lovelace" },
    })
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "pw" },
    })
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "pw" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(await screen.findByRole("alert")).toBeTruthy()
    // Still on the form step — no backup step without a stored key.
    expect(screen.queryByText("Save your public key")).toBeNull()
  })
})

describe("PgpSection import flow", () => {
  it("imports a correspondent's public key from the textarea", async () => {
    const imported = publicKeySummary()
    await seedEnabled()
    pgpKeysHolder.listPublicKeys.mockResolvedValueOnce([]) // initial load
    pgpKeysHolder.listPublicKeys.mockResolvedValueOnce([imported]) // reload
    pgpKeysHolder.importPublicKey.mockResolvedValue(imported)

    render(<PgpSection />)
    // Wait out the initial load: the manager's buttons start disabled.
    expect(await screen.findByText(/No keys yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Import Key" }))

    // Public is the default kind — no passphrase field.
    expect(screen.queryByLabelText("Passphrase")).toBeNull()
    fireEvent.change(screen.getByLabelText("Armored key"), {
      target: { value: PUBLIC_ARMOR },
    })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => {
      expect(pgpKeysHolder.importPublicKey).toHaveBeenCalledWith(
        executor,
        accountId,
        PUBLIC_ARMOR
      )
    })
    expect(await screen.findByTestId("pgp-public-key-row")).toBeTruthy()
    expect(screen.getByText("grace@example.com")).toBeTruthy()
    expect(screen.getByText("Imported")).toBeTruthy()
  })

  it("requires the passphrase before importing a private key", async () => {
    const imported = privateKeySummary()
    await seedEnabled()
    pgpKeysHolder.listPrivateKeys.mockResolvedValueOnce([]) // initial load
    pgpKeysHolder.listPrivateKeys.mockResolvedValueOnce([imported]) // reload
    pgpKeysHolder.importPrivateKey.mockResolvedValue(imported)

    render(<PgpSection />)
    // Wait out the initial load: the manager's buttons start disabled.
    expect(await screen.findByText(/No keys yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Import Key" }))

    fireEvent.click(screen.getByRole("combobox", { name: "Key type" }))
    chooseOption(await screen.findByRole("option", { name: "Private key" }))

    fireEvent.change(screen.getByLabelText("Armored key"), {
      target: { value: PRIVATE_ARMOR },
    })
    const submit = screen.getByRole("button", {
      name: "Import",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(await screen.findByLabelText("Passphrase"), {
      target: { value: "existing passphrase" },
    })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(pgpKeysHolder.importPrivateKey).toHaveBeenCalledWith(
        executor,
        accountId,
        PRIVATE_ARMOR,
        "existing passphrase"
      )
    })
    expect(await screen.findByTestId("pgp-private-key-row")).toBeTruthy()
  })
})

describe("PgpSection key management", () => {
  const keyOne = privateKeySummary({
    email: "k1@example.com",
    isDefault: true,
  })
  const keyTwo = privateKeySummary({
    id: "2222222222222222222222222222222222222222",
    email: "k2@example.com",
    isDefault: false,
  })

  it("promotes another key to the account default", async () => {
    await seedEnabled()
    pgpKeysHolder.listPrivateKeys.mockResolvedValue([keyOne, keyTwo])

    render(<PgpSection />)
    expect(await screen.findAllByTestId("pgp-private-key-row")).toHaveLength(2)
    expect(screen.getByText("Default")).toBeTruthy()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Make k2@example.com the default key",
      })
    )
    await waitFor(() => {
      expect(pgpKeysHolder.setDefaultPrivateKey).toHaveBeenCalledWith(
        executor,
        accountId,
        keyTwo.id
      )
    })
  })

  it("deletes a private key only through the confirmation dialog", async () => {
    await seedEnabled()
    pgpKeysHolder.listPrivateKeys
      .mockResolvedValueOnce([keyOne, keyTwo]) // initial load
      .mockResolvedValueOnce([keyTwo]) // after the delete

    render(<PgpSection />)
    expect(await screen.findAllByTestId("pgp-private-key-row")).toHaveLength(2)

    fireEvent.click(
      screen.getByRole("button", { name: "Delete the key for k1@example.com" })
    )
    expect(await screen.findByText(/no longer be decrypted/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Delete key" }))
    await waitFor(() => {
      expect(pgpKeysHolder.deletePrivateKey).toHaveBeenCalledWith(
        executor,
        accountId,
        keyOne.id
      )
    })
    // The reload after the delete leaves only the surviving key.
    expect(await screen.findAllByTestId("pgp-private-key-row")).toHaveLength(1)
  })

  it("copies and deletes public keys", async () => {
    const imported = publicKeySummary()
    await seedEnabled()
    pgpKeysHolder.listPrivateKeys.mockResolvedValue([keyOne])
    pgpKeysHolder.listPublicKeys
      .mockResolvedValueOnce([imported]) // initial load
      .mockResolvedValueOnce([]) // after the delete
    pgpKeysHolder.getPublicKeyArmor.mockResolvedValue(PUBLIC_ARMOR)

    render(<PgpSection />)
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy the public key for grace@example.com",
      })
    )
    await waitFor(() => {
      expect(pgpKeysHolder.getPublicKeyArmor).toHaveBeenCalledWith(
        executor,
        accountId,
        imported.id
      )
      expect(clipboardWrite).toHaveBeenCalledWith(PUBLIC_ARMOR)
    })

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete the public key for grace@example.com",
      })
    )
    expect(
      await screen.findByText(/no longer be able to encrypt mail/)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Delete key" }))
    await waitFor(() => {
      expect(pgpKeysHolder.deletePublicKey).toHaveBeenCalledWith(
        executor,
        accountId,
        imported.id
      )
    })
  })
})
