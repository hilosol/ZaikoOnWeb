import { lazy, Suspense } from "react";

/** 読み取り機能（ライブラリが大きい）は使うときだけ読み込む */
const ScannerLazy = lazy(() => import("./Scanner"));

export function ScannerDialog(props: { onDetected: (code: string) => void; onClose: () => void }) {
  return (
    <Suspense fallback={null}>
      <ScannerLazy {...props} />
    </Suspense>
  );
}
