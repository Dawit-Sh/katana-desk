// A small GitHub REST helper for the release scripts (Node's own fetch, the workflow's token).
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
export const repo = process.env.GITHUB_REPOSITORY;

export async function gh(method, path, body, headers = {}) {
  const url = path.startsWith("https://") ? path : `https://api.github.com/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body == null ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  if (headers.accept === "application/octet-stream") return new Uint8Array(await res.arrayBuffer());
  return res.status === 204 ? null : res.json();
}

/** Every release, drafts included (only a signed-in token sees drafts). */
export async function releases() {
  const all = [];
  for (let page = 1; ; page++) {
    const part = await gh("GET", `repos/${repo}/releases?per_page=100&page=${page}`);
    all.push(...part);
    if (part.length < 100) return all;
  }
}
