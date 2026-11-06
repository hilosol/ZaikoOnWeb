import { useCallback, useEffect, useRef, useState } from "react";

// ------------------------------------------------------------ 画面遷移（URL の # 以降で管理）

export type Route =
  | { page: "inventory" }
  | { page: "new"; code: string }
  | { page: "edit"; id: number }
  | { page: "settings" }
  /** 履歴ページ（productId 指定時はその商品の履歴に絞る） */
  | { page: "history"; productId?: number };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  if (path === "/products/new") return { page: "new", code: params.get("code") ?? "" };
  const edit = /^\/products\/(\d+)$/.exec(path);
  if (edit) return { page: "edit", id: Number(edit[1]) };
  if (path === "/settings") return { page: "settings" };
  if (path === "/history") {
    const pid = Number(params.get("productId"));
    return Number.isSafeInteger(pid) && pid > 0 ? { page: "history", productId: pid } : { page: "history" };
  }
  return { page: "inventory" };
}

export function routeToHash(route: Route): string {
  switch (route.page) {
    case "new":
      return route.code ? `#/products/new?code=${encodeURIComponent(route.code)}` : "#/products/new";
    case "edit":
      return `#/products/${route.id}`;
    case "settings":
      return "#/settings";
    case "history":
      return route.productId ? `#/history?productId=${route.productId}` : "#/history";
    default:
      return "#/";
  }
}

/** 離れる前に確認が必要な画面（未保存の編集）が登録する確認処理 */
let leaveGuard: (() => boolean) | null = null;
export function setLeaveGuard(guard: (() => boolean) | null) {
  leaveGuard = guard;
}

export function navigate(route: Route) {
  if (leaveGuard && !leaveGuard()) return;
  leaveGuard = null;
  window.location.hash = routeToHash(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    let last = window.location.hash;
    const onChange = () => {
      // ブラウザの「戻る」で未保存の編集画面から離れようとした場合も確認する
      if (leaveGuard && !leaveGuard()) {
        history.replaceState(null, "", last);
        return;
      }
      leaveGuard = null;
      last = window.location.hash;
      setRoute(parseRoute(last));
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

// ------------------------------------------------------------ 端末ごとの設定（localStorage）

/** localStorage はプライベートモード等で使えない場合があるため、失敗しても動くようにする */
export function useLocalStorage(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: string) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // 保存できなくても画面上は反映する
      }
    },
    [key],
  );
  return [value, set];
}

// ------------------------------------------------------------ 定期更新

/**
 * 画面が表示されている間、一定間隔で再読み込みする（他の端末での入出庫を反映するため）。
 * タブが裏に回っている間は止め、表示に戻ったら即更新する。
 */
export function usePolling(callback: () => void, intervalMs: number) {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") saved.current();
    };
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [intervalMs]);
}

/** 未保存の変更があるときに、タブを閉じる・再読み込みする前に確認する */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
