/// Tracks which overlay is on top so Escape only closes that one. Overlays register
/// when they mount and unregister when they unmount; the last registered is on top.
export function createEscapeStack() {
  const ids: object[] = [];
  return {
    push(id: object) {
      ids.push(id);
    },
    remove(id: object) {
      const i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1);
    },
    isTop(id: object) {
      return ids[ids.length - 1] === id;
    },
  };
}
