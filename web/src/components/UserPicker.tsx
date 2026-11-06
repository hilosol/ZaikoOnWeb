import type { User } from "../../../shared/types";
import { navigate } from "../hooks";
import { Modal } from "./common";

/** 入力者の選択。選んだ名前は端末（ブラウザ）ごとに記憶する。 */
export function UserPicker({
  users,
  current,
  onSelect,
  onClose,
  onGoSettings = () => navigate({ page: "settings" }),
  ipUserName = "",
}: {
  users: User[];
  current: string;
  onSelect: (name: string) => void;
  onClose: () => void;
  /** 入力者が未登録のときの「設定画面で登録する」の移動先（スマホ画面では PC 画面の設定へ） */
  onGoSettings?: () => void;
  /** この端末の IP に紐づいた入力者。名前を選んでいる場合に「紐づけに戻す」を出す（onSelect("") で通知） */
  ipUserName?: string;
}) {
  return (
    <Modal title="入力者を選択" onClose={onClose}>
      {users.length === 0 ? (
        <div className="empty">
          <p>入力者が登録されていません。</p>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              onClose();
              onGoSettings();
            }}
          >
            設定画面で登録する
          </button>
        </div>
      ) : (
        <>
          <p className="muted">この端末で操作する人を選んでください。入出庫の履歴に記録されます。</p>
          <div className="user-grid">
            {users.map((u) => (
              <button
                key={u.id}
                type="button"
                className={`user-button${u.name === current ? " selected" : ""}`}
                onClick={() => onSelect(u.name)}
              >
                {u.name}
              </button>
            ))}
          </div>
          {ipUserName && current !== "" && (
            <p className="small">
              <button type="button" className="button small" onClick={() => onSelect("")}>
                選択をやめて、この端末の紐づけ（{ipUserName}）に戻す
              </button>
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
