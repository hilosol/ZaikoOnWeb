import { useEffect, useState } from "react";

/**
 * デモ（お試し・説明用）環境かどうか。サーバーの /api/health で判断する。
 * デモのときはタブの名前にも【デモ】を付け、本番と取り違えないようにする。
 */
export function useDemoFlag(): boolean {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((h: { demo?: boolean } | null) => {
        if (h?.demo) {
          setDemo(true);
          if (!document.title.startsWith("【デモ】")) document.title = `【デモ】${document.title}`;
        }
      })
      .catch(() => undefined);
  }, []);
  return demo;
}

export function DemoBadge({ demo }: { demo: boolean }) {
  return demo ? (
    <span className="demo-badge" title="お試し・説明用のデータです。本番の在庫とは関係ありません">
      デモ
    </span>
  ) : null;
}
