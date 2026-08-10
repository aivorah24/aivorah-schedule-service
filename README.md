# Aivorah Schedule Service

Standalone microservice for Aivorah's Schedule/Calendar feature — event
CRUD, month/upcoming views, iCal export, and cross-persona visibility
scoping (student/teacher/parent) — extracted from `ai-mentor/server`.

Unlike AI Coach and Challenges, this route is shared across three personas:
the Student, Teacher, and Parent schedule screens all call these same
endpoints (with role-appropriate scoping applied server-side).

## Structure

```
routes/
  schedule.js          — thin route handlers only:
                          GET / (day), GET /teacher, GET /month, GET /upcoming,
                          POST /, PATCH|PUT /:id, DELETE /:id, GET /tags,
                          GET /ical
services/
  schedule.js           — data-access + domain logic:
                           mapRow (DB row -> camelCase), getStudentProfile,
                           scopeAllEvents ('all'-student broadcast visibility),
                           filterCompleted (assignment/challenge completion
                           status), notifyScheduleEvent (push/parent-message
                           side-effects on create)
  icalExport.js          — buildICalendar: RFC 5545 .ics file generation
                            (a genuinely distinct concern from the DB layer)
  supabase.js            — Supabase client
```

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3009`).

## Endpoints

- `GET /schedule?studentId=&date=` — a student's events for one day
- `GET /schedule/teacher?date=&email=` — a teacher's own class events for one day
- `GET /schedule/month?studentId=&year=&month=` — dates-with-events in a month
- `GET /schedule/upcoming?studentId=` — next 5 assignment/challenge deadlines
- `POST /schedule` — create an event (notifies student/parent if teacher/parent-created)
- `PATCH` / `PUT /schedule/:id` — update an event
- `DELETE /schedule/:id` — delete an event
- `GET /schedule/tags` — static tag/color definitions
- `GET /schedule/ical?studentId=&email=&role=` — subscribe/download .ics feed
- `GET /health`

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR (see `.github/PULL_REQUEST_TEMPLATE.md`).
