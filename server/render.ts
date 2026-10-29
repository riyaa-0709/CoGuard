import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { SpecforgeOutput } from "./schema.js";
import type { TemplateKind } from "./templateChoice.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function loadTemplate(kind: TemplateKind): { html: string; sampleStrings: string[] } {
  const file = kind === "integrated" ? "integrated_lab.html" : "non_lab.html";
  const html = readFileSync(join(root, "templates", file), "utf8");
  const $ = cheerio.load(html);
  const samples = new Set<string>();

  const add = (v: string) => {
    const t = norm(v);
    if (t.length >= 4) samples.add(t);
  };

  add($("h1 span[contenteditable='true']").first().text());
  $("h2").each((_, h2) => {
    if (/Course Summary/i.test($(h2).text())) add($(h2).nextAll("p").first().text());
  });

  $("table")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return;
      const label = norm($(cells[0]).text()).toLowerCase();
      const val = norm($(cells[1]).text());
      if (label.includes("course title") || label.includes("course code") || label.includes("department") || label.includes("course type")) add(val);
    });

  $("h2").each((_, h2) => {
    if (!/Course Size and Credits/i.test($(h2).text())) return;
    $(h2)
      .nextAll("table")
      .first()
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 2) return;
        if (norm($(cells[0]).text()).toLowerCase().includes("credit structure")) add(norm($(cells[1]).text()));
      });
  });

  $(".unit-row span[contenteditable='true']").each((_, el) => add($(el).text()));
  $("ul.co-list li").each((_, el) => add($(el).text()));

  // Distinctive sample markers from the starter templates
  for (const s of ["Computer Vision", "AIC304A", "AIML", "3:2:0", "Digital Twining", "Vision Transformers"]) add(s);

  return { html, sampleStrings: [...samples] };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function fillHeaderTable($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  $("table")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return;
      const label = norm($(cells[0]).text()).toLowerCase();
      const target = $(cells[1]);
      if (label.includes("course title")) target.text(out.course.title);
      else if (label.includes("course code")) target.text(out.course.code);
      else if (label.includes("course type")) target.text(out.course.course_type);
      else if (label.includes("department")) target.text(out.course.department);
    });
}

function fillCreditsTable($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  $("h2").each((_, h2) => {
    if (!/Course Size and Credits/i.test($(h2).text())) return;
    $(h2)
      .nextAll("table")
      .first()
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 2) return;
        const label = norm($(cells[0]).text()).toLowerCase();
        const target = $(cells[cells.length - 1]);
        if (label.includes("credit structure")) target.text(out.course.credits_ltp);
        else if (label.includes("number of credits")) {
          const [l, t, p] = out.course.credits_ltp.split(":").map(Number);
          const n = (l ?? 0) + (t ?? 0) + (p ?? 0);
          target.text(String(n).padStart(2, "0"));
        } else if (label.includes("total hours")) target.text(String(out.teaching_hours.total));
        else if (label.includes("department responsible")) target.text(out.course.department);
      });
  });
}

function fillCos($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  const list = $("ul.co-list").first();
  if (!list.length) return;
  list.empty();
  for (const co of out.course_outcomes) list.append(`<li>${escapeHtml(co.statement)}</li>`);
}

function fillUnits($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  let anchor: cheerio.Cheerio<Element> | null = null;
  $("h2").each((_, h2) => {
    if (/Course Contents/i.test($(h2).text())) anchor = $(h2) as cheerio.Cheerio<Element>;
  });
  $(".unit-row").remove();
  if (!anchor) return;
  let insertAfter: cheerio.Cheerio<AnyNode> = anchor;
  for (const u of out.units) {
    const lab = u.lab ? ` Lab: ${u.lab}` : "";
    const row = `<div class="unit-row"><span class="static unit-label" style="padding: 1px 3px; border-radius: 2px;">Unit ${u.number}:</span> <span contenteditable="true">${escapeHtml(u.title)}.${escapeHtml(lab)}</span></div>`;
    insertAfter.after(row);
    insertAfter = insertAfter.next();
  }
}

function fillMap($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  const table = $("table.copo-table").first();
  if (!table.length) return;
  const body = table.find("tbody");
  const legend = body.find("tr.copo-legend-row");
  body.find("tr").not(".copo-legend-row").remove();

  const cols = ["PO-1", "PO-2", "PO-3", "PO-4", "PO-5", "PO-6", "PO-7", "PO-8", "PO-9", "PO-10", "PO-11", "PSO-1", "PSO-2"];
  for (const co of out.course_outcomes) {
    const row = out.co_po_pso_map[co.id] ?? {};
    const cells = cols.map((c) => {
      const cell = row[c];
      const v = cell?.level ? String(cell.level) : "";
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
      const label = norm($(tds[0]).text()).toLowerCase();
      const last = $(tds[tds.length - 1]);
      if (label.includes("face to face")) last.text(String(out.teaching_hours.lectures));
      if (label === "practicals" || label === "practical work") last.text(String(out.teaching_hours.lab));
      if (label.includes("computer laboratory")) {
        if (tds.length >= 2) $(tds[1]).text(String(out.teaching_hours.lab));
        if (tds.length >= 3) last.text(String(out.teaching_hours.lab));
      }
      if (label.includes("term tests") || label.includes("mid terms") || label.includes("laboratory examination/written")) {
        last.text(String(out.teaching_hours.tests_exams));
      }
      if (label.includes("total duration")) last.text(String(out.teaching_hours.total));
    });
  });
}

