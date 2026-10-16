/**
 * Thread-document content hash (parity-round-3 task 6.2, design D1).
 *
 * The incremental-skip key for the semantic index: a thread is
 * re-embedded only when this hash differs from the stored
 * thread_vectors.content_hash. Deliberately a NON-cryptographic hash
 * (two differently-seeded 32-bit FNV-1a passes, hex-concatenated to 64
 * bits): the value guards nothing — it only detects "the document text
 * changed" — so WebCrypto's async digest would buy nothing but an await
 * per thread on the indexing path. The combined 64 bits put a collision
 * far beyond the 50k-thread loader cap, and a hash collision would at
 * worst skip one stale re-embed until the text changes again — never a
 * wrong answer (vectors rank mail, they do not gate reads).
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** One 32-bit FNV-1a pass over the UTF-16 code units, starting from
 * `seed`. `>>> 0` keeps every intermediate in the unsigned 32-bit
 * range, where JS integer math is exact. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** FNV-1a over the string, then a second pass seeded with a different
 * basis (so both halves must collide simultaneously for a false "unchanged");
 * 16 hex chars out. */
export function contentHash(text: string): string {
  const first = fnv1a32(text, FNV_OFFSET_BASIS)
  const second = fnv1a32(text, FNV_OFFSET_BASIS ^ 0x9e3779b9)
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0")
}
