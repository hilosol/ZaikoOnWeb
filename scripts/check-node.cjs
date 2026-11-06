// 起動前に Node.js のバージョンを確認する（古い Node.js では内蔵 SQLite が使えないため）
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = major > 22 || (major === 22 && minor >= 13);
if (!ok) {
  console.error(`Node.js ${process.versions.node} は古いため起動できません。Node.js 24 LTS（22.13 以上）をインストールしてください。`);
  console.error("https://nodejs.org/ja/download");
  process.exit(1);
}
