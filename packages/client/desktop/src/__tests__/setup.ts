import "@testing-library/jest-dom/vitest"

// radix relies on pointer-capture APIs that jsdom doesn't implement
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
