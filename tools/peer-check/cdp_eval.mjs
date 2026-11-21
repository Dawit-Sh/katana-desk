// node cdp_eval.mjs <port> "<expr>": evaluates in Katana Desk's page over WebView2's debug port and prints the value.
const [, , port, expr] = process.argv;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) {
    console.log(JSON.stringify(m.result?.result?.value ?? m.result?.exceptionDetails ?? m));
    process.exit(0);
  }
});
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
