# CoGuard v2 — component map (React 18 + Vite + TS)

Tokens + keyframes: `src/styles/tokens.css` (= handoff/tokens.css). Icons/illustrations: inline SVG in `src/art/*.tsx`.

- Intro (9 s): `Intro` → `GateScene`, `SchoolScene`, `ClassroomScene` (`Teacher`, `Student`, `Smartboard`, `SpeechBubble`), `BrowserFrame`, `BlushWipe`, `SkipButton`. Hook `useIntroOnce()` (sessionStorage in try/catch, reduced-motion → 1 s still).
- Shell: `AppHeader` (`RoleSwitcher`, `ThemeToggle`, gear → `SettingsDialog`), `FlowStepper`
- 1 Home: `Hero` + `RobotTidyArt`
- 2 Upload: `UploadScreen` → `DropZone` ×2, `FileCard`, `FieldError`, `ReadFilesButton`, `Skeleton`
- 3 Parsed: `ParsedScreen` → `TemplateCard` (`TemplateOverride`), `CourseDetailsCard`, `OutcomeCard`, `BloomBadge`
- 4 Map: `MapScreen` → `StrengthLegend`, `MapTable` (`MapCell`), `CellDetail`
- 5 Validation: `ValidationScreen` → `SeveritySummary`, `SeverityGroup`, `ValidationItem`
- 6 Preview: `SpecDocument` (`DraftWatermark`, `DocSection`, `SectionComments`), `ExportButtons`
- 7 Workflow: `StatusTimeline`, `StatusBadge`, `WorkflowActions`
- 8 Activity: `ActivityLog` → `ActivityItem`
- 9 Dashboard: `DashboardScreen` → `SpecCard`, `EmptyState`
- 10 Settings: `SettingsDialog`
