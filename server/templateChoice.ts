export type TemplateKind = "integrated" | "non_lab";

export type TemplateDecision = {
  template: TemplateKind;
  signals: string[];
  override?: { template: TemplateKind; reason: string };
};

export function chooseTemplate(credits_ltp: string, course_type: string, override?: { template: TemplateKind; reason: string }): TemplateDecision {
  const parts = credits_ltp.split(":").map((x) => Number(x));
  const practical = parts[2] ?? 0;
  const signals: string[] = [];
  if (practical > 0) signals.push(`practical credits = ${practical}`);
  if (/laboratory/i.test(course_type)) signals.push(`course_type contains laboratory (${course_type})`);
  const detected: TemplateKind = practical > 0 || /laboratory/i.test(course_type) ? "integrated" : "non_lab";
  if (!signals.length) signals.push("no practical credits and course_type has no laboratory → non_lab");
  if (override?.template) {
    return { template: override.template, signals, override };
  }
  return { template: detected, signals };
}
