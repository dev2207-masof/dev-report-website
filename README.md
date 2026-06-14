# Developers Report System

An internal web app where developers submit daily work reports, and managers/admins review and annotate them.

---

## Setup & Running

**Requirements:** Node.js, a running SQL Server instance.

```bash
npm install
npm start        # starts the server on http://localhost:3000
```

To verify the database connection is working:

```bash
node test-db.js
```

---

## Database

The app connects to a SQL Server instance. Connection settings are in `db.js`:

- **Server:** `Dev2`
- **Database:** `DevReportsDB`
- **Login:** `dev_login`

### Tables

**Users**

| Column     | Type    | Notes                              |
|------------|---------|------------------------------------|
| Id         | int     | Primary key                        |
| Username   | varchar | Used to log in                     |
| Password   | varchar | Stored as plain text               |
| Role       | varchar | `developer`, `manager`, or `admin` |
| FullName   | varchar | Displayed in the UI                |

**Reports**

| Column   | Type    | Notes                                      |
|----------|---------|--------------------------------------------|
| Id       | int     | Primary key                                |
| UserId   | int     | FK → Users.Id                              |
| Content  | text    | The body of the report                     |
| Date     | date    | Set to today's date at submission time     |
| Status   | varchar | `draft` or `published`                     |
| Notes    | text    | Manager/admin annotation, nullable         |

---

## Authentication

Login is session-based (`express-session`). When a user logs in via `POST /api/login`, their username, role, and full name are stored in the server-side session. All report endpoints check for an active session before doing anything.

There is no token system — the browser sends a session cookie automatically with every request.

---

## Roles & Permissions

The system has three roles with different levels of access:

### Developer
- Can submit new reports (as draft or published)
- Can view **only their own** reports
- Can edit and delete their **own drafts** (not published reports)
- Can promote a draft to published

### Manager / Admin
- Can view **all published** reports (not drafts)
- Can edit any report's content, regardless of who wrote it
- Can add or update notes on any report
- **Cannot** submit reports of their own

These rules are enforced on the server side. The frontend also hides/shows buttons based on role, but the backend will reject unauthorized actions even if someone bypasses the UI.

---

## API Endpoints

All endpoints under `/api/` require a logged-in session (except login itself).

### Auth

| Method | Path          | Description                                      |
|--------|---------------|--------------------------------------------------|
| POST   | `/api/login`  | Log in. Body: `{ username, password }`           |
| GET    | `/api/me`     | Returns the current session user, or `null`      |
| POST   | `/api/logout` | Destroys the session                             |

### Reports

| Method | Path                     | Who can use         | Description                                                         |
|--------|--------------------------|---------------------|---------------------------------------------------------------------|
| GET    | `/api/reports?date=YYYY-MM-DD` | All logged-in users | Fetch reports for a given date. Developers see their own; managers/admins see all published. |
| POST   | `/api/reports`           | Developers only     | Create a new report. Body: `{ content, status }` (`draft` or `published`) |
| PUT    | `/api/reports/:id`       | Developers (own drafts), managers/admins (any) | Update content and/or status of a report. |
| DELETE | `/api/reports/:id`       | Developers only     | Delete a draft. Only the report's owner can do this.                |
| PATCH  | `/api/reports/:id/notes` | Managers/admins only | Set the notes field on a report. Body: `{ notes }`                  |

---

## Frontend

The frontend is a single HTML page (`public/index.html`) with no framework — just vanilla JavaScript in `public/app.js`.

**How it works:**

1. On page load, `checkLogin()` calls `GET /api/me`. If a user is already logged in (active session), it shows the main app. Otherwise, the login form is shown.
2. After login, `loadReports()` fetches reports for today's date and stores them in `reportsMap` (a plain object keyed by report ID). This map is the local source of truth for the current view.
3. Every action that changes data (submit, edit, delete, save note) re-calls `loadReports()` to refresh the view from the server.

**Two view modes:**
- **Card view** (default) — each report is a card with the content and note side by side.
- **Table view** — a compact table. Clicking a row expands it. Toggle with the button in the header.

The "Status" column in the table view is only shown to developers (since managers only ever see published reports, the column would always say "Published" and adds no value).

**Modals:**
- **Edit modal** — opens when clicking "Edit" on a report. Shows different action buttons depending on role: developers get "Submit" and "Save as Draft"; managers/admins get a plain "Save".
- **Notes modal** — opens when a manager/admin clicks "Note". Pre-fills with the existing note if there is one.

---

## File Structure

```
server.js          - Express server: all API routes and middleware
db.js              - SQL Server connection (returns a shared pool)
test-db.js         - One-off script to verify the DB connection works
public/
  index.html       - The single-page UI
  app.js           - All frontend logic
  styles.css       - Styles
routes/
  reports.js       - Empty, not used (placeholder for future route splitting)
```
