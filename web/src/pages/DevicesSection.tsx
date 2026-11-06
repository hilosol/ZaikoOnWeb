import { useCallback, useEffect, useState } from "react";
import { Rules, type Device, type User } from "../../../shared/types";
import { api, errorMessage } from "../api";
import { shortDateTime } from "../components/common";
import { useApp } from "../context";

/**
 * 端末（ブラウザ）と入力者の紐づけ。端末は初回アクセス時に自動で登録される（Cookie の端末ID）。
 * 紐づけると、その端末では名前を選ばなくてもその人として記録する。IP が変わっても有効（スマホ向け）。
 */
export function DevicesSection() {
  const app = useApp();
  const [devices, setDevices] = useState<Device[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [myDeviceId, setMyDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, u, who] = await Promise.all([api.devices(), api.users(), api.whoami()]);
      setDevices(d);
      setUsers(u);
      setMyDeviceId(who.deviceId);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = async () => {
    await Promise.all([load(), app.refreshWhoAmI()]);
  };

  return (
    <section className="card" aria-label="端末">
      <h2>端末（スマホ・PC）と入力者の紐づけ</h2>
      <p className="muted small">
        この画面を開いた端末（ブラウザ）は自動で一覧に載ります。端末を人に紐づけると、その端末では名前を選ばなくてもその人として記録します。
        スマホのように IP アドレスが変わる端末でも有効です（端末の紐づけは IP の紐づけより優先）。
      </p>
      {error && <div className="error-box">{error}</div>}
      {devices.length === 0 ? (
        <p className="muted">まだ端末の記録がありません。</p>
      ) : (
        <div className="table-scroll">
          <table className="audit-table devices-table" data-testid="devices">
            <thead>
              <tr>
                <th>端末</th>
                <th>最後の利用</th>
                <th>IP</th>
                <th className="num">名前なし</th>
                <th>入力者・メモ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <DeviceRow key={d.id} device={d} users={users} isMine={d.id === myDeviceId} onChanged={afterChange} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        ※ 端末はブラウザごとに区別します。同じスマホでも別のブラウザ・プライベートブラウズ、ブラウザのデータ（Cookie）を消した場合は別の端末として載ります。
        サーバーPC本体のように複数の人が使う端末は紐づけないでください。
      </p>
    </section>
  );
}

function DeviceRow({ device, users, isMine, onChanged }: { device: Device; users: User[]; isMine: boolean; onChanged: () => Promise<void> }) {
  const app = useApp();
  const [userId, setUserId] = useState(device.userId === null ? "" : String(device.userId));
  const [note, setNote] = useState(device.note);
  const [busy, setBusy] = useState(false);
  const dirty = userId !== (device.userId === null ? "" : String(device.userId)) || note.trim() !== device.note;
  // 無効化された人に紐づいている場合も選択肢に出す（表示が空にならないように）
  const options = device.userId !== null && !users.some((u) => u.id === device.userId)
    ? [...users, { id: device.userId, name: `${device.userName}（無効）`, active: false, ips: [] }]
    : users;

  const save = async () => {
    setBusy(true);
    try {
      await api.linkDevice(device.id, userId === "" ? null : Number(userId), note, app.userName);
      app.toast(userId === "" ? "端末の紐づけを解除しました" : "端末を紐づけました");
      await onChanged();
    } catch (e) {
      app.toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`端末「${device.label}${device.note ? `（${device.note}）` : ""}」を一覧から削除しますか？\n（過去の履歴は残ります。次にこの端末から開くと、また一覧に載ります）`)) return;
    setBusy(true);
    try {
      await api.deleteDevice(device.id, app.userName);
      app.toast("端末を一覧から削除しました");
      await onChanged();
    } catch (e) {
      app.toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={isMine ? "mine" : ""}>
      <td>
        {device.label}
        {isMine && <span className="tag-label this-device">この端末</span>}
        <div className="muted small" title={device.id}>
          ID {device.id.slice(0, 8)}…（{device.firstSeen.slice(0, 10)}〜）
        </div>
      </td>
      <td>{shortDateTime(device.lastSeen)}</td>
      <td>{device.lastIp}</td>
      <td className="num">{device.unnamedCount > 0 ? device.unnamedCount : ""}</td>
      <td>
        <div className="device-link">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="紐づける入力者" className="plain-select" disabled={busy}>
            <option value="">（紐づけなし）</option>
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={Rules.userIpNoteMaxLength}
            placeholder="メモ（例: 鈴木のiPhone）"
            aria-label="端末のメモ"
            disabled={busy}
          />
        </div>
      </td>
      <td className="device-actions">
        <button type="button" className="button small primary" onClick={() => void save()} disabled={busy || !dirty}>
          保存
        </button>
        <button type="button" className="button small" onClick={() => void remove()} disabled={busy}>
          削除
        </button>
      </td>
    </tr>
  );
}
