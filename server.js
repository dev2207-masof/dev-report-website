const express = require("express");
const session = require("express-session");
const path = require("path");
const ExcelJS = require("exceljs");

const db = require("./db");

const app = express();

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

async function runMigrations() {
    try {
        const pool = await db.getPool();
        await pool.request().query(`
            IF NOT EXISTS (
                SELECT * FROM sys.columns
                WHERE object_id = OBJECT_ID('Users') AND name = 'IsActive'
            )
            ALTER TABLE Users ADD IsActive BIT NOT NULL DEFAULT 1
        `);
        await pool.request().query(`
            IF NOT EXISTS (
                SELECT * FROM sys.columns
                WHERE object_id = OBJECT_ID('Reports') AND name = 'ReadAt'
            )
            ALTER TABLE Reports ADD ReadAt DATETIME NULL
        `);
        await pool.request().query(`
            IF NOT EXISTS (
                SELECT * FROM sys.objects
                WHERE object_id = OBJECT_ID('ReportProjects') AND type = 'U'
            )
            CREATE TABLE ReportProjects (
                ReportId  INT NOT NULL,
                ProjectId INT NOT NULL,
                PRIMARY KEY (ReportId, ProjectId)
            )
        `);
        await pool.request().query(`
            IF NOT EXISTS (
                SELECT * FROM sys.columns
                WHERE object_id = OBJECT_ID('Reports') AND name = 'NotesByFullName'
            )
            ALTER TABLE Reports ADD NotesByFullName NVARCHAR(100) NULL
        `);
        console.log("Migrations OK");
    } catch (err) {
        console.error("Migration error:", err);
    }
}

app.use(
    session({
        secret: process.env.SESSION_SECRET || "dev-reports-secret",
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: false,
            sameSite: 'lax'
        }
    })
);


// --------------------
// LOGIN
// --------------------
app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;

    try {
        const pool = await db.getPool();

        const result = await pool.request()
            .input("username", username)
            .input("password", password)
            .query(`
                SELECT Id, Username, Role, FullName
                FROM Users
                WHERE Username = @username
                AND Password = @password
                AND IsActive = 1
            `);

        const user = result.recordset[0];

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        req.session.user = {
            id: user.Id,
            username: user.Username,
            role: user.Role,
            fullName: user.FullName
        };

        res.json(req.session.user);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// --------------------
// CURRENT USER
// --------------------
app.get("/api/me", (req, res) => {
    if (!req.session.user) return res.json(null);

    res.json(req.session.user);
});

// --------------------
// LOGOUT
// --------------------
app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ ok: true });
    });
});

// --------------------
// AUTH GUARD
// --------------------
function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: "Not logged in" });
    }
    next();
}

// --------------------
// ATTENDANCE API
// --------------------
app.get("/api/attendance", requireLogin, async (req, res) => {
    const user = req.session.user;

    if (user.role === "developer") {
        return res.status(403).json({ error: "Access denied" });
    }

    const date = req.query.date || new Date().toISOString().split("T")[0];

    try {
        const pool = await db.getPool();

        const result = await pool.request()
            .input("date", date)
            .query(`
                SELECT u.Username, u.FullName,
                       CASE WHEN r.Id IS NOT NULL THEN 1 ELSE 0 END AS Submitted
                FROM Users u
                LEFT JOIN Reports r
                    ON r.UserId = u.Id
                    AND CONVERT(date, r.Date) = @date
                    AND r.Status = 'published'
                WHERE u.Role = 'developer'
                ORDER BY u.FullName
            `);

        res.json(result.recordset);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch attendance" });
    }
});

