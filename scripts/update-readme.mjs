// Detecta as stacks dos seus repositórios, gera as imagens do perfil e atualiza o README.md.
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

// Linguagens de programação "de verdade" (exclui HTML, CSS, SQL, scripts de shell)
const PROGRAMMING = ["TypeScript", "JavaScript", "Python", "Go", "PHP", "Java", "C#", "Rust", "Dart", "Kotlin", "Swift", "Ruby", "Elixir", "Scala", "C", "C++"];
const SHORT = { TypeScript: "TS", JavaScript: "JS" };

// Cores das linguagens (mesmas do GitHub) para o card de linguagens
const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", PHP: "#4F5D95",
  Java: "#b07219", "C#": "#178600", Go: "#00ADD8", Rust: "#dea584", HTML: "#e34c26",
  CSS: "#663399", SCSS: "#c6538c", Sass: "#a53b70", Shell: "#89e051",
  PowerShell: "#012456", Dockerfile: "#384d54", Vue: "#41b883", Svelte: "#ff3e00",
  Dart: "#00B4AB", Kotlin: "#A97BFF", Swift: "#F05138", Ruby: "#701516", C: "#555555",
  "C++": "#f34b7d", Lua: "#000080", Elixir: "#6e4a7e", Scala: "#c22d40",
  Astro: "#ff5a03", Solidity: "#AA6746", HCL: "#844FBA", "Jupyter Notebook": "#DA5B0B",
  PLpgSQL: "#336790",
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

// Nome legível de cada ícone, para os chips de stack dos produtos
const LABELS = {
  ts: "TypeScript", js: "JavaScript", py: "Python", go: "Go", php: "PHP", nodejs: "Node.js",
  nestjs: "NestJS", fastapi: "FastAPI", express: "Express", nextjs: "Next.js", react: "React",
  vue: "Vue", tailwind: "Tailwind", prisma: "Prisma", postgres: "PostgreSQL", mysql: "MySQL",
  mongodb: "MongoDB", redis: "Redis", docker: "Docker", supabase: "Supabase", firebase: "Firebase",
  laravel: "Laravel", django: "Django", flask: "Flask", graphql: "GraphQL", vite: "Vite",
};

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

// ---------- Imagens SVG (todas no mesmo estilo) ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => n.toLocaleString("pt-BR");
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const FONT = "'Segoe UI', 'Helvetica Neue', Ubuntu, Arial, sans-serif";
const MONO = "'Cascadia Code', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace";
const ACCENT = `<linearGradient id="accent" x1="0" x2="1"><stop offset="0" stop-color="#7F00FF"/><stop offset="1" stop-color="#00D4FF"/></linearGradient>`;

