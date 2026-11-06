// 在庫管理 Web 版のブラウザ動作確認（PC幅・スマホ幅）
// 実行: npm run build のあと node e2e/e2e.cjs（Playwright と Chromium が必要: npx playwright install chromium）
// EXTERNAL_IP を指定すると、そのアドレス（社内用でないアドレス）からの接続が 403 になることも確認する
const { chromium } = require("playwright");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const os = require("node:os");
const { startSmtpSink } = require("./smtp-sink.cjs");
const SMTP_PORT = 2526;
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(os.tmpdir(), "zaiko-e2e-data");
const UPDATE_ROOT = path.join(os.tmpdir(), "zaiko-e2e-update-root");
const EXTRA_BACKUP = path.join(os.tmpdir(), "zaiko-e2e-extra-backup");
const SHOTS = path.join(__dirname, "shots");
const A = (f) => path.join(__dirname, "assets", f);
const PORT = 8090;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function registerProduct(page, { code, name, category, initial, warning, image, location }) {
  await page.getByRole("button", { name: "商品登録", exact: true }).first().click();
  await page.locator(".field:has-text('商品コード') input").fill(code);
  await page.getByLabel("商品名（必須）").fill(name);
  await page.getByLabel("カテゴリ").fill(category);
  if (location) await page.getByLabel("保管場所").fill(location);
  await page.getByLabel("初期在庫").fill(String(initial));
  await page.getByLabel("警告在庫").fill(String(warning));
  if (image) {
    await page.setInputFiles('[data-testid="image-input"]', A(image));
    await page.locator(".drop-zone img").waitFor();
  }
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".toast", { hasText: `「${name}」を登録しました` }).waitFor();
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(UPDATE_ROOT, { recursive: true, force: true });
  fs.rmSync(EXTRA_BACKUP, { recursive: true, force: true });
  fs.mkdirSync(path.join(UPDATE_ROOT, ".git"), { recursive: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  // 紐づけIDリスト link-ids.txt（PowerShell の Set-Content 既定の Shift_JIS で作られた場合を想定して UTF-8 以外でも読めるか確認するため、ここでは BOM 付き UTF-8）
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    path.join(DATA, "link-ids.txt"),
    "\uFEFFAWO-26008_湖北工業_AW610M\r\nYHO-26002_京都大学_HMP-400\r\nYHO-26042_キオクシア_高温プローバー\r\n",
  );
  const server = spawn("node", ["--disable-warning=ExperimentalWarning", path.join(ROOT, "dist/server.mjs")], {
    // 画面からの更新は、本物の GitHub に接続しないよう中身の無い .git フォルダを相手にする
    env: { ...process.env, ZAIKO_PORT: String(PORT), ZAIKO_DATA_DIR: DATA, ZAIKO_UPDATE_ROOT: UPDATE_ROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOut = "";
  server.stdout.on("data", (d) => (serverOut += d));
  server.stderr.on("data", (d) => (serverOut += d));

  const smtp = await startSmtpSink(SMTP_PORT);
  try {
    await waitHealthy();

    // ================================================================ PC（localhost = 安全なコンテキスト。カメラは偽装映像）
    const desktopBrowser = await chromium.launch({
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${A("qr_A001.mjpeg")}`],
    });
    const ctx = await desktopBrowser.newContext({ viewport: { width: 1366, height: 860 }, locale: "ja-JP" });
    await ctx.grantPermissions(["camera"], { origin: `http://localhost:${PORT}` });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    const base = `http://localhost:${PORT}`;

    await page.goto(base);
    await page.getByText("入力者が登録されていません").waitFor();
    check("初回は入力者の登録を案内する", true);
    await page.getByRole("button", { name: "設定画面で登録する" }).click();
    for (const n of ["山田", "鈴木", "佐藤"]) {
      await page.getByLabel("追加する名前").fill(n);
      await page.getByRole("button", { name: "追加", exact: true }).click();
      await page.locator(".toast", { hasText: `「${n}」を追加しました` }).waitFor();
    }
    await page.getByRole("button", { name: "在庫一覧" }).click();
    await page.getByRole("dialog", { name: "入力者を選択" }).waitFor();
    check("入力者が未選択なら選択画面が出る", true);
    await page.screenshot({ path: `${SHOTS}/00_user_picker.png` });
    const health = await (await fetch(`${base}/api/health`)).json();
    check("バージョン（ビルド日時）を右上に表示し、サーバーと一致", /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}$/.test(health.version) && (await page.locator(".app-header .app-version").textContent()) === `Ver. ${health.version}`, health.version);
    await page.locator(".user-button", { hasText: "山田" }).click();
    await page.screenshot({ path: `${SHOTS}/01_desktop_empty.png` });

    await registerProduct(page, { code: "A001", name: "りんご", category: "果物", initial: 12, warning: 3, image: "apple.jpg", location: "上段A-1,上段B-1" });
    await registerProduct(page, { code: "B001", name: "オレンジ", category: "果物", initial: 2, warning: 3, image: "orange.jpg" });
    await registerProduct(page, { code: "C001", name: "レモン（縦長写真）", category: "果物", initial: 30, warning: 5, image: "lemon_exif6.jpg" });
    await registerProduct(page, { code: "4901234567894", name: "青い箱（透過PNG）", category: "資材", initial: 5, warning: 1, image: "box.png" });
    await registerProduct(page, { code: "X100", name: "画像なし商品", category: "", initial: 0, warning: 0 });
    check("商品を5件登録できる", (await page.locator(".product-row:not(.header)").count()) === 5);
    check("登録後は在庫一覧（初期画面）に戻る", (await page.evaluate(() => location.hash)) === "#/" && (await page.locator(".product-list").isVisible()));

    // 入力エラー（全角の重複コード・必須漏れ・壊れた画像）
    await page.getByRole("button", { name: "商品登録", exact: true }).first().click();
    await page.locator(".field:has-text('商品コード') input").fill("Ａ００１");
    await page.getByLabel("商品名（必須）").fill("重複");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".error-box", { hasText: "既に登録" }).waitFor();
    check("全角で入力しても重複コードを検出する", true);
    await page.setInputFiles('[data-testid="image-input"]', A("fake.jpg"));
    await page.locator(".error-box", { hasText: "読み込めません" }).waitFor();
    check("画像でないファイルはエラー表示", true);
    await page.locator(".field:has-text('商品コード') input").fill("");
    await page.getByLabel("商品名（必須）").fill("");
    await page.getByRole("button", { name: "保存" }).click();
    check("必須項目のエラーをまとめて表示", (await page.locator(".error-box div").count()) >= 2);
    await page.screenshot({ path: `${SHOTS}/02_desktop_editor_errors.png` });
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "キャンセル" }).click();
    await page.locator(".product-list").waitFor();
    check("未保存の変更があると確認して戻る", true);

    // 入出庫
    await page.locator(".product-row", { hasText: "りんご" }).click();
    await page.getByLabel("数量").fill("3");
    await page.getByLabel("コメント").fill("修理用");
    await page.getByRole("button", { name: "出庫", exact: true }).click();
    await page.locator(".toast", { hasText: "出庫しました" }).last().waitFor();
    check("出庫で在庫が減る（12→9）", (await page.getByTestId("stock-value").textContent()) === "9");
    await page.locator(".history-card .comment", { hasText: "修理用" }).first().waitFor();
    check("PC：履歴にコメントを表示", true);
    check("PC：出庫後はコメント欄を空にする", (await page.getByLabel("コメント").inputValue()) === "");
    await page.getByLabel("数量").fill("１００"); // 全角
    await page.getByRole("button", { name: "出庫", exact: true }).click();
    await page.locator(".toast.error", { hasText: "在庫が不足" }).last().waitFor();
    check("在庫不足の出庫は拒否し在庫は変わらない", (await page.getByTestId("stock-value").textContent()) === "9");
    await page.getByLabel("数量").fill("abc");
    check("数量が不正なら入出庫ボタンを押せない", await page.getByRole("button", { name: "入庫", exact: true }).isDisabled());
    await page.getByLabel("数量").fill("5");
    await page.getByRole("button", { name: "入庫", exact: true }).click();
    await page.locator(".toast", { hasText: "入庫しました" }).last().waitFor();
    check("入庫で在庫が増える（9→14）", (await page.getByTestId("stock-value").textContent()) === "14");

    // 移管（PC）
    const pcOrder = await page.locator(".stock-panel .stock-buttons button").allTextContents();
    check("PC：ボタンの並びは 出庫・移管・入庫（スマホと同じ）", pcOrder.map((t) => t.trim()).join(",") === "出庫,移管,入庫", pcOrder.join(","));
    await page.getByLabel("数量").fill("2");
    await page.locator(".stock-panel").getByRole("button", { name: "移管", exact: true }).click();
    const pcTransfer = page.getByRole("dialog", { name: "移管" });
    await pcTransfer.waitFor();
    await pcTransfer.getByRole("button", { name: "移管する" }).click();
    check("PC：移管先が空なら止める", await pcTransfer.getByText("移管先（人・部署）を入力してください").isVisible());
    await pcTransfer.getByLabel("移管先（人・部署）").fill("品証部 田中");
    await pcTransfer.getByRole("button", { name: "移管する" }).click();
    await page.locator(".toast", { hasText: "移管しました" }).last().waitFor();
    check("PC：移管で在庫が減る（14→12）", (await page.getByTestId("stock-value").textContent()) === "12");
    check("PC：移管の通知に移管先を表示", (await page.locator(".toast", { hasText: "移管しました" }).last().textContent()).includes("移管先 品証部 田中"));
    check("PC：移管後は入力画面を閉じる", (await pcTransfer.count()) === 0);
    await page.locator(".stock-panel .recent", { hasText: "→品証部 田中" }).first().waitFor();
    check("PC：履歴に移管先を表示", true);
    await page.getByLabel("数量").fill("100");
    await page.locator(".stock-panel").getByRole("button", { name: "移管", exact: true }).click();
    await pcTransfer.getByLabel("移管先（人・部署）").fill("品証部 田中");
    await pcTransfer.getByRole("button", { name: "移管する" }).click();
    await page.locator(".toast.error", { hasText: "在庫が不足" }).last().waitFor();
    check("PC：在庫不足の移管は拒否し在庫は変わらない", (await page.getByTestId("stock-value").textContent()) === "12");
    await pcTransfer.getByRole("button", { name: "キャンセル" }).click();
    // 以降の確認のため在庫を 14 に戻す
    await page.getByLabel("数量").fill("2");
    await page.getByRole("button", { name: "入庫", exact: true }).click();
    await page.locator(".toast", { hasText: "入庫しました" }).last().waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid=stock-value]")?.textContent === "14");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/03_desktop_inventory.png` });

    // 在庫調整（棚卸し）
    await page.locator(".product-row", { hasText: "レモン" }).click();
    await page.getByRole("button", { name: "在庫調整" }).click();
    await page.getByLabel("調整後の在庫").fill("27");
    check("在庫調整：差を表示（30→27 で -3）", (await page.getByTestId("adjust-delta").textContent()) === "-3");
    await page.screenshot({ path: `${SHOTS}/31_adjust.png` });
    await page.getByRole("button", { name: "調整する" }).click();
    await page.locator(".toast", { hasText: "30 → 27 に調整しました" }).last().waitFor();
    check("在庫調整：在庫を合わせる", (await page.getByTestId("stock-value").textContent()) === "27");
    await page.locator(".stock-panel .recent .comment", { hasText: "棚卸し（-3）" }).waitFor();
    check("在庫調整：履歴に棚卸調整と理由を残す", true);
    // 画面を開いた後に他の端末で在庫が変わった場合
    await page.getByRole("button", { name: "在庫調整" }).click();
    await page.getByLabel("調整後の在庫").fill("20");
    await page.evaluate(async () => {
      const p = (await (await fetch("/api/products")).json()).find((x) => x.code === "C001");
      await fetch(`/api/products/${p.id}/stock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "OUT", quantity: 1, userName: "山田" }) });
    });
    await page.getByRole("button", { name: "調整する" }).click();
    await page.locator(".modal .error-box", { hasText: "他の端末で入出庫があり" }).waitFor();
    check("在庫調整：他の端末で在庫が変わっていたら上書きしない", (await page.getByTestId("stock-value").textContent()) === "26");
    await page.getByRole("button", { name: "キャンセル" }).click();

    // 画像の向き（EXIF 回転）とサイズ
    const lemon = await page.evaluate(async () => {
      const res = await fetch("/api/products");
      const list = await res.json();
      const p = list.find((x) => x.code === "C001");
      const img = new Image();
      img.src = `/api/images/${p.imageFile}`;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    check("縦長写真（EXIF回転）は縦向き・長辺1024pxで保存", lemon.h === 1024 && lemon.w === 768, JSON.stringify(lemon));

    // カテゴリの絞り込み
    await page.getByLabel("カテゴリで絞り込み").selectOption("果物");
    check("カテゴリで絞り込める（果物 3件）", (await page.locator(".product-row:not(.header)").count()) === 3);
    const catOptions = await page.getByLabel("カテゴリで絞り込み").locator("option").allTextContents();
    check("カテゴリの選択肢に件数と（カテゴリなし）を表示", catOptions.includes("果物（3）") && catOptions.some((o) => o.startsWith("（カテゴリなし）")), catOptions.join(" / "));
    await page.getByLabel("検索").fill("おれんじ");
    check("カテゴリと検索を組み合わせられる", (await page.locator(".product-row:not(.header)").count()) === 1);
    await page.getByLabel("カテゴリで絞り込み").selectOption({ label: "資材（1）" });
    await page.getByRole("button", { name: "絞り込みを解除" }).click();
    check("該当なしの時は絞り込みを解除できる", (await page.locator(".product-row:not(.header)").count()) === 1);
    await page.reload();
    await page.locator(".product-list").waitFor();
    check("カテゴリの選択を記憶する（解除後は「すべて」）", (await page.getByLabel("カテゴリで絞り込み").inputValue()) === "");
    await page.getByLabel("検索").fill("");

    // 検索（全角・小文字）と Enter でのコード一致選択（USB リーダー想定）
    await page.getByLabel("検索").fill("490-1234");
    check("検索はハイフンを無視（490-1234 → 4901234567894）", (await page.locator(".product-row:not(.header)").count()) === 1);
    await page.getByLabel("検索").fill("おれんじ");
    check("検索はひらがな・カタカナを区別しない（おれんじ → オレンジ）", (await page.locator(".product-row:not(.header)").count()) === 1);
    await page.getByLabel("検索").fill("ｂ００");
    check("全角・小文字でも検索できる", (await page.locator(".product-row:not(.header)").count()) === 1);
    await page.getByLabel("検索").fill("4901234567894");
    await page.getByLabel("検索").press("Enter");
    check("コード入力 + Enter で商品を選択", (await page.locator(".stock-panel .name").first().textContent()).includes("青い箱"));

    // 同時編集の衝突
    const page2 = await ctx.newPage();
    const appleId = await page.evaluate(async () => (await (await fetch("/api/products")).json()).find((x) => x.code === "A001").id);
    await page.goto(`${base}/#/products/${appleId}`);
    await page2.goto(`${base}/#/products/${appleId}`);
    await page.getByLabel("商品名（必須）").fill("りんご（青森）");
    await page.getByLabel("備考").fill("棚卸ドル払い\n円払い別");
    await page.getByLabel("概要").fill("青森産の赤いりんご");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".toast", { hasText: "更新しました" }).last().waitFor();
    check("同時編集：先に開いている人がいると「編集中」と表示", (await page2.getByTestId("editing-notice").textContent()).includes("山田さん"));
    await page2.getByLabel("カテゴリ").fill("フルーツ");
    await page2.getByRole("button", { name: "保存" }).click();
    await page2.getByTestId("merge-panel").waitFor();
    check("同時編集：違う項目なら相手の変更を取り込み、自分の変更も残す（選ぶ項目なし）",
      (await page2.getByLabel("商品名（必須）").inputValue()) === "りんご（青森）" &&
        (await page2.getByLabel("カテゴリ").inputValue()) === "フルーツ" &&
        (await page2.locator(".merge-row").count()) === 0 &&
        (await page2.getByTestId("merge-panel").textContent()).includes("商品名"));
    await page2.screenshot({ path: `${SHOTS}/04_desktop_conflict.png` });
    await page2.getByRole("button", { name: "保存" }).click();
    await page2.locator(".toast", { hasText: "更新しました" }).last().waitFor();
    const merged = await page.evaluate(async (id) => (await (await fetch(`/api/products/${id}`)).json()), appleId);
    check("同時編集：取り込んだ内容で保存できる", merged.name === "りんご（青森）" && merged.category === "フルーツ" && merged.note.startsWith("棚卸"));

    // 同じ項目を違う内容に変えた場合は、どちらにするか選ぶ
    await page.goto(`${base}/#/products/${appleId}`);
    await page2.goto(`${base}/#/products/${appleId}`);
    await page.getByLabel("保管場所").fill("上段A-1,上段B-1,下段C");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".toast", { hasText: "更新しました" }).last().waitFor();
    await page2.getByLabel("保管場所").fill("倉庫2");
    await page2.getByLabel("カテゴリ").fill("果物");
    await page2.getByRole("button", { name: "保存" }).click();
    const row = page2.getByTestId("merge-location");
    await row.waitFor();
    check("同時編集：同じ項目がぶつかったら相手の内容・自分の内容を並べて選ばせる",
      (await row.textContent()).includes("上段A-1,上段B-1,下段C") && (await row.textContent()).includes("倉庫2") && (await page2.locator(".merge-row").count()) === 1);
    await page2.waitForTimeout(600);
    await page2.screenshot({ path: `${SHOTS}/04b_desktop_merge.png` });
    await row.getByRole("radio").first().check(); // 相手の内容
    check("同時編集：「相手の内容」を選ぶと入力欄に反映", (await page2.getByLabel("保管場所").inputValue()) === "上段A-1,上段B-1,下段C");
    await page2.getByRole("button", { name: "保存" }).click();
    await page2.locator(".toast", { hasText: "更新しました" }).last().waitFor();
    const chosen = await page.evaluate(async (id) => (await (await fetch(`/api/products/${id}`)).json()), appleId);
    check("同時編集：選んだ内容で保存", chosen.location === "上段A-1,上段B-1,下段C" && chosen.category === "果物", `${chosen.location} / ${chosen.category}`);
    // 閉じたときの知らせは非同期で届くので、少し待つ
    const cleared = await page
      .waitForFunction(async () => Object.keys(await (await fetch("/api/editing")).json()).length === 0, null, { timeout: 5000, polling: 300 })
      .then(() => true, () => false);
    check("編集画面を閉じると「編集中」は消える", cleared);
    await page2.close();

    // PC 画面には「読み取り」「＋商品登録」ボタンを置かない（読み取りは USB リーダー＝検索欄、またはスマホ用画面）
    await page.goto(base);
    await page.locator(".product-list").waitFor();
    check("PC：在庫一覧の上に「読み取り」「＋商品登録」ボタンが無い",
      (await page.locator(".toolbar").getByRole("button", { name: /読み取り|商品登録/ }).count()) === 0);
    await page.locator(".toolbar").screenshot({ path: `${SHOTS}/47_toolbar.png` });

    // カメラ映像からのリアルタイム読み取り（スマホ用画面。localhost は安全なコンテキストなのでライブ方式）
    await page.goto(`${base}/m`);
    await page.getByRole("button", { name: /QRを読み取る/ }).click();
    await page.getByTestId("m-stock").waitFor({ timeout: 15000 });
    check("カメラ映像から QR を読み取って商品を表示（ライブ）", (await page.locator(".m-name").textContent()).includes("りんご"));
    await page.goto(base);
    await page.locator(".product-list").waitFor();

    // カメラの選択（QR が写っていない映像：Chromium の既定のテスト映像）
    const camBrowser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    const camCtx = await camBrowser.newContext({ viewport: { width: 1366, height: 860 } });
    await camCtx.grantPermissions(["camera"], { origin: base });
    const cp = await camCtx.newPage();
    await cp.goto(`${base}/m`);
    await cp.getByRole("button", { name: /QRを読み取る/ }).click();
    await cp.getByLabel("カメラ").waitFor({ timeout: 10000 });
    const camOptions = await cp.getByLabel("カメラ").locator("option").allTextContents();
    check("カメラの選択欄に自動とカメラ名を表示", camOptions.length >= 2 && camOptions[0].startsWith("自動"), camOptions.join(" / "));
    await cp.waitForFunction(() => document.querySelector(".scanner-live video")?.videoWidth > 0, null, { timeout: 10000 });
    check("カメラの映像が表示される", true);
    const deviceId = await cp.getByLabel("カメラ").locator("option").nth(1).getAttribute("value");
    await cp.getByLabel("カメラ").selectOption(deviceId);
    await cp.waitForFunction(() => document.querySelector(".scanner-live video")?.videoWidth > 0, null, { timeout: 10000 });
    check("選んだカメラを記憶する", (await cp.evaluate(() => localStorage.getItem("zaiko.cameraId"))) === deviceId);
    await cp.waitForTimeout(4500);
    check("映像が届いていれば警告を出さない", !(await cp.getByText("映像が届いていません").isVisible()));
    await cp.screenshot({ path: `${SHOTS}/08_camera_select.png` });
    await cp.evaluate(() => localStorage.setItem("zaiko.cameraId", "no-such-camera"));
    await cp.reload();
    await cp.getByRole("button", { name: /QRを読み取る/ }).click();
    await cp.getByText("既定のカメラに切り替えました").waitFor({ timeout: 10000 });
    check("記憶したカメラが無い場合は既定のカメラに戻す", (await cp.evaluate(() => localStorage.getItem("zaiko.cameraId"))) === null);
    // ドライバーが「背面カメラ優先」の指定を受け付けない場合 → 条件なしで再試行して映る
    const fbCtx = await camBrowser.newContext({ viewport: { width: 1366, height: 860 } });
    await fbCtx.grantPermissions(["camera"], { origin: base });
    await fbCtx.addInitScript(() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) =>
        c && c.video && c.video.facingMode ? Promise.reject(new DOMException("facingMode not supported", "OverconstrainedError")) : orig(c);
    });
    const fp = await fbCtx.newPage();
    await fp.goto(`${base}/m`);
    await fp.getByRole("button", { name: /QRを読み取る/ }).click();
    await fp.waitForFunction(() => document.querySelector(".scanner-live video")?.videoWidth > 0, null, { timeout: 10000 });
    check("背面カメラ指定が使えないカメラでも条件なしで再試行して映る", true);
    await camBrowser.close();

    // カメラが無い・起動できない場合 → 原因の詳細と再試行ボタン
    const noCamBrowser = await chromium.launch();
    const ncCtx = await noCamBrowser.newContext({ viewport: { width: 1366, height: 860 } });
    await ncCtx.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Could not start video source", "NotReadableError"));
    });
    const np = await ncCtx.newPage();
    await np.goto(`${base}/m`);
    await np.getByRole("button", { name: /QRを読み取る/ }).click();
    await np.locator(".camera-error code", { hasText: "NotReadableError: Could not start video source" }).waitFor({ timeout: 10000 });
    check("起動できない場合はエラーの詳細と再試行ボタンを表示", await np.getByRole("button", { name: "再試行" }).isVisible());
    await np.screenshot({ path: `${SHOTS}/09_camera_error.png` });
    await noCamBrowser.close();

    // 編集画面（画像付き）＋ 購入元
    await page.locator(".product-row", { hasText: "レモン" }).click();
    await page.getByRole("button", { name: "商品を編集" }).click();
    await page.locator(".drop-zone img").waitFor();
    await page.getByRole("button", { name: "＋ 購入元を追加" }).click();
    await page.getByLabel("購入元1 名前").fill("モノタロウ");
    await page.getByLabel("購入元1 URL").fill("javascript:alert(1)");
    await page.getByRole("button", { name: "＋ 購入元を追加" }).click();
    await page.getByLabel("購入元2 名前").fill("近所の青果店");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".error-box", { hasText: "購入元1件目" }).waitFor();
    check("購入元：http/https 以外の URL は保存できない", true);
    await page.getByLabel("購入元1 URL").fill("www.monotaro.com/g/123/");
    await page.getByRole("button", { name: "＋ 購入元を追加" }).click();
    await page.getByLabel("購入元3 名前").fill("Amazon");
    await page.getByLabel("購入元3 URL").fill("https://www.amazon.co.jp/");
    await page.getByRole("button", { name: "購入元3を上へ" }).click();
    await page.screenshot({ path: `${SHOTS}/05_desktop_editor.png`, fullPage: true });
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".toast", { hasText: "「レモン（縦長写真）」を更新しました" }).waitFor();
    await page.locator(".product-row", { hasText: "レモン" }).click();
    await page.getByTestId("supplier-links").waitFor();
    const supplierLinks = await page.locator("[data-testid=supplier-links] li").evaluateAll((els) =>
      els.map((li) => `${li.textContent.replace("↗", "")}|${li.querySelector("a")?.getAttribute("href") ?? ""}|${li.querySelector("a")?.getAttribute("target") ?? ""}`),
    );
    check(
      "購入元：詳細欄に順番どおり表示し、URL は https を補って別タブのリンクにする",
      supplierLinks.join(",") === "モノタロウ|https://www.monotaro.com/g/123/|_blank,Amazon|https://www.amazon.co.jp/|_blank,近所の青果店||",
      supplierLinks.join(","),
    );
    await page.locator(".stock-panel").screenshot({ path: `${SHOTS}/32_suppliers_panel.png` });

    // 写真の拡大表示（クリックで拡大、Esc で閉じる）
    await page.getByRole("button", { name: "レモン（縦長写真）を拡大" }).click();
    const viewerImg = page.locator(".image-viewer img");
    await viewerImg.waitFor();
    await page.waitForFunction(() => document.querySelector(".image-viewer img")?.complete);
    const zoomBox = await viewerImg.boundingBox();
    check("写真をクリックすると大きく表示する", zoomBox && zoomBox.height > 600, zoomBox && `${Math.round(zoomBox.width)}x${Math.round(zoomBox.height)}`);
    await page.screenshot({ path: `${SHOTS}/37_image_zoom.png` });
    await page.keyboard.press("Escape");
    await viewerImg.waitFor({ state: "detached" });
    check("拡大表示は Esc で閉じる", true);
    await page.getByRole("button", { name: "レモン（縦長写真）を拡大" }).click();
    await page.locator(".image-viewer").click({ position: { x: 20, y: 300 } });
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    check("拡大表示は背景のクリックでも閉じる", true);

    // CSV
    const csv = await (await page.request.get(`${base}/api/histories.csv`)).text();
    check("CSV に入力者と端末IPが出る", csv.startsWith("﻿日時") && csv.includes("山田,127.0.0.1"));

    // ================================================================ スマホ（http + 社内ホスト名 = カメラ映像は使えない環境）
    const mobileBrowser = await chromium.launch({ args: ["--host-resolver-rules=MAP zaiko.local 127.0.0.1"] });
    const mctx = await mobileBrowser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "ja-JP",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });
    const m = await mctx.newPage();
    m.on("pageerror", (e) => consoleErrors.push(String(e)));
    const mbase = `http://zaiko.local:${PORT}`;
    await m.goto(mbase);
    await m.locator(".user-button", { hasText: "鈴木" }).tap();
    await m.locator(".product-list").waitFor();
    await m.waitForTimeout(300);
    await m.screenshot({ path: `${SHOTS}/10_mobile_list.png` });

    await m.locator(".product-row", { hasText: "オレンジ" }).tap();
    await m.getByRole("button", { name: "1増やす" }).tap();
    await m.getByRole("button", { name: "1増やす" }).tap();
    await m.screenshot({ path: `${SHOTS}/11_mobile_sheet.png` });
    await m.getByRole("button", { name: "入庫", exact: true }).tap();
    await m.locator(".toast", { hasText: "入庫しました" }).last().waitFor();
    check("スマホ：＋ボタンで数量3にして入庫（2→5）", (await m.getByTestId("stock-value").textContent()) === "5");
    await m.getByRole("button", { name: "閉じる" }).tap();

    // 写真からの読み取り（スマホ用画面。http のため写真方式）
    await m.goto(`${mbase}/m`);
    await m.getByRole("button", { name: /QRを読み取る/ }).tap();
    await m.locator(".scanner-photo").waitFor();
    check("http 接続では写真から読み取る方式になる", await m.getByText("写真から読み取ります").isVisible());
    await m.screenshot({ path: `${SHOTS}/12_mobile_scanner.png` });
    await m.setInputFiles('[data-testid="scan-photo-input"]', A("ean_known.jpg"));
    await m.getByTestId("m-stock").waitFor();
    check("JAN バーコードの写真から商品を表示", (await m.locator(".m-name").textContent()).includes("青い箱"));

    // 未登録コード（USB リーダー＝検索欄にコード + Enter）→ 新規登録へ
    await m.goto(mbase);
    await m.locator(".product-list").waitFor();
    m.once("dialog", (d) => d.accept());
    await m.getByLabel("検索").fill("4512345678906");
    await m.getByLabel("検索").press("Enter");
    await m.getByRole("heading", { name: "商品登録" }).waitFor();
    const scannedCode = await m.locator(".field:has-text('商品コード') input").inputValue();
    check("未登録コードは新規登録画面にコードを入れて開く", scannedCode === "4512345678906", scannedCode);
    await m.getByLabel("商品名（必須）").fill("新商品（スキャン登録）");
    await m.getByLabel("初期在庫").fill("８"); // 全角
    await m.screenshot({ path: `${SHOTS}/13_mobile_new_from_scan.png`, fullPage: true });
    await m.getByRole("button", { name: "保存" }).tap();
    await m.locator(".toast", { hasText: "登録しました" }).last().waitFor();
    check("スマホから登録できる", true);

    await m.getByRole("tab", { name: /在庫警告/ }).tap();
    await m.screenshot({ path: `${SHOTS}/14_mobile_low.png` });
    await m.getByRole("tab", { name: "履歴" }).tap();
    await m.screenshot({ path: `${SHOTS}/15_mobile_history.png` });

    const hist = await m.evaluate(async () => (await fetch("/api/histories?limit=2")).json());
    check("スマホの操作は入力者「鈴木」で記録", hist.every((h) => h.userName === "鈴木"), hist.map((h) => h.userName).join(","));

    // PC で設定画面
    await page.getByRole("button", { name: "設定" }).click();
    await page.locator("section.mail-settings").waitFor();
    check("設定：操作ログの表は置かない（履歴ページの「操作ログ」で見る）", (await page.getByTestId("audit-log").count()) === 0);
    const menu = page.getByRole("navigation", { name: "設定の項目" });
    check("設定：上に項目のメニュー（サーバーPCの画面ではプログラムの更新も）", (await menu.locator(".settings-menu-item").allTextContents()).join(",") === "入力者,端末,在庫データ（CSV）,紐づけIDリスト,履歴のCSV保存,バックアップ,メール通知,サーバーPC IP,プログラムの更新");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const rightArrow = menu.getByRole("button", { name: "メニューを右へ" });
    check("設定：メニューが収まらないときは右へ移動するボタン（左端では左ボタンなし）",
      (await rightArrow.count()) === 1 && (await menu.getByRole("button", { name: "メニューを左へ" }).count()) === 0);
    await rightArrow.click();
    await menu.getByRole("button", { name: "メニューを左へ" }).waitFor();
    check("設定：右へ動かすと左へ戻るボタンが出る", true);
    await menu.getByRole("button", { name: "メニューを左へ" }).click();
    await page.waitForTimeout(600);
    await menu.getByRole("button", { name: "メール通知" }).click();
    await page.waitForTimeout(800);
    const mailTop = await page.locator("#settings-mail").evaluate((el) => el.getBoundingClientRect().top);
    const menuBottom = await menu.evaluate((el) => el.getBoundingClientRect().bottom);
    check("設定：メニューを押すとその項目へ移動（メニューに隠れない）", mailTop >= menuBottom && mailTop < menuBottom + 40, `${mailTop} / ${menuBottom}`);
    check("設定：移動した項目をメニューで強調", (await menu.locator(".settings-menu-item.active").textContent()) === "メール通知");
    await page.screenshot({ path: `${SHOTS}/06b_settings_menu.png` });
    await page.evaluate(() => window.scrollTo(0, 0));

    // バックアップ
    const bk = page.getByRole("region", { name: "バックアップ" });
    await bk.getByTestId("backup-place-サーバーPC内").waitFor();
    check("バックアップ：既定は毎日の分30日・月1回の分はオフ・サーバーPC内に保存済み",
      (await bk.getByLabel("毎日の分を残す期間").inputValue()) === "30d" &&
        (await bk.getByLabel("月1回の分を残す日").isDisabled()) &&
        (await bk.getByTestId("backup-place-サーバーPC内").textContent()).includes("成功"));
    await bk.getByLabel("月1回の分も残す").check();
    const dayOptions = await bk.getByLabel("月1回の分を残す日").locator("option").allTextContents();
    check("バックアップ：月1回の分の日は 1〜28日と月末", dayOptions.length === 29 && dayOptions[0] === "1日" && dayOptions[27] === "28日" && dayOptions[28] === "月末");
    await bk.getByLabel("月1回の分を残す日").selectOption({ label: "月末" });
    check("バックアップ：無制限でなければ注意書きは出ない", (await bk.getByTestId("unlimited-note").count()) === 0);
    await bk.getByLabel("月1回の分を残す期間").selectOption("unlimited");
    check("バックアップ：無制限を選ぶと注意書き", await bk.getByTestId("unlimited-note").isVisible());
    await bk.getByLabel("追加の保存先").fill("\\\\nas\\share");
    await bk.getByRole("button", { name: "書き込みテスト" }).click();
    await bk.locator(".error-box", { hasText: "ネットワークの場所" }).waitFor();
    check("バックアップ：NAS（\\\\…）は理由を示して受け付けない", true);
    await bk.getByLabel("追加の保存先").fill(EXTRA_BACKUP);
    await bk.getByRole("button", { name: "書き込みテスト" }).click();
    check("バックアップ：書き込みテスト", (await bk.getByTestId("backup-test-result").textContent()).includes("書き込めました"));
    await bk.getByRole("button", { name: "保存" }).click();
    await bk.getByTestId("backup-place-追加の保存先").waitFor();
    check("バックアップ：保存先を指定するとすぐにデータベースと写真をコピー",
      (await bk.getByTestId("backup-place-追加の保存先").textContent()).includes("成功") &&
        fs.readdirSync(path.join(EXTRA_BACKUP, "db")).length === 1 && fs.readdirSync(path.join(EXTRA_BACKUP, "images")).length >= 1,
      fs.readdirSync(path.join(EXTRA_BACKUP, "images")).length + "枚");
    await bk.screenshot({ path: `${SHOTS}/06c_backup.png` });
    const savedBackup = await page.evaluate(async () => (await (await fetch("/api/backup")).json()).settings);
    check("バックアップ：月1回の分の設定を保存", savedBackup.monthlyEnabled === true && savedBackup.monthlyDay === 0 && savedBackup.monthly === "unlimited", JSON.stringify(savedBackup));
    check("バックアップ：失敗していなければ警告は出ない", (await page.locator(".backup-warning").count()) === 0);

    // プログラムの更新（E2E はサーバーと同じPCから開くので「サーバーPCの画面」）
    const upd = page.getByRole("region", { name: "プログラムの更新" });
    check("更新：新しい版が無ければ画面上部のお知らせは出ない", (await page.locator(".update-banner").count()) === 0);
    await upd.getByRole("button", { name: "今すぐ確認" }).click();
    await upd.locator(".error-box", { hasText: "GitHub" }).waitFor();
    check("更新：確認に失敗したら理由を表示", true, await upd.locator(".error-box").textContent());
    check("更新：新しい版が無ければ更新ボタンは押せない", await upd.getByRole("button", { name: "内容を見て更新" }).isDisabled());
    await upd.getByLabel("GitHub のトークン").fill("短すぎる");
    await upd.getByRole("button", { name: "保存" }).click();
    await page.locator(".toast.error", { hasText: "トークンの形式" }).last().waitFor();
    check("更新：トークンの形式を確認する", (await upd.getByRole("heading", { name: /トークン/ }).textContent()).includes("未設定"));
    const otherIp = await page.evaluate(async () => (await (await fetch("/api/update/status")).json()).local);
    check("更新：サーバーPCの画面からは状態を取得できる", otherIp === true);
    await page.screenshot({ path: `${SHOTS}/06_desktop_settings.png`, fullPage: true });

    // メール通知の設定（E2E 用の SMTP サーバーに送る）
    const mailSec = page.locator("section.mail-settings");
    await mailSec.getByLabel("毎日の在庫警告メールを送る").check();
    await mailSec.getByRole("button", { name: "保存", exact: true }).click();
    await mailSec.locator(".error-box", { hasText: "メールサーバー（SMTP）を入力してください" }).waitFor();
    check("メール通知：有効にするにはサーバー・送信元・宛先が必要", (await mailSec.locator(".error-box div").count()) === 3);
    await mailSec.getByLabel("サーバー名").fill("localhost");
    await mailSec.getByLabel("ポート").fill(String(SMTP_PORT));
    await mailSec.getByLabel("送信元アドレス").fill("prober-zaiko@hisol.jp");
    await mailSec.getByLabel(/^宛先/).fill("machida@hisol.jp\nsoumu@hisol.jp");
    // このテスト環境には社内向け IP が無いため、メール内リンクのアドレスを指定する
    await mailSec.getByLabel("メール内リンクのアドレス").fill("http://192.168.0.210:8080");
    await mailSec.getByRole("button", { name: "テスト送信" }).click();
    await mailSec.locator(".notice-box", { hasText: "テストメールを送信しました" }).waitFor();
    check("メール通知：保存前の入力内容でテスト送信できる", smtp.messages.some((x) => /Subject: =\?UTF-8/.test(x.body) && x.to.length === 2));
    await mailSec.getByRole("button", { name: "保存", exact: true }).click();
    await page.locator(".toast", { hasText: "メール通知の設定を保存しました" }).waitFor();
    const savedMail = await page.evaluate(async () => (await (await fetch("/api/settings/mail")).json()).settings);
    check("メール通知：設定を保存（宛先2件・有効）", savedMail.enabled && savedMail.to.length === 2 && savedMail.port === SMTP_PORT);
    const before = smtp.messages.length;
    await mailSec.getByRole("button", { name: "今すぐ在庫警告を送る" }).click();
    await mailSec.locator(".notice-box", { hasText: "在庫警告" }).waitFor();
    const digest = smtp.messages.slice(before).map((x) => x.body).join("\n");
    const digestText = Buffer.from((digest.split("\n\n")[1] ?? "").replace(/\s+/g, ""), "base64").toString("utf8");
    check("メール通知：在庫警告メールに商品・リンクを載せる", digestText.includes("在庫が警告在庫以下の商品が") && digestText.includes("http://192.168.0.210:8080/m?id="), digestText.slice(0, 60));
    // 接続できないポートでテスト → 原因を表示し、前回の結果に失敗を残す
    await mailSec.getByLabel("ポート").fill("2599");
    await mailSec.getByRole("button", { name: "テスト送信" }).click();
    await mailSec.locator(".error-box", { hasText: "接続を拒否" }).waitFor();
    await mailSec.locator(".mail-status.ng").waitFor();
    check("メール通知：送信失敗の原因を表示し、前回の結果に残す", true);
    await mailSec.screenshot({ path: `${SHOTS}/33_mail_settings.png` });
    await mailSec.getByRole("button", { name: "元に戻す" }).click();
    await mailSec.getByRole("button", { name: "元に戻す" }).waitFor({ state: "detached" });
    check("メール通知：元に戻すで保存済みの値に戻る", (await mailSec.getByLabel("ポート").inputValue()) === String(SMTP_PORT));
    const mailAudit = await page.evaluate(async () => (await (await fetch("/api/audit-logs?limit=5")).json()).find((l) => l.action === "SETTINGS_CHANGE"));
    check("メール通知：設定変更を操作ログに残す", !!mailAudit && mailAudit.detail.includes("通知を有効化"));

    // 入力者と端末の IP の紐づけ
    const usersSec = page.locator("section[aria-label='入力者']");
    check("この端末（サーバーPC本体）は紐づけできないと案内する", await usersSec.getByText("サーバーPC本体は複数の人が使うため").isVisible());
    await usersSec.getByLabel("紐づける入力者").selectOption({ label: "鈴木" });
    await usersSec.getByLabel("IPアドレス").fill("192.168.1.23");
    await usersSec.getByLabel("端末のメモ").fill("iPhone");
    await usersSec.getByRole("button", { name: "紐づけ", exact: true }).click();
    await page.locator(".toast", { hasText: "192.168.1.23 を「鈴木」に紐づけました" }).waitFor();
    check("入力者に端末の IP を紐づけ、一覧に表示", await usersSec.locator(".ip-chip", { hasText: "192.168.1.23" }).isVisible());
    // 別の人へ付け替え（確認あり）
    await usersSec.getByLabel("紐づける入力者").selectOption({ label: "山田" });
    await usersSec.getByLabel("IPアドレス").fill("192.168.1.23");
    let replaceMsg = "";
    page.once("dialog", (d) => {
      replaceMsg = d.message();
      d.accept();
    });
    await usersSec.getByRole("button", { name: "紐づけ", exact: true }).click();
    await page.locator(".toast", { hasText: "192.168.1.23 を「山田」に紐づけました" }).waitFor();
    check("他の人に紐づいた IP は確認して付け替える", replaceMsg.includes("既に「鈴木」に紐づいています"), replaceMsg.split("\n")[0]);
    await usersSec.getByLabel("IPアドレス").fill("192.168.1.999");
    await usersSec.getByLabel("紐づける入力者").selectOption({ label: "鈴木" });
    await usersSec.getByRole("button", { name: "紐づけ", exact: true }).click();
    await usersSec.locator(".error-box", { hasText: "IP アドレスの形式" }).waitFor();
    check("IP アドレスの形式エラーを表示", true);
    await usersSec.screenshot({ path: `${SHOTS}/38_user_ips.png` });
    page.once("dialog", (d) => d.accept());
    await usersSec.getByRole("button", { name: "192.168.1.23 の紐づけを解除" }).click();
    await page.locator(".toast", { hasText: "192.168.1.23 の紐づけを解除しました" }).waitFor();
    check("紐づけを解除できる", (await usersSec.locator(".ip-chip").count()) === 0);

    // 他の端末の操作が自動で反映される（10秒ごとの更新）
    await page.getByRole("button", { name: "在庫一覧" }).click();
    await page.locator(".product-list").waitFor();
    await m.getByRole("tab", { name: "商品" }).tap();
    await m.locator(".product-row", { hasText: "りんご" }).tap();
    await m.getByRole("button", { name: "出庫", exact: true }).tap();
    await m.locator(".toast", { hasText: "出庫しました" }).last().waitFor();
    await page.locator(".product-row", { hasText: "りんご" }).locator(".stock", { hasText: "13" }).waitFor({ timeout: 15000 });
    check("他の端末の入出庫がPCの一覧に自動反映される", true);

    // 在庫CSV：出力
    const stockCsv = await (await page.request.get(`${base}/api/products.csv`)).text();
    check("在庫CSVを出力できる（BOM付き・見出し）", stockCsv.startsWith("\uFEFF商品コード,商品名,概要,カテゴリ,保管場所,在庫,警告在庫,備考"));

    // 在庫CSV：エラーのあるファイル → 取り込めない
    await page.getByRole("button", { name: "設定" }).click();
    await page.setInputFiles('[data-testid="csv-input"]', A("stock_error.csv"));
    await page.locator(".import-preview .error-box", { hasText: "2行目（A001）: 在庫は整数で入力してください" }).waitFor();
    check("在庫CSV：エラーを行番号付きで表示し、取り込めない", await page.getByRole("button", { name: "取り込む" }).isDisabled());

    // 在庫CSV：Shift_JIS のファイル → 確認 → 取り込み
    await page.setInputFiles('[data-testid="csv-input"]', A("stock_sjis.csv"));
    await page.locator(".import-summary", { hasText: "新規 1 件" }).waitFor();
    check("在庫CSV：Shift_JIS を読み、変更内容を確認表示", await page.locator(".import-table", { hasText: "在庫: " }).isVisible());
    await page.screenshot({ path: `${SHOTS}/30_csv_preview.png`, fullPage: true });
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "取り込む" }).click();
    await page.locator(".toast", { hasText: "取り込みました" }).last().waitFor();
    const afterImport = await page.evaluate(async () => (await (await fetch("/api/products")).json()).filter((p) => ["A001", "CSV-NEW"].includes(p.code)));
    check("在庫CSV：在庫・場所の上書きと新規登録", afterImport.find((p) => p.code === "A001").stock === 50 && afterImport.find((p) => p.code === "A001").location === "倉庫" && afterImport.some((p) => p.code === "CSV-NEW"));
    const adj = await page.evaluate(async () => (await (await fetch("/api/histories?limit=5")).json()).find((h) => h.type === "ADJUST"));
    check("在庫CSV：在庫の差を「棚卸調整」として履歴に残す", !!adj && adj.stockAfter === 50 && adj.comment.startsWith("CSV取込"));

    // ================================================================ スマホ用画面（/m）
    const s = await mctx.newPage();
    s.on("pageerror", (e) => consoleErrors.push(String(e)));
    await s.goto(`${mbase}/m`);
    await s.getByLabel("ID").waitFor();
    check("スマホ用画面：タイトルは「在庫管理（入出庫）」", (await s.title()) === "在庫管理（入出庫）");
    check("スマホ用画面：バージョンを右上に表示", (await s.locator(".m-header .app-version").textContent()).startsWith("Ver. 20"));
    await s.screenshot({ path: `${SHOTS}/20_m_start.png` });
    check("スマホ用画面：入力者の選択画面を強制しない", (await s.getByRole("dialog").count()) === 0);

    // ID の候補（サジェスト）
    await s.getByLabel("ID").fill("a0");
    await s.locator(".m-suggest").waitFor();
    await s.screenshot({ path: `${SHOTS}/26_m_suggest.png` });
    const sug = await s.locator(".m-suggest-code").allTextContents();
    check("スマホ用画面：IDの候補を表示（a0 → A001）", sug[0] === "A001", sug.join(","));
    await s.getByLabel("ID").fill("おれんじ");
    await s.locator(".m-suggest-code", { hasText: "B001" }).waitFor();
    check("スマホ用画面：商品名（ひらがな）からも候補を表示", true);
    await s.locator(".m-suggest button", { hasText: "B001" }).tap();
    await s.locator(".m-code", { hasText: "B001" }).waitFor();
    check("スマホ用画面：候補をタップすると商品を表示し、候補を閉じる", (await s.locator(".m-suggest").count()) === 0);
    await s.screenshot({ path: `${SHOTS}/26_m_suggest_selected.png` });
    await s.getByRole("button", { name: "別の商品を表示" }).tap();

    // 購入元（スマホでも見られる）
    await s.getByLabel("ID").fill("C001");
    await s.getByRole("button", { name: "表示" }).tap();
    await s.getByTestId("m-suppliers").waitFor();
    check("スマホ用画面：購入元をリンクで表示", (await s.locator("[data-testid=m-suppliers] a").count()) === 2);
    await s.screenshot({ path: `${SHOTS}/27_m_suppliers.png`, fullPage: true });
    await s.locator(".m-product .product-image.zoomable").tap();
    await s.locator(".image-viewer img").waitFor();
    await s.screenshot({ path: `${SHOTS}/29_m_image_zoom.png` });
    await s.locator(".image-viewer").tap();
    await s.locator(".image-viewer").waitFor({ state: "detached" });
    check("スマホ：写真をタップで拡大し、タップで閉じる", true);
    await s.getByRole("button", { name: "別の商品を表示" }).tap();

    await s.getByLabel("ID").fill("a-001"); // 小文字・ハイフンありで入力
    await s.getByRole("button", { name: "表示" }).tap();
    await s.getByTestId("m-location").waitFor();
    check("スマホ用画面：PC で選んだ入力者を引き継ぐ", (await s.getByLabel("入力者").inputValue()) === "鈴木");
    check("スマホ用画面：小文字のIDでも商品を表示", (await s.locator(".m-code").textContent()) === "A001");
    check("スマホ用画面：場所を表示（CSV取込で更新した値）", (await s.getByTestId("m-location").textContent()) === "倉庫");
    check("スマホ用画面：概要を表示", (await s.locator(".m-summary").textContent()) === "青森産の赤いりんご");
    check("スマホ用画面：備考を表示", (await s.locator(".m-note").textContent()) === "棚卸ドル払い\n円払い別");
    await s.getByLabel("コメント").fill("発注分入荷");
    const stock0 = Number((await s.getByTestId("m-stock").textContent()).match(/^[\d,]+/)[0].replace(/,/g, ""));
    await s.screenshot({ path: `${SHOTS}/21_m_product.png` });

    await s.getByRole("button", { name: "入庫", exact: true }).tap();
    await s.getByRole("dialog", { name: "入庫" }).waitFor();
    check("スマホ用画面：入庫は理由を選ぶまで確定できない", await s.getByRole("button", { name: "入庫する" }).isDisabled());
    await s.getByRole("radio", { name: "購入" }).tap();
    await s.screenshot({ path: `${SHOTS}/27_m_in_dialog.png` });
    await s.getByRole("button", { name: "入庫する" }).tap();
    await s.locator(".m-message.ok").waitFor();
    await s.locator(".m-recent .in-reason", { hasText: "購入" }).first().waitFor();
    check("スマホ用画面：入庫の理由を履歴に表示", true);
    check("スマホ用画面：入庫（確認後に在庫+1）", (await s.locator(".m-message.ok").textContent()).includes(`→ ${stock0 + 1}`));
    await s.locator(".m-recent .comment", { hasText: "発注分入荷" }).waitFor();
    check("スマホ用画面：履歴にコメントを表示", true);

    await s.getByLabel("数量").fill("2");
    await s.getByRole("button", { name: "移管", exact: true }).tap();
    await s.getByRole("dialog", { name: "移管" }).waitFor();
    await s.getByRole("button", { name: "移管する" }).tap();
    check("スマホ用画面：移管先が空なら止める", await s.getByText("移管先（人・部署）を入力してください").isVisible());
    await s.getByLabel("移管先（人・部署）").fill("製造部 佐藤");
    await s.screenshot({ path: `${SHOTS}/22_m_transfer.png` });
    s.once("dialog", (d) => d.accept());
    await s.getByRole("button", { name: "移管する" }).tap();
    await s.locator(".m-message.ok", { hasText: "移管しました" }).waitFor();
    check("スマホ用画面：移管で在庫が減る", (await s.locator(".m-message.ok").textContent()).includes(`→ ${stock0 - 1}`));
    check("スマホ用画面：履歴に移管先を表示", await s.locator(".m-recent", { hasText: "→ 製造部 佐藤" }).isVisible());

    await s.getByLabel("数量").fill("9999");
    s.once("dialog", (d) => d.accept());
    await s.getByRole("button", { name: "出庫", exact: true }).tap();
    await s.locator(".m-message.error", { hasText: "在庫が不足" }).waitFor();
    check("スマホ用画面：在庫を超える出庫は拒否", true);

    await s.getByLabel("数量").fill("1");
    s.once("dialog", (d) => d.dismiss());
    await s.getByRole("button", { name: "出庫", exact: true }).tap();
    await s.waitForTimeout(300);
    check("スマホ用画面：確認でキャンセルすると何もしない", (await s.locator(".m-message").count()) === 1);
    await s.screenshot({ path: `${SHOTS}/23_m_after.png`, fullPage: true });

    // 入力者を未選択にすると IP で記録される
    await s.getByLabel("入力者").selectOption("");
    await s.getByLabel("数量").fill("1");
    await s.getByRole("button", { name: "入庫", exact: true }).tap();
    await s.getByRole("radio", { name: "戻り" }).tap();
    await s.getByRole("button", { name: "入庫する" }).tap();
    await s.locator(".m-message.ok", { hasText: "入庫しました" }).waitFor();
    const anon = await s.evaluate(async () => (await (await fetch("/api/histories?limit=1")).json())[0]);
    check("スマホ用画面：入力者未選択なら名前なし・IPで記録", anon.userName === "" && anon.clientIp === "127.0.0.1", JSON.stringify([anon.userName, anon.clientIp]));
    check("スマホ用画面：入庫の理由（戻り）を記録", anon.reason === "戻り");
    const order = await s.locator(".m-ops .button").allTextContents();
    check("スマホ用画面：ボタンの並びは 出庫・移管・入庫", order.join(",") === "出庫,移管,入庫", order.join(","));
    await s.screenshot({ path: `${SHOTS}/25_m_anonymous.png` });

    // 2回目の移管では候補が出る
    await s.getByRole("button", { name: "移管", exact: true }).tap();
    await s.locator(".chip", { hasText: "製造部 佐藤" }).waitFor({ timeout: 5000 });
    check("スマホ用画面：過去の移管先を候補に表示", true);
    await s.getByRole("button", { name: "キャンセル" }).tap();

    // QR（写真）で別の商品
    await s.getByRole("button", { name: "別の商品を表示" }).tap();
    await s.getByRole("button", { name: /QRを読み取る/ }).tap();
    await s.setInputFiles('[data-testid="scan-photo-input"]', A("ean_known.jpg"));
    await s.locator(".m-code", { hasText: "4901234567894" }).waitFor();
    check("スマホ用画面：バーコード写真から商品を表示", true);

    await s.getByRole("button", { name: "別の商品を表示" }).tap();
    await s.getByLabel("ID").fill("NOTHING");
    await s.getByLabel("ID").press("Enter");
    await s.locator(".m-message.error", { hasText: "見つかりません" }).waitFor();
    check("スマホ用画面：存在しないIDはメッセージ", true);
    await s.screenshot({ path: `${SHOTS}/24_m_notfound.png` });

    // QR に URL を入れた場合（スマホの標準カメラで開く運用）
    await s.goto(`${mbase}/m?id=a-001`);
    await s.locator(".m-code", { hasText: "A001" }).waitFor();
    check("スマホ用画面：/m?id=… で開くと商品を表示", (await s.evaluate(() => location.search)) === "?id=A001");
    await s.getByRole("button", { name: "別の商品を表示" }).tap();
    check("スマホ用画面：別の商品でアドレスの id を消す", (await s.evaluate(() => location.pathname + location.search)) === "/m");
    const urlQr = path.join(os.tmpdir(), "qr_url_A001.png");
    await require(path.join(ROOT, "node_modules", "qrcode")).toFile(urlQr, "http://192.168.0.210:8080/m?id=A001", { width: 500, margin: 4 });
    await s.getByRole("button", { name: /QRを読み取る/ }).tap();
    await s.setInputFiles('[data-testid="scan-photo-input"]', urlQr);
    await s.locator(".m-code", { hasText: "A001" }).waitFor();
    check("スマホ用画面：URL入りのQRからIDを取り出して表示", true);

    // ZXing では読めない QR（jsQR で読む）
    await s.goto(`${mbase}/m`);
    await s.getByRole("button", { name: /QRを読み取る/ }).tap();
    await s.setInputFiles('[data-testid="scan-photo-input"]', A("qr_zxing_hard.png"));
    await s.locator(".m-message.error", { hasText: "ID「A15」" }).waitFor({ timeout: 8000 });
    check("スマホ用画面：ZXing が苦手な QR も読み取れる（jsQR）", true);

    // PC：概要で検索
    await page.goto(base);
    await page.getByLabel("検索").fill("青森産");
    check("PC：概要の文字でも検索できる", (await page.locator(".product-row:not(.header)").count()) === 1);
    await page.getByLabel("検索").fill("");

    // PC：QR ラベル
    await page.goto(base);
    await page.locator(".product-row", { hasText: "りんご" }).click();
    await page.getByRole("button", { name: "QRラベル" }).click();
    await page.getByRole("dialog", { name: "QRラベル" }).waitFor();
    await page.getByLabel(/QR に入れるアドレス/).fill("http://192.168.0.210:8080");
    await page.locator(".qr-label img").waitFor();
    check("PC：QRラベルにスマホ用画面のURLを入れる", (await page.locator(".qr-url").textContent()) === "http://192.168.0.210:8080/m?id=A001");
    await page.screenshot({ path: `${SHOTS}/07_desktop_qr_label.png` });
    await page.getByLabel(/QR に入れるアドレス/).fill("http://localhost:8080");
    check("PC：localhost のアドレスは QR に使えない", await page.getByText("localhost・127.0.0.1 は使えません").isVisible());
    await page.getByRole("dialog", { name: "QRラベル" }).getByRole("button", { name: "閉じる", exact: true }).last().click();
    // PC の検索欄に URL を読み込んだ場合（USB リーダー）
    await page.getByLabel("検索").fill("http://192.168.0.210:8080/m?id=4901234567894");
    await page.getByLabel("検索").press("Enter");
    check("PC：検索欄で URL を読み込んでも商品を選択", (await page.locator(".stock-panel .name").first().textContent()).includes("青い箱"));

    const csvAfter = await (await page.request.get(`${base}/api/histories.csv`)).text();
    check("CSV に移管先・コメントが出る", csvAfter.includes(",移管,,,2,") && csvAfter.includes("製造部 佐藤,,鈴木") && csvAfter.includes(",発注分入荷,鈴木") && csvAfter.includes("入庫,購入,,1,"));

    // ================================================================ 簿外・商品コードの変更履歴・履歴CSVの自動保存
    await page.getByRole("button", { name: "在庫一覧" }).click();
    await page.getByLabel("カテゴリで絞り込み").selectOption("");
    await page.getByLabel("検索").fill("");
    await page.locator(".product-row", { hasText: "画像なし商品" }).click();
    await page.getByRole("button", { name: "商品を編集" }).click();
    await page.getByLabel("簿外（帳簿に載せていない在庫）").check();
    await page.locator(".field:has-text('商品コード') input").fill("Z-200");
    let codeConfirm = "";
    page.once("dialog", (d) => {
      codeConfirm = d.message();
      d.accept();
    });
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".toast", { hasText: "「画像なし商品」を更新しました" }).waitFor();
    check("コード変更時は確認を出す", codeConfirm.includes("「X100」から「Z-200」"), codeConfirm.split("\n")[0]);
    await page.locator(".product-row", { hasText: "画像なし商品" }).click();
    await page.getByTestId("old-codes").waitFor();
    check("詳細欄に旧コードと簿外を表示", (await page.getByTestId("old-codes").textContent()).includes("X100") && (await page.locator(".stock-panel .tag-label.off-book").isVisible()));
    await page.locator(".stock-panel").screenshot({ path: `${SHOTS}/34_offbook_oldcode_panel.png` });

    await page.getByLabel("簿外で絞り込み").selectOption("only");
    const offRows = await page.locator(".product-row:not(.header) .code").allTextContents();
    check("簿外のみで絞り込める", offRows.length === 1 && offRows[0].startsWith("Z-200"), offRows.join(","));
    await page.screenshot({ path: `${SHOTS}/35_offbook_filter.png` });
    await page.getByLabel("簿外で絞り込み").selectOption("exclude");
    check("簿外以外で絞り込める", !(await page.locator(".product-row:not(.header) .code").allTextContents()).some((t) => t.startsWith("Z-200")));
    await page.reload();
    await page.locator(".product-list").waitFor();
    check("簿外の絞り込みを記憶する", (await page.getByLabel("簿外で絞り込み").inputValue()) === "exclude");
    await page.getByLabel("簿外で絞り込み").selectOption("all");

    // 旧コードの読み取り（USB リーダー = 検索欄 + Enter）
    await page.locator(".stock-panel .close-sheet").click().catch(() => {});
    await page.getByLabel("検索").fill("X100");
    await page.getByLabel("検索").press("Enter");
    await page.locator(".toast", { hasText: "「X100」は旧コードです" }).waitFor();
    check("PC：旧コードを読み取ると現在の商品を選択", (await page.locator(".stock-panel .name").first().textContent()).includes("画像なし商品"));
    await s.goto(`${mbase}/m?id=x100`);
    await s.locator(".m-message.info", { hasText: "旧コードです" }).waitFor();
    check("スマホ：旧コードで開くと現在のコードを案内し、簿外を表示", (await s.locator(".m-code").textContent()).startsWith("Z-200") && (await s.locator(".m-code .off-book").isVisible()));
    await s.screenshot({ path: `${SHOTS}/28_m_oldcode.png` });

    // ================================================================ 受注番号（リストから選択 or 手入力）
    await page.getByRole("button", { name: "在庫一覧" }).click();
    await page.locator(".product-row", { hasText: "青い箱" }).click();
    const orderInput = page.locator(".stock-panel").getByRole("combobox", { name: "紐づけID" });
    await orderInput.fill("きおく");
    await page.locator(".order-suggest button", { hasText: "YHO-26042" }).waitFor();
    await page.screenshot({ path: `${SHOTS}/39_order_suggest.png` });
    await page.locator(".order-suggest button", { hasText: "YHO-26042" }).click();
    check("紐づけID：案件名（ひらがな）で絞り込んでリストから選べる", (await orderInput.inputValue()) === "YHO-26042");
    check("紐づけID：選んだ番号の案件名を表示", (await page.getByTestId("order-hint").textContent()).includes("キオクシア"));
    await page.locator(".stock-panel").getByRole("button", { name: "出庫", exact: true }).click();
    await page.locator(".toast", { hasText: "紐づけ YHO-26042" }).waitFor();
    await page.locator(".stock-panel .tag-label.order-no", { hasText: "紐づけ YHO-26042" }).first().waitFor();
    check("紐づけID：出庫の履歴に記録し表示", true);
    check("紐づけID：出庫後も残す（続けて同じ受注で出庫できる）", (await orderInput.inputValue()) === "YHO-26042");
    await page.locator(".stock-panel").screenshot({ path: `${SHOTS}/40_order_panel.png` });
    // リストに無い番号の手入力（全角・小文字で入力したリストの番号はリストの表記にそろう）
    await orderInput.fill("NEW-99001");
    await page.locator(".stock-panel").getByLabel("コメント").click();
    check("紐づけID：リストに無い番号はその旨を表示", (await page.getByTestId("order-hint").textContent()).includes("リストに無い番号"));
    await page.locator(".stock-panel").getByRole("button", { name: "入庫", exact: true }).click();
    await page.locator(".toast", { hasText: "紐づけ NEW-99001" }).waitFor();
    await orderInput.fill("ｙｈｏ２６００２");
    await page.locator(".stock-panel").getByRole("button", { name: "出庫", exact: true }).click();
    await page.locator(".toast", { hasText: "出庫しました" }).last().waitFor();
    const orderHist = await page.evaluate(async () => (await (await fetch("/api/histories?limit=3")).json()).map((h) => h.orderNo));
    check("紐づけID：手入力の番号も記録し、リストの番号は表記をそろえる", orderHist.join(",") === "YHO-26002,NEW-99001,YHO-26042", orderHist.join(","));
    const orderCsv = await (await page.request.get(`${base}/api/histories.csv`)).text();
    check("紐づけID：履歴CSVに受注番号の列", orderCsv.includes("区分,理由,紐づけID,数量") && orderCsv.includes(",出庫,,YHO-26042,1,"));
    await orderInput.fill("");
    await orderInput.click();
    const firstSuggest = await page.locator(".order-suggest .order-number").first().textContent();
    check("紐づけID：最近手入力した番号も候補に出る", firstSuggest === "NEW-99001", firstSuggest);
    await page.keyboard.press("Escape");

    // スマホ
    await s.goto(`${mbase}/m?id=B001`);
    await s.getByTestId("m-stock").waitFor();
    await s.getByRole("combobox", { name: "紐づけID" }).fill("26002");
    await s.locator(".order-suggest button", { hasText: "YHO-26002" }).tap();
    let mConfirm = "";
    s.once("dialog", (d) => {
      mConfirm = d.message();
      d.accept();
    });
    await s.getByRole("button", { name: "出庫", exact: true }).tap();
    await s.locator(".m-message.ok").waitFor();
    check("スマホ：紐づけIDを選んで出庫（確認に紐づけIDを表示）", mConfirm.includes("紐づけID: YHO-26002"), mConfirm.replace(/\n/g, " / "));
    await s.locator(".m-recent .tag-label.order-no", { hasText: "YHO-26002" }).first().waitFor();
    await s.screenshot({ path: `${SHOTS}/41_m_order.png`, fullPage: true });

    // ================================================================ 履歴の修正・取消
    await page.getByRole("button", { name: "在庫一覧" }).click();
    await page.locator(".product-row", { hasText: "青い箱" }).click();
    const stockBefore = Number(await page.getByTestId("stock-value").textContent());
    await page.locator(".stock-panel").getByRole("combobox", { name: "紐づけID" }).fill("");
    await page.locator(".stock-panel").getByLabel("コメント").fill("数量まちがい用");
    await page.locator(".stock-panel").getByRole("button", { name: "出庫", exact: true }).click();
    await page.locator(".toast", { hasText: "出庫しました" }).last().waitFor();
    await page.locator(".stock-panel .history-list li", { hasText: "数量まちがい用" }).first().click();
    const dlg = page.getByRole("dialog", { name: "履歴の詳細・修正" });
    await dlg.waitFor();
    check("履歴の修正：直せるのは紐づけIDとコメント（移管先・数量などの入力欄は無い）",
      (await dlg.getByRole("combobox", { name: "紐づけID" }).count()) === 1 && (await dlg.locator("input").count()) === 3);
    await dlg.getByLabel("コメント").fill("修理用（修正）");
    await dlg.getByRole("combobox", { name: "紐づけID" }).fill("yho26002");
    await dlg.getByLabel("コメント").click(); // 候補の一覧を閉じる
    await dlg.getByRole("button", { name: "修正を保存" }).click();
    await page.locator(".toast", { hasText: "履歴を修正しました" }).waitFor();
    await dlg.getByTestId("history-edits").waitFor();
    const editRows = await dlg.locator("[data-testid=history-edits] tbody tr").allTextContents();
    check("履歴の修正：紐づけID（リストの表記にそろえる）とコメントを直し、項目ごとに修正履歴に残す",
      editRows.length === 2 && editRows.some((r) => r.includes("数量まちがい用") && r.includes("修理用（修正）")) && editRows.some((r) => r.includes("紐づけID") && r.includes("YHO-26002")),
      editRows.join(" | "));
    await dlg.getByLabel("取消の理由").fill("数量の入力間違い");
    page.once("dialog", (d) => d.accept());
    await dlg.getByRole("button", { name: "この履歴を取り消す" }).click();
    await page.locator(".toast", { hasText: "出庫を取り消しました" }).waitFor();
    await dlg.locator(".tag-label.canceled").waitFor();
    await dlg.screenshot({ path: `${SHOTS}/42_history_edit.png` });
    await dlg.getByRole("button", { name: "閉じる" }).click();
    await page.getByTestId("stock-value").filter({ hasText: String(stockBefore) }).waitFor();
    check("履歴の取消：在庫が元に戻り、取消の履歴と取消済の印", (await page.locator(".stock-panel .history-list li.canceled").count()) >= 1 && (await page.locator(".stock-panel .history-list .type-CANCEL").count()) >= 1);
    await page.locator(".stock-panel").screenshot({ path: `${SHOTS}/43_history_canceled.png` });

    // ================================================================ 端末ID での紐づけ（スマホは IP が変わっても同じ人）
    const devCtx = await mobileBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    const dp = await devCtx.newPage();
    await dp.goto(`${mbase}/m?id=B001`);
    await dp.getByTestId("m-stock").waitFor();
    const myDev = await dp.evaluate(async () => (await (await fetch("/api/whoami")).json()).deviceId);
    check("端末ID：初回アクセスで Cookie の端末ID を発行（画面のスクリプトからは読めない）", /^[0-9a-f]{32}$/.test(myDev) && (await dp.evaluate(() => document.cookie)) === "", myDev.slice(0, 8));
    await page.getByRole("button", { name: "設定" }).click();
    const devRow = page.locator("[data-testid=devices] tr", { has: page.locator(`[title="${myDev}"]`) });
    await devRow.waitFor();
    check("端末一覧に機種・ブラウザを表示", (await devRow.textContent()).includes("iPhone / Safari"));
    await devRow.getByLabel("紐づける入力者").selectOption({ label: "佐藤" });
    await devRow.getByLabel("端末のメモ").fill("佐藤のiPhone");
    await devRow.getByRole("button", { name: "保存" }).click();
    await page.locator(".toast", { hasText: "端末を紐づけました" }).waitFor();
    await page.locator("section[aria-label='端末']").screenshot({ path: `${SHOTS}/44_devices.png` });
    await dp.reload();
    await dp.getByTestId("m-stock").waitFor();
    check("スマホ：紐づけた端末では入力者欄に「佐藤（この端末）」", (await dp.getByLabel("入力者").locator("option:checked").textContent()) === "佐藤（この端末）");
    dp.once("dialog", (d) => d.accept());
    await dp.getByRole("button", { name: "出庫", exact: true }).tap();
    await dp.locator(".m-message.ok").waitFor();
    const devHist = await dp.evaluate(async () => (await (await fetch("/api/histories?limit=1")).json())[0]);
    check("スマホ：名前を選ばずに出庫しても、端末に紐づいた人で記録", devHist.userName === "佐藤" && devHist.deviceId === myDev, `${devHist.userName} ${String(devHist.deviceId).slice(0, 8)}`);
    await devCtx.close();

    // ================================================================ 履歴ページ
    await page.getByRole("button", { name: "在庫一覧" }).click();
    await page.locator(".product-row", { hasText: "青い箱" }).click();
    await page.locator(".stock-panel").getByRole("button", { name: "すべての履歴を見る →" }).click();
    await page.getByTestId("history-table").waitFor();
    check("履歴ページ：商品パネルから、その商品の履歴だけを表示", (await page.locator(".history-product-filter").textContent()).includes("青い箱") &&
      (await page.locator("[data-testid=history-table] tbody tr").allTextContents()).every((t) => t.includes("青い箱")));
    check("履歴ページ：既定は直近3か月（ボタンが選択状態）", await page.getByRole("button", { name: "直近3か月" }).evaluate((b) => b.classList.contains("active")));
    const from3m = await page.getByLabel("開始日").inputValue();
    await page.getByRole("button", { name: "半年" }).click();
    const from6m = await page.getByLabel("開始日").inputValue();
    check("履歴ページ：「半年」を押すと開始日に反映", from6m < from3m && (await page.getByLabel("終了日").inputValue()) === new Date().toLocaleDateString("sv-SE"), `${from3m} → ${from6m}`);
    const fy = await page.getByLabel("年度").locator("option").nth(1).getAttribute("value");
    await page.getByLabel("年度").selectOption(fy);
    check("履歴ページ：年度を選ぶと4月1日〜翌3月31日", (await page.getByLabel("開始日").inputValue()) === `${fy}-04-01` && (await page.getByLabel("終了日").inputValue()) === `${Number(fy) + 1}-03-31`);
    check("履歴ページ：決算月の既定は3月", (await page.getByLabel("決算月").inputValue()) === "3");
    await page.getByLabel("決算月").selectOption("12");
    check("履歴ページ：年度を選んだまま決算月を変えると、同じ年度を新しい区切りで選び直す",
      (await page.getByLabel("開始日").inputValue()) === `${fy}-01-01` && (await page.getByLabel("終了日").inputValue()) === `${fy}-12-31`,
      await page.getByLabel("開始日").inputValue());
    check("履歴ページ：年度の選択肢は「○年度」だけ（期間は開始日・終了日の欄で分かる）", /^\d{4}年度$/.test((await page.getByLabel("年度").locator("option").nth(1).textContent()).trim()));
    await page.waitForFunction(async () => (await (await fetch("/api/settings/general")).json()).fiscalYearEndMonth === 12);
    await page.reload();
    await page.getByTestId("history-table").waitFor();
    await page.waitForFunction(() => document.querySelector("select[aria-label=決算月]")?.value === "12");
    check("履歴ページ：選んだ決算月を記憶する（開き直しても12月）", true);
    check("設定：設定画面に年度の項目は無い（履歴ページで選ぶ）", (await page.getByRole("region", { name: "年度" }).count()) === 0);
    await page.getByLabel("決算月").selectOption("3");
    await page.waitForFunction(async () => (await (await fetch("/api/settings/general")).json()).fiscalYearEndMonth === 3);
    await page.getByLabel("開始日").fill("2030-01-01");
    await page.locator(".history-page .error-box", { hasText: "開始日が終了日より後" }).waitFor();
    check("履歴ページ：期間の入力ミスを表示", true);
    await page.getByRole("button", { name: "直近3か月" }).click();
    await page.getByRole("combobox", { name: "紐づけID" }).fill("YHO-26002");
    await page.locator(".history-page").getByLabel("区分").selectOption("OUT");
    await page.waitForFunction(() => document.querySelector("[data-testid=history-total]")?.textContent?.match(/^\d+ 件$/));
    await page.waitForTimeout(500);
    const sum = await page.getByTestId("history-summary").textContent();
    const outRows = await page.locator("[data-testid=history-table] tbody tr").allTextContents();
    check("履歴ページ：紐づけID・区分で絞り込み、合計は取消分を除く", outRows.length >= 1 && outRows.every((t) => t.includes("出庫") && t.includes("YHO-26002")) && sum.includes("出庫 1"), `${outRows.length}行 ${sum}`);
    await page.screenshot({ path: `${SHOTS}/45_history_page.png`, fullPage: true });
    const csvHref = await page.getByRole("link", { name: "この条件でCSV出力" }).getAttribute("href");
    const pageCsv = await (await page.request.get(`${base}${csvHref}`)).text();
    check("履歴ページ：同じ条件でCSV出力", pageCsv.includes("紐づけID") && pageCsv.split("\r\n").filter(Boolean).length === outRows.length + 1, `${pageCsv.split("\r\n").filter(Boolean).length - 1}行`);
    // 受注番号を入力した直後（入力欄にカーソルがある状態）でも、1回のクリックで開けること
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid=history-table] tbody tr").first().click();
    await page.getByRole("dialog", { name: "履歴の詳細・修正" }).waitFor();
    check("履歴ページ：行をクリックで詳細・修正を開く", true);
    await page.getByRole("dialog", { name: "履歴の詳細・修正" }).getByRole("button", { name: "閉じる" }).click();
    await page.getByRole("button", { name: "商品の絞り込みを解除" }).click();
    await page.getByRole("tab", { name: "履歴の修正" }).click();
    await page.locator(".history-table tbody tr", { hasText: "修理用（修正）" }).waitFor();
    check("履歴ページ：履歴の修正の記録を表示", true);
    await page.getByRole("tab", { name: "コード変更" }).click();
    await page.locator(".history-table tbody tr", { hasText: "Z-200" }).waitFor();
    check("履歴ページ：コード変更の記録を表示", (await page.locator(".history-table tbody tr", { hasText: "Z-200" }).textContent()).includes("X100"));
    await page.getByRole("tab", { name: "操作ログ" }).click();
    await page.getByLabel("キーワード").fill("商品更新");
    await page.waitForTimeout(800);
    const auditRows = await page.locator(".history-table tbody tr").allTextContents();
    check("履歴ページ：操作ログを操作の種類で検索", auditRows.length >= 1 && auditRows.every((t) => t.includes("商品更新")), `${auditRows.length}行`);
    await page.screenshot({ path: `${SHOTS}/46_history_audit.png` });

    // 設定画面にリストの状態
    await page.getByRole("button", { name: "設定" }).click();
    await page.getByTestId("order-list-status").waitFor();
    check("設定：紐づけIDリスト（link-ids.txt）の件数を表示", (await page.getByTestId("order-list-status").textContent()).startsWith("3件"));


    // 履歴CSVの自動保存
    await page.getByRole("button", { name: "設定" }).click();
    await page.getByTestId("log-export-dir").waitFor();
    page.getByRole("button", { name: "今すぐ書き出す" }).click();
    await page.locator(".toast", { hasText: "履歴のCSVを書き出しました" }).waitFor();
    const logDir = path.join(DATA, "logs");
    const logFiles = fs.readdirSync(logDir);
    const ym = new Date().toISOString().slice(0, 7);
    const codeCsv = fs.readFileSync(path.join(logDir, `コード変更履歴_${ym}.csv`), "utf8");
    check(
      "履歴CSV：月別ファイル（入出庫・操作ログ・コード変更）を data/logs に保存",
      logFiles.includes(`入出庫履歴_${ym}.csv`) && logFiles.includes(`操作ログ_${ym}.csv`) && codeCsv.includes("X100,Z-200,画像なし商品,山田"),
      logFiles.join(","),
    );
    await page.locator("section[aria-label='履歴のCSV保存']").screenshot({ path: `${SHOTS}/36_log_export.png` });
    const stockCsv2 = await (await page.request.get(`${base}/api/products.csv`)).text();
    check("在庫CSV：簿外の列（○）を出力", stockCsv2.split("\r\n")[0].endsWith(",簿外") && stockCsv2.includes(",○\r\n"));

    // 入力エラーのテストで意図的に発生させた 400 / 409 応答のログは除く
    const unexpected = consoleErrors.filter((t) => !/status of (400|409|502)/.test(t));
    check("画面のエラー（JS例外・想定外のコンソールエラー）なし", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));

    await desktopBrowser.close();
    await mobileBrowser.close();
  } catch (e) {
    console.error("E2E FAILED:", e);
    results.push({ name: "例外", ok: false, detail: String(e) });
  } finally {
    // 社外アドレス（このコンテナの 192.0.2.2 は社内用アドレスではない）からの接続拒否
    if (process.env.EXTERNAL_IP) {
      try {
        const code = execSync(`curl -s -o /dev/null -w "%{http_code}" http://${process.env.EXTERNAL_IP}:${PORT}/api/health`).toString();
        check("ローカルネットワーク以外のアドレスからの接続は 403", code === "403", code);
      } catch (e) {
        check("ローカルネットワーク以外のアドレスからの接続は 403", false, String(e));
      }
    }
    server.kill("SIGINT");
    smtp.server.close();
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(`${SHOTS}/server.log`, serverOut);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
