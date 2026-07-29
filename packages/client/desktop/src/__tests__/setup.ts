import "@testing-library/jest-dom/vitest"

// radix relies on pointer-capture APIs that jsdom doesn't implement
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

// jsdom has no layout, so it ships no scrollIntoView either — keyboard-driven
// lists (the `/` command menu) call it on every selection change.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
