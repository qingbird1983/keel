// `model-deepseek` 手动验证（Phase 4 切片③，K4：真适配器不进 CI、不承诺生产可用）。
//
// 用法：DEEPSEEK_API_KEY=... node scripts/verify-model-deepseek.mjs [模型名]
// 先 `pnpm build`。脚本只打印用量与按 manifest 价格表算出的费用，不写账本、不起 Cell。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "../packages/plugins/model-deepseek/dist/index.js";
import { priceUsage } from "../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(
    path.join(root, "packages", "plugins", "model-deepseek", "keel-plugin.json"),
    "utf8",
  ),
);
const model = process.argv[2] ?? "deepseek-flash";
const decl = manifest.model;

const upstream = create({
  model: decl,
  secrets: { resolve: (ref) => (ref === decl.auth.ref ? process.env[ref] : undefined) },
});

const outcome = await upstream.invoke({
  model,
  params: { messages: [{ role: "user", content: "Reply with exactly: keel-ok" }] },
});
const tiered = priceUsage(decl.pricing[model], outcome.usage, new Date());
console.log(
  `invoke: model=${model} usage=${JSON.stringify(outcome.usage)} tier=${tiered.tier} usd=${tiered.cost}`,
);
console.log(`content: ${JSON.stringify(outcome.result)}`);

let parts = 0;
let lastUsage;
let text = "";
for await (const part of upstream.stream({
  model,
  params: { messages: [{ role: "user", content: "Count 1 to 3, comma separated." }] },
})) {
  parts += 1;
  if (part.usage) lastUsage = part.usage;
  const c = part.chunk?.content;
  if (typeof c === "string") text += c;
}
const streamTier = lastUsage ? priceUsage(decl.pricing[model], lastUsage, new Date()) : null;
console.log(
  `stream: parts=${parts} usage=${JSON.stringify(lastUsage ?? null)} tier=${streamTier?.tier ?? "-"} usd=${streamTier?.cost ?? "-"}`,
);
console.log(`stream text: ${JSON.stringify(text)}`);
