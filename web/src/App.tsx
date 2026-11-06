import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "../../shared/types";
import { api, errorMessage } from "./api";
import { UserPicker } from "./components/UserPicker";
import { AppContext, type AppContextValue, type ToastKind } from "./context";
import { navigate, useLocalStorage, useRoute } from "./hooks";
import { InventoryPage } from "./pages/InventoryPage";
import { ProductEditPage } from "./pages/ProductEditPage";
import { HistoryPage } from "./history/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { DemoBadge, useDemoFlag } from "./demo";
import { APP_VERSION } from "./version";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

export function App() {
  const route = useRoute();
  const [userName, setUserName] = useLocalStorage("zaiko.userName", "");
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const demo = useDemoFlag();
  const [pickerOpen, setPickerOpen] = useState(false);
  // 端末の IP に紐づいた入力者（入力者を選んでいない端末は、この人として扱う）
  const [ipUser, setIpUser] = useState("");
  const [whoLoaded, setWhoLoaded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((message: string, kind: ToastKind = "success") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-1), { id, message, kind }]); // 同時に表示するのは2件まで
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);

  const refreshUsers = useCallback(async () => {
    try {
      setUsers(await api.users());
      setUsersLoaded(true);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }, [toast]);

  const refreshWhoAmI = useCallback(async () => {
    try {
      setIpUser((await api.whoami()).userName);
    } catch {
      setIpUser("");
    } finally {
      setWhoLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshUsers();
    void refreshWhoAmI();
  }, [refreshUsers, refreshWhoAmI]);

  // 選択中の名前が無効化・名前変更された場合は未選択に戻す
  const selectedUserName = users.some((u) => u.name === userName) ? userName : "";
  const ipUserName = users.some((u) => u.name === ipUser) ? ipUser : "";
  const validUserName = selectedUserName || ipUserName;
  const userFromIp = !selectedUserName && !!ipUserName;

  // 初回（未選択・IP の紐づけも無し）は入力者の選択画面を出す（未登録なら登録を案内）。設定画面では登録作業の邪魔になるので出さない
  useEffect(() => {
    if (usersLoaded && whoLoaded && !validUserName && route.page !== "settings") setPickerOpen(true);
  }, [usersLoaded, whoLoaded, validUserName, route.page]);

  const ctx = useMemo<AppContextValue>(
    () => ({
      userName: validUserName,
      userFromIp,
      refreshWhoAmI,
      users,
      refreshUsers,
      requireUser: () => {
        if (validUserName) return validUserName;
        setPickerOpen(true);
        return null;
      },
      openUserPicker: () => setPickerOpen(true),
      toast,
    }),
    [validUserName, userFromIp, refreshWhoAmI, users, refreshUsers, toast],
  );

  return (
    <AppContext.Provider value={ctx}>
      {demo && <div className="demo-ribbon">デモ環境：お試し・説明用のデータです（本番の在庫とは関係ありません）</div>}
      <header className="app-header">
        <button type="button" className="brand" onClick={() => navigate({ page: "inventory" })}>
          <img src="/icon-192.png" alt="" width={32} height={32} />
          <span>在庫管理</span>
        </button>
        <DemoBadge demo={demo} />
        <nav className="nav">
          <button type="button" className={route.page === "inventory" ? "active" : ""} onClick={() => navigate({ page: "inventory" })}>
            在庫一覧
          </button>
          <button type="button" className={route.page === "new" ? "active" : ""} onClick={() => navigate({ page: "new", code: "" })}>
            商品登録
          </button>
          <button type="button" className={route.page === "history" ? "active" : ""} onClick={() => navigate({ page: "history" })}>
            履歴
          </button>
          <button type="button" className={route.page === "settings" ? "active" : ""} onClick={() => navigate({ page: "settings" })}>
            設定
          </button>
        </nav>
        <button
          type="button"
          className={`user-chip${validUserName ? "" : " empty"}`}
          onClick={() => setPickerOpen(true)}
          title={userFromIp ? "この端末に紐づいた入力者です（クリックで変更）" : undefined}
        >
          👤 {validUserName || "入力者を選択"}
          {userFromIp && <span className="user-chip-ip">（この端末）</span>}
        </button>
        <span className="app-version" title="ビルド日時">
          Ver. {APP_VERSION}
        </span>
      </header>

      <main className="app-main">
        {route.page === "inventory" && <InventoryPage />}
        {route.page === "new" && <ProductEditPage key={`new-${route.code}`} productId={null} initialCode={route.code} />}
        {route.page === "edit" && <ProductEditPage key={`edit-${route.id}`} productId={route.id} initialCode="" />}
        {route.page === "settings" && <SettingsPage />}
        {route.page === "history" && <HistoryPage key={route.productId ?? 0} productId={route.productId ?? null} />}
      </main>

      {pickerOpen && (
        <UserPicker
          users={users}
          current={selectedUserName}
          ipUserName={ipUserName}
          onSelect={(name) => {
            setUserName(name);
            setPickerOpen(false);
            toast(name ? `入力者を「${name}」にしました` : `この端末の紐づけ（${ipUserName}）で記録します`, "info");
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