// --------------------
// REPORTS API
// --------------------
app.get("/api/reports", requireLogin, async (req, res) => {
    const user = req.session.user;
    const from = req.query.from;
    const to   = req.query.to;
    const date = req.query.date || new Date().toISOString().split("T")[0];

    try {
        const pool = await db.getPool();

        let request = pool.request();
        let query = `
            SELECT r.Id, r.Content, r.Date, r.Status, r.Notes, r.NotesByFullName, r.ReadAt,
                   u.Username, u.FullName
            FROM Reports r
            JOIN Users u ON r.UserId = u.Id
            WHERE
        `;

        if (user.role === "developer") {
            query += " u.Username = @username AND";
            request.input("username", user.username);
        } else {
            query += " r.Status = 'published' AND";
        }

        if (from && to) {
            query += " CONVERT(date, r.Date) BETWEEN @from AND @to";
            request.input("from", from);
            request.input("to", to);
        } else {
            query += " CONVERT(date, r.Date) = @date";
            request.input("date", date);
        }

        query += " ORDER BY r.Date, u.FullName";

        const result = await request.query(query);
        const records = result.recordset;

        // Attach linked projects
        if (records.length > 0) {
            const ids = records.map(r => r.Id).join(",");
            const projResult = await pool.request().query(`
                SELECT rp.ReportId, p.Id AS ProjectId, p.Name AS ProjectName, p.Status, p.Immediacy
                FROM ReportProjects rp
                JOIN Projects p ON p.Id = rp.ProjectId
                WHERE rp.ReportId IN (${ids})
            `);
            const byReport = {};
            projResult.recordset.forEach(row => {
                if (!byReport[row.ReportId]) byReport[row.ReportId] = [];
                byReport[row.ReportId].push({ Id: row.ProjectId, Name: row.ProjectName, Status: row.Status, Immediacy: row.Immediacy });
            });
            records.forEach(r => { r.Projects = byReport[r.Id] || []; });
        } else {
            records.forEach(r => { r.Projects = []; });
        }

        res.json(records);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch reports" });
    }
});

app.post("/api/reports", requireLogin, async (req, res) => {
    const user = req.session.user;

    if (user.role !== "developer") {
        return res.status(403).json({ error: "Only developers can submit reports" });
    }

    try {
        const pool = await db.getPool();

        const userResult = await pool.request()
            .input("username", user.username)
            .query("SELECT Id FROM Users WHERE Username = @username");

        const userId = userResult.recordset[0].Id;

        const status = req.body.status === "draft" ? "draft" : "published";

        const result = await pool.request()
            .input("userId", userId)
            .input("content", req.body.content)
            .input("date", new Date().toISOString().split("T")[0])
            .input("status", status)
            .query(`
                INSERT INTO Reports (UserId, Content, Date, Status)
                OUTPUT INSERTED.*
                VALUES (@userId, @content, @date, @status)
            `);

        const report = result.recordset[0];

        // Save project associations
        const projectIds = Array.isArray(req.body.projectIds) ? req.body.projectIds : [];
        for (const pid of projectIds) {
            await pool.request()
                .input("reportId", report.Id)
                .input("projectId", pid)
                .query("INSERT INTO ReportProjects (ReportId, ProjectId) VALUES (@reportId, @projectId)");
        }

        res.json(report);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create report" });
    }
});

app.put("/api/reports/:id", requireLogin, async (req, res) => {
    const user = req.session.user;

    try {
        const pool = await db.getPool();

        if (user.role === "developer") {
            const check = await pool.request()
                .input("id", req.params.id)
                .input("username", user.username)
                .query(`
                    SELECT r.Id FROM Reports r
                    JOIN Users u ON r.UserId = u.Id
                    WHERE r.Id = @id AND u.Username = @username AND r.Status = 'draft'
                `);

            if (!check.recordset[0]) {
                return res.status(403).json({ error: "Can only edit your own drafts" });
            }
        }

        const status = ["draft", "published"].includes(req.body.status) ? req.body.status : null;

        const request = pool.request()
            .input("id", req.params.id)
            .input("content", req.body.content);

        let updateQuery = "UPDATE Reports SET Content = @content";
        if (status) {
            updateQuery += ", Status = @status";
            request.input("status", status);
        }
        updateQuery += " WHERE Id = @id; SELECT * FROM Reports WHERE Id = @id;";

        const result = await request.query(updateQuery);
        const updated = result.recordset[0];

        if (!updated) return res.status(404).send("Not found");

        // Sync project associations if provided
        if (Array.isArray(req.body.projectIds)) {
            await pool.request()
                .input("id", req.params.id)
                .query("DELETE FROM ReportProjects WHERE ReportId = @id");
            for (const pid of req.body.projectIds) {
                await pool.request()
                    .input("reportId", req.params.id)
                    .input("projectId", pid)
                    .query("INSERT INTO ReportProjects (ReportId, ProjectId) VALUES (@reportId, @projectId)");
            }
        }

        res.json(updated);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update report" });
    }
});

