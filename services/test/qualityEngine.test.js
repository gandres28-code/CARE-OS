const assert = require("assert");
const { summarizeIssues, calculateScores } = require("../intelligence/qualityEngine");

const summary = summarizeIssues([
  { label: "Duvet manchado", severity: "critical", category: "Beds" },
  { label: "Piso mal trapeado", severity: "major", category: "Floors" },
  { label: "Cafetera sucia", severity: "medium", category: "Kitchen" },
  { label: "Cojines mal acomodados", severity: "minor", category: "Presentation" },
]);
assert.deepStrictEqual(
  { critical: summary.critical, major: summary.major, medium: summary.medium, minor: summary.minor, total: summary.total },
  { critical: 1, major: 1, medium: 1, minor: 1, total: 4 }
);

const strong = calculateScores({ overallScore: 98, cleanTime: 35, expectedTime: 40, issues: [], firstPass: true });
assert(strong.overallScore >= 95);
assert.strictEqual(strong.efficiencyScore, 100);

const weak = calculateScores({ overallScore: 90, cleanTime: 70, expectedTime: 40, issues: [{ severity: "critical" }], firstPass: false });
assert(weak.qualityScore < strong.qualityScore);
assert(weak.efficiencyScore < strong.efficiencyScore);
assert(weak.overallScore < strong.overallScore);

console.log("qualityEngine tests passed");
