let currentUser = null;
let reportsMap = {};
let viewMode = "cards";
let weekMode = false;

const HE_DAYS = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"];

function getWeekRange(dateStr) {
    const d = new Date(dateStr);
    const sun = new Date(d);
    sun.setDate(d.getDate() - d.getDay());
    const thu = new Date(sun);
    thu.setDate(sun.getDate() + 4);
    return {
        from: sun.toISOString().slice(0, 10),
        to:   thu.toISOString().slice(0, 10)
    };
}

function formatShortDate(dateStr) {
    const [year, month, day] = dateStr.slice(0, 10).split("-");
    return `${day}-${month}-${year}`;
}

function formatHeDate(dateStr) {
    const [year, month, day] = dateStr.split("-");
    const d = new Date(dateStr);
    const dayName = HE_DAYS[d.getDay()];
    return `${dayName} — ${day}-${month}-${year}`;
}

const TEMPLATE_SEP = "\n\n";
const TEMPLATE_HEADERS = ["מה עשיתי היום", "חסמים", "מחר"];

function buildContent(today, blockers, tomorrow) {
    return `מה עשיתי היום:\n${today}${TEMPLATE_SEP}חסמים:\n${blockers}${TEMPLATE_SEP}מחר:\n${tomorrow}`;
}

function parseTemplate(content) {
    const re = /^מה עשיתי היום:\n([\s\S]*?)\n\nחסמים:\n([\s\S]*?)\n\nמחר:\n([\s\S]*)$/;
    const m = content.match(re);
    if (!m) return null;
    return { today: m[1], blockers: m[2], tomorrow: m[3] };
}

function formatReadAt(readAtStr) {
    // Parse directly from the string to avoid browser UTC→local timezone shift
    const clean = readAtStr.slice(0, 16); // "2026-06-11T11:44"
    const [date, time] = clean.split("T");
    const [, month, day] = date.split("-");
    return `${day}/${month} ${time}`;
}

function readStatusHtml(r) {
    if (r.Status !== "published") return "";
    if (r.ReadAt) {
        if (currentUser.role === "manager" || currentUser.role === "admin") {
            return `<button class="btn btn-sm read-badge read-badge-btn" onclick="acknowledgeReport(${r.Id})" title="לחץ לביטול סימון">&#10003; נקרא ${formatReadAt(r.ReadAt)}</button>`;
        }
        return `<span class="read-badge">&#10003; נקרא ${formatReadAt(r.ReadAt)}</span>`;
    }
    if (currentUser.role === "manager" || currentUser.role === "admin") {
        return `<button class="btn btn-secondary btn-sm" onclick="acknowledgeReport(${r.Id})">סמן כנקרא</button>`;
    }
    return "";
}

function renderStructuredContent(content) {
    const parsed = parseTemplate(content);
    if (!parsed) return `<p>${content}</p>`;
    return TEMPLATE_HEADERS.map((header, i) => {
        const text = [parsed.today, parsed.blockers, parsed.tomorrow][i];
        return `<div class="structured-section">
            <span class="structured-label">${header}</span>
            <p>${text || '<span class="no-note">—</span>'}</p>
        </div>`;
    }).join("");
}

async function checkLogin() {
    const res = await fetch("/api/me");
    const user = await res.json();

    if (user) {
        currentUser = user;

        document.getElementById("loginBox").style.display = "none";
        document.getElementById("app").style.display = "block";

        const hour = new Date().getHours();
        const greeting = hour >= 6 && hour < 12  ? "בוקר טוב"
                       : hour >= 12 && hour < 16 ? "צהריים טובים"
                       : hour >= 16 && hour < 19 ? "אחר הצהריים טובים"
                       : hour >= 19 && hour < 22 ? "ערב טוב"
                       : "ברוך הבא";
        document.getElementById("welcomeMsg").innerText = `${greeting}, ${user.fullName}!`;

        loadProjects();

        if (user.role === "developer") {
            loadProjectCheckboxes("createProjectCheckboxes");
        }

        if (user.role === "manager" || user.role === "admin") {
            document.getElementById("createBox").style.display = "none";
            document.getElementById("attendanceBox").style.display = "block";
            document.getElementById("exportBtn").style.display = "inline-flex";
        }

        if (user.role === "admin" || user.role === "manager") {
            document.getElementById("manageUsersBtn").style.display = "inline-flex";
        }

        const today = new Date().toISOString().split("T")[0];
        const dateInput = document.getElementById("reportDate");
        dateInput.value = today;
        dateInput.max = today;

        loadAttendance();
        loadReports();
    }
}

