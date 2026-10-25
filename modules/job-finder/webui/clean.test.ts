import { describe, expect, test } from "bun:test"
import { trimPageChrome } from "./lib/clean"

const para = (s: string) => `${s} `.repeat(8).trim() // a line long enough to count as prose

describe("trimPageChrome", () => {
  test("starts at the job title and drops cookie banners and footers", () => {
    const page = [
      "Skip to main content",
      "We use cookies to optimize your experience on our website.",
      "Accept All Cookies",
      "Careers", "Jobs", "English",
      "Senior Data Engineer",
      para("You will build data platforms."),
      "Responsibilities",
      para("Design and run pipelines."),
      ...Array.from({ length: 14 }, (_, i) => `Footer link ${i}`),
      para("Cookie Consent Manager stores information on your browser."),
    ].join("\n")
    const out = trimPageChrome(page, "Senior Data Engineer")
    expect(out.startsWith("Senior Data Engineer")).toBe(true)
    expect(out).toContain("Responsibilities")
    expect(out).not.toMatch(/cookie|Footer link|Careers/i)
  })

  test("collapses a heading repeated on consecutive lines and decodes entities", () => {
    const out = trimPageChrome(["Nav", "Analyst &amp; Planner", "Analyst &amp; Planner", para("Join us.")].join("\n"), "Analyst & Planner")
    expect(out.split("\n")).toEqual(["Analyst & Planner", para("Join us.")])
  })

  test("returns empty when the page is a form with no prose", () => {
    const form = ["Business Developer", "Your e-mail address:", "Continue", ...Array.from({ length: 80 }, () => "Enter valid e-mail address")].join("\n")
    expect(form.length).toBeGreaterThan(1000)
    expect(trimPageChrome(form, "Business Developer")).toBe("")
  })

  test("leaves short clean text alone", () => {
    expect(trimPageChrome("Short ad text.", "Title")).toBe("Short ad text.")
  })
})
