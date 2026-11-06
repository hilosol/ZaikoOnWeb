import type { EditingInfo } from "../../../shared/types";
import { shortDateTime } from "./common";

/** 「山田さん」／名前を選んでいない端末は IP で表す */
export function editorName(e: EditingInfo): string {
  return e.userName ? `${e.userName}さん` : `名前未選択の端末（${e.clientIp}）`;
}

/** 商品一覧・商品パネルに出す「編集中」の印 */
export function EditingBadge({ editors }: { editors: EditingInfo[] | undefined }) {
  if (!editors || editors.length === 0) return null;
  const names = editors.map(editorName).join("・");
  return (
    <span className="editing-badge" title={`${names} が編集画面を開いています（${shortDateTime(editors[0]!.since)}から）`}>
      ✏ {names}が編集中
    </span>
  );
}
