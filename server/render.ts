import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import type { SpecforgeOutput } from "./schema.js";
import type { TemplateKind } from "./templateChoice.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadTemplate(kind: TemplateKind): { html: string; sampleStrings: string[] } {
  const file = kind === "integrated" ? "integrated_lab.html" : "non_lab.html";
  const html = readFileSync(join(root, "templates", file), "utf8");
  const $ = cheerio.load(html);
  const samples = new Set<string>();

  const title = $("h1 span[contenteditable='true']").first().text().trim();
  if (title) samples.add(title);

  $("table")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length >= 2) {
        const label = $(cells[0]).text().replace(/\s+/g, " ").trim().toLowerCase();
        const val = $(cells[1]).text().replace(/\s+/g, " ").trim();
        if (!val) return;
        if (label.includes("course title") || label.includes("course code") || label.includes("department") || label.includes("course type")) {
          samples.add(val);
        }
      }
    });

  $(".unit-row span[contenteditable='true']").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length > 20) samples.add(t.slice(0, 60));
  });

  $("ul.co-list li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length > 20) samples.add(t.slice(0, 60));
  });

  return { html, sampleStrings: [...samples] };
}

function setEditable($: cheerio.CheerioAPI, selector: string, value: string) {
  const el = $(selector).first();
  if (el.length) el.text(value);
}

function fillHeaderTable($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  $("table")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return;
      const label = $(cells[0]).text().replace(/\s+/g, " ").trim().toLowerCase();
      const target = $(cells[1]);
      if (label.includes("course title")) target.text(out.course.title);
      else if (label.includes("course code")) target.text(out.course.code);
      else if (label.includes("course type")) target.text(out.course.course_type);
      else if (label === "department" || label.startsWith("department")) target.text(out.course.department);
    });
}

function fillCreditsTable($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  $("h2").each((_, h2) => {
    const title = $(h2).text();
    if (!/Course Size and Credits/i.test(title)) return;
    const table = $(h2).nextAll("table").first();
    table.find("tr").each((__, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return;
      const label = $(cells[0]).text().replace(/\s+/g, " ").trim().toLowerCase();
      const target = cells.last();
      if (label.includes("credit structure")) target.text(out.course.credits_ltp);
      else if (label.includes("number of credits")) {
        const [l, t, p] = out.course.credits_ltp.split(":").map(Number);
        target.text(String((l ?? 0) + (t ?? 0) + (p ?? 0)).padStart(2, "0"));
      } else if (label.includes("total hours")) target.text(String(out.teaching_hours.total));
      else if (label.includes("department responsible")) target.text(out.course.department);
    });
  });
}

function fillCos($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  const list = $("ul.co-list").first();
  if (!list.length) return;
  list.empty();
  for (const co of out.course_outcomes) {
    list.append(`<li>${co.statement}</li>`);
  }
}

function fillUnits($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  const first = $(".unit-row").first();
  if (!first.length) return;
  const parent = first.parent();
  $(".unit-row").remove();
  for (const u of out.units) {
    const lab = u.lab ? ` Lab: ${u.lab}` : "";
    parent.append(
      `<div class="unit-row"><span class="static unit-label" style="padding: 1px 3px; border-radius: 2px;">Unit ${u.number}:</span> <span contenteditable="true">${escapeHtml(u.title)}.${escapeHtml(lab)}</span></div>`,
    );
  }
}

