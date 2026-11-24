# Scheduled Exports Management Panel

**Issue:** #461
**Component path:** `src/components/ScheduledExports/`
**Page path:** `src/pages/ScheduledExportsPage.tsx`
**Route:** `/admin/scheduled-exports`

---

## Overview

The Scheduled Exports panel allows users to create, view, edit, pause, resume, and delete recurring exports (daily, weekly, monthly). It provides a plain-language recurrence editor so users can schedule exports without exposing raw cron syntax.

---

## Components

### `ScheduledExportsPanel`
Top-level container that manages state for all child components.

**Props:** `schedules?: ScheduledExport[]` — optional initial schedules (defaults to mock data).

**State handling:**
- `schedules` — the list of `ScheduledExport` objects
- `dialogOpen` / `editingSchedule` — create vs edit mode
- `deleteConfirmId` — which schedule is pending deletion
- `toastMessage` — ephemeral notification (auto-dismisses after 3 s)

**Actions per row (via action menu):**
- **Edit** — opens `ScheduleFormDialog` pre-filled with existing data
- **Toggle** — switches between `active` and `paused` status
- **Delete** — shows confirmation `alertdialog` before removing

### `RecurrenceEditor`
Plain-language recurrence builder. Exposes frequency, time, timezone, and conditional day-of-week / day-of-month selectors.

**Props:** `value: RecurrenceRule`, `onChange`, `errors?: string[]`

**Live summary:** An `aria-live="polite"` block shows a human-readable summary string (e.g. _"Weekly on Monday at 2:00 PM (America/New_York)"_) that updates as the user makes selections.

### `ScheduleFormDialog`
Modal dialog for creating or editing a schedule. Contains fields for name, description, format, and the `RecurrenceEditor`.

**Behavior:**
- Traps focus (Tab/Shift+Tab cycles within dialog)
- Closes on Escape and backdrop click
- Validates before submitting; shows inline error banner
- Restores focus to the trigger element on close

### `SchedulesTable`
Responsive table listing all scheduled exports with columns: Name, Status, Schedule, Format, Next run, Last run, Entries, Actions.

**States:**
- **Populated** — rows with sortable columns and per-row action menus
- **Empty** — illustration + call-to-action button
- **Error status** — badge includes a tooltip with the error message

**Action menu:** Per-row dropdown with Edit, Pause/Resume, and Delete options.

### `Recurrence Utilities` (`recurrence.ts`)

| Function | Purpose |
|---|---|
| `describeSchedule(rule)` | Plain-language summary string |
| `formatTime(time)` | `HH:mm` → `h:mm AM/PM` |
| `computeNextRun(rule, after?)` | ISO‑8601 next occurrence (timezone‑aware) |
| `validateRecurrenceRule(rule)` | Validation error string or `null` |
| `defaultRecurrenceRule()` | Daily at 09:00 UTC |

**`computeNextRun` algorithm:**
1. Resolve the current local date and weekday in `rule.timezone` via `Intl.DateTimeFormat`
2. For weekly/monthly schedules, snap the local calendar components to the target weekday or day-of-month (clamped to month length) *before* converting to UTC
3. Convert the local date and wall-clock time to UTC using the timezone offset at the target date
4. If the candidate is in the past, advance the local calendar components (1 day, 7 days, or 1 month with clamping) and convert to UTC again
5. Because day/month arithmetic is performed on local calendar components and converted via the target date's offset, DST transitions preserve wall-clock time and non-UTC zones (e.g. `Pacific/Auckland`, `America/Los_Angeles`) never drift a day near midnight

---

## Types

| Type | Fields |
|---|---|
| `RecurrenceRule` | `frequency`, `time` (HH:mm), `timezone`, `dayOfWeek?`, `dayOfMonth?` |
| `ScheduledExport` | `id`, `name`, `description`, `format`, `schedule`, `status`, `lastRunAt`, `nextRunAt`, `createdAt`, `updatedAt`, `entryCount`, `errorMessage?` |
| `ScheduleFormData` | `name`, `description`, `format`, `schedule` |