function markFor(coId: string, colLabel: string, coverage: string[]): string {
  const cov = coverage.map((c) => c.toLowerCase());
  const col = colLabel.toLowerCase();
  const hit = (re: RegExp) => cov.some((c) => re.test(c));
  if (/term test-?1|tt1|test 1/i.test(col) && hit(/test/)) return "X";
  if (/term test-?2|tt2|test 2/i.test(col) && hit(/test/)) return "X";
  if (/assign/i.test(col) && hit(/assign/)) return "X";
  if (/^lab$|lab ce|lab\b/i.test(col) && !/exam|see|written/i.test(col) && hit(/lab(?! exam)|practical|lab ce/)) return "X";
  if (/written/i.test(col) && hit(/written|see/)) return "X";
  if (/lab exam|lsee/i.test(col) && hit(/lsee|lab exam|lab see/)) return "X";
  // Fallback: Tests column(s)
  if (/^tests?$/i.test(col) && hit(/test/)) return "X";
  void coId;
  return "";
}

function fillAssessment($: cheerio.CheerioAPI, out: SpecforgeOutput) {
  $("h2").each((_, h2) => {
    if (!/Assessment and Reassessment/i.test($(h2).text())) return;
    const table = $(h2).nextAll("table").first();
    if (!table.length) return;

    const headerRows = table.find("thead tr");
    const colLabels: string[] = [];
    // Prefer the row with Term Test / Assignments / etc.
    headerRows.each((__, tr) => {
      const ths = $(tr).find("th");
      const texts = ths.map((___, th) => norm($(th).text())).get();
      if (texts.some((t) => /term test|assignment|written|lab/i.test(t))) {
        colLabels.length = 0;
        texts.forEach((t, i) => {
          if (i === 0 && /course|outcome/i.test(t)) return;
          colLabels.push(t);
        });
      }
    });
    if (!colLabels.length) {
      // integrated sample has 6 data columns
      colLabels.push("Term Test-1", "Term Test-2", "Assignments", "Lab", "Written Exam", "Lab Exam");
    }

    const body = table.find("tbody");
    const note = body.find("tr").filter((__, tr) => /Academic Regulations/i.test($(tr).text()));
    body.find("tr").each((__, tr) => {
      if (/^CO-?\d+/i.test(norm($(tr).find("td").first().text()))) $(tr).remove();
    });

    for (const co of out.course_outcomes) {
      const cov = out.assessment.co_coverage[co.id] ?? [];
      const tds = [`<td class="static text-center" style="font-weight: bold;">${co.id}</td>`];
      for (const label of colLabels) {
        tds.push(`<td class="text-center" contenteditable="true">${markFor(co.id, label, cov)}</td>`);
      }
      const row = `<tr>${tds.join("")}</tr>`;
      if (note.length) note.first().before(row);
      else body.append(row);
    }
  });
}

function scrubResources($: cheerio.CheerioAPI) {
  const sampleHints = [
    "Computer Vision",
    "Digital Image Processing",
    "Gonzalez",
    "Szeliski",
    "Digital Twin Fundamentals",
    "Locascio",
    "Forsyth",
    "IEEE-T-PAMI",
  ];
  $("ol[contenteditable='true']").each((_, ol) => {
    const text = $(ol).text();
    if (sampleHints.some((h) => text.includes(h))) {
      $(ol).html("<li>As listed in the source course specification.</li>");
    }
  });
}

export function renderHtml(out: SpecforgeOutput, kind: TemplateKind): { html: string; sampleStrings: string[] } {
  const { html: raw, sampleStrings } = loadTemplate(kind);
  const $ = cheerio.load(raw);

  $("h1 span[contenteditable='true']").first().text(out.course.title);
  fillHeaderTable($, out);
  $("h2").each((_, h2) => {
    if (/Course Summary/i.test($(h2).text())) $(h2).nextAll("p").first().text(out.course.summary);
  });
  fillCreditsTable($, out);
  fillCos($, out);
  fillUnits($, out);
  fillMap($, out);
  fillTeachingHours($, out);
  fillAssessment($, out);
  scrubResources($);

  $("h2").each((_, h2) => {
    if (!/Course Organization/i.test($(h2).text())) return;
    $(h2)
      .nextAll("table")
      .first()
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 2) return;
        const label = norm($(cells[0]).text()).toLowerCase();
        if (label.includes("course code")) $(cells[cells.length - 1]).text(out.course.code);
        if (label.includes("course title")) $(cells[cells.length - 1]).text(out.course.title);
      });
  });

  let html = $.html();
  const keep = new Set([out.course.title, out.course.code, out.course.department, out.course.course_type, out.course.credits_ltp]);
  for (const s of sampleStrings) {
    if (!s || keep.has(s)) continue;
    if (html.includes(s)) html = html.split(s).join("");
  }
  return { html, sampleStrings };
}
