import { cp, mkdir, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
const sourceFiles = ["index.html", "styles.css"];
const modules = await readdir(path.join(root, "src"), { withFileTypes: true });

await mkdir(output, { recursive: true });
for (const file of sourceFiles) {
  await cp(path.join(root, file), path.join(output, file));
}
await mkdir(path.join(output, "src"), { recursive: true });
for (const entry of modules) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    await cp(path.join(root, "src", entry.name), path.join(output, "src", entry.name));
  }
}

for (const entry of modules.filter((item) => item.isFile() && item.name.endsWith(".js")).map((item) => `src/${item.name}`)) {
  const check = spawnSync(process.execPath, ["--check", path.join(root, entry)], { stdio: "inherit" });
  if (check.status !== 0) process.exit(check.status ?? 1);
}

console.log(`Built ${sourceFiles.length + modules.filter((item) => item.isFile() && item.name.endsWith(".js")).length} frontend assets into dist/.`);