### Statuses
- `active` — green badge with pulsing dot
- `paused` — muted badge
- `error` — red badge with tooltip containing error details

### Frequencies
- `daily` — every day at the specified time
- `weekly` — on a specific day of the week
- `monthly` — on a specific day of the month (clamped to month length, e.g. 31st → 28th in February)

### Export formats
- `csv` — comma-separated values
- `json` — JSON file
- `pdf` — PDF document

---

## Accessibility (WCAG 2.1 AA)

| Criterion | Implementation |
|---|---|
| 1.3.1 Info and Relationships | Semantic `<table>` with `<caption>`, `<th scope="col">` |
| 1.4.1 Use of Color | Status badges use both colour and text labels |
| 2.1.1 Keyboard | All interactive elements are reachable and operable via keyboard |
| 2.1.2 No Keyboard Trap | Tab cycle in dialog wraps (Shift+Tab on first → last) |
| 2.4.3 Focus Order | Logical tab order through dialog form fields |
| 2.4.7 Focus Visible | `:focus-visible` outlines on all interactive elements |
| 3.3.1 Error Identification | Validation errors shown inline with `role="alert"` |
| 4.1.2 Name, Role, Value | `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-expanded` |
| 4.1.3 Status Messages | Toast and summary use `role="status"` with `aria-live="polite"` |

**axe-core compliance:** All component tests pass `jest-axe` assertions with no violations.

---

## Responsive Breakpoints

| Breakpoint | Behaviour |
|---|---|
| ≥ 768 px | Full table with horizontal scroll on wrapper |
| ≤ 768 px | Summary cards go 2×2; table cells reduce padding; recurrence editor stacks vertically |
| ≤ 480 px | Summary cards go 1‑column |

The table wrapper uses `overflow-x: auto` with `-webkit-overflow-scrolling: touch` for mobile swipe.

---

## Recurrence Editor — Plain Language Summary Examples

| Frequency | Summary |
|---|---|
| Daily, 09:00 UTC | _"Daily at 9:00 AM (UTC)"_ |
| Weekly, Monday, 14:00 America/New_York | _"Weekly on Monday at 2:00 PM (America/New_York)"_ |
| Monthly, 1st, 02:00 UTC | _"Monthly on the 1st at 2:00 AM (UTC)"_ |
| Monthly, 15th, 10:00 Asia/Tokyo | _"Monthly on the 15th at 10:00 AM (Asia/Tokyo)"_ |

---

## DST and Edge Cases

| Scenario | Behaviour |
|---|---|
| Spring forward (gap) | Daily schedule at 02:30 on transition day → runs at 02:30 pre-transition (EST). Full gap‑detection is a known limitation. |
| Fall back (overlap) | Daily schedule at 01:30 on transition day → correctly advances past the first occurrence to the second (EDT→EST). |
| Monthly 31st in February | Day is clamped to the last valid day (e.g. 28). |
| Monthly across DST boundary | Timezone offset is recomputed for the future month (e.g. EST→EDT offset change is handled automatically). |
| Year boundary | Daily schedule on Dec 31 advances to Jan 1. |
| Weekly, same day as today | If time hasn't passed, runs today. If time has passed, advances to next week. |

---

## Test Coverage

| File | Tests | Notes |
|---|---|---|
| `recurrence.test.ts` | 56 | `computeNextRun`, `describeSchedule`, `formatTime`, validation |
| `RecurrenceEditor.test.tsx` | 13 | Render, interaction, accessibility (axe) |
| `ScheduleFormDialog.test.tsx` | 13 | Open/close, validation, save, accessibility |
| `SchedulesTable.test.tsx` | 16 | Render, action menu, empty state, accessibility |
| `ScheduledExportsPanel.test.tsx` | 14 | CRUD, toggle, delete, accessibility |
| `ScheduledExportsPage.test.tsx` | 2 | Page render, accessibility |
| `types.test.ts` | 9 | Constants, mock data shape |

All tests include axe-core accessibility assertions.
