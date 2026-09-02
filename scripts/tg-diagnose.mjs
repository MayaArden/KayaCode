// Reads ~/.kaya/telegram.json locally; never prints the token.
import { loadTelegramConfig } from "../packages/server/dist/index.js";
import * as os from "node:os";
import * as path from "node:path";

const configDir = path.join(os.homedir(), ".kaya");
const config = loadTelegramConfig(configDir);
if (!config?.botToken) { console.log("NO BOT TOKEN CONFIGURED"); process.exit(1); }
const base = config.apiBase ?? "https://api.telegram.org";
const call = async (method, payload) => {
  const res = await fetch(`${base}/bot${config.botToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}),
  });
  return res.json();
};

const me = await call("getMe");
console.log("getMe:", me.ok ? `@${me.result.username} (id ${me.result.id})` : me.description);

const webhook = await call("getWebhookInfo");
console.log("webhook:", webhook.result?.url || "(none — polling is fine)");

const updates = await call("getUpdates", { limit: 5, offset: -5 });
if (updates.ok) {
  console.log("recent updates:", updates.result.length);
  for (const u of updates.result) {
    const m = u.message ?? u.edited_message ?? u.callback_query?.message;
    console.log(" update", u.update_id, "| chat:", m?.chat?.id, "| from:", u.message?.from?.id, "@", u.message?.from?.username, "| text:", JSON.stringify(m?.text ?? "").slice(0, 60));
  }
} else {
  console.log("getUpdates FAILED:", updates.description, "(409 = something else is polling this token)");
}
