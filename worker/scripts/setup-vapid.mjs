import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveVapidPublicKey } from "../src/lib/crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(__dirname, "..");

async function generateVapidPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKey = deriveVapidPublicKey(privateJwk);
  return {
    privateKeyJson: JSON.stringify(privateJwk),
    publicKey,
  };
}

function putSecret(name, value) {
  const res = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: workerDir,
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`wrangler secret put ${name} が失敗しました (exit ${res.status})`);
  }
}

async function main() {
  const mode = process.argv[2] || "--local";
  const { privateKeyJson, publicKey } = await generateVapidPair();

  if (mode === "--local") {
    const devVarsPath = path.join(workerDir, ".dev.vars");
    if (fs.existsSync(devVarsPath)) {
      console.log(".dev.vars は既に存在するため上書きしませんでした。");
      return;
    }
    const content = `VAPID_PRIVATE_KEY=${privateKeyJson}\nVAPID_PUBLIC_KEY=${publicKey}\n`;
    fs.writeFileSync(devVarsPath, content, { mode: 0o600 });
    console.log("ローカル用の VAPID 鍵ペアを生成し、worker/.dev.vars に安全に保存しました。");
    return;
  }

  if (mode === "--remote") {
    putSecret("VAPID_PRIVATE_KEY", privateKeyJson);
    putSecret("VAPID_PUBLIC_KEY", publicKey);
    console.log("本番用の VAPID 鍵ペアを生成し、Cloudflare Workers Secrets に安全に登録しました。");
    return;
  }

  console.error("使い方: node scripts/setup-vapid.mjs [--local | --remote]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
