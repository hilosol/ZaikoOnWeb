import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Rules, type ImportResult, type UnassignedIp, type User } from "../../../shared/types";
import { api, ApiError, errorMessage } from "../api";
import { shortDateTime } from "../components/common";
import { useApp } from "../context";
import { UpdateSection, useUpdateStatus } from "../update";
import { BackupSection } from "./BackupSection";
import { DevicesSection } from "./DevicesSection";
import { LogExportSection } from "./LogExportSection";
import { MailSettingsSection } from "./MailSettingsSection";
import { OrderListSection } from "./OrderListSection";

export function SettingsPage() {
  // プログラムの更新はサーバーPCの画面にだけ出す（他の端末では status が null）
  const update = useUpdateStatus();
  const updateStatus = update.status;
  const menu = updateStatus ? [...SECTIONS, { id: UPDATE_SECTION_ID, label: "プログラムの更新" }] : SECTIONS;
  return (
    <div className="settings">
      <SettingsMenu sections={menu} />
      {SECTIONS.map(({ id, Component }) => (
        <div key={id} id={id} className="settings-anchor">
          <Component />
        </div>
      ))}
      {updateStatus && (
        <div id={UPDATE_SECTION_ID} className="settings-anchor">
          <UpdateSection status={updateStatus} onChange={update.setStatus} />
        </div>
      )}
    </div>
  );
}

/** 設定の項目（上のメニューの順・表示名）。項目を増やすときはここに足す */
interface SettingsSectionDef {
  id: string;
  label: string;
  Component: ComponentType;
}

const UPDATE_SECTION_ID = "settings-update";

const SECTIONS: SettingsSectionDef[] = [
  { id: "settings-users", label: "入力者", Component: UsersSection },
  { id: "settings-devices", label: "端末", Component: DevicesSection },
  { id: "settings-stock-csv", label: "在庫データ（CSV）", Component: StockCsvSection },
  { id: "settings-order-list", label: "紐づけIDリスト", Component: OrderListSection },
  { id: "settings-log-export", label: "履歴のCSV保存", Component: LogExportSection },
  { id: "settings-backup", label: "バックアップ", Component: BackupSection },
  { id: "settings-mail", label: "メール通知", Component: MailSettingsSection },
  { id: "settings-access", label: "サーバーPC IP", Component: AccessSection },
];

/**
 * 設定画面の上に出す項目のメニュー（画面上部に固定）。押すとその項目へ移動する。
 * 画面上部の見出し（app-header）とこのメニューに隠れない位置までスクロールする。
 * URL の # は画面の切り替えに使っているため、リンクではなくスクロールで移動する。
 */
