// Detecta as stacks dos seus repositórios e atualiza o README.md.
// Roda no GitHub Actions (Node 20+), sem dependências.
import { readFile, writeFile } from "node:fs/promises";

const OWNER = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const USE_PAT = Boolean(process.env.GH_PAT);
if (!OWNER) throw new Error("Defina GH_USER ou GITHUB_REPOSITORY_OWNER");

const config = JSON.parse(await readFile("stacks.config.json", "utf8"));
const ignore = new Set(config.ignore ?? []);

// Linguagem do GitHub -> ícone do skillicons.dev
const LANGS = {
  JavaScript: "js", TypeScript: "ts", Python: "py", PHP: "php", Java: "java",
  "C#": "cs", Go: "go", Rust: "rust", HTML: "html", CSS: "css", SCSS: "sass",
  Sass: "sass", Shell: "bash", PowerShell: "powershell", Dockerfile: "docker",
  Vue: "vue", Svelte: "svelte", Dart: "dart", Kotlin: "kotlin", Swift: "swift",
  Ruby: "ruby", C: "c", "C++": "cpp", Lua: "lua", Elixir: "elixir", Scala: "scala",
  Astro: "astro", Solidity: "solidity", HCL: "terraform", "Jupyter Notebook": "py",
};

// Dependência -> ícone
const DEPS = {
  react: "react", "react-native": "react", next: "nextjs", vue: "vue", nuxt: "nuxtjs",
  svelte: "svelte", "@angular/core": "angular", express: "express", "@nestjs/core": "nestjs",
  tailwindcss: "tailwind", prisma: "prisma", "@prisma/client": "prisma", mongoose: "mongodb",
  mongodb: "mongodb", pg: "postgres", mysql: "mysql", mysql2: "mysql", redis: "redis",
  ioredis: "redis", firebase: "firebase", "firebase-admin": "firebase",
  "@supabase/supabase-js": "supabase", vite: "vite", jest: "jest", vitest: "vitest",
  graphql: "graphql", electron: "electron", sass: "sass", "styled-components": "styledcomponents",
  redux: "redux", "@reduxjs/toolkit": "redux", three: "threejs", bootstrap: "bootstrap",
  "socket.io": "nodejs", webpack: "webpack", "@sveltejs/kit": "svelte", astro: "astro",
  sequelize: "sequelize", typeorm: "ts", cypress: "cypress",
  django: "django", flask: "flask", fastapi: "fastapi", tensorflow: "tensorflow",
  torch: "pytorch", "laravel/framework": "laravel", "symfony/framework-bundle": "symfony",
};

// Topics do repositório -> ícone (além de ids que já batem com o skillicons)
const TOPIC_ALIASES = {
  javascript: "js", typescript: "ts", python: "py", nodejs: "nodejs", node: "nodejs",
  "next-js": "nextjs", nextjs: "nextjs", reactjs: "react", vuejs: "vue", postgresql: "postgres",
  tailwindcss: "tailwind", "amazon-web-services": "aws", kubernetes: "kubernetes", k8s: "kubernetes",
  "github-actions": "githubactions", wordpress: "wordpress", "react-native": "react",
};
const KNOWN_TOPICS = new Set([
  ...Object.values(LANGS), ...Object.values(DEPS), "aws", "gcp", "azure", "docker",
  "kubernetes", "linux", "nginx", "vercel", "netlify", "heroku", "cloudflare", "figma",
  "postman", "githubactions", "wordpress", "nodejs", "mongodb", "postgres", "mysql",
  "sqlite", "redis", "firebase", "supabase", "rabbitmq", "kafka", "flutter",
]);

