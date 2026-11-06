import { createContext, useContext } from "react";
import type { User } from "../../shared/types";

export type ToastKind = "success" | "error" | "info";

export interface AppContextValue {
  /** この端末の入力者名（選択した名前 → 無ければ端末の IP に紐づいた人。どちらも無ければ ""） */
  userName: string;
  /** userName が IP の紐づけによるものか */
  userFromIp: boolean;
  /** 設定画面で紐づけを変えたときに読み直す */
  refreshWhoAmI(): Promise<void>;
  users: User[];
  refreshUsers(): Promise<void>;
  /** 入力者を確認する。未選択なら選択画面を開いて null を返す（呼び出し側は処理を中断する） */
  requireUser(): string | null;
  openUserPicker(): void;
  toast(message: string, kind?: ToastKind): void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext が設定されていません");
  return ctx;
}
