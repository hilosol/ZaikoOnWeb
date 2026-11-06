// E2E 用の最小 SMTP サーバー（受け取ったメールを配列に保存するだけ。認証・暗号化なし）
const net = require("node:net");

function startSmtpSink(port) {
  const messages = [];
  const server = net.createServer((sock) => {
    let data = false;
    let buf = "";
    let current = { from: "", to: [], body: "" };
    sock.write("220 sink ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(current);
            current = { from: "", to: [], body: "" };
            sock.write("250 OK queued\r\n");
          } else current.body += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-sink\r\n250 8BITMIME\r\n");
        else if (cmd === "MAIL") { current.from = line; sock.write("250 OK\r\n"); }
        else if (cmd === "RCPT") { current.to.push(line); sock.write("250 OK\r\n"); }
        else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else if (cmd === "RSET" || cmd === "NOOP") sock.write("250 OK\r\n");
        else sock.write("502 not implemented\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, messages })));
}

module.exports = { startSmtpSink };