async function gh(path, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: accept,
      "User-Agent": "profile-readme-updater",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} em ${path}: ${await res.text()}`);
  return accept.includes("raw") ? res.text() : res.json();
}

// Executa fn em lotes pequenos para não esbarrar no limite secundário da API
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function listRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const base = USE_PAT
      ? `/user/repos?affiliation=owner&per_page=100&page=${page}`
      : `/users/${OWNER}/repos?type=owner&per_page=100&page=${page}`;
    const batch = (await gh(base)) ?? [];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => !r.fork && !r.archived && r.name.toLowerCase() !== OWNER.toLowerCase());
}

const raw = (repo, file) => gh(`/repos/${repo}/contents/${file}`, "application/vnd.github.raw+json");

async function detectRepo(repo) {
  const found = new Set();
  const [langs, pkg, reqs, composer] = await Promise.all([
    gh(`/repos/${repo.full_name}/languages`),
    raw(repo.full_name, "package.json"),
    raw(repo.full_name, "requirements.txt"),
    raw(repo.full_name, "composer.json"),
  ]);

  if (pkg) {
    found.add("nodejs");
    try {
      const json = JSON.parse(pkg);
      for (const dep of Object.keys({ ...json.dependencies, ...json.devDependencies })) {
        if (DEPS[dep]) found.add(DEPS[dep]);
      }
    } catch {}
  }
  if (reqs) {
    for (const line of reqs.toLowerCase().split("\n")) {
      const name = line.split(/[=<>~\[;\s]/)[0].trim();
      if (DEPS[name]) found.add(DEPS[name]);
    }
  }
  if (composer) {
    try {
      for (const dep of Object.keys(JSON.parse(composer).require ?? {})) {
        if (DEPS[dep]) found.add(DEPS[dep]);
      }
    } catch {}
  }
  for (const topic of repo.topics ?? []) {
    const id = TOPIC_ALIASES[topic] ?? topic;
    if (KNOWN_TOPICS.has(id)) found.add(id);
  }
  return { langs: langs ?? {}, tools: found };
}

const icons = (ids) =>
  `https://skillicons.dev/icons?i=${ids.join(",")}&theme=dark&perline=14`;

function replaceBlock(md, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  return md.replace(re, `$1\n${content}\n$2`);
}

// ---------- Coleta ----------

if (!USE_PAT) {
  console.log("::warning::GH_PAT não configurado: só repositórios públicos entram na detecção de stacks.");
}

const repos = await listRepos();
const results = await mapLimit(repos, 5, detectRepo);
const detected = new Map(repos.map((r, i) => [r.full_name, results[i]]));

// Linguagens ordenadas por bytes de código; ferramentas por nº de repositórios
const langBytes = {};
const toolCount = {};
for (const { langs, tools } of results) {
  for (const [lang, bytes] of Object.entries(langs)) {
    const id = LANGS[lang];
    if (id) langBytes[id] = (langBytes[id] ?? 0) + bytes;
  }
  for (const t of tools) toolCount[t] = (toolCount[t] ?? 0) + 1;
}

const langIds = Object.entries(langBytes)
  .sort((a, b) => b[1] - a[1])
  .map(([id]) => id)
  .filter((id) => !ignore.has(id));
const toolIds = [
  ...Object.entries(toolCount).sort((a, b) => b[1] - a[1]).map(([id]) => id),
  ...(config.extra ?? []),
].filter((id, i, arr) => !ignore.has(id) && !langIds.includes(id) && arr.indexOf(id) === i);

const max = config.maxIcons ?? 40;

// ---------- Seções do README ----------