async function login() {
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
        document.getElementById("loginError").innerText = "שם משתמש או סיסמה שגויים";
        return;
    }

    checkLogin();
}

async function logout() {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
}

async function loadProjectCheckboxes(containerId, selectedIds = []) {
    const res = await fetch("/api/projects?showClosed=0");
    const projects = await res.json();
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!Array.isArray(projects) || projects.length === 0) {
        container.innerHTML = '<span class="no-note">אין פרויקטים פעילים</span>';
        return;
    }
    container.innerHTML = projects.map(p => `
        <label class="proj-check-label">
            <input type="checkbox" value="${p.Id}" ${selectedIds.includes(p.Id) ? "checked" : ""} />
            <span class="proj-badge status-${p.Status}">${p.Name}</span>
        </label>
    `).join("");
}

function getCheckedProjectIds(containerId) {
    return Array.from(
        document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)
    ).map(cb => parseInt(cb.value));
}

async function loadAttendance() {
    if (currentUser.role === "developer") return;

    const date = document.getElementById("reportDate").value;
    if (!date) return;

    const res = await fetch(`/api/attendance?date=${date}`);
    const data = await res.json();

    if (!Array.isArray(data)) return;

    const submitted = data.filter(d => d.Submitted).length;
    document.getElementById("attendanceSummary").textContent = `${submitted}/${data.length} הגישו`;

    const list = document.getElementById("attendanceList");
    list.innerHTML = "";

    data.forEach(d => {
        const chip = document.createElement("div");
        chip.className = `attendance-chip ${d.Submitted ? "submitted" : "missing"}`;
        chip.innerHTML = `<span class="attendance-dot"></span>${d.FullName}`;
        list.appendChild(chip);
    });
}

async function loadReports() {
    const date = document.getElementById("reportDate").value;
    if (!date) return;

    let url;
    if (weekMode) {
        const { from, to } = getWeekRange(date);
        url = `/api/reports?from=${from}&to=${to}`;
    } else {
        url = `/api/reports?date=${date}`;
    }

    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data)) {
        console.error("Failed to load reports:", data);
        document.getElementById("reports").innerHTML = '<p class="empty-state">טעינת הדוחות נכשלה.</p>';
        return;
    }

    reportsMap = {};
    data.forEach(r => reportsMap[r.Id] = r);

    renderReports(data);
}

function filterReports(data) {
    const q = document.getElementById("searchInput").value.trim().toLowerCase();
    if (!q) return data;
    return data.filter(r =>
        r.FullName.toLowerCase().includes(q) ||
        r.Username.toLowerCase().includes(q) ||
        r.Content.toLowerCase().includes(q) ||
        (r.Notes && r.Notes.toLowerCase().includes(q))
    );
}

function renderReports(data) {
    const container = document.getElementById("reports");
    container.innerHTML = "";

    const filtered = filterReports(data);

    if (data.length === 0) {
        container.innerHTML = `<p class="empty-state">${weekMode ? "אין דוחות לשבוע זה." : "אין דוחות לתאריך זה."}</p>`;
        return;
    }

    if (filtered.length === 0) {
        container.innerHTML = `<p class="empty-state">לא נמצאו תוצאות לחיפוש.</p>`;
        return;
    }

    if (weekMode) {
        renderWeek(filtered, container);
    } else if (viewMode === "table") {
        renderTable(filtered, container);
    } else {
        renderCards(filtered, container);
    }
}

