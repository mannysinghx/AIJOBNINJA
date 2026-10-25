// Local web UI for the job search framework.
//
//   bun run webui/server.ts            → http://127.0.0.1:4310
//
// Zero runtime dependencies: Bun's built-in HTTP server, the portal CLIs that
// already ship in .agents/skills, and static files. It binds to loopback only
// and talks to no service other than the job portals the CLIs already query.
//
// Data it writes: webui/data/saved.json (your shortlist) and nothing else.
// job_search_tracker.csv is read-only here - /apply and /outcome own it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { extname, join, normalize, resolve } from "node:path"
import { PORTALS, REPO_ROOT, portalById, runCli, type Job, type SearchParams, type WorkMode } from "./lib/portals"
import { renderDescription } from "./lib/render"

const PORT = Number(process.env.PORT ?? 4310)
const HOST = process.env.HOST ?? "127.0.0.1"
const PUBLIC = join(import.meta.dir, "public")
const FONTS = join(REPO_ROOT, "cover_letters", "OpenFonts", "fonts", "lato")
const DATA = join(import.meta.dir, "data")
const SAVED = join(DATA, "saved.json")
const TRACKER = join(REPO_ROOT, "job_search_tracker.csv")

// ---------------------------------------------------------------- caching
const CACHE_TTL = 10 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, fn: () => Promise<T>, keep: (v: T) => boolean): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value
  const value = await fn()
  if (keep(value)) cache.set(key, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value!)
  return value
}

// ---------------------------------------------------------------- search
function parseSearch(u: URL): SearchParams {
  const clip = (s: string | null, n: number) => (s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n)
  const days = Number(u.searchParams.get("days"))
  const remote = u.searchParams.get("remote")
  return {
    q: clip(u.searchParams.get("q"), 120),
    location: clip(u.searchParams.get("location"), 80),
    days: [1, 3, 7, 14, 30].includes(days) ? days : null,
    remote: (["remote", "hybrid", "onsite"] as const).includes(remote as WorkMode) ? (remote as WorkMode) : null,
    sort: u.searchParams.get("sort") === "date" ? "date" : "relevance",
    page: Math.min(Math.max(Number(u.searchParams.get("page")) || 1, 1), 20),
  }
}

const dedupKey = (j: Job) =>
  `${(j.company ?? "").toLowerCase().replace(/[^a-z0-9æøå]+/g, "")}|${j.title.toLowerCase().replace(/[^a-z0-9æøå]+/g, "")}`

async function search(u: URL) {
  const p = parseSearch(u)
  const wanted = (u.searchParams.get("portals") ?? "").split(",").filter(Boolean)
  const portals = PORTALS.filter((x) => wanted.length === 0 || wanted.includes(x.id))
  const since = p.days ? new Date(Date.now() - p.days * 86400000).toISOString().slice(0, 10) : null

  const perPortal = await Promise.all(
    portals.map(async (portal) => {
      const args = portal.searchArgs(p)
      if (!Array.isArray(args)) return { portal: portal.id, status: "skipped" as const, message: args.skip, jobs: [] as Job[], total: null }
      const started = Date.now()
      const res = await cached(`s:${portal.id}:${JSON.stringify(args)}`, () => runCli(portal, args), (r) => r.ok)
      if (!res.ok) return { portal: portal.id, status: "error" as const, message: res.error, jobs: [] as Job[], total: null }
      let jobs = portal.normalize(res.data)
      // Not every portal filters by age server-side; apply it uniformly here.
      if (since) jobs = jobs.filter((j) => !j.date || j.date >= since)
      return { portal: portal.id, status: "ok" as const, jobs, total: portal.total(res.data), ms: Date.now() - started }
    }),
  )

  // Interleave portals (keeps relevance order within each), then dedupe the
  // same posting syndicated to several boards - first occurrence wins.
  const merged: Job[] = []
  const lists = perPortal.map((r) => r.jobs)
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) merged.push(l[i])
  const seen = new Map<string, Job>()
  for (const j of merged) {
    const k = dedupKey(j)
    const prev = seen.get(k)
    if (prev) prev.tags = Array.from(new Set([...prev.tags, `Also on ${portalById(j.portal)?.name}`]))
    else seen.set(k, j)
  }
  let jobs = [...seen.values()]
  if (p.sort === "date") jobs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

  return {
    params: p,
    jobs,
    portals: perPortal.map(({ jobs, ...r }) => ({ ...r, count: jobs.length })),
  }
}