function wrap(text, max) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && `${line} ${word}`.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function headerSvg(profile, stack) {
  const stackLine = stack.map((s) => `<tspan fill="#a5d6ff">"${esc(s)}"</tspan>`).join(", ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="320" viewBox="0 0 1200 320" role="img" aria-label="${esc(`${profile.name} · ${profile.role}`)}">
<defs>
${ACCENT}
<radialGradient id="glow" cx="0.82" cy="0.15" r="0.7"><stop offset="0" stop-color="#7F00FF" stop-opacity="0.35"/><stop offset="1" stop-color="#7F00FF" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#ffffff" stroke-opacity="0.045"/></pattern>
<clipPath id="frame"><rect width="1200" height="320" rx="16"/></clipPath>
</defs>
<style>
.sans{font-family:${FONT}}
.mono{font-family:${MONO};font-size:15px;fill:#c9d1d9;white-space:pre}
.in{opacity:0;animation:in .8s ease forwards}
@keyframes in{to{opacity:1}}
</style>
<g clip-path="url(#frame)">
<rect width="1200" height="320" fill="#0D1117"/>
<rect width="1200" height="320" fill="url(#grid)"/>
<rect width="1200" height="320" fill="url(#glow)"/>
<rect y="316" width="1200" height="4" fill="url(#accent)"/>
</g>
<rect x="64" y="76" width="56" height="4" rx="2" fill="url(#accent)"/>
<text x="64" y="142" class="sans" font-size="56" font-weight="700" fill="#ffffff">${esc(profile.name)}</text>
<text x="64" y="188" class="sans" font-size="24" font-weight="600" fill="#00D4FF">${esc(profile.role)}</text>
<text x="64" y="232" class="sans" font-size="18" fill="#8b949e">${esc(profile.tagline)}</text>
<text x="64" y="268" class="sans" font-size="15" fill="#6e7681">${esc(profile.location)}</text>
<g transform="translate(772 56)">
<rect width="364" height="208" rx="12" fill="#161B22" stroke="#30363d"/>
<circle cx="22" cy="22" r="5" fill="#ff5f57"/><circle cx="40" cy="22" r="5" fill="#febc2e"/><circle cx="58" cy="22" r="5" fill="#28c840"/>
<text x="22" y="66" class="mono in" style="animation-delay:.2s"><tspan fill="#ff7b72">const</tspan> <tspan fill="#d2a8ff">eSolucoes</tspan> = {</text>
<text x="22" y="92" class="mono in" style="animation-delay:.5s">  foco: <tspan fill="#a5d6ff">"problemas reais"</tspan>,</text>
<text x="22" y="118" class="mono in" style="animation-delay:.8s">  stack: [${stackLine}],</text>
<text x="22" y="144" class="mono in" style="animation-delay:1.1s">  ia: <tspan fill="#79c0ff">true</tspan>,</text>
<text x="22" y="170" class="mono in" style="animation-delay:1.4s">  automatiza: <tspan fill="#79c0ff">true</tspan>,</text>
<text x="22" y="194" class="mono in" style="animation-delay:1.7s">};</text>
<rect x="46" y="181" width="9" height="17" fill="#00D4FF"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/></rect>
</g>
</svg>
`;
}

function productCard(p) {
  const W = 440;
  const H = 220;
  const desc = wrap(p.description ?? "", 54).slice(0, 3);
  let x = 24;
  const chips = [];
  for (const c of p.chips.slice(0, 6)) {
    const w = Math.round(c.length * 7.4 + 22);
    if (x + w > W - 24) break;
    chips.push(`<rect x="${x}" y="${H - 50}" width="${w}" height="26" rx="13" fill="#161B22" stroke="#30363d"/>` +
      `<text x="${x + w / 2}" y="${H - 32}" class="c" text-anchor="middle">${esc(c)}</text>`);
    x += w + 8;
  }
  const status = p.active
    ? `<circle cx="${W - 120}" cy="44" r="4" fill="#3fb950"><animate attributeName="opacity" values="1;0.35;1" dur="2s" repeatCount="indefinite"/></circle>` +
      `<text x="${W - 24}" y="49" class="s" text-anchor="end">Em evolução</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${p.name}: ${p.description ?? ""}`)}">
<defs>${ACCENT}</defs>
<style>
.g{font:600 11px ${FONT};fill:#00D4FF;letter-spacing:1.2px}
.n{font:700 22px ${FONT};fill:#ffffff}
.d{font:400 14px ${FONT};fill:#8b949e}
.c{font:500 12px ${FONT};fill:#c9d1d9}
.s{font:500 12px ${FONT};fill:#3fb950}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="#0D1117" stroke="#30363d"/>
<rect x="24" y="24" width="32" height="3" rx="1.5" fill="url(#accent)"/>
${status}
<text x="24" y="52" class="g">${esc((p.tag ?? "").toUpperCase())}</text>
<text x="24" y="82" class="n">${esc(p.name)}</text>
${desc.map((l, i) => `<text x="24" y="${112 + i * 20}" class="d">${esc(l)}</text>`).join("\n")}
${chips.join("\n")}
</svg>
`;
}

function impactSvg(items) {
  const W = 900;
  const H = 140;
  const colW = (W - 48) / items.length;
  const cells = items
    .map(({ value, label }, i) => {
      const cx = 24 + colW * i + colW / 2;
      const divider = i ? `<line x1="${24 + colW * i}" x2="${24 + colW * i}" y1="36" y2="${H - 36}" stroke="#21262d"/>` : "";
      return `${divider}<g class="m" style="animation-delay:${(i * 0.25).toFixed(2)}s">` +
        `<text x="${cx}" y="74" class="v" text-anchor="middle">${esc(value)}</text>` +
        `<text x="${cx}" y="102" class="l" text-anchor="middle">${esc(label)}</text></g>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(items.map((i) => `${i.value} ${i.label}`).join(", "))}">
<defs>${ACCENT}</defs>
<style>
.v{font:700 34px ${FONT};fill:url(#accent)}
.l{font:400 14px ${FONT};fill:#8b949e}
.m{opacity:0;animation:in .9s ease forwards}
@keyframes in{to{opacity:1}}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="#0D1117" stroke="#30363d"/>
${cells}
</svg>
`;
}

const CARD_W = 440;
const CARD_H = 210;

const card = (title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="${esc(title)}">
<defs>${ACCENT}</defs>
<style>
.t{font:600 17px ${FONT};fill:#ffffff}
.l{font:400 14px ${FONT};fill:#8b949e}
.v{font:600 14px ${FONT};fill:#e6edf3}
</style>
<rect x="0.5" y="0.5" width="${CARD_W - 1}" height="${CARD_H - 1}" rx="12" fill="#0D1117" stroke="#30363d"/>
<rect x="24" y="24" width="32" height="3" rx="1.5" fill="url(#accent)"/>
<text x="24" y="52" class="t">${esc(title)}</text>
${body}
</svg>
`;

function statsCard(rows) {
  const body = rows
    .map(([label, value], i) => {
      const y = 92 + i * 30;
      return `<text x="24" y="${y}" class="l">${esc(label)}</text>` +
        `<text x="${CARD_W - 24}" y="${y}" class="v" text-anchor="end">${esc(value)}</text>` +
        (i < rows.length - 1 ? `<line x1="24" x2="${CARD_W - 24}" y1="${y + 11}" y2="${y + 11}" stroke="#21262d"/>` : "");
    })
    .join("\n");
  return card("Visão geral", body);
}

function langsCard(langs) {
  const total = langs.reduce((s, [, b]) => s + b, 0) || 1;
  const barW = CARD_W - 48;
  let x = 24;
  const bar = langs
    .map(([name, bytes]) => {
      const w = (bytes / total) * barW;
      const rect = `<rect x="${x.toFixed(2)}" y="72" width="${w.toFixed(2)}" height="8" fill="${LANG_COLORS[name] ?? "#7F00FF"}"/>`;
      x += w;
      return rect;
    })
    .join("");
  const legend = langs
    .map(([name, bytes], i) => {
      const cx = 30 + (i % 2) * 200;
      const y = 114 + Math.floor(i / 2) * 26;
      const pct = ((bytes / total) * 100).toFixed(1).replace(".", ",");
      return `<circle cx="${cx}" cy="${y - 5}" r="5" fill="${LANG_COLORS[name] ?? "#7F00FF"}"/>` +
        `<text x="${cx + 12}" y="${y}" class="v">${esc(name)} <tspan class="l">${pct}%</tspan></text>`;
    })
    .join("\n");
  return card(
    "Linguagens",
    `<clipPath id="bar"><rect x="24" y="72" width="${barW}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)">${bar}</g>
${legend}`,
  );
}

// ---------- Coleta ----------

if (!USE_PAT) {
  console.log("::warning::GH_PAT não configurado: só repositórios públicos entram no README.");
}

const repos = await listRepos();
const results = await mapLimit(repos, 5, detectRepo);
const detected = new Map(repos.map((r, i) => [r.full_name, results[i]]));
const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));

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
const allIds = [...langIds, ...toolIds].slice(0, max);
const topLangs = Object.entries(langNameBytes)
  .filter(([name]) => !ignore.has(LANGS[name] ?? name))
  .sort((a, b) => b[1] - a[1]);

// Stack de um repositório, em nomes legíveis (linguagens por volume + frameworks)
function repoStack(r) {
  const d = detected.get(r.full_name);
  if (!d) return [];
  const langs = Object.entries(d.langs)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .filter((name) => PROGRAMMING.includes(name))
    .slice(0, 2);
  const tools = [...d.tools].filter((t) => LABELS[t] && t !== "nodejs").map((t) => LABELS[t]);
  return [...new Set([...langs, ...tools])];
}

// Cada item de "featured" é descrito no config; com "repo", os chips mostram a stack
// detectada nesse repositório (que pode ser privado, o código não é exposto) e o
// selo "Em evolução" aparece se ele recebeu commits nos últimos 30 dias.
const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
const featuredItems = (config.featured ?? []).map((item) => {
  const r = item.repo && byName.get(item.repo.toLowerCase());
  const stack = r ? repoStack(r) : [];
  return {
    ...item,
    chips: stack.length ? stack : item.chips ?? [],
    active: Boolean(r && new Date(r.pushed_at) > monthAgo),
    full_name: r?.full_name,
  };
});

// ---------- Imagens ----------

await mkdir("assets/products", { recursive: true });

const bannerStack = topLangs.map(([name]) => name).filter((n) => PROGRAMMING.includes(n)).slice(0, 3).map((n) => SHORT[n] ?? n);
if (config.profile) await writeFile("assets/header.svg", headerSvg(config.profile, bannerStack));
if (config.impact?.length) await writeFile("assets/impact.svg", impactSvg(config.impact));
for (const p of featuredItems) await writeFile(`assets/products/${slug(p.name)}.svg`, productCard(p));

const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
await writeFile("assets/stats.svg", statsCard([
  ["Repositórios (incluindo privados)", fmt(repos.length)],
  ["Projetos ativos no último ano", fmt(repos.filter((r) => new Date(r.pushed_at) > yearAgo).length)],
  ["Linguagens", fmt(topLangs.length)],
  ["Tecnologias detectadas", fmt(allIds.length)],
]));
await writeFile("assets/langs.svg", langsCard(topLangs.slice(0, 8)));

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
const groups = CATEGORIES.map(([label, ids]) => [label, allIds.filter((id) => ids.includes(id))]);
const known = new Set(CATEGORIES.flatMap(([, ids]) => ids));
groups.push(["Ferramentas", allIds.filter((id) => !known.has(id))]);

const stacks = [
  "<table>",
  ...groups
    .filter(([, ids]) => ids.length)
    .map(([label, ids]) => `  <tr><td><b>${esc(label)}</b></td><td><img src="${icons(ids)}" alt="${ids.join(", ")}" /></td></tr>`),
  "</table>",
].join("\n");

const featured = featuredItems.length
  ? [
      "### Produtos",
      "",
      "<p>",
      ...featuredItems.map((p) => {
        const img = `<img src="./assets/products/${slug(p.name)}.svg" width="49%" alt="${esc(`${p.name}: ${p.description ?? ""}`)}" />`;
        return p.url ? `  <a href="${esc(p.url)}">${img}</a>` : `  ${img}`;
      }),
      "</p>",
    ].join("\n")
  : "";

const cell = (s) => (s ?? "—").replace(/\|/g, "\\|");
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
console.log(`Produtos: ${featuredItems.map((p) => `${p.name}${p.full_name ? ` (repo ${p.full_name})` : ""}`).join(", ")}`);
