if (typeof window !== "undefined") {
  class TestPointerEvent extends window.MouseEvent {
    pointerId = 1;
    pointerType = "mouse";
    isPrimary = true;
  }

  if (!window.PointerEvent) {
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
  }

  if (!window.ResizeObserver) {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => undefined;
  }
}