function renderWeek(data, container) {
    const groups = {};
    data.forEach(r => {
        const d = r.Date.slice(0, 10);
        if (!groups[d]) groups[d] = [];
        groups[d].push(r);
    });

    Object.keys(groups).sort().forEach(date => {
        const daySection = document.createElement("div");
        daySection.className = "week-day-section";

        const header = document.createElement("div");
        header.className = "week-day-header";
        header.innerHTML = `
            <span>${formatHeDate(date)}</span>
            ${(currentUser.role === "manager" || currentUser.role === "admin")
                ? `<button class="btn btn-secondary btn-sm" onclick="exportDay('${date}')">ייצוא Excel</button>`
                : ""}
        `;
        daySection.appendChild(header);

        const inner = document.createElement("div");
        if (viewMode === "table") {
            renderTable(groups[date], inner);
        } else {
            renderCards(groups[date], inner);
        }
        daySection.appendChild(inner);
        container.appendChild(daySection);
    });
}

function renderCards(data, container) {
    data.forEach(r => {
        const canEdit =
            (currentUser.role === "developer" && r.Status === "draft") ||
            currentUser.role === "manager" ||
            currentUser.role === "admin";

        const canNote = currentUser.role === "manager" || currentUser.role === "admin";

        const div = document.createElement("div");
        div.className = "report-card";

        const projBadges = r.Projects && r.Projects.length > 0
            ? `<div class="report-projects">${r.Projects.map(p => `<span class="proj-badge status-${p.Status}">${p.Name}</span>`).join("")}</div>`
            : "";

        div.innerHTML = `
        <div class="card-meta">
            <strong>${r.FullName}</strong>
            <span class="meta-sep">·</span>
            <span class="meta-date">${r.Username}</span>
            <span class="meta-sep">·</span>
            <span class="meta-date">${formatShortDate(r.Date)}</span>
            ${r.Status === "draft" ? '<span class="draft-badge">טיוטה</span>' : ''}
            ${readStatusHtml(r)}
            <div class="card-actions">
                ${canEdit ? `<button class="btn btn-secondary btn-sm" onclick="openEditModal(${r.Id})">עריכה</button>` : ''}
                ${currentUser.role === "developer" && r.Status === "draft" ? `<button class="btn btn-primary btn-sm" onclick="submitDraft(${r.Id})">שלח</button>` : ''}
                ${currentUser.role === "developer" && r.Status === "draft" ? `<button class="btn btn-danger btn-sm" onclick="deleteDraft(${r.Id})">מחק</button>` : ''}
                ${canNote ? `<button class="btn btn-secondary btn-sm" onclick="openNotesModal(${r.Id})">הערה</button>` : ''}
            </div>
        </div>
        <div class="card-columns">
            <div class="card-section">
                <span class="section-label">Report</span>
                <div class="structured-content">${renderStructuredContent(r.Content)}</div>
                ${projBadges}
            </div>
            <div class="card-section notes-section">
                <span class="section-label">Note</span>
                <p>${r.Notes || '<span class="no-note">אין הערה עדיין</span>'}</p>
                ${r.Notes && r.NotesByFullName ? `<span class="note-by">${r.NotesByFullName}</span>` : ""}
            </div>
        </div>
        `;

        container.appendChild(div);
    });
}

