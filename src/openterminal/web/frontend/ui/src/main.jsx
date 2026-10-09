// 卡片层 React island 入口：一卡一 root，直挂 xterm decoration 的 host。
// api = { onDecision(decision, stateText, command) } 由 app.js 提供。
import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
import { CardsStore } from "./store.js";
import { OneCard } from "./cards.jsx";
import "./island.css";

function CardApp({ store, cardId }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const card = snap.cards.find(c => c.id === cardId) || null;
  return <OneCard card={card} dispatch={e => store.handle(e)} />;
}

export function createFeed(api) {
  const store = new CardsStore();
  if (api && api.onDecision) store.onDecision = api.onDecision;
  if (api && api.onRescue) store.onRescue = api.onRescue;
  if (api && api.onNewSession) store.onNewSession = api.onNewSession;
  if (api && api.onDrop) store.onDrop = api.onDrop;
  const roots = new Map();   // cardId -> {root, el}

  return {
    handle: evt => store.handle(evt),
    flush: () => store.flushNow(),
    mount(cardId, hostEl) {
      const prev = roots.get(cardId);
      if (prev) {
        if (prev.el === hostEl) return;
        // 重贴 decoration 会换新 host 元素：root 必须迁过去，否则 React 树
        // 留在已离屏的旧元素上——卡片真机空白（P0-1）
        roots.delete(cardId);
        try { prev.root.unmount(); } catch (e) {}
      }
      const root = createRoot(hostEl);
      root.render(<CardApp store={store} cardId={cardId} />);
      roots.set(cardId, { root, el: hostEl });
    },
    unmount(cardId) {
      const r = roots.get(cardId);
      if (!r) return;
      roots.delete(cardId);
      try { r.root.unmount(); } catch (e) {}
    },
    destroy() {
      for (const id of [...roots.keys()]) this.unmount(id);
    },
  };
}