function SettingsMenu({ sections }: { sections: Pick<SettingsSectionDef, "id" | "label">[] }) {
  const menuRef = useRef<HTMLElement>(null);
  const [top, setTop] = useState(0);

  // 画面上部の見出しの高さ（スマホでは折り返して変わる）のすぐ下に固定する
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".app-header");
    if (!header) return;
    const update = () => setTop(header.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  const [active, setActive] = useState(sections[0]?.id ?? "");
  const ids = sections.map((x) => x.id).join(",");

  /** 見出しとメニューに隠れずに見え始める位置 */
  const offset = () => (document.querySelector<HTMLElement>(".app-header")?.offsetHeight ?? 0) + (menuRef.current?.offsetHeight ?? 0) + 16;

  // スクロールに合わせて、いま見ている項目をメニューで強調する
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = offset();
      let current = ids.split(",")[0] ?? "";
      for (const id of ids.split(",")) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      // 一番下までスクロールしたら最後の項目
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = ids.split(",").at(-1) ?? current;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids]);

  // 強調した項目がメニューの外（スマホで横スクロール）に出たら見える位置へ
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(`[data-target="${active}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const jump = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - offset() + 8, behavior: "smooth" });
  };
  return (
    <nav ref={menuRef} className="settings-menu" style={{ top }} aria-label="設定の項目">
      <div className="settings-menu-inner">
        {sections.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            data-target={id}
            className={`settings-menu-item${active === id ? " active" : ""}`}
            aria-current={active === id ? "true" : undefined}
            onClick={() => jump(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

/**
 * 入力者の管理（名前を選ぶだけの簡易方式。誰がどの端末から操作したかは IP でも記録される）。
 * 端末の IP を入力者に紐づけると、その端末で入力者を選ばずに操作しても、その人として記録する。
 */
function UsersSection() {
  const app = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedIp[]>([]);
  const [myIp, setMyIp] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // IP の紐づけフォーム
  const [linkUserId, setLinkUserId] = useState("");
  const [linkIp, setLinkIp] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, un] = await Promise.all([api.users(true), api.unassignedIps()]);
      setUsers(u);
      setUnassigned(un);
    } catch (e) {
      app.toast(errorMessage(e), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
    api
      .whoami()
      .then((r) => setMyIp(r.ip))
      .catch(() => setMyIp(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const afterChange = async () => {
    await Promise.all([load(), app.refreshUsers(), app.refreshWhoAmI()]);
  };

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await action();
      app.toast(message);
      await afterChange();
      return true;
    } catch (e) {
      app.toast(errorMessage(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    if (await run(() => api.createUser(name, app.userName), `「${name}」を追加しました`)) setNewName("");
  };

  const rename = (u: User) => {
    const name = window.prompt("新しい名前", u.name)?.trim();
    if (!name || name === u.name) return;
    void run(() => api.updateUser(u.id, { name }, app.userName), `「${name}」に変更しました`);
  };

  const toggle = (u: User) => {
    if (u.active && !window.confirm(`「${u.name}」を無効にしますか？\n（入力者の選択肢に表示されなくなります。過去の履歴は残ります。IP の紐づけも使われなくなります）`)) return;
    void run(() => api.updateUser(u.id, { active: !u.active }, app.userName), u.active ? `「${u.name}」を無効にしました` : `「${u.name}」を有効にしました`);
  };

  const link = async () => {
    const userId = Number(linkUserId);
    const ip = linkIp.trim();
    if (!userId) {
      setLinkError("紐づける入力者を選んでください。");
      return;
    }
    if (!ip) {
      setLinkError("IP アドレスを入力してください。");
      return;
    }
    const user = users.find((u) => u.id === userId);
    setBusy(true);
    setLinkError(null);
    try {
      try {
        await api.linkUserIp(userId, ip, linkNote, false, app.userName);
      } catch (e) {
        // 別の人に紐づいている → 確認して付け替える
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        if (!window.confirm(`${e.message}\n「${user?.name ?? ""}」に付け替えますか？`)) return;
        await api.linkUserIp(userId, ip, linkNote, true, app.userName);
      }
      app.toast(`${ip} を「${user?.name ?? ""}」に紐づけました`);
      setLinkIp("");
      setLinkNote("");
      await afterChange();
    } catch (e) {
      setLinkError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = (u: User, ip: string) => {
    if (!window.confirm(`${ip} と「${u.name}」の紐づけを解除しますか？`)) return;
    void run(() => api.unlinkUserIp(ip, app.userName), `${ip} の紐づけを解除しました`);
  };

  const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.");
  const myIpLinkedTo = users.find((u) => u.ips.some((x) => x.ip === myIp));
  const activeUsers = users.filter((u) => u.active);

  return (
    <section className="card" aria-label="入力者">
      <h2>入力者</h2>
      <p className="muted small">
        入出庫や商品の登録をする人の名前です。各端末で選択し、履歴に端末のIPアドレスと一緒に記録されます。
        端末のIPアドレスを紐づけると、その端末では名前を選ばなくても、その人として記録します。
      </p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          type="text"
          placeholder="名前を追加"
          value={newName}
          maxLength={Rules.userNameMaxLength}
          onChange={(e) => setNewName(e.target.value)}
          aria-label="追加する名前"
        />
        <button type="submit" className="button primary" disabled={busy || !newName.trim()}>
          追加
        </button>
      </form>
      {users.length === 0 ? (
        <p className="muted">まだ登録されていません。</p>
      ) : (
        <ul className="user-list">
          {users.map((u) => (
            <li key={u.id} className={u.active ? "" : "inactive"}>
              <div className="user-line">
                <span className="name">{u.name}</span>
                {!u.active && <span className="tag">無効</span>}
                <span className="spacer" />
                <button type="button" className="button small" onClick={() => rename(u)} disabled={busy}>
                  名前変更
                </button>
                <button type="button" className="button small" onClick={() => toggle(u)} disabled={busy}>
                  {u.active ? "無効にする" : "有効にする"}
                </button>
              </div>
              {u.ips.length > 0 && (
                <ul className="ip-chips" aria-label={`${u.name}の端末`}>
                  {u.ips.map((x) => (
                    <li key={x.ip} className="ip-chip">
                      <span className="tag-label">IP</span>
                      {x.ip}
                      {x.note && <span className="muted">（{x.note}）</span>}
                      {x.ip === myIp && <span className="muted">← この端末</span>}
                      <button type="button" className="ip-chip-remove" onClick={() => unlink(u, x.ip)} disabled={busy} aria-label={`${x.ip} の紐づけを解除`}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {activeUsers.length > 0 && (
        <div className="ip-link">
          <h3>IPアドレスで紐づける（PC など IP が変わらない端末向け。スマホは下の「端末」で紐づけ）</h3>
          <form
            className="ip-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              void link();
            }}
          >
            <select value={linkUserId} onChange={(e) => setLinkUserId(e.target.value)} aria-label="紐づける入力者">
              <option value="">入力者を選択</option>
              {activeUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <input type="text" value={linkIp} onChange={(e) => setLinkIp(e.target.value)} placeholder="例: 192.168.1.23" aria-label="IPアドレス" spellCheck={false} />
            <input
              type="text"
              value={linkNote}
              onChange={(e) => setLinkNote(e.target.value)}
              placeholder="メモ（例: iPhone）"
              maxLength={Rules.userIpNoteMaxLength}
              aria-label="端末のメモ"
            />
            <button type="submit" className="button primary" disabled={busy}>
              紐づけ
            </button>
          </form>
          {linkError && <div className="error-box">{linkError}</div>}
          <p className="muted small">
            この端末のIPアドレス：<b>{myIp || "不明"}</b>
            {myIp && !isLoopback(myIp) && !myIpLinkedTo && (
              <button type="button" className="button small inline-button" onClick={() => setLinkIp(myIp)}>
                この端末を入力
              </button>
            )}
            {myIpLinkedTo && `（「${myIpLinkedTo.name}」に紐づけ済み）`}
            {myIp && isLoopback(myIp) && "（サーバーPC本体は複数の人が使うため紐づけできません）"}
          </p>

          {unassigned.length > 0 && (
            <>
              <h3>名前なしで記録された端末</h3>
              <p className="muted small">入力者を選ばずに入出庫した端末です。誰の端末か分かれば紐づけてください（過去の履歴は変わりません）。</p>
              <table className="audit-table" data-testid="unassigned-ips">
                <thead>
                  <tr>
                    <th>IPアドレス</th>
                    <th className="num">件数</th>
                    <th>最後の操作</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {unassigned.map((x) => (
                    <tr key={x.ip}>
                      <td>{x.ip}</td>
                      <td className="num">{x.count}</td>
                      <td>{shortDateTime(x.lastAt)}</td>
                      <td>
                        <button type="button" className="button small" onClick={() => setLinkIp(x.ip)}>
                          この IP を入力
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="muted small">
            ※ スマホ・PCのIPアドレスはルーターの設定（DHCP）で変わることがあります。確実にするには、ルーターで端末ごとにIPアドレスを固定（予約）してください。
            スマホは「プライベートWi-Fiアドレス」の設定によっても変わる場合があります。
          </p>
        </div>
      )}
    </section>
  );
}

/** スマホから開くためのアドレスと QR コード */
function AccessSection() {
  const [urls, setUrls] = useState<{ url: string; qr: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const info = await api.serverInfo();
        // スマホにはスマホ用画面（/m）を案内する
        const mobileUrls = info.urls.map((u) => `${u}/m`);
        setUrls(await Promise.all(mobileUrls.map(async (url) => ({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 180 }) }))));
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);

  return (
    <section className="card">
      <h2>サーバーPC IP</h2>
      <p className="muted small">
        同じローカルネットワーク（Wi-Fi）に接続したスマホのカメラで読み取ると、スマホ用画面（ID入力・QR読み取り → 入庫・移管・出庫）が開きます。
        ホーム画面に追加するとアプリのように使えます。
      </p>
      {error && <div className="error-box">{error}</div>}
      <div className="qr-list">
        {urls.map(({ url, qr }) => (
          <figure key={url}>
            <img src={qr} alt={`${url} の QR コード`} width={180} height={180} />
            <figcaption>{url}</figcaption>
          </figure>
        ))}
        {urls.length === 0 && !error && <p className="muted">ローカルネットワークのアドレスが見つかりません。</p>}
      </div>
    </section>
  );
}

/**
 * CSV ファイルの文字コードを判別して読み込む。
 * Excel で「CSV（コンマ区切り）」保存すると Shift_JIS、「CSV UTF-8」保存や本アプリの出力は UTF-8 になる。
 */
export async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

/** 在庫データ（商品マスタ＋在庫数）の CSV 出力・取り込み */
function StockCsvSection() {
  const app = useApp();
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCsv(null);
    setPreview(null);
    setFileName("");
    setError(null);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const userName = app.requireUser();
    if (!userName) return;
    reset();
    if (file.size > Rules.maxImportBytes) {
      setError(`ファイルが大きすぎます（${Rules.maxImportBytes / 1024 / 1024}MBまで）。`);
      return;
    }
    setBusy(true);
    try {
      const text = await readCsvFile(file);
      setFileName(file.name);
      setCsv(text);
      setPreview(await api.importProducts(text, true, userName));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!csv || !preview) return;
    const userName = app.requireUser();
    if (!userName) return;
    if (!window.confirm(`新規 ${preview.created}件・更新 ${preview.updated}件を取り込みます。よろしいですか？`)) return;
    setBusy(true);
    try {
      const r = await api.importProducts(csv, false, userName);
      if (r.errors.length > 0) {
        // 確認後に他の人が変更して、エラーになった場合
        setPreview(r);
        setError("エラーがあるため取り込みませんでした。内容を確認してください。");
        return;
      }
      app.toast(`取り込みました（新規 ${r.created}件・更新 ${r.updated}件・在庫調整 ${r.stockAdjusted}件）`);
      reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const changed = preview ? preview.rows.filter((r) => r.action !== "unchanged") : [];
  const canApply = !!preview && preview.errors.length === 0 && changed.length > 0;

  return (
    <section className="card">
      <h2>在庫データ（CSV）</h2>
      <p className="muted small">
        商品と在庫数を CSV で出力・取り込みできます。出力した CSV を Excel で編集して取り込むと、まとめて登録・修正できます。
        在庫数が現在と違う場合は、CSV の数に合わせて「棚卸調整」として履歴に残します。CSV に無い商品は削除されません。
      </p>
      <div className="csv-actions">
        <a className="button" href="/api/products.csv" download>
          在庫一覧をCSV出力
        </a>
        <label className={`button primary${busy ? " disabled" : ""}`}>
          CSVを取り込む…
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            disabled={busy}
            data-testid="csv-input"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <p className="muted small">
        列: 商品コード（必須）・商品名（新規は必須）・概要・カテゴリ・保管場所・在庫・警告在庫・備考・簿外（○ か空欄）。無い列の項目は変更しません。文字コードは
        UTF-8・Shift_JIS どちらも可。
      </p>

      {busy && <p className="muted">確認中…</p>}
      {error && <div className="error-box">{error}</div>}

      {preview && (
        <div className="import-preview">
          <h3>取り込み内容の確認：{fileName}</h3>
          <div className="import-summary">
            <span>新規 <b>{preview.created}</b> 件</span>
            <span>更新 <b>{preview.updated}</b> 件（うち在庫調整 {preview.stockAdjusted} 件）</span>
            <span>変更なし {preview.unchanged} 件</span>
            <span className={preview.errors.length ? "danger" : ""}>エラー <b>{preview.errors.length}</b> 件</span>
          </div>
          <p className="muted small">
            使う列: {preview.columns.map((c) => (c.header === c.field ? c.field : `${c.header}→${c.field}`)).join("、")}
            {preview.ignoredColumns.length > 0 && <>　／　使わない列: {preview.ignoredColumns.join("、")}</>}
          </p>

          {preview.errors.length > 0 && (
            <div className="error-box">
              <b>エラーがあるため取り込めません。CSV を修正して選び直してください。</b>
              <ul>
                {preview.errors.slice(0, 50).map((e) => (
                  <li key={e.line}>
                    {e.line}行目{e.code && `（${e.code}）`}: {e.messages.join(" ")}
                  </li>
                ))}
              </ul>
              {preview.errors.length > 50 && <div>ほか {preview.errors.length - 50} 件</div>}
            </div>
          )}

          {changed.length > 0 && (
            <div className="table-scroll import-table">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>行</th>
                    <th>商品コード</th>
                    <th>区分</th>
                    <th>内容</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.slice(0, 200).map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td>
                      <td className="nowrap">{r.code}</td>
                      <td className="nowrap">{r.action === "create" ? "新規" : "更新"}</td>
                      <td>{r.changes.join(" / ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {changed.length > 200 && <p className="muted small">ほか {changed.length - 200} 件</p>}
            </div>
          )}
          {preview.errors.length === 0 && changed.length === 0 && <p className="muted">変更はありません。</p>}

          <div className="m-dialog-actions">
            <button type="button" className="button" onClick={reset} disabled={busy}>
              やめる
            </button>
            <button type="button" className="button primary" onClick={() => void apply()} disabled={!canApply || busy}>
              取り込む
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
