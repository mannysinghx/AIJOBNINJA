import { describe, expect, test } from "bun:test"
import { renderDescription, sanitizeHtml, textToHtml } from "./lib/render"
import { PORTALS } from "./lib/portals"

describe("sanitizeHtml", () => {
  test("drops scripts, handlers and unknown tags", () => {
    const out = sanitizeHtml(`<p onclick="x()">Hi</p><script>alert(1)</script><img src=x onerror=alert(1)><style>p{}</style>`)
    expect(out).toBe("<p>Hi</p>")
  })
  test("keeps only http(s) links and forces safe rel", () => {
    expect(sanitizeHtml(`<a href="javascript:alert(1)">x</a>`)).toBe("<a>x</a>")
    expect(sanitizeHtml(`<a href="https://e.com/a">x</a>`)).toBe(
      `<a href="https://e.com/a" target="_blank" rel="noopener noreferrer nofollow">x</a>`,
    )
  })
  test("normalizes headings", () => {
    expect(sanitizeHtml("<h1>T</h1>")).toBe("<h4>T</h4>")
  })
})

describe("textToHtml", () => {
  test("escapes text and builds lists", () => {
    expect(textToHtml("<b>x</b>\n\n- one\n- two")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>\n<ul><li>one</li><li>two</li></ul>")
  })
  test("markdown headings and bold", () => {
    expect(textToHtml("### Role\n**Bold** text", true)).toBe("<h4>Role</h4>\n<p><strong>Bold</strong> text</p>")
  })
  test("pageText makes paragraphs and detects headings", () => {
    const long = "This role builds data platforms for clients across the Nordics, with modern tooling."
    expect(textToHtml(`Your role\n${long}\n- Python\nShort line.`, false, true)).toBe(
      `<h4>Your role</h4>\n<p>${long}</p>\n<ul><li>Python</li></ul>\n<p>Short line.</p>`,
    )
  })
  test("renderDescription treats tag-free html as text", () => {
    expect(renderDescription({ html: "a & b" })).toBe("<p>a &amp; b</p>")
  })
})

describe("portal adapters", () => {
  const base = { q: "python", location: "", days: null, remote: null, sort: "relevance" as const, page: 1 }
  test("user input stays a single argv element", () => {
    for (const p of PORTALS) {
      const args = p.searchArgs({ ...base, q: "a; rm -rf / --limit 1" })
      if (Array.isArray(args)) expect(args.some((a) => a.includes("; rm -rf /"))).toBe(true)
    }
  })
  test("jobindex needs a keyword", () => {
    const ji = PORTALS.find((p) => p.id === "jobindex")!
    expect(ji.searchArgs({ ...base, q: "" })).toEqual({ skip: "Needs a keyword" })
  })
})