// Agrupa os ícones por área; o que não estiver listado cai em "Ferramentas"
const CATEGORIES = [
  ["Linguagens", ["ts", "js", "py", "php", "java", "cs", "go", "rust", "dart", "kotlin", "swift", "ruby", "c", "cpp", "lua", "elixir", "scala", "solidity"]],
  ["Front-end", ["react", "nextjs", "vue", "nuxtjs", "svelte", "angular", "astro", "html", "css", "sass", "tailwind", "styledcomponents", "bootstrap", "redux", "threejs", "vite", "webpack", "electron", "flutter"]],
  ["Back-end", ["nodejs", "express", "nestjs", "django", "flask", "fastapi", "laravel", "symfony", "graphql", "wordpress"]],
  ["Dados", ["postgres", "mysql", "mongodb", "redis", "sqlite", "prisma", "sequelize", "firebase", "supabase", "rabbitmq", "kafka", "tensorflow", "pytorch"]],
  ["Infra & DevOps", ["docker", "kubernetes", "aws", "gcp", "azure", "nginx", "vercel", "netlify", "heroku", "cloudflare", "terraform", "githubactions", "linux", "bash", "powershell"]],
  ["Testes", ["jest", "vitest", "cypress"]],
];
const allIds = [...langIds, ...toolIds].slice(0, max);
const groups = CATEGORIES.map(([label, ids]) => [label, allIds.filter((id) => ids.includes(id))]);
const known = new Set(CATEGORIES.flatMap(([, ids]) => ids));
groups.push(["Ferramentas", allIds.filter((id) => !known.has(id))]);

const stacks = [
  "<table>",
  ...groups
    .filter(([, ids]) => ids.length)
    .map(([label, ids]) => `  <tr><td><b>${label.replace("&", "&amp;")}</b></td><td><img src="${icons(ids)}" alt="${ids.join(", ")}" /></td></tr>`),
  "</table>",
].join("\n");

const cell = (s) => (s ?? "—").replace(/\|/g, "\\|");
const code = (items) => items.filter(Boolean).map((t) => `\`${t}\``).join(" ") || "—";
const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));

// Cada item de "featured" pode ser:
//  - o nome de um repositório: descrição e stack vêm do GitHub (link só se for público)
//  - um objeto { name, description, stack, url }: projeto descrito à mão, sem expor repositório
const featuredItems = (config.featured ?? [])
  .map((item) => {
    if (typeof item === "object") {
      return { name: item.name, url: item.url, description: item.description, stack: item.stack ?? [] };
    }
    const r = byName.get(String(item).toLowerCase());
    if (!r) return null;
    const tools = [...(detected.get(r.full_name)?.tools ?? [])].filter((t) => t !== "nodejs").slice(0, 4);
    return {
      name: r.name,
      url: r.homepage || (r.private ? null : r.html_url),
      description: r.description,
      stack: [r.language, ...tools],
      full_name: r.full_name,
    };
  })
  .filter((p) => p?.name);

const featured = featuredItems.length
  ? [
      "### Trabalhos selecionados",
      "",
      "| Projeto | O que é | Stack |",
      "| --- | --- | --- |",
      ...featuredItems.map((p) => {
        const name = p.url ? `[**${cell(p.name)}**](${p.url})` : `**${cell(p.name)}**`;
        return `| ${name} | ${cell(p.description)} | ${code(p.stack)} |`;
      }),
    ].join("\n")
  : "";

const featuredSet = new Set(featuredItems.map((p) => p.full_name).filter(Boolean));
const recent = [...repos]
  .filter((r) => !r.private && !featuredSet.has(r.full_name))
  .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
  .slice(0, config.recentProjects ?? 0);

// Só repositórios públicos; com recentProjects = 0 (ou sem públicos), a seção some
const projects = recent.length
  ? [
      "### Projetos open source",
      "",
      "| Projeto | Descrição | Linguagem | ⭐ |",
      "| --- | --- | --- | --- |",
      ...recent.map((r) => `| [**${r.name}**](${r.html_url}) | ${cell(r.description)} | \`${r.language ?? "—"}\` | ${r.stargazers_count} |`),
    ].join("\n")
  : "";

let md = await readFile("README.md", "utf8");
md = replaceBlock(md, "STACKS", stacks);
md = replaceBlock(md, "FEATURED", featured);
md = replaceBlock(md, "PROJECTS", projects);
await writeFile("README.md", md);

console.log(`OK: ${repos.length} repos | langs: ${langIds.join(", ")} | tools: ${toolIds.join(", ")}`);