function renderTable(data, container) {
    const table = document.createElement("table");
    table.className = "report-table";

    const showStatus = currentUser.role === "developer";

    table.innerHTML = `
        <colgroup>
            <col class="col-name">
            <col class="col-username">
            <col class="col-date">
            ${showStatus ? '<col class="col-status">' : ''}
            <col class="col-report">
            <col class="col-note">
            <col class="col-actions">
        </colgroup>
        <thead>
            <tr>
                <th>שם</th>
                <th>שם משתמש</th>
                <th>תאריך</th>
                ${showStatus ? '<th>סטטוס</th>' : ''}
                <th>דוח</th>
                <th>הערה</th>
                <th></th>
            </tr>
        </thead>
    `;

    const tbody = document.createElement("tbody");

    data.forEach(r => {
        const canEdit =
            (currentUser.role === "developer" && r.Status === "draft") ||
            currentUser.role === "manager" ||
            currentUser.role === "admin";

        const canNote = currentUser.role === "manager" || currentUser.role === "admin";

        const projBadgesTable = r.Projects && r.Projects.length > 0
            ? `<div class="report-projects">${r.Projects.map(p => `<span class="proj-badge status-${p.Status}">${p.Name}</span>`).join("")}</div>`
            : "";

        const tr = document.createElement("tr");
        tr.className = "table-row";
        tr.innerHTML = `
            <td><b>${r.FullName}</b></td>
            <td>${r.Username}</td>
            <td>${formatShortDate(r.Date)}</td>
            ${showStatus ? `<td>${r.Status === "draft" ? '<span class="draft-badge">טיוטה</span>' : 'פורסם'}</td>` : ''}
            <td class="content-cell"><div class="cell-text structured-content">${renderStructuredContent(r.Content)}</div>${projBadgesTable}</td>
            <td class="content-cell notes-cell"><div class="cell-text">${r.Notes || '<span class="no-note">—</span>'}${r.Notes && r.NotesByFullName ? `<span class="note-by">${r.NotesByFullName}</span>` : ""}</div></td>
            <td>
                <div class="table-actions">
                    ${canEdit ? `<button class="btn btn-secondary btn-sm" onclick="openEditModal(${r.Id})">עריכה</button>` : ''}
                    ${currentUser.role === "developer" && r.Status === "draft" ? `<button class="btn btn-primary btn-sm" onclick="submitDraft(${r.Id})">שלח</button>` : ''}
                    ${currentUser.role === "developer" && r.Status === "draft" ? `<button class="btn btn-danger btn-sm" onclick="deleteDraft(${r.Id})">מחק</button>` : ''}
                    ${canNote ? `<button class="btn btn-secondary btn-sm" onclick="openNotesModal(${r.Id})">הערה</button>` : ''}
                    ${readStatusHtml(r)}
                </div>
            </td>
        `;

        tr.addEventListener("click", e => {
            if (e.target.closest("button")) return;
            tr.classList.toggle("expanded");
        });

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
}

function toggleView() {
    viewMode = viewMode === "cards" ? "table" : "cards";
    document.getElementById("toggleViewBtn").innerText =
        viewMode === "cards" ? "תצוגת טבלה" : "תצוגת כרטיסיות";
    renderReports(Object.values(reportsMap));
}

function toggleWeek() {
    weekMode = !weekMode;
    document.getElementById("weekModeBtn").innerText =
        weekMode ? "תצוגת יום" : "תצוגת שבוע";
    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) exportBtn.innerText = weekMode ? "ייצוא שבוע לExcel" : "ייצוא יום לExcel";
    loadReports();
}

async function submitReport(status = "published") {
    const today = document.getElementById("field-today").value.trim();
    const blockers = document.getElementById("field-blockers").value.trim();
    const tomorrow = document.getElementById("field-tomorrow").value.trim();

    if (!today && !blockers && !tomorrow) return;

    const content = buildContent(today, blockers, tomorrow);
    const projectIds = getCheckedProjectIds("createProjectCheckboxes");

    await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, status, projectIds })
    });

    document.getElementById("field-today").value = "";
    document.getElementById("field-blockers").value = "";
    document.getElementById("field-tomorrow").value = "";
    loadProjectCheckboxes("createProjectCheckboxes");
    showToast(status === "draft" ? "טיוטה נשמרה." : "הדוח נשלח. תודה!");
    loadAttendance();
    loadReports();
}

function exportExcel() {
    const date = document.getElementById("reportDate").value;
    if (!date) return;
    if (weekMode) {
        const { from, to } = getWeekRange(date);
        window.location.href = `/api/reports/export?from=${from}&to=${to}`;
    } else {
        window.location.href = `/api/reports/export?date=${date}`;
    }
}

function exportDay(date) {
    window.location.href = `/api/reports/export?date=${date}`;
}

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 3000);
}

function openNotesModal(id) {
    const r = reportsMap[id];
    document.getElementById("notesContent").value = r.Notes || "";
    document.getElementById("notesModal").dataset.id = id;
    document.getElementById("notesModal").style.display = "flex";
}

function closeNotesModal() {
    document.getElementById("notesModal").style.display = "none";
}

async function acknowledgeReport(id) {
    await fetch(`/api/reports/${id}/acknowledge`, { method: "PATCH" });
    loadReports();
}

