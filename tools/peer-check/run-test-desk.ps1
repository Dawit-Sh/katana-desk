# Starts the Katana Desk test build (copied to katana-desk-test\local-sync-bin) on the local-sync test
# profile: not signed in to Grimmory, Local folder Documents\KatanaSyncTest, window off-screen, the sync
# server on 127.0.0.1:47615 only (an emulator reaches it as 10.0.2.2:47615; no mDNS, no firewall prompt),
# WebView2's debug port 9231 for cdp_eval.mjs.
# A pairing code: node cdp_eval.mjs 9231 "window.__TAURI_INTERNALS__.invoke('peer_pair_open').then(s => s.code)"
$t = "$env:LOCALAPPDATA\katana-desk-test"
$env:KATANA_DATA_DIR = "$t\local-sync"
$env:KATANA_QUIET = "1"
$env:KATANA_PEER_BIND = "127.0.0.1"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9231"
$env:WEBVIEW2_USER_DATA_FOLDER = "$t\local-sync\webview"
& "$t\local-sync-bin\katana-desk.exe"
