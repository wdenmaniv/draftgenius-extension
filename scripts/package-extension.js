// Zips the extension/ folder into a downloadable artifact for the
// DraftGenius website's /app/extension page — the extension isn't on the
// Chrome Web Store yet (that needs a developer account, review, and a
// privacy policy given the host_permissions on live ESPN/Yahoo pages — a
// separate workstream), so a direct zip + "load unpacked" is the real v1
// distribution method. No build step exists or is needed (plain ES
// modules), so this is just an archive, not a bundle.
//
// Usage: node scripts/package-extension.js [output-path]
// Default output: dist/draftgenius-extension.zip
// .github/workflows/release-extension.yml runs this on every push to main
// that touches extension/, then attaches the output to a GitHub Release —
// the website's download button links straight at that release's "latest"
// asset, so there's no manual copy step and no cross-repo deploy involved.
// Run this manually only if you want a local zip to test "load unpacked"
// against outside of that CI flow.
//
// Stages extension/ into a temp dir renamed to "draftgenius-extension"
// before zipping, so unzipping the download produces a
// draftgenius-extension/extension/ folder matching exactly what the
// website's install instructions tell the user to select — zipping
// extension/ in place would instead unzip to a bare "extension" folder,
// a confusing mismatch with those instructions.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const outPath = path.resolve(process.argv[2] ?? path.join(ROOT, "dist/draftgenius-extension.zip"));

mkdirSync(path.dirname(outPath), { recursive: true });
if (existsSync(outPath)) rmSync(outPath);

const stageRoot = mkdtempSync(path.join(os.tmpdir(), "draftgenius-package-"));
const stageDir = path.join(stageRoot, "draftgenius-extension", "extension");
mkdirSync(stageDir, { recursive: true });
cpSync(path.join(ROOT, "extension"), stageDir, {
  recursive: true,
  filter: (src) => !src.endsWith(".DS_Store"),
});

execFileSync("zip", ["-r", outPath, "draftgenius-extension"], {
  cwd: path.join(stageDir, "..", ".."),
  stdio: "inherit",
});
rmSync(stageRoot, { recursive: true, force: true });

console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
console.log("Push to main to have CI attach this to a GitHub Release automatically, or load it unpacked locally to test.");
