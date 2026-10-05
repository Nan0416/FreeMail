import '@testing-library/jest-dom/vitest';

// jsdom gaps that Radix (menus, dialogs, tooltips) and ProseMirror (the compose editor)
// touch. Inert stand-ins: tests assert behaviour, never layout.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
const emptyRects = (): DOMRectList => {
  const list = [] as unknown as DOMRectList;
  return Object.assign(list, { item: () => null });
};
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.elementFromPoint ??= () => null;
