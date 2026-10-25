// Adapters between the web UI's single search form and the six portal CLIs
// under .agents/skills/*/cli. Each CLI is run as a subprocess exactly as the
// /scrape workflow runs it, so the UI inherits every fix made to the CLIs and
// never talks to a portal itself.

import { join, resolve } from "node:path"
import { trimPageChrome } from "./clean"

export const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const SKILLS = join(REPO_ROOT, ".agents", "skills")

export type WorkMode = "remote" | "hybrid" | "onsite"

export interface SearchParams {
  q: string
  location: string
  days: number | null // null = any time
  remote: WorkMode | null
  sort: "date" | "relevance"
  page: number
}

export interface Job {
  key: string // `${portal}:${id}` — stable handle the UI uses for detail/save
  portal: string
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null // YYYY-MM-DD
  deadline: string | null // YYYY-MM-DD
  url: string
  applyUrl: string | null
  snippet: string | null
  tags: string[]
  workMode: string | null
}

export interface JobDetail extends Job {
  descriptionHtml: string
  employmentType: string | null
}

export interface Portal {
  id: string
  name: string
  region: string
  dir: string
  // Off until the user switches it on, with the reason shown on its chip.
  offByDefault?: string
  // Returns null when the portal cannot run this query (e.g. a required flag
  // is missing), with the reason shown to the user instead of an error.
  searchArgs(p: SearchParams): string[] | { skip: string }
  normalize(raw: any): Job[]
  total(raw: any): number | null
  detailArgs(id: string): string[]
  // titleHint is the title from the search result, which is more reliable
  // than what some detail pages report.
  normalizeDetail(raw: any, id: string, titleHint?: string): Omit<JobDetail, "key" | "portal">
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

const isoDate = (v: unknown): string | null => {
  const s = str(v)
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

const sinceDate = (days: number): string => {
  const d = new Date(Date.now() - days * 86400000)
  return d.toISOString().slice(0, 10)
}

const snippetOf = (text: unknown, max = 260): string | null => {
  const s = str(text)
  if (!s) return null
  const flat = s.replace(/[#*_>`]+/g, " ").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max).replace(/\s\S*$/, "") + "…" : flat
}

function baseJob(portal: string, r: any, id: string): Job {
  return {
    key: `${portal}:${id}`,
    portal,
    id,
    title: str(r.title) ?? "Untitled posting",
    company: str(r.company),
    location: str(r.location),
    date: isoDate(r.date),
    deadline: isoDate(r.deadline),
    url: str(r.url) ?? "",
    applyUrl: str(r.applyUrl),
    snippet: null,
    tags: [],
    workMode: null,
  }
}

export const PORTALS: Portal[] = [
  {
    id: "jobindex",
    name: "Jobindex",
    region: "Denmark",
    dir: "jobindex-search",
    searchArgs: (p) => {
      if (!p.q) return { skip: "Needs a keyword" }
      // Jobindex ignores area params; its README says to put the city in the query.
      const query = p.location ? `${p.q} ${p.location}` : p.q
      return [
        "search", "--query", query,
        "--jobage", String(p.days ?? 9999),
        "--sort", p.sort === "date" ? "date" : "score",
        "--page", String(p.page),
      ]
    },
    normalize: (raw) => (raw.results ?? []).map((r: any) => baseJob("jobindex", r, String(r.id))),
    total: (raw) => raw.meta?.total ?? null,
    detailArgs: (id) => ["detail", id],
    normalizeDetail: (r, id, titleHint) => ({
      ...baseJob("jobindex", r, id),
      descriptionHtml: "",
      employmentType: str(r.employmentType),
      snippet: null,
      _desc: { text: r.description ? trimPageChrome(String(r.description), titleHint || r.title) : null, pageText: true },
    } as any),
  },
  {
    id: "jobnet",
    name: "Jobnet",
    region: "Denmark",
    dir: "jobnet-search",
    searchArgs: (p) => {
      const args = ["search", "--page", String(p.page), "--per-page", "20"]
      const postal = /^\d{4}$/.test(p.location)
      const text = [p.q, postal ? "" : p.location].filter(Boolean).join(" ")
      if (text) args.push("--search-string", text)
      if (postal) args.push("--postal-code", p.location)
      return args
    },
    normalize: (raw) =>
      (raw.results ?? []).map((r: any) => ({
        ...baseJob("jobnet", r, String(r.id ?? r.jobAdId)),
        location: str(r.location) ?? str(r.postalDistrictName) ?? str(r.municipality),
        tags: [str(r.occupation), r.workHourPartTime ? "Part-time" : null].filter(Boolean) as string[],
      })),
    total: (raw) => raw.meta?.totalJobAdCount ?? null,
    detailArgs: (id) => ["detail", id],
    normalizeDetail: (r, id) => ({
      ...baseJob("jobnet", r, id),
      company: str(r.company) ?? str(r.hiringOrgName),
      employmentType: str(r.employmentType) ?? str(r.workHours),
      descriptionHtml: "",
      _desc: { html: r.body ?? r.description },
    } as any),
  },
  {
    id: "jobdanmark",
    name: "Jobdanmark",
    region: "Denmark",
    dir: "jobdanmark-search",
    searchArgs: (p) => {
      const args = ["search", "--page", String(p.page)]
      if (p.q) args.push("--text", p.q)
      if (/^\d{4}$/.test(p.location)) args.push("--zip", p.location)
      else if (p.location) args.push("--municipality", p.location)
      return args
    },
    normalize: (raw) =>
      (raw.results ?? []).map((r: any) => ({
        ...baseJob("jobdanmark", r, String(r.slug)),
        tags: (r.jobTypes ?? []).map(String),
      })),
    total: (raw) => raw.meta?.totalItems ?? null,
    detailArgs: (id) => ["detail", id],
    normalizeDetail: (r, id) => ({
      ...baseJob("jobdanmark", r, id),
      company: str(r.hiringOrganization?.name),
      location: str(r.jobLocation?.addressLocality) ?? str(r.jobLocation?.streetAddress),
      date: isoDate(r.datePosted),
      deadline: isoDate(r.validThrough),
      employmentType: Array.isArray(r.employmentType) ? r.employmentType.join(", ") : str(r.employmentType),
      descriptionHtml: "",
      _desc: { text: r.description },
    } as any),
  },
  {
    id: "jobbank",
    name: "Akademikernes Jobbank",
    region: "Denmark",
    dir: "jobbank-search",
    offByDefault: "Jobbank currently blocks automated requests (Cloudflare). Switch it on to retry.",
    searchArgs: (p) => {
      const args = ["search", "--limit", "40"]
      if (p.q) args.push("--key", p.location ? `${p.q} ${p.location}` : p.q)
      if (p.days) args.push("--since", sinceDate(p.days))
      if (p.remote === "remote") args.push("--remote", "helt")
      if (p.remote === "hybrid") args.push("--remote", "delvist")
      // The RSS feed has no pagination; page 1 is everything it returns.
      if (p.page > 1) return { skip: "No further pages" }
      return args
    },
    normalize: (raw) =>
      (raw.results ?? []).map((r: any) => ({
        ...baseJob("jobbank", r, String(r.id)),
        tags: [str(r.jobType)].filter(Boolean) as string[],
      })),
    total: (raw) => raw.meta?.total ?? null,
    detailArgs: (id) => ["detail", id],
    normalizeDetail: (r, id) => ({
      ...baseJob("jobbank", r, id),
      employmentType: str(r.jobType) ?? str(r.employmentType),
      descriptionHtml: "",
      _desc: { text: r.description },
    } as any),
  },
  {
    id: "linkedin",
    name: "LinkedIn (public)",
    region: "Global",
    dir: "linkedin-search",
    searchArgs: (p) => {
      const args = ["search", "--location", p.location || "Denmark", "--page", String(p.page), "--limit", "25"]
      if (p.q) args.push("--query", p.q)
      if (p.days) args.push("--jobage", String(nearest(p.days, [1, 7, 14, 30])))
      if (p.remote) args.push("--remote", p.remote)
      return args
    },
    normalize: (raw) => (raw.results ?? []).map((r: any) => baseJob("linkedin", r, String(r.id))),
    total: () => null,
    detailArgs: (id) => ["detail", id],
    normalizeDetail: (r, id) => ({
      ...baseJob("linkedin", r, id),
      employmentType: str(r.employmentType),
      descriptionHtml: "",
      _desc: { text: r.description },
    } as any),
  },
  {
    id: "freehire",
    name: "freehire",
    region: "Global",
    dir: "freehire-search",
    searchArgs: (p) => {
      const args = ["search", "--page", String(p.page), "--limit", "25", "--description-format", "text"]
      if (p.q) args.push("--query", p.q)
      if (p.days) args.push("--jobage", String(p.days))
      if (p.remote) args.push("--remote", p.remote)
      if (/^[a-z]{2}$/i.test(p.location)) args.push("--country", p.location.toUpperCase())
      else if (p.location) args.push("--city", p.location)
      return args
    },
    normalize: (raw) =>
      (raw.results ?? []).map((r: any) => ({
        ...baseJob("freehire", r, String(r.id)),
        snippet: snippetOf(r.description),
        tags: (r.skills ?? []).slice(0, 6).map(String),
        workMode: str(r.work_mode),
      })),
    total: (raw) => raw.meta?.total ?? null,
    detailArgs: (id) => ["detail", id],
    normalizeDetail: (r, id) => ({
      ...baseJob("freehire", r, id),
      tags: (r.skills ?? []).map(String),
      workMode: str(r.work_mode),
      employmentType: str(r.employment_type),
      descriptionHtml: "",
      _desc: { markdown: r.description },
    } as any),
  },
]

function nearest(n: number, options: number[]): number {
  return options.find((o) => o >= n) ?? options[options.length - 1]
}

export function portalById(id: string): Portal | undefined {
  return PORTALS.find((p) => p.id === id)
}

export function cliDir(p: Portal): string {
  return join(SKILLS, p.dir, "cli")
}

export interface CliResult {
  ok: boolean
  data?: any
  error?: string
}

// Runs one portal CLI with an argv array (never a shell string), so nothing a
// user types can be interpreted as a command.
export async function runCli(p: Portal, args: string[], timeoutMs = 30000): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args, "--format", "json"], {
    cwd: cliDir(p),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      let msg = err.trim() || `exited with code ${code}`
      try {
        msg = JSON.parse(msg.split("\n").filter(Boolean).pop()!).error ?? msg
      } catch {}
      if (proc.signalCode) msg = "Timed out"
      return { ok: false, error: msg.slice(0, 300) }
    }
    return { ok: true, data: JSON.parse(out) }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}
