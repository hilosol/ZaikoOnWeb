import { useEffect, useState } from "react";
import {
  BACKUP_LOW_FREE_BYTES,
  DailyRetentionLabels,
  DefaultBackupSettings,
  MONTH_END,
  MonthlyRetentionLabels,
  monthlyDayLabel,
  type BackupPlaceStatus,
  type BackupSettings,
  type BackupView,
  type DailyRetention,
  type MonthlyRetention,
} from "../../../shared/types";
import { api, errorMessage } from "../api";
import { shortDateTime } from "../components/common";
import { useApp } from "../context";

const DAILY = Object.keys(DailyRetentionLabels) as DailyRetention[];
const MONTHLY = Object.keys(MonthlyRetentionLabels) as MonthlyRetention[];
/** 1〜28日、月末 */
const MONTHLY_DAYS = [
  ...Array.from({ length: 28 }, (_, i) => i + 1),
  MONTH_END,
];

/** 1,234,567 → "1.2 MB" */
export function formatBytes(n: number | null): string {
  if (n === null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** バックアップの設定（残す期間・追加の保存先）と状態 */
export function BackupSection() {
  const app = useApp();
  const [view, setView] = useState<BackupView | null>(null);
  /** 画面で編集中の設定（保存するまでサーバーには反映しない） */
  const [draft, setDraft] = useState<BackupSettings>(DefaultBackupSettings);
  const set = <K extends keyof BackupSettings>(
    key: K,
    value: BackupSettings[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));
  const extraDir = draft.extraDir;
  const setExtraDir = (v: string) => set("extraDir", v);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  const apply = (v: BackupView) => {
    setView(v);
    setDraft(v.settings);
  };

  useEffect(() => {
    api.backup().then(apply, (e) => setError(errorMessage(e)));
  }, []);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      const userName = app.userName;
      const v = await api.saveBackupSettings(draft, userName);
      apply(v);
      setTest(null);
      app.toast(
        v.extra && v.extra.lastOk === false
          ? "保存しましたが、追加の保存先に書き込めませんでした"
          : "バックアップの設定を保存しました",
        v.extra?.lastOk === false ? "error" : undefined,
      );
    });

  const changed =
    view !== null &&
    (Object.keys(draft) as (keyof BackupSettings)[]).some((k) =>
      k === "extraDir"
        ? draft.extraDir.trim() !== view.settings.extraDir
        : draft[k] !== view.settings[k],
    );
  const unlimited =
    draft.daily === "unlimited" ||
    (draft.monthlyEnabled && draft.monthly === "unlimited");

  return (
    <section className="card" aria-label="バックアップ">
      <h2>バックアップ（自動）</h2>
      <p className="muted small">
        1日1回、在庫・履歴のデータベースをサーバーPC内に保存します。追加の保存先（外付けドライブ・USB
        メモリ）を指定すると、そこにもデータベースと商品写真をコピーします（写真は増えた・変わった分だけ）。
      </p>
      {error && <div className="error-box">{error}</div>}
      {view && (
        <>
          <div className="backup-form">
            <label className="field">
              <span>毎日の分を残す期間</span>
              <select
                className="plain-select"
                value={draft.daily}
                onChange={(e) => set("daily", e.target.value as DailyRetention)}
                disabled={busy}
                aria-label="毎日の分を残す期間"
              >
                {DAILY.map((r) => (
                  <option key={r} value={r}>
                    {DailyRetentionLabels[r]}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="backup-monthly">
              <legend>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.monthlyEnabled}
                    onChange={(e) => set("monthlyEnabled", e.target.checked)}
                    disabled={busy}
                  />
                  月1回の分も残す
                </label>
              </legend>
              <div className="backup-monthly-row">
                <label>
                  残す日{" "}
                  <select
                    className="plain-select"
                    value={draft.monthlyDay}
                    onChange={(e) => set("monthlyDay", Number(e.target.value))}
                    disabled={busy || !draft.monthlyEnabled}
                    aria-label="月1回の分を残す日"
                  >
                    {MONTHLY_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {monthlyDayLabel(d)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  残す期間{" "}
                  <select
                    className="plain-select"
                    value={draft.monthly}
                    onChange={(e) =>
                      set("monthly", e.target.value as MonthlyRetention)
                    }
                    disabled={busy || !draft.monthlyEnabled}
                    aria-label="月1回の分を残す期間"
                  >
                    {MONTHLY.map((r) => (
                      <option key={r} value={r}>
                        {MonthlyRetentionLabels[r]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="muted small">
                例：毎日の分 30日分 ＋ 月末の分を無制限 →
                直近1か月は毎日、それより前は各月末の状態に戻せます。その日の分が無い月（サーバーPCが止まっていた等）は、それ以降で最初の分を残します。
              </p>
            </fieldset>
            {unlimited && (
              <p className="warning-note" data-testid="unlimited-note">
                「無制限」は古いバックアップを消さないため、保存先の空き容量が少しずつ減ります。下の「合計」と「空き」を時々確認してください（空きが
                1GB を切ると画面の上に警告が出ます）。
              </p>
            )}
            <label className="field">
              <span>追加の保存先（任意）</span>
              <input
                type="text"
                value={extraDir}
                onChange={(e) => {
                  setExtraDir(e.target.value);
                  setTest(null);
                }}
                placeholder="例: E:\zaiko-backup（空欄ならサーバーPC内だけ）"
                maxLength={200}
                disabled={busy}
                aria-label="追加の保存先"
              />
            </label>
            <p className="muted small">
              外付けドライブ・USB
              メモリのフォルダを指定します（ネットワークの場所・NAS
              は指定できません）。ドライブ文字が変わらないよう、Windows
              の「ディスクの管理」で固定しておくと確実です。
            </p>
            <div className="csv-actions">
              <button
                type="button"
                className="button"
                disabled={busy || extraDir.trim() === ""}
                onClick={() =>
                  void act(async () =>
                    setTest(await api.testBackupDir(extraDir)),
                  )
                }
              >
                書き込みテスト
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || !changed}
                onClick={() => void save()}
              >
                保存
              </button>
            </div>
            {test && (
              <div
                className={test.ok ? "ok-box" : "error-box"}
                data-testid="backup-test-result"
              >
                {test.message}
              </div>
            )}
          </div>

          <div className="backup-places">
            <PlaceStatus title="サーバーPC内" place={view.local} />
            {view.extra && (
              <PlaceStatus title="追加の保存先" place={view.extra} />
            )}
          </div>
          <div className="csv-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void act(async () => apply(await api.runBackup()))}
            >
              {busy ? "実行中…" : "今すぐバックアップ"}
            </button>
          </div>
          <p className="muted small">
            同じ日のデータベースは1日1回だけ保存します（「今すぐバックアップ」は、今日の分がまだ無いとき・追加の保存先へのコピーが残っているときに実行されます）。
          </p>
        </>
      )}
    </section>
  );
}

function PlaceStatus({
  title,
  place,
}: {
  title: string;
  place: BackupPlaceStatus;
}) {
  const lowFree =
    place.freeBytes !== null && place.freeBytes < BACKUP_LOW_FREE_BYTES;
  return (
    <div className="backup-place" data-testid={`backup-place-${title}`}>
      <h3>{title}</h3>
      <dl className="log-export">
        <dt>場所</dt>
        <dd>
          <code>{place.dir}</code>
        </dd>
        <dt>最後の実行</dt>
        <dd className={place.lastOk === false ? "danger-text" : ""}>
          {place.lastAttemptAt
            ? `${shortDateTime(place.lastAttemptAt)}・${place.lastOk ? "成功" : "失敗"}`
            : "まだありません"}
          {place.lastMessage && `：${place.lastMessage}`}
        </dd>
        {place.lastOk === false && (
          <>
            <dt>最後の成功</dt>
            <dd>
              {place.lastSuccessAt
                ? shortDateTime(place.lastSuccessAt)
                : "まだありません"}
            </dd>
          </>
        )}
        <dt>合計</dt>
        <dd>
          {place.count === null
            ? "読み取れません"
            : `${place.count} 件・${formatBytes(place.totalBytes)}`}
        </dd>
        <dt>空き</dt>
        <dd className={lowFree ? "danger-text" : ""}>
          {formatBytes(place.freeBytes)}
          {lowFree && "（残りわずかです）"}
        </dd>
      </dl>
    </div>
  );
}

/** バックアップに失敗しているとき、全画面の上に出す警告（PC用画面） */
export function BackupWarning({ onOpen }: { onOpen: () => void }) {
  const [view, setView] = useState<BackupView | null>(null);
  useEffect(() => {
    const load = () => api.backup().then(setView, () => undefined);
    load();
    const id = window.setInterval(load, 30 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!view) return null;
  const failed = [view.local, view.extra].find((p) => p && p.lastOk === false);
  const low = [view.local, view.extra].find(
    (p) => p && p.freeBytes !== null && p.freeBytes < BACKUP_LOW_FREE_BYTES,
  );
  if (!failed && !low) return null;
  return (
    <div className="backup-warning" role="alert">
      {failed
        ? `バックアップを保存できていません（${failed === view.local ? "サーバーPC内" : "追加の保存先"}・最後の成功: ${failed.lastSuccessAt ? shortDateTime(failed.lastSuccessAt) : "なし"}）。`
        : "バックアップの保存先の空き容量が残りわずかです。"}
      <button type="button" className="button small" onClick={onOpen}>
        確認する
      </button>
    </div>
  );
}
