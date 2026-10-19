// Detecta as stacks dos seus repositórios, gera os cards de estatísticas e atualiza o README.md.
// Roda no GitHub Actions (Node 20+), sem dependências.
import { mkdir, readFile, writeFile } from "node:fs/promises";

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

// Cores das linguagens (mesmas do GitHub) para o card de linguagens
const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", PHP: "#4F5D95",
  Java: "#b07219", "C#": "#178600", Go: "#00ADD8", Rust: "#dea584", HTML: "#e34c26",
  CSS: "#563d7c", SCSS: "#c6538c", Sass: "#a53b70", Shell: "#89e051",
  PowerShell: "#012456", Dockerfile: "#384d54", Vue: "#41b883", Svelte: "#ff3e00",
  Dart: "#00B4AB", Kotlin: "#A97BFF", Swift: "#F05138", Ruby: "#701516", C: "#555555",
  "C++": "#f34b7d", Lua: "#000080", Elixir: "#6e4a7e", Scala: "#c22d40",
  Astro: "#ff5a03", Solidity: "#AA6746", HCL: "#844FBA", "Jupyter Notebook": "#DA5B0B",
  Blade: "#f7523f", Hack: "#878787",
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

const HEADERS = {
  "User-Agent": "profile-readme-updater",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, { headers: { ...HEADERS, Accept: accept } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} em ${path}: ${await res.text()}`);
  return accept.includes("raw") ? res.text() : res.json();
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
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
  `https://skillicons.dev/icons?i=${ids.join(",")}&theme=dark&perline=12`;

function replaceBlock(md, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  return md.replace(re, `$1\n${content}\n$2`);
}

// ---------- Cards SVG (gerados aqui, sem depender de serviço externo) ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => n.toLocaleString("pt-BR");
const CARD_W = 450;
const CARD_H = 200;
const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif";

const card = (title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="${esc(title)}">
<style>
.t{font:600 18px ${FONT};fill:#00D4FF}
.l{font:400 14px ${FONT};fill:#c9d1d9}
.v{font:700 14px ${FONT};fill:#ffffff}
</style>
<rect width="${CARD_W}" height="${CARD_H}" rx="10" fill="#0D1117"/>
<text x="25" y="38" class="t">${esc(title)}</text>
${body}
</svg>
`;

function statsCard(rows) {
  const body = rows
    .map(([label, value], i) => {
      const y = 75 + i * 27;
      return `<circle cx="30" cy="${y - 5}" r="4" fill="#7F00FF"/>` +
        `<text x="45" y="${y}" class="l">${esc(label)}</text>` +
        `<text x="${CARD_W - 25}" y="${y}" class="v" text-anchor="end">${esc(value)}</text>`;
    })
    .join("\n");
  return card("Estatísticas no GitHub", body);
}

function langsCard(langs) {
  const total = langs.reduce((s, [, b]) => s + b, 0) || 1;
  const barW = CARD_W - 50;
  let x = 25;
  const bar = langs
    .map(([name, bytes]) => {
      const w = (bytes / total) * barW;
      const rect = `<rect x="${x.toFixed(2)}" y="55" width="${w.toFixed(2)}" height="10" fill="${LANG_COLORS[name] ?? "#7F00FF"}"/>`;
      x += w;
      return rect;
    })
    .join("");
  const legend = langs
    .map(([name, bytes], i) => {
      const cx = 30 + (i % 2) * 205;
      const y = 100 + Math.floor(i / 2) * 25;
      const pct = ((bytes / total) * 100).toFixed(1).replace(".", ",");
      return `<circle cx="${cx}" cy="${y - 5}" r="5" fill="${LANG_COLORS[name] ?? "#7F00FF"}"/>` +
        `<text x="${cx + 12}" y="${y}" class="l">${esc(name)} <tspan class="v">${pct}%</tspan></text>`;
    })
    .join("\n");
  return card(
    "Linguagens mais usadas",
    `<clipPath id="bar"><rect x="25" y="55" width="${barW}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)">${bar}</g>
${legend}`,
  );
}

async function fetchStats(repos) {
  const data = await graphql(
    `query($login: String!) {
      user(login: $login) {
        pullRequests { totalCount }
        contributionsCollection {
          totalCommitContributions
          contributionCalendar { totalContributions }
        }
      }
    }`,
    { login: OWNER },
  );
  const c = data.user.contributionsCollection;
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const active = repos.filter((r) => new Date(r.pushed_at) > yearAgo).length;
  return [
    ["Contribuições (últimos 12 meses)", fmt(c.contributionCalendar.totalContributions)],
    ["Commits (últimos 12 meses)", fmt(c.totalCommitContributions)],
    ["Repositórios", fmt(repos.length)],
    ["Projetos ativos (últimos 12 meses)", fmt(active)],
    ["Pull requests", fmt(data.user.pullRequests.totalCount)],
  ];
}

// ---------- Coleta ----------

if (!USE_PAT) {
  console.log("::warning::GH_PAT não configurado: só repositórios públicos e contribuições públicas entram nas stacks e nos cards.");
}

const repos = await listRepos();
const results = await mapLimit(repos, 5, detectRepo);
const detected = new Map(repos.map((r, i) => [r.full_name, results[i]]));

// Linguagens ordenadas por bytes de código; ferramentas por nº de repositórios
const langBytes = {};
const langNameBytes = {};
const toolCount = {};
for (const { langs, tools } of results) {
  for (const [lang, bytes] of Object.entries(langs)) {
    langNameBytes[lang] = (langNameBytes[lang] ?? 0) + bytes;
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

// ---------- Cards ----------

await mkdir("assets", { recursive: true });
await writeFile("assets/stats.svg", statsCard(await fetchStats(repos)));
const topLangs = Object.entries(langNameBytes)
  .filter(([name]) => !ignore.has(LANGS[name] ?? name))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
await writeFile("assets/langs.svg", langsCard(topLangs));

// ---------- Seções do README ----------

const stacks = [
  langIds.length && `<p align="center"><b>Linguagens</b><br/><br/><img src="${icons(langIds.slice(0, max))}" alt="Linguagens" /></p>`,
  toolIds.length && `<p align="center"><b>Frameworks, bancos & ferramentas</b><br/><br/><img src="${icons(toolIds.slice(0, max))}" alt="Ferramentas" /></p>`,
  `<p align="center"><sub>🤖 Detectado automaticamente em ${repos.length} repositórios</sub></p>`,
].filter(Boolean).join("\n\n");

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
      "### `> ls ~/projetos --destaque`",
      "",
      "| Projeto | O que é | Stack |",
      "| --- | --- | --- |",
      ...featuredItems.map((p) => {
        const name = p.url ? `[**${cell(p.name)}**](${p.url})` : `**${cell(p.name)}**`;
        return `| ${name} | ${cell(p.description)} | ${code(p.stack)} |`;
      }),
      "",
      "---",
    ].join("\n")
  : "";

const featuredSet = new Set(featuredItems.map((p) => p.full_name).filter(Boolean));
const recent = [...repos]
  .filter((r) => !r.private && !featuredSet.has(r.full_name))
  .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
  .slice(0, config.recentProjects ?? 6);

// Repositórios privados nunca aparecem aqui; sem públicos, a seção some
const projects = recent.length
  ? [
      "### `> git log --recent`",
      "",
      "| Projeto | Descrição | Linguagem | ⭐ |",
      "| --- | --- | --- | --- |",
      ...recent.map((r) => `| [**${r.name}**](${r.html_url}) | ${cell(r.description)} | \`${r.language ?? "—"}\` | ${r.stargazers_count} |`),
      "",
      "---",
    ].join("\n")
  : "";

let md = await readFile("README.md", "utf8");
md = md.replaceAll("SEU_USUARIO", OWNER);
md = replaceBlock(md, "STACKS", stacks);
md = replaceBlock(md, "FEATURED", featured);
md = replaceBlock(md, "PROJECTS", projects);
await writeFile("README.md", md);

console.log(`OK: ${repos.length} repos | langs: ${langIds.join(", ")} | tools: ${toolIds.join(", ")}`);
