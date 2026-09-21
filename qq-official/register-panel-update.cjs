"use strict";
// Standalone updater: read the server's own credentials; never connect the gateway.
const fs = require("node:fs");
const { createOfficial } = require("./official-transport.cjs");
const { registerGroupPanel, createApi, findOurs, normalizeItems, buildPanel } = require("./mia-command-panel.cjs");
async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
  const transport = createOfficial({ ...config, log: () => {} });
  try {
    await registerGroupPanel({ transport, groups: config.allowedGroupIds, log: () => {} });
    const current = findOurs(await createApi(transport).list("group"));
    if (JSON.stringify(normalizeItems(current?.panel?.items)) !== JSON.stringify(normalizeItems(buildPanel().items))) throw Error("verification failed");
    console.log("QQ command panel updated and verified: song search is available.");
  } finally { transport.stop(); }
}
if (require.main === module) main().catch(() => { console.error("QQ panel update failed. Retry Update-Panel.cmd on the server."); process.exitCode = 1; });
