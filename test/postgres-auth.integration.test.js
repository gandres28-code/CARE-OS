"use strict";

const assert = require("assert");
const { protectCode, verifyCode } = require("../services/auth/credentialService");

(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    console.log("postgres auth integration skipped (TEST_DATABASE_URL no configurada)");
    return;
  }

  process.env.DATABASENEW_URL = connectionString;
  const { initializeDatabase, query, closeDatabase } = require("../db");
  const { findEmployeeByCodePostgres } = require("../services/employeeSyncService");
  const notionId = `credential-test-${Date.now()}`;
  try {
    await initializeDatabase();
    const testPepper = process.env.CODE_PEPPER || "integration-test-pepper-with-32-characters";
    const credential = await protectCode("928441", testPepper);
    await query(`INSERT INTO employees(notion_id,name,normalized_name,code,code_hash,code_lookup,role,active) VALUES($1,'CI Employee','ci employee',NULL,$2,$3,'Cleaner',TRUE)`, [notionId,credential.codeHash,credential.codeLookup]);
    const result = await query(`SELECT code,code_hash FROM employees WHERE notion_id=$1`, [notionId]);
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].code, null);
    assert.strictEqual(await verifyCode("928441", result.rows[0].code_hash, testPepper), true);
    assert.strictEqual(await verifyCode("000000", result.rows[0].code_hash, testPepper), false);
    const authenticated = await findEmployeeByCodePostgres("928441");
    assert.strictEqual(authenticated.name, "CI Employee");
    assert.strictEqual(await findEmployeeByCodePostgres("000000"), null);
    console.log("postgres auth integration tests passed");
  } finally {
    await query(`DELETE FROM employees WHERE notion_id=$1`, [notionId]).catch(() => {});
    await closeDatabase();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