async function detail(u: URL) {
  const portal = portalById(u.searchParams.get("portal") ?? "")
  const id = (u.searchParams.get("id") ?? "").trim()
  if (!portal || !id || id.length > 300 || id.startsWith("-")) return json({ error: "Unknown job" }, 400)
  const res = await cached(`d:${portal.id}:${id}`, () => runCli(portal, portal.detailArgs(id), 40000), (r) => r.ok)
  if (!res.ok) return json({ error: res.error }, 502)
  const titleHint = (u.searchParams.get("title") ?? "").slice(0, 300)
  const d: any = portal.normalizeDetail(res.data, id, titleHint)
  const descriptionHtml = renderDescription(d._desc)
  delete d._desc
  return json({ ...d, key: `${portal.id}:${id}`, portal: portal.id, descriptionHtml })
}

// ---------------------------------------------------------------- saved
function readSaved(): any[] {
  try {
    return JSON.parse(readFileSync(SAVED, "utf8"))
  } catch {
    return []
  }
}
function writeSaved(list: any[]) {
  mkdirSync(DATA, { recursive: true })
  const tmp = `${SAVED}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2))
  renameSync(tmp, SAVED) // atomic: a crash never leaves a half-written shortlist
}

async function saved(req: Request) {
  if (req.method === "GET") return json(readSaved())
  const body: any = await req.json().catch(() => null)
  const key = typeof body?.key === "string" ? body.key.slice(0, 400) : ""
  if (!key) return json({ error: "Missing key" }, 400)
  let list = readSaved().filter((j) => j.key !== key)
  if (req.method === "POST") {
    const pick = (v: unknown, n = 500) => (typeof v === "string" ? v.slice(0, n) : null)
    list.unshift({
      key,
      portal: pick(body.portal, 40),
      id: pick(body.id, 300),
      title: pick(body.title) ?? "Untitled",
      company: pick(body.company),
      location: pick(body.location),
      date: pick(body.date, 10),
      deadline: pick(body.deadline, 10),
      url: pick(body.url, 2000),
      applyUrl: pick(body.applyUrl, 2000),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map((t: unknown) => String(t).slice(0, 60)) : [],
      note: pick(body.note, 2000) ?? "",
      savedAt: new Date().toISOString(),
    })
  } else if (req.method !== "DELETE") return json({ error: "Method not allowed" }, 405)
  writeSaved(list)
  return json(list)
}

// ---------------------------------------------------------------- tracker (read-only)
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') q = false
      else field += c
    } else if (c === '"') q = true
    else if (c === ",") { row.push(field); field = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field); rows.push(row); row = []; field = ""
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim()))
}

function tracker() {
  if (!existsSync(TRACKER)) return json({ exists: false, rows: [] })
  const [header, ...rows] = parseCsv(readFileSync(TRACKER, "utf8").replace(/^﻿/, ""))
  const cols = (header ?? []).map((h) => h.trim())
  return json({ exists: true, columns: cols, rows: rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""]))) })
}

// ---------------------------------------------------------------- http
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  })
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
}

function staticFile(root: string, rel: string) {
  const path = resolve(root, normalize(rel).replace(/^([/\\])+/, ""))
  if (!path.startsWith(root + "/") || !existsSync(path)) return new Response("Not found", { status: 404 })
  return new Response(Bun.file(path), {
    headers: { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-cache", ...SECURITY_HEADERS },
  })
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const u = new URL(req.url)
    // Writes only from this page: refuse cross-site requests to the API.
    const site = req.headers.get("sec-fetch-site")
    if (u.pathname.startsWith("/api/") && site && !["same-origin", "none"].includes(site))
      return json({ error: "Cross-site request refused" }, 403)
    try {
      if (u.pathname === "/api/portals") return json(PORTALS.map(({ id, name, region, offByDefault }) => ({ id, name, region, offByDefault: offByDefault ?? null })))
      if (u.pathname === "/api/search") return json(await search(u))
      if (u.pathname === "/api/detail") return await detail(u)
      if (u.pathname === "/api/saved") return await saved(req)
      if (u.pathname === "/api/tracker") return tracker()
      if (u.pathname.startsWith("/fonts/")) return staticFile(FONTS, u.pathname.slice(7))
      if (u.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404)
      return staticFile(PUBLIC, u.pathname === "/" ? "index.html" : u.pathname)
    } catch (e: any) {
      console.error(e)
      return json({ error: "Internal error" }, 500)
    }
  },
})

console.log(`AIJobNinja UI → http://${server.hostname}:${server.port}`)