// --------------------
// DELETE DRAFT
// --------------------
app.delete("/api/reports/:id", requireLogin, async (req, res) => {
    const user = req.session.user;

    if (user.role !== "developer") {
        return res.status(403).json({ error: "Only developers can delete drafts" });
    }

    try {
        const pool = await db.getPool();

        const check = await pool.request()
            .input("id", req.params.id)
            .input("username", user.username)
            .query(`
                SELECT r.Id FROM Reports r
                JOIN Users u ON r.UserId = u.Id
                WHERE r.Id = @id AND u.Username = @username AND r.Status = 'draft'
            `);

        if (!check.recordset[0]) {
            return res.status(403).json({ error: "Can only delete your own drafts" });
        }

        await pool.request()
            .input("id", req.params.id)
            .query("DELETE FROM Reports WHERE Id = @id");

        res.json({ ok: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete report" });
    }
});

// --------------------
// EXPORT TO EXCEL
// --------------------
const TEMPLATE_RE = /^מה עשיתי היום:\n([\s\S]*?)\n\nחסמים:\n([\s\S]*?)\n\nמחר:\n([\s\S]*)$/;

function parseTemplate(content) {
    const m = (content || "").match(TEMPLATE_RE);
    if (!m) return { today: content || "", blockers: "", tomorrow: "" };
    return { today: m[1], blockers: m[2], tomorrow: m[3] };
}

function addSheetRows(sheet, records) {
    const COLS = [
        { header: "שם מלא",        key: "fullName",  width: 20 },
        { header: "שם משתמש",      key: "username",  width: 16 },
        { header: "מה עשיתי היום", key: "today",     width: 40 },
        { header: "חסמים",         key: "blockers",  width: 30 },
        { header: "מחר",           key: "tomorrow",  width: 30 },
        { header: "הערת מנהל",     key: "notes",     width: 30 },
    ];
    sheet.columns = COLS;
    sheet.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
        cell.alignment = { horizontal: "right", vertical: "middle" };
    });
    sheet.getRow(1).height = 22;
    records.forEach((r, i) => {
        const { today, blockers, tomorrow } = parseTemplate(r.Content);
        const row = sheet.addRow({
            fullName: r.FullName,
            username: r.Username,
            today, blockers, tomorrow,
            notes: r.Notes || "",
        });
        row.eachCell(cell => {
            cell.alignment = { horizontal: "right", vertical: "top", wrapText: true };
        });
        if (i % 2 === 1) {
            row.eachCell(cell => {
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
            });
        }
    });
}