function fillMap($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  const table = $("table.copo-table").first();
  if (!table.length) return;
  const body = table.find("tbody");
  const legend = body.find("tr.copo-legend-row");
  body.find("tr").not(".copo-legend-row").remove();

  const cols = [
    "PO-1",
    "PO-2",
    "PO-3",
    "PO-4",
    "PO-5",
    "PO-6",
    "PO-7",
    "PO-8",
    "PO-9",
    "PO-10",
    "PO-11",
    "PSO-1",
    "PSO-2",
  ];

  for (const co of out.course_outcomes) {
    const row = out.co_po_pso_map[co.id] ?? {};
    const cells = cols.map((c) => {
      const cell = row[c];
      const v = cell && cell.level ? String(cell.level) : "";
      const title = cell?.justification ? ` title="${escapeAttr(cell.justification)}"` : "";
      return `<td class="text-center" contenteditable="true"${title}>${v}</td>`;
    });
    const html = `<tr><td class="text-center" contenteditable="true" style="font-weight:bold;">${co.id}</td>${cells.join("")}</tr>`;
    if (legend.length) legend.before(html);
    else body.append(html);
  }
}

function fillTeachingHours($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  $("h2").each((_, h2) => {
    if (!/Teaching and Learning Methods/i.test($(h2).text())) return;
    const table = $(h2).nextAll("table").first();
    table.find("tr").each((__, tr) => {
      const tds = $(tr).find("td");
      if (!tds.length) return;
      const label = $(tds[0]).text().replace(/\s+/g, " ").trim().toLowerCase();
      const last = tds.last();
      if (label.includes("face to face")) last.text(String(out.teaching_hours.lectures));
      else if (label.includes("computer laboratory") || (label.includes("practical") && !label.includes("1."))) {
        /* skip sub-rows; set practicals total when label is Practicals / Practical Work */
      }
      if (/^practicals?$/.test(label) || label === "practical work") last.text(String(out.teaching_hours.lab));
      if (label.includes("computer laboratory")) {
        // set the duration cell (usually middle or last numeric)
        if (tds.length >= 2) $(tds[tds.length - 2] || tds.last()).text(String(out.teaching_hours.lab));
      }
      if (label.includes("term tests") || label.includes("mid terms") || label.includes("laboratory examination")) {
        last.text(String(out.teaching_hours.tests_exams));
      }
      if (label.includes("total duration")) last.text(String(out.teaching_hours.total));
    });
  });
}

function fillAssessment($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  const table = $("table.assessment-integrated-table, table.assessment-table").first();
  if (!table.length) {
    // fallback: first table after section 7 heading
    $("h2").each((_, h2) => {
      if (!/Assessment and Reassessment/i.test($(h2).text())) return;
      const t = $(h2).nextAll("table").first();
      rewriteAssessmentTable($, t, out);
    });
    return;
  }
  rewriteAssessmentTable($, table, out);
}

function rewriteAssessmentTable($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>, out: SpecforgeOutput) {
  if (!table.length) return;
  const thead = table.find("thead");
  const headerRows = thead.find("tr");
  // Keep header structure; rebuild body CO rows
  const body = table.find("tbody");
  const note = body
    .find("tr")
    .filter((_, tr) => $(tr).find("td").length === 1 || /Academic Regulations/i.test($(tr).text()))
    .last();

  // Count data columns from last header row with component names
  let colCount = 6;
  const lastHeader = headerRows.last();
  if (lastHeader.length) colCount = Math.max(1, lastHeader.find("th").length - 0);
  // Prefer counting from first data row pattern: CO + N cells
  const sample = body.find("tr").first();
  if (sample.length) colCount = Math.max(1, sample.find("td").length - 1);

  body.find("tr").each((_, tr) => {
    const first = $(tr).find("td").first().text();
    if (/^CO-?\d+/i.test(first.trim()) || $(tr).find("td").length > 2) $(tr).remove();
  });

  const componentNames: string[] = [];
  // Try to read component names from header
  headerRows.each((_, tr) => {
    $(tr)
      .find("th")
      .each((i, th) => {
        if (i === 0 && /course|outcome/i.test($(th).text())) return;
        const name = $(th).text().replace(/\s+/g, " ").trim();
        if (name && !/weightage|marks|ce\b|see\b|focus/i.test(name) && name.length < 40) {
          /* collect later */
        }
      });
  });
  // Use assessment component coverage keys vs generic columns
  const colsFromCoverage = new Set<string>();
  for (const list of Object.values(out.assessment.co_coverage)) for (const n of list) colsFromCoverage.add(n);

  for (const co of out.course_outcomes) {
    const covered = new Set((out.assessment.co_coverage[co.id] ?? []).map((s) => s.toLowerCase()));
    const tds: string[] = [`<td class="static text-center" style="font-weight: bold;">${co.id}</td>`];
    // Emit colCount cells; mark X when any coverage token loosely matches column index heuristics
    for (let i = 0; i < colCount; i++) {
      // Without stable header names, mark X if this CO has any coverage (first columns) — better: match by known names order
      const mark = covered.size > 0 && i < covered.size ? "X" : coverageMark(i, covered, colCount);
      tds.push(`<td class="text-center" contenteditable="true">${mark}</td>`);
    }
    const row = `<tr>${tds.join("")}</tr>`;
    if (note.length) note.before(row);
    else body.append(row);
  }
}

