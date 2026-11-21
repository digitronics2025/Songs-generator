import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseOwnerEmails } from "../src/lib/ownerEmails.ts";

export function renderRules(template: string, emails: string[]) {
  const marker = "/* OWNER_EMAILS */ []";
  if (!template.includes(marker)) throw new Error("The rules template has no owner allow-list placeholder.");
  return template.replace(marker, JSON.stringify(emails));
}

async function main() {
  const emails = parseOwnerEmails(process.env.OWNER_EMAILS);
  if (!emails.length) throw new Error("Set OWNER_EMAILS privately before rendering deployment rules.");
  const folder = ".firebase/studio-rules";
  await mkdir(folder, { recursive: true });
  for (const file of ["firestore.rules", "storage.rules"]) {
    await writeFile(folder + "/" + file, renderRules(await readFile(file, "utf8"), emails));
  }
  const config = JSON.parse(await readFile("firebase.json", "utf8"));
  config.firestore[0].rules = folder + "/firestore.rules";
  config.storage[0].rules = folder + "/storage.rules";
  await writeFile(".firebase-studio.generated.json", JSON.stringify(config, null, 2) + "\n");
  console.log("Rendered owner rules and local Firebase config. Nothing was deployed.");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/render-rules.ts")) {
  main().catch(() => { console.error("Could not render rules. Check OWNER_EMAILS and local templates."); process.exitCode = 1; });
}
