import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import "./styles.css";

/** /m で始まるアドレスはスマホ用画面、それ以外は PC 用画面 */
const isMobileScreen = /^\/m(\/|$)/.test(window.location.pathname);

if (isMobileScreen) {
  // ホーム画面に追加したときにスマホ用画面から開くよう、専用の manifest に差し替える
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", "/manifest-m.webmanifest");
  document.title = "在庫管理（入出庫）";
}

createRoot(document.getElementById("root")!).render(<StrictMode>{isMobileScreen ? <MobileApp /> : <App />}</StrictMode>);