function coverageMark(index: number, covered: Set<string>, colCount: number): string {
  // Heuristic column order for integrated template: TT1, TT2, Assignments, Lab, Written, Lab Exam
  const order = ["term test-1", "term test-2", "assignments", "lab", "written exam", "lab exam", "tests", "written", "lsee", "lab ce"];
  const keys = [...covered];
  for (const k of keys) {
    const idx = order.findIndex((o) => k.includes(o) || o.includes(k));
    if (idx >= 0 && idx === index) return "X";
    if (/test/.test(k) && (index === 0 || index === 1)) return "X";
    if (/assign/.test(k) && index === 2) return "X";
    if (/^lab$|lab ce|computer lab/.test(k) && index === 3) return "X";
    if (/written|see/.test(k) && (index === 4 || index === colCount - 2)) return "X";
    if (/lsee|lab exam|lab see/.test(k) && index === colCount - 1) return "X";
  }
  return "";
}

function fillResourcesLightly($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  // Clear obvious Computer Vision sample readings by wiping editable resource lists if they still mention sample title tokens
  const sampleHints = ["Computer Vision", "Digital Image Processing", "Gonzalez", "Szeliski", "Digital Twin Fundamentals"];
  $("ol[contenteditable='true']").each((_, ol) => {
    const text = $(ol).text();
    if (sampleHints.some((h) => text.includes(h))) {
      $(ol).html("<li>As listed in the source course specification.</li>");
    }
  });
  void out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export function renderHtml(out: SpecforgeOutput, kind: TemplateKind): { html: string; sampleStrings: string[] } {
  const { html: raw, sampleStrings } = loadTemplate(kind);
  const $ = cheerio.load(raw);

  $("h1 span[contenteditable='true']").first().text(out.course.title);
  fillHeaderTable($, out);
  setEditable($, "h2 + p[contenteditable='true']", out.course.summary);
  // Course summary is first contenteditable p after section 1
  $("h2").each((_, h2) => {
    if (/Course Summary/i.test($(h2).text())) {
      $(h2).nextAll("p").first().text(out.course.summary);
    }
  });
  fillCreditsTable($, out);
  fillCos($, out);
  fillUnits($, out);
  fillMap($, out);
  fillTeachingHours($, out);
  fillAssessment($, out);
  fillResourcesLightly($, out);

  // Organisation table course code/title
  $("h2").each((_, h2) => {
    if (!/Course Organization/i.test($(h2).text())) return;
    $(h2)
      .nextAll("table")
      .first()
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 2) return;
        const label = $(cells[0]).text().replace(/\s+/g, " ").trim().toLowerCase();
        if (label.includes("course code")) cells.last().text(out.course.code);
        if (label.includes("course title")) cells.last().text(out.course.title);
      });
  });

  let html = $.html();
  // Final sweep: remove remaining known sample strings if they are exact leftovers
  for (const s of sampleStrings) {
    if (s && html.includes(s) && s !== out.course.title && s !== out.course.code && s !== out.course.department) {
      html = html.split(s).join("");
    }
  }
  return { html, sampleStrings };
}