async function saveNote() {
    const id = document.getElementById("notesModal").dataset.id;
    const notes = document.getElementById("notesContent").value;

    await fetch(`/api/reports/${id}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes })
    });

    closeNotesModal();
    loadAttendance();
    loadReports();
}

function openEditModal(id) {
    const r = reportsMap[id];
    document.getElementById("editModal").dataset.id = id;
    document.getElementById("editModal").dataset.templateMode = "false";

    const body = document.getElementById("editModalBody");
    const actions = document.getElementById("editActions");

    const parsed = parseTemplate(r.Content);

    if (currentUser.role === "developer" && parsed) {
        document.getElementById("editModal").dataset.templateMode = "true";
        body.innerHTML = `
            <div class="template-field">
                <label class="template-label">מה עשיתי היום</label>
                <textarea id="edit-today">${parsed.today}</textarea>
            </div>
            <div class="template-field">
                <label class="template-label">חסמים</label>
                <textarea id="edit-blockers">${parsed.blockers}</textarea>
            </div>
            <div class="template-field">
                <label class="template-label">מחר</label>
                <textarea id="edit-tomorrow">${parsed.tomorrow}</textarea>
            </div>
            <div class="template-field">
                <label class="template-label">פרויקטים שעבדתי עליהם</label>
                <div id="editProjectCheckboxes" class="project-checkboxes"></div>
            </div>
        `;
        const selectedIds = (r.Projects || []).map(p => p.Id);
        loadProjectCheckboxes("editProjectCheckboxes", selectedIds);
        actions.innerHTML = `
            <button class="btn btn-primary" onclick="saveEdit('published')">שלח</button>
            <button class="btn btn-secondary" onclick="saveEdit('draft')">שמור כטיוטה</button>
        `;
    } else {
        body.innerHTML = `<textarea id="editContent">${r.Content}</textarea>`;
        if (currentUser.role === "developer") {
            actions.innerHTML = `
                <button class="btn btn-primary" onclick="saveEdit('published')">שלח</button>
                <button class="btn btn-secondary" onclick="saveEdit('draft')">שמור כטיוטה</button>
            `;
        } else {
            actions.innerHTML = `<button class="btn btn-primary" onclick="saveEdit()">שמור</button>`;
        }
    }

    document.getElementById("editModal").style.display = "flex";
}

function closeEditModal() {
    document.getElementById("editModal").style.display = "none";
}

async function saveEdit(status) {
    const modal = document.getElementById("editModal");
    const id = modal.dataset.id;
    const isTemplate = modal.dataset.templateMode === "true";

    let content;
    let projectIds;
    if (isTemplate) {
        content = buildContent(
            document.getElementById("edit-today").value.trim(),
            document.getElementById("edit-blockers").value.trim(),
            document.getElementById("edit-tomorrow").value.trim()
        );
        projectIds = getCheckedProjectIds("editProjectCheckboxes");
    } else {
        content = document.getElementById("editContent").value;
    }

    const body = { content };
    if (status) body.status = status;
    if (projectIds !== undefined) body.projectIds = projectIds;

    await fetch(`/api/reports/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    closeEditModal();
    if (status === "published") showToast("הדוח נשלח. תודה!");
    else if (status === "draft") showToast("טיוטה נשמרה.");
    loadAttendance();
    loadReports();
}

async function deleteDraft(id) {
    if (!confirm("למחוק את הטיוטה?")) return;
    await fetch(`/api/reports/${id}`, { method: "DELETE" });
    loadAttendance();
    loadReports();
}

async function submitDraft(id) {
    const r = reportsMap[id];
    await fetch(`/api/reports/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: r.Content, status: "published" })
    });
    showToast("Report submitted. Thank you!");
    loadAttendance();
    loadReports();
}

// --------------------
// PROJECTS
// --------------------
let editingProjectId  = null;
let lastProjectsData  = [];
let expandedProjects  = new Set();

const STATUS_LABELS    = { future: "עתידי", ongoing: "פעיל", closed: "סגור" };
const IMMEDIACY_LABELS = { low: "נמוכה", normal: "רגילה", high: "גבוהה", urgent: "דחוף" };

async function loadProjects() {
    const showClosed = document.getElementById("showClosedProjects").checked ? "1" : "0";
    const res  = await fetch(`/api/projects?showClosed=${showClosed}`);
    const data = await res.json();
    if (!Array.isArray(data)) return;
    lastProjectsData = data;
    renderProjects(data);
}

function sidebarProjectHtml(p) {
    const isExpanded = expandedProjects.has(p.Id);
    const canManage  = currentUser.role === "manager" || currentUser.role === "admin";
    const canDelete  = currentUser.role === "admin";

    return `
        <div class="sp-item imm-border-${p.Immediacy} ${isExpanded ? "expanded" : ""}"
             data-id="${p.Id}" onclick="toggleProjectExpand(${p.Id})">
            <div class="sp-header">
                <span class="sp-name">${p.Name}</span>
                <div class="sp-badges">
                    <span class="proj-badge status-${p.Status}">${STATUS_LABELS[p.Status] || p.Status}</span>
                    <span class="proj-badge imm-${p.Immediacy}">${IMMEDIACY_LABELS[p.Immediacy] || p.Immediacy}</span>
                </div>
            </div>
            ${p.Description ? `<p class="sp-desc">${p.Description}</p>` : ""}
            <div class="sp-expand-content">
                ${canManage ? `
                    <div class="sp-selects" onclick="event.stopPropagation()">
                        <select class="sp-select" onchange="quickUpdateProject(${p.Id},'status',this.value)">
                            <option value="ongoing" ${p.Status==="ongoing"?"selected":""}>פעיל</option>
                            <option value="future"  ${p.Status==="future" ?"selected":""}>עתידי</option>
                            <option value="closed"  ${p.Status==="closed" ?"selected":""}>סגור</option>
                        </select>
                        <select class="sp-select" onchange="quickUpdateProject(${p.Id},'immediacy',this.value)">
                            <option value="urgent" ${p.Immediacy==="urgent"?"selected":""}>דחוף</option>
                            <option value="high"   ${p.Immediacy==="high"  ?"selected":""}>גבוהה</option>
                            <option value="normal" ${p.Immediacy==="normal"?"selected":""}>רגילה</option>
                            <option value="low"    ${p.Immediacy==="low"   ?"selected":""}>נמוכה</option>
                        </select>
                    </div>
                    <div class="sp-actions" onclick="event.stopPropagation()">
                        <button class="btn btn-secondary btn-sm"
                            onclick="openProjectForm(${p.Id});event.stopPropagation()">עריכה</button>
                        ${canDelete ? `<button class="btn btn-danger btn-sm"
                            onclick="deleteProject(${p.Id});event.stopPropagation()">מחק</button>` : ""}
                    </div>
                ` : ""}
            </div>
        </div>
    `;
}

function renderProjects(data) {
    const canManage = currentUser.role === "manager" || currentUser.role === "admin";
    document.getElementById("addProjectBtn").style.display = canManage ? "inline-flex" : "none";

    const urgentItems = data.filter(p =>
        p.Status !== "closed" && (p.Immediacy === "urgent" || p.Immediacy === "high")
    );
    const mainItems = data.filter(p =>
        !(p.Status !== "closed" && (p.Immediacy === "urgent" || p.Immediacy === "high"))
    );

    const urgentSection = document.getElementById("urgentSidebarSection");
    urgentSection.style.display = urgentItems.length ? "block" : "none";
    document.getElementById("urgentSidebarList").innerHTML = urgentItems.map(sidebarProjectHtml).join("");

    document.getElementById("mainSidebarList").innerHTML = mainItems.length
        ? mainItems.map(sidebarProjectHtml).join("")
        : '<p class="empty-state" style="padding:16px 0;font-size:13px;">אין פרויקטים.</p>';
}

function toggleProjectExpand(id) {
    if (expandedProjects.has(id)) expandedProjects.delete(id);
    else expandedProjects.add(id);
    renderProjects(lastProjectsData);
}

async function quickUpdateProject(id, field, value) {
    await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value })
    });
    loadProjects();
}

function openProjectForm(id) {
    editingProjectId = id || null;
    document.getElementById("projectFormTitle").textContent = id ? "עריכת פרויקט" : "פרויקט חדש";
    document.getElementById("projectFormError").textContent = "";

    if (id) {
        const p = lastProjectsData.find(x => x.Id === id);
        if (p) {
            document.getElementById("projectName").value        = p.Name;
            document.getElementById("projectDescription").value = p.Description || "";
            document.getElementById("projectStatus").value      = p.Status;
            document.getElementById("projectImmediacy").value   = p.Immediacy;
        }
    } else {
        document.getElementById("projectName").value        = "";
        document.getElementById("projectDescription").value = "";
        document.getElementById("projectStatus").value      = "ongoing";
        document.getElementById("projectImmediacy").value   = "normal";
    }

    document.getElementById("projectFormModal").style.display = "flex";
}

function closeProjectForm() {
    document.getElementById("projectFormModal").style.display = "none";
    editingProjectId = null;
}

async function saveProject() {
    const name        = document.getElementById("projectName").value.trim();
    const description = document.getElementById("projectDescription").value.trim();
    const status      = document.getElementById("projectStatus").value;
    const immediacy   = document.getElementById("projectImmediacy").value;
    const errEl       = document.getElementById("projectFormError");

    if (!name) { errEl.textContent = "שם הפרויקט נדרש"; return; }

    const url    = editingProjectId ? `/api/projects/${editingProjectId}` : "/api/projects";
    const method = editingProjectId ? "PATCH" : "POST";

    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, status, immediacy })
    });

    if (!res.ok) {
        const err = await res.json();
        errEl.textContent = err.error || "שגיאה";
        return;
    }

    closeProjectForm();
    showToast(editingProjectId ? "הפרויקט עודכן." : "הפרויקט נוסף.");
    loadProjects();
}

async function deleteProject(id) {
    const p = lastProjectsData.find(x => x.Id === id);
    if (!p || !confirm(`למחוק את הפרויקט "${p.Name}"?`)) return;
    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) { showToast("מחיקה נכשלה."); return; }
    expandedProjects.delete(id);
    showToast("הפרויקט נמחק.");
    loadProjects();
}

// --------------------
// USER MANAGEMENT
// --------------------
let editingUserId = null;
let usersMap = {};

async function openUsersModal() {
    document.getElementById("usersModal").style.display = "flex";
    // Show add-user form only for admins
    const addSection = document.getElementById("addUserSection");
    if (addSection) addSection.style.display = currentUser.role === "admin" ? "" : "none";
    await loadUsers();
}

function closeUsersModal() {
    document.getElementById("usersModal").style.display = "none";
}

async function loadUsers() {
    const res = await fetch("/api/users");
    const data = await res.json();
    if (!Array.isArray(data)) return;
    renderUsersTable(data);
}

const ROLE_LABELS = { developer: "מפתח", manager: "מנהל", admin: "אדמין" };

function renderUsersTable(users) {
    usersMap = {};
    users.forEach(u => { usersMap[u.Id] = u; });

    const container = document.getElementById("usersTableContainer");
    if (users.length === 0) {
        container.innerHTML = '<p class="empty-state">אין משתמשים.</p>';
        return;
    }

    const table = document.createElement("table");
    table.className = "report-table users-table";
    table.innerHTML = `
        <thead><tr>
            <th>שם מלא</th>
            <th>שם משתמש</th>
            <th>תפקיד</th>
            <th>סטטוס</th>
            <th></th>
        </tr></thead>
    `;
    const tbody = document.createElement("tbody");

    users.forEach(u => {
        const isSelf = u.Username === currentUser.username;
        const canManage = currentUser.role === "admin" ||
                          (currentUser.role === "manager" && (u.Role === "developer" || isSelf));
        const canDelete = canManage && !isSelf;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><b>${u.FullName}</b></td>
            <td>${u.Username}</td>
            <td>${ROLE_LABELS[u.Role] || u.Role}</td>
            <td>${u.IsActive
                ? '<span class="status-badge active">פעיל</span>'
                : '<span class="status-badge inactive">מושבת</span>'}</td>
            <td>
                <div class="table-actions">
                    ${canManage ? `<button class="btn btn-secondary btn-sm user-edit-btn" data-id="${u.Id}">עריכה</button>` : ""}
                    ${canManage ? `<button class="btn btn-${u.IsActive ? "danger" : "secondary"} btn-sm user-toggle-btn" data-id="${u.Id}" data-active="${u.IsActive}">
                        ${u.IsActive ? "השבת" : "הפעל"}
                    </button>` : ""}
                    ${canDelete ? `<button class="btn btn-danger btn-sm user-delete-btn" data-id="${u.Id}">מחק</button>` : ""}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);

    // Attach events safely (avoids quote-escaping issues)
    container.querySelectorAll(".user-edit-btn").forEach(btn =>
        btn.addEventListener("click", () => openEditUserModal(+btn.dataset.id)));
    container.querySelectorAll(".user-toggle-btn").forEach(btn =>
        btn.addEventListener("click", () => toggleUserActive(+btn.dataset.id, btn.dataset.active === "1")));
    container.querySelectorAll(".user-delete-btn").forEach(btn =>
        btn.addEventListener("click", () => deleteUser(+btn.dataset.id)));
}

function openEditUserModal(id) {
    const u = usersMap[id];
    editingUserId = id;
    document.getElementById("editUserFullName").value = u.FullName;
    document.getElementById("editUserUsername").value = u.Username;
    document.getElementById("editUserRole").value = u.Role;
    document.getElementById("editUserPassword").value = "";
    document.getElementById("editUserError").textContent = "";
    document.getElementById("editUserModal").style.display = "flex";
}

function closeEditUserModal() {
    document.getElementById("editUserModal").style.display = "none";
    editingUserId = null;
}

async function saveUserEdit() {
    const fullName = document.getElementById("editUserFullName").value.trim();
    const username = document.getElementById("editUserUsername").value.trim();
    const role     = document.getElementById("editUserRole").value;
    const password = document.getElementById("editUserPassword").value;

    if (!fullName || !username) {
        document.getElementById("editUserError").textContent = "שם מלא ושם משתמש נדרשים";
        return;
    }

    const body = { fullName, username, role };
    if (password) body.password = password;

    const res = await fetch(`/api/users/${editingUserId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.json();
        document.getElementById("editUserError").textContent = err.error || "שגיאה";
        return;
    }

    closeEditUserModal();
    showToast("המשתמש עודכן.");
    loadUsers();
}

async function deleteUser(id) {
    const u = usersMap[id];
    if (!confirm(`למחוק את המשתמש "${u.FullName}" לצמיתות?\nפעולה זו תמחק גם את כל הדוחות שלו.`)) return;
    const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
    if (!res.ok) {
        showToast("מחיקה נכשלה.");
        return;
    }
    showToast("המשתמש נמחק.");
    loadUsers();
}

async function toggleUserActive(id, currentActive) {
    await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !currentActive })
    });
    showToast(currentActive ? "המשתמש הושבת." : "המשתמש הופעל.");
    loadUsers();
}

async function addUser() {
    const fullName = document.getElementById("newFullName").value.trim();
    const username = document.getElementById("newUsername").value.trim();
    const password = document.getElementById("newPassword").value;
    const role     = document.getElementById("newRole").value;
    const errEl    = document.getElementById("addUserError");

    if (!fullName || !username || !password) {
        errEl.textContent = "יש למלא את כל השדות";
        return;
    }

    const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, username, password, role })
    });

    if (!res.ok) {
        const err = await res.json();
        errEl.textContent = err.error || "שגיאה";
        return;
    }

    errEl.textContent = "";
    document.getElementById("newFullName").value = "";
    document.getElementById("newUsername").value = "";
    document.getElementById("newPassword").value = "";
    showToast("המשתמש נוסף.");
    loadUsers();
}

document.getElementById("username").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
document.getElementById("password").addEventListener("keydown", e => { if (e.key === "Enter") login(); });

const reportDateInput = document.getElementById("reportDate");
reportDateInput.addEventListener("change", () => { loadAttendance(); loadReports(); });
reportDateInput.addEventListener("input", () => { loadAttendance(); loadReports(); });

document.getElementById("searchInput").addEventListener("input", () => {
    renderReports(Object.values(reportsMap));
});

checkLogin();
