// jsdom implements getClientRects/getBoundingClientRect on Element and
// Text, but NOT on Range or the base Node/Document types. ProseMirror's
// coordsAtPos measures a reused DOM Range (textRange → singleRect) whenever
// a TipTap update scrolls the selection into view; in jsdom that call
// explodes with "target.getClientRects is not a function" — and when the
// transaction fires while (or after) a composer editor unmounts, the error
// escapes any test as an unhandled process-level error and fails the whole
// run even though every test passed. Read-only zero rects make that scroll
// computation a harmless no-op; Element keeps its real (empty-rect)
// implementation, so element-level assertions are unaffected.
function zeroRect() {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this
    },
  }
}

// Some suites opt into the plain-node environment (@vitest-environment
// node), where these globals do not exist — nothing to patch there.
if (typeof Node !== "undefined" && typeof Document !== "undefined") {
  for (const proto of [Node.prototype, Document.prototype]) {
    if (!proto.getClientRects) {
      proto.getClientRects = function getClientRects() {
        return []
      }
    }
    if (!proto.getBoundingClientRect) {
      proto.getBoundingClientRect = zeroRect
    }
  }
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function getClientRects() {
      return []
    }
    Range.prototype.getBoundingClientRect = zeroRect
  }
}