app.get("/api/reports/export", requireLogin, async (req, res) => {
    const user = req.session.user;

    if (user.role === "developer") {
        return res.status(403).json({ error: "Access denied" });
    }

    const from = req.query.from;
    const to   = req.query.to;
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const isRange = from && to;

    try {
        const pool = await db.getPool();
        const request = pool.request();

        let query = `
            SELECT r.Content, r.Date, r.Notes, u.Username, u.FullName
            FROM Reports r
            JOIN Users u ON r.UserId = u.Id
            WHERE r.Status = 'published'
        `;

        if (isRange) {
            query += " AND CONVERT(date, r.Date) BETWEEN @from AND @to";
            request.input("from", from);
            request.input("to", to);
        } else {
            query += " AND CONVERT(date, r.Date) = @date";
            request.input("date", date);
        }
        query += " ORDER BY r.Date, u.FullName";

        const result = await request.query(query);
        const workbook = new ExcelJS.Workbook();

        if (isRange) {
            // One sheet per day
            const groups = {};
            result.recordset.forEach(r => {
                const d = new Date(r.Date).toISOString().slice(0, 10);
                if (!groups[d]) groups[d] = [];
                groups[d].push(r);
            });
            Object.keys(groups).sort().forEach(d => {
                addSheetRows(workbook.addWorksheet(d), groups[d]);
            });
        } else {
            addSheetRows(workbook.addWorksheet(date), result.recordset);
        }

        const filename = isRange ? `reports-${from}-to-${to}.xlsx` : `reports-${date}.xlsx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to export" });
    }
});

// --------------------
// ACKNOWLEDGE
// --------------------
app.patch("/api/reports/:id/acknowledge", requireLogin, async (req, res) => {
    const user = req.session.user;
    if (user.role === "developer") {
        return res.status(403).json({ error: "Only managers can acknowledge reports" });
    }
    try {
        const pool = await db.getPool();
        const result = await pool.request()
            .input("id", req.params.id)
            .query(`
                UPDATE Reports
                SET ReadAt = CASE WHEN ReadAt IS NULL THEN GETDATE() ELSE NULL END
                WHERE Id = @id;
                SELECT * FROM Reports WHERE Id = @id;
            `);
        const updated = result.recordset[0];
        if (!updated) return res.status(404).send("Not found");
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to acknowledge" });
    }
});

// --------------------
// NOTES API
// --------------------
app.patch("/api/reports/:id/notes", requireLogin, async (req, res) => {
    const user = req.session.user;

    if (user.role === "developer") {
        return res.status(403).json({ error: "Developers cannot add notes" });
    }

    try {
        const pool = await db.getPool();

        const result = await pool.request()
            .input("id", req.params.id)
            .input("notes", req.body.notes)
            .input("notesByFullName", req.body.notes ? user.fullName : null)
            .query(`
                UPDATE Reports
                SET Notes = @notes,
                    NotesByFullName = @notesByFullName,
                    ReadAt = CASE WHEN ReadAt IS NULL THEN GETDATE() ELSE ReadAt END
                WHERE Id = @id;
                SELECT * FROM Reports WHERE Id = @id;
            `);

        const updated = result.recordset[0];
        if (!updated) return res.status(404).send("Not found");

        res.json(updated);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update notes" });
    }
});

// --------------------
// USER MANAGEMENT
// --------------------
function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admins only" });
    }
    next();
}

function requireManagerOrAdmin(req, res, next) {
    const role = req.session.user && req.session.user.role;
    if (role !== "admin" && role !== "manager") {
        return res.status(403).json({ error: "Access denied" });
    }
    next();
}

app.get("/api/users", requireLogin, async (req, res) => {
    try {
        const pool = await db.getPool();
        const result = await pool.request().query(`
            SELECT Id, Username, FullName, Role, IsActive
            FROM Users
            ORDER BY
                CASE Role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
                FullName
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

app.post("/api/users", requireLogin, requireAdmin, async (req, res) => {
    const { username, fullName, password, role } = req.body;
    if (!username || !fullName || !password || !role) {
        return res.status(400).json({ error: "All fields required" });
    }
    if (!["developer", "manager", "admin"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
    }
    try {
        const pool = await db.getPool();
        const exists = await pool.request()
            .input("username", username)
            .query("SELECT Id FROM Users WHERE Username = @username");
        if (exists.recordset[0]) {
            return res.status(409).json({ error: "Username already exists" });
        }
        const result = await pool.request()
            .input("username", username)
            .input("fullName", fullName)
            .input("password", password)
            .input("role", role)
            .query(`
                INSERT INTO Users (Username, FullName, Password, Role, IsActive)
                OUTPUT INSERTED.Id, INSERTED.Username, INSERTED.FullName, INSERTED.Role, INSERTED.IsActive
                VALUES (@username, @fullName, @password, @role, 1)
            `);
        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create user" });
    }
});

app.delete("/api/users/:id", requireLogin, requireManagerOrAdmin, async (req, res) => {
    const requester = req.session.user;
    try {
        const pool = await db.getPool();
        const targetResult = await pool.request()
            .input("id", req.params.id)
            .query("SELECT Username, Role FROM Users WHERE Id = @id");
        const target = targetResult.recordset[0];
        if (!target) return res.status(404).json({ error: "User not found" });

        if (requester.role === "manager" && target.Role !== "developer") {
            return res.status(403).json({ error: "Managers can only delete developers" });
        }

        await pool.request()
            .input("id", req.params.id)
            .query("DELETE FROM Reports WHERE UserId = @id");
        await pool.request()
            .input("id", req.params.id)
            .query("DELETE FROM Users WHERE Id = @id");
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete user" });
    }
});

app.patch("/api/users/:id", requireLogin, requireManagerOrAdmin, async (req, res) => {
    const requester = req.session.user;
    const { fullName, role, password, isActive } = req.body;
    try {
        const pool = await db.getPool();

        // Fetch target user to check their role
        const targetResult = await pool.request()
            .input("id", req.params.id)
            .query("SELECT Id, Username, Role FROM Users WHERE Id = @id");
        const target = targetResult.recordset[0];
        if (!target) return res.status(404).json({ error: "User not found" });

        // Managers can only edit developers or themselves
        if (requester.role === "manager") {
            const isSelf = target.Username === requester.username;
            if (!isSelf && target.Role !== "developer") {
                return res.status(403).json({ error: "Managers can only edit developers or themselves" });
            }
        }

        const { username } = req.body;

        // Check username uniqueness if changing it
        if (username !== undefined && username !== target.Username) {
            const conflict = await pool.request()
                .input("username", username)
                .input("id", req.params.id)
                .query("SELECT Id FROM Users WHERE Username = @username AND Id <> @id");
            if (conflict.recordset[0]) {
                return res.status(409).json({ error: "Username already taken" });
            }
        }

        const request = pool.request().input("id", req.params.id);
        const parts = [];

        if (username !== undefined && username !== "") { parts.push("Username = @username"); request.input("username", username); }
        if (fullName !== undefined) { parts.push("FullName = @fullName"); request.input("fullName", fullName); }
        if (role !== undefined) {
            if (!["developer", "manager", "admin"].includes(role)) {
                return res.status(400).json({ error: "Invalid role" });
            }
            parts.push("Role = @role"); request.input("role", role);
        }
        if (password !== undefined && password !== "") { parts.push("Password = @password"); request.input("password", password); }
        if (isActive !== undefined) { parts.push("IsActive = @isActive"); request.input("isActive", isActive ? 1 : 0); }

        if (parts.length === 0) return res.status(400).json({ error: "Nothing to update" });

        const result = await request.query(`
            UPDATE Users SET ${parts.join(", ")} WHERE Id = @id;
            SELECT Id, Username, FullName, Role, IsActive FROM Users WHERE Id = @id;
        `);
        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update user" });
    }
});

// --------------------
// PROJECTS API
// --------------------
const VALID_STATUSES   = ["future", "ongoing", "closed"];
const VALID_IMMEDIACY  = ["low", "normal", "high", "urgent"];

app.get("/api/projects", requireLogin, async (req, res) => {
    const showClosed = req.query.showClosed === "1";
    try {
        const pool = await db.getPool();
        let query = `
            SELECT Id, Name, Description, Status, Immediacy, CreatedAt, UpdatedAt
            FROM Projects
            ${showClosed ? "" : "WHERE Status != 'closed'"}
            ORDER BY
                CASE Immediacy WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                CASE Status   WHEN 'ongoing' THEN 1 WHEN 'future' THEN 2 ELSE 3 END,
                Name
        `;
        const result = await pool.request().query(query);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});

app.post("/api/projects", requireLogin, requireManagerOrAdmin, async (req, res) => {
    const { name, description, status, immediacy } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    if (status && !VALID_STATUSES.includes(status))   return res.status(400).json({ error: "Invalid status" });
    if (immediacy && !VALID_IMMEDIACY.includes(immediacy)) return res.status(400).json({ error: "Invalid immediacy" });
    try {
        const pool = await db.getPool();
        const result = await pool.request()
            .input("name",        name)
            .input("description", description || null)
            .input("status",      status    || "ongoing")
            .input("immediacy",   immediacy || "normal")
            .query(`
                INSERT INTO Projects (Name, Description, Status, Immediacy)
                OUTPUT INSERTED.*
                VALUES (@name, @description, @status, @immediacy)
            `);
        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create project" });
    }
});

app.patch("/api/projects/:id", requireLogin, requireManagerOrAdmin, async (req, res) => {
    const { name, description, status, immediacy } = req.body;
    if (status    && !VALID_STATUSES.includes(status))   return res.status(400).json({ error: "Invalid status" });
    if (immediacy && !VALID_IMMEDIACY.includes(immediacy)) return res.status(400).json({ error: "Invalid immediacy" });
    try {
        const pool = await db.getPool();
        const request = pool.request().input("id", req.params.id);
        const parts = ["UpdatedAt = GETDATE()"];
        if (name        !== undefined) { parts.push("Name = @name");               request.input("name", name); }
        if (description !== undefined) { parts.push("Description = @description"); request.input("description", description); }
        if (status      !== undefined) { parts.push("Status = @status");           request.input("status", status); }
        if (immediacy   !== undefined) { parts.push("Immediacy = @immediacy");     request.input("immediacy", immediacy); }
        const result = await request.query(`
            UPDATE Projects SET ${parts.join(", ")} WHERE Id = @id;
            SELECT * FROM Projects WHERE Id = @id;
        `);
        const updated = result.recordset[0];
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update project" });
    }
});

app.delete("/api/projects/:id", requireLogin, requireAdmin, async (req, res) => {
    try {
        const pool = await db.getPool();
        await pool.request()
            .input("id", req.params.id)
            .query("DELETE FROM Projects WHERE Id = @id");
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete project" });
    }
});

// --------------------
// CHAT API
// --------------------

app.get("/api/conversations", requireLogin, async (req, res) => {
    const user = req.session.user;
    try {
        const pool = await db.getPool();
        const result = await pool.request()
            .input("userId", user.id)
            .query(`
                SELECT
                    c.Id,
                    c.Type,
                    c.Name,
                    c.CreatedAt,
                    lm.Body         AS LastMessage,
                    lm.SentAt       AS LastMessageAt,
                    lm.SenderName   AS LastSenderName,
                    (
                        SELECT COUNT(*) FROM Messages m2
                        WHERE m2.ConversationId = c.Id
                          AND m2.SenderId <> @userId
                          AND NOT EXISTS (
                              SELECT 1 FROM MessageReads mr
                              WHERE mr.MessageId = m2.Id AND mr.UserId = @userId
                          )
                    ) AS UnreadCount,
                    op.FullName AS OtherName,
                    op.Id       AS OtherUserId
                FROM Conversations c
                JOIN ConversationParticipants cp ON cp.ConversationId = c.Id AND cp.UserId = @userId
                OUTER APPLY (
                    SELECT TOP 1 m.Body, m.SentAt, u.FullName AS SenderName
                    FROM Messages m
                    JOIN Users u ON u.Id = m.SenderId
                    WHERE m.ConversationId = c.Id
                    ORDER BY m.SentAt DESC
                ) lm
                OUTER APPLY (
                    SELECT TOP 1 u.FullName, u.Id
                    FROM ConversationParticipants cp2
                    JOIN Users u ON u.Id = cp2.UserId
                    WHERE cp2.ConversationId = c.Id AND cp2.UserId <> @userId
                ) op
                ORDER BY COALESCE(lm.SentAt, c.CreatedAt) DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch conversations" });
    }
});

app.post("/api/conversations", requireLogin, async (req, res) => {
    const user = req.session.user;
    const { userId } = req.body;
    if (!userId || userId === user.id) return res.status(400).json({ error: "Invalid userId" });

    try {
        const pool = await db.getPool();

        const existing = await pool.request()
            .input("userId", user.id)
            .input("otherId", userId)
            .query(`
                SELECT c.Id FROM Conversations c
                WHERE c.Type = 'direct'
                  AND EXISTS (SELECT 1 FROM ConversationParticipants WHERE ConversationId = c.Id AND UserId = @userId)
                  AND EXISTS (SELECT 1 FROM ConversationParticipants WHERE ConversationId = c.Id AND UserId = @otherId)
                  AND (SELECT COUNT(*) FROM ConversationParticipants WHERE ConversationId = c.Id) = 2
            `);

        if (existing.recordset[0]) {
            return res.json({ id: existing.recordset[0].Id });
        }

        const result = await pool.request().query(`
            INSERT INTO Conversations (Type) OUTPUT INSERTED.Id VALUES ('direct')
        `);
        const convId = result.recordset[0].Id;

        await pool.request()
            .input("convId", convId)
            .input("u1", user.id)
            .input("u2", userId)
            .query(`
                INSERT INTO ConversationParticipants (ConversationId, UserId) VALUES (@convId, @u1);
                INSERT INTO ConversationParticipants (ConversationId, UserId) VALUES (@convId, @u2);
            `);

        res.json({ id: convId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create conversation" });
    }
});

app.get("/api/conversations/:id/messages", requireLogin, async (req, res) => {
    const user = req.session.user;
    const since = req.query.since;

    try {
        const pool = await db.getPool();

        const access = await pool.request()
            .input("convId", req.params.id)
            .input("userId", user.id)
            .query("SELECT 1 AS ok FROM ConversationParticipants WHERE ConversationId = @convId AND UserId = @userId");
        if (!access.recordset[0]) return res.status(403).json({ error: "Access denied" });

        const req2 = pool.request().input("convId", req.params.id);
        let query = `
            SELECT m.Id, m.Body, m.SentAt, u.FullName AS SenderName, u.Id AS SenderId
            FROM Messages m
            JOIN Users u ON u.Id = m.SenderId
            WHERE m.ConversationId = @convId
        `;
        if (since) {
            req2.input("since", new Date(since));
            query += " AND m.SentAt > @since";
        }
        query += " ORDER BY m.SentAt ASC";

        const result = await req2.query(query);
        const messages = result.recordset;

        for (const msg of messages) {
            if (msg.SenderId !== user.id) {
                await pool.request()
                    .input("msgId", msg.Id)
                    .input("userId", user.id)
                    .query(`
                        IF NOT EXISTS (SELECT 1 FROM MessageReads WHERE MessageId = @msgId AND UserId = @userId)
                            INSERT INTO MessageReads (MessageId, UserId) VALUES (@msgId, @userId)
                    `);
            }
        }

        res.json(messages);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});

app.post("/api/conversations/:id/messages", requireLogin, async (req, res) => {
    const user = req.session.user;
    const content = (req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "Message required" });

    try {
        const pool = await db.getPool();

        const access = await pool.request()
            .input("convId", req.params.id)
            .input("userId", user.id)
            .query("SELECT 1 AS ok FROM ConversationParticipants WHERE ConversationId = @convId AND UserId = @userId");
        if (!access.recordset[0]) return res.status(403).json({ error: "Access denied" });

        const result = await pool.request()
            .input("convId", req.params.id)
            .input("senderId", user.id)
            .input("body", content)
            .query(`
                INSERT INTO Messages (ConversationId, SenderId, Body)
                OUTPUT INSERTED.Id, INSERTED.Body, INSERTED.SentAt, INSERTED.ConversationId, INSERTED.SenderId
                VALUES (@convId, @senderId, @body)
            `);

        const msg = result.recordset[0];

        await pool.request()
            .input("msgId", msg.Id)
            .input("userId", user.id)
            .query("INSERT INTO MessageReads (MessageId, UserId) VALUES (@msgId, @userId)");

        res.json({ ...msg, SenderName: user.fullName });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

runMigrations().then(() => {
    app.listen(3000, () => {
        console.log("Server running on http://localhost:3000");
    });
});