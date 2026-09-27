const { Client } = require("@notionhq/client");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const dayjs = require("dayjs");

const notion = new Client({
  auth: process.env.NOTION_TOKEN || process.env.NOTION_API_KEY,
});

function getText(page, propertyName) {
  const prop = page.properties[propertyName];

  if (!prop) return "";

  if (prop.title) return prop.title.map((t) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join("");
  if (prop.select) return prop.select.name || "";
  if (prop.status) return prop.status.name || "";
  if (prop.date) return prop.date.start || "";
  if (prop.number !== null && prop.number !== undefined) return String(prop.number);
  if (prop.checkbox !== undefined) return prop.checkbox ? "Yes" : "No";

  return "";
}

function formatTime(value) {
  if (!value) return "N/A";
  return dayjs(value).format("hh:mm A");
}

function normalizeUnit(unit) {
  return String(unit || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function normalizePersonName(name) {
  const clean = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const map = {
    steve: "Steve Soto",
    "steve soto": "Steve Soto",
    yoel: "Yoel",
    brenda: "Brenda",
    carolina: "Carolina",
  };

  if (map[clean]) return map[clean];

  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function isDoneAction(action) {
  const a = String(action || "").toLowerCase();
  return a === "done" || a.includes("done") || a.includes("terminada") || a.includes("terminado");
}

function isIssueAction(action, category) {
  const a = String(action || "").toLowerCase();
  const c = String(category || "").toLowerCase();

  return (
    a.includes("issue") ||
    a.includes("problem") ||
    a.includes("problema") ||
    a.includes("report") ||
    c.includes("issue") ||
    c.includes("problem") ||
    c.includes("problema") ||
    c.includes("maintenance") ||
    c.includes("damage")
  );
}

function isCleanerError(action, category, cleanerError) {
  const a = String(action || "").toLowerCase();
  const c = String(category || "").toLowerCase();
  const e = String(cleanerError || "").toLowerCase().trim();

  if (!a.includes("inspection_report")) return false;

  if (
    e === "yes" ||
    e === "true" ||
    e === "si" ||
    e === "sí"
  ) {
    return true;
  }

  return (
    c.includes("cleaning") ||
    c.includes("cleaner") ||
    c.includes("limpieza")
  );
}

async function getDailyLogs(date) {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_DAILY_CLEANING_LOGS_DB_ID,
    filter: {
      property: "date",
      date: {
        equals: date,
      },
    },
    sorts: [
      {
        property: "time",
        direction: "ascending",
      },
    ],
  });

  return response.results;
}
console.log("USANDO NUEVA VERSION DEL REPORTE");

async function generateDailyReport(date = dayjs().format("YYYY-MM-DD")) {
  const logs = await getDailyLogs(date);

  const fileName = `daily-housekeeping-report-${date}.pdf`;
  const doc = new PDFDocument({ margin: 50 });

  doc.pipe(fs.createWriteStream(fileName));

  const allUnits = new Set();
  const completedUnits = new Set();
  const cleaners = new Set();
  const inspectors = new Set();

  const productivity = {};
  const issuesByUnit = {};
  const errorsByCleaner = {};

  let issues = 0;
  let cleanerErrors = 0;
  let highPriority = 0;

  logs.forEach((log) => {
    const unitRaw = getText(log, "unit");
    const unit = normalizeUnit(unitRaw);

    const cleanerRaw = getText(log, "cleaner");
    const inspectorRaw = getText(log, "inspector");

    const cleaner = normalizePersonName(cleanerRaw);
    const inspector = normalizePersonName(inspectorRaw);

    const action = getText(log, "action");
    const category = getText(log, "category");
    const priority = getText(log, "priority");
    const cleanerError = getText(log, "cleaner error");

    const priorityLower = priority.toLowerCase();

    if (unit) allUnits.add(unit);
    if (cleaner) cleaners.add(cleaner);
    if (inspector) inspectors.add(inspector);

    if (isDoneAction(action) && cleaner && unit) {
      const unitCleanerKey = `${cleaner}__${unit}`;

      if (!completedUnits.has(unitCleanerKey)) {
        completedUnits.add(unitCleanerKey);
        productivity[cleaner] = (productivity[cleaner] || 0) + 1;
      }
    }

    if (isIssueAction(action, category)) {
      issues++;
      if (unit) issuesByUnit[unit] = (issuesByUnit[unit] || 0) + 1;
    }

    if (isCleanerError(action, category, cleanerError)) {
      cleanerErrors++;

      const cleanerName = cleaner || "Unknown";
      errorsByCleaner[cleanerName] = (errorsByCleaner[cleanerName] || 0) + 1;
    }

    if (
      priorityLower.includes("high") ||
      priorityLower.includes("urgent") ||
      priorityLower.includes("alta") ||
      priorityLower.includes("urgente")
    ) {
      highPriority++;
    }
  });

  const completedUnitCount = Object.values(productivity).reduce(
    (sum, count) => sum + count,
    0
  );

  doc.fontSize(16).text("DAILY REPORT", {
    align: "center",
  });

  doc.moveDown(0.5);
  doc.fontSize(9).text(`Date: ${date}`);
  doc.text(`Company: ${process.env.COMPANY_NAME || "Care Luxury Cleaning"}`);

  doc.moveDown();

  doc.fontSize(12).text("1. Executive Summary");
  doc.moveDown(0.4);
  doc.fontSize(9).text(`Total Activity Logs: ${logs.length}`);
  doc.text(`Total Units Registered: ${allUnits.size}`);
  doc.text(`Completed Units: ${completedUnitCount}`);
  doc.text(`Issues Reported: ${issues}`);
  doc.text(`High Priority Records: ${highPriority}`);
  doc.text(`Active Cleaners: ${cleaners.size}`);
  doc.text(`Active Inspectors: ${inspectors.size}`);

  if (cleanerErrors > 0) {
    doc.text(`Cleaner Errors: ${cleanerErrors}`);
  } else {
    doc.text("Cleaner Errors: 0");
  }

  doc.moveDown();

  doc.fontSize(12).text("2. Productivity by Cleaner");
  doc.moveDown(0.4);

  if (Object.keys(productivity).length === 0) {
    doc.fontSize(9).text("No completed cleaning records found.");
  } else {
    Object.entries(productivity)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cleaner, count], index) => {
        doc.fontSize(9).text(`${index + 1}. ${cleaner}: ${count} completed unit(s)`);
      });
  }

  doc.moveDown();

  doc.fontSize(12).text("3. Issues Summary");
  doc.moveDown(0.4);

  doc.fontSize(9).text("Issues by Unit:");

  if (Object.keys(issuesByUnit).length === 0) {
    doc.text("No issues reported.");
  } else {
    Object.entries(issuesByUnit)
      .sort((a, b) => b[1] - a[1])
      .forEach(([unit, count]) => {
        doc.text(`Unit ${unit}: ${count} issue(s)`);
      });
  }

  doc.moveDown(0.5);
  doc.fontSize(12).text("4. Cleaner Errors");
  doc.moveDown(0.4);

  if (Object.keys(errorsByCleaner).length === 0) {
    doc.fontSize(9).text("No cleaner errors reported.");
  } else {
    Object.entries(errorsByCleaner)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cleaner, count]) => {
        doc.fontSize(9).text(`${cleaner}: ${count} error(s)`);
      });
  }

  doc.addPage();

  doc.fontSize(13).text("5. Activity Ledger", {
    align: "center",
  });

  doc.moveDown();

  logs.forEach((log, index) => {
    const logTitle = getText(log, "log");
    const time = getText(log, "time");
    const unit = getText(log, "unit");
    const cleaner = normalizePersonName(getText(log, "cleaner"));
    const action = getText(log, "action");
    const note = getText(log, "note");
    const inspector = normalizePersonName(getText(log, "inspector"));
    const category = getText(log, "category");
    const priority = getText(log, "priority");
    const status = getText(log, "status");
    const cleanerError = getText(log, "cleaner error");

    doc.fontSize(8.5).text(
      `${index + 1}. ${formatTime(time)} | Unit: ${unit || "N/A"} | ${action || "N/A"}`
    );

    if (logTitle) doc.text(`Log: ${logTitle}`);
    if (cleaner) doc.text(`Cleaner: ${cleaner}`);
    if (inspector) doc.text(`Inspector: ${inspector}`);
    if (category) doc.text(`Category: ${category}`);
    if (priority) doc.text(`Priority: ${priority}`);
    if (status) doc.text(`Status: ${status}`);

    if (isCleanerError(action, category, cleanerError)) {
      doc.text(`Cleaner Error: Yes`);
    }

    if (note) {
      doc.text(`Note: ${note}`);
    }

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.4);
  });

  doc.end();

  return fileName;
}

module.exports = {
  generateDailyReport,
};
