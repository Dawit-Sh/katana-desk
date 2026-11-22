// Makes the draft release v<version> (the version in src-tauri/tauri.conf.json), or reuses the draft
// already there and clears its files so a new run attaches fresh ones. Never publishes anything.
import { appendFileSync, readFileSync } from "node:fs";
import { gh, releases, repo } from "./github.mjs";

const version = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const tag = `v${version}`;

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== tag) {
  throw new Error(`The tag ${process.env.GITHUB_REF_NAME} doesn't match the app's version ${version} (tauri.conf.json).`);
}

const all = await releases();
if (all.some((r) => r.tag_name === tag && !r.draft)) {
  // publishing a draft creates its tag, and that tag's push lands here: nothing to build, all done
  if (process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_TYPE === "tag") {
    console.log(`${tag} is published already (its tag came from publishing it): nothing to build.`);
    appendFileSync(process.env.GITHUB_OUTPUT, `skip=true\nversion=${version}\n`);
    process.exit(0);
  }
  throw new Error(`${tag} is already published. Raise the version for a new release.`);
}

const body = readFileSync(".github/release-notes.md", "utf8").replaceAll("__VERSION__", version);
// GitHub renames an older draft's tag to "untagged-..." once another draft claims it, so a draft is
// found by its name too (the newest one)
let rel = all
  .filter((r) => r.draft && (r.tag_name === tag || r.name === `Katana Desk ${version}`))
  .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
if (rel) {
  for (const a of rel.assets) await gh("DELETE", `repos/${repo}/releases/assets/${a.id}`);
  rel = await gh("PATCH", `repos/${repo}/releases/${rel.id}`, { tag_name: tag, target_commitish: process.env.GITHUB_SHA, body });
  console.log(`Reusing draft ${rel.id} for ${tag} (its old files removed).`);
} else {
  rel = await gh("POST", `repos/${repo}/releases`, {
    tag_name: tag,
    target_commitish: process.env.GITHUB_SHA,
    name: `Katana Desk ${version}`,
    body,
    draft: true,
    prerelease: false,
  });
  console.log(`Made draft ${rel.id} for ${tag}.`);
}
appendFileSync(process.env.GITHUB_OUTPUT, `id=${rel.id}\nversion=${version}\n`);
