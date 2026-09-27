"use strict";

const assert = require("assert");
const { assertProductionConfig, validateProductionConfig } = require("../services/auth/productionConfig");

const valid = {
  DATABASENEW_URL:"postgres://example",
  NOTION_API_KEY:"secret_notion",
  NOTION_EMPLOYEES_DATABASE_ID:"employees-id",
  CODE_PEPPER:"a-secure-random-pepper-with-32-characters",
  ALLOWED_ORIGINS:"https://care.example.com",
  NOTION_DATABASE_ID:"00000000000000000000000000000001",
  ALLOW_LEGACY_NAME_LOGIN:"false",
};

assert.strictEqual(validateProductionConfig(valid).ok, true);
assert.strictEqual(validateProductionConfig({...valid,NOTION_DATABASE_ID:"",DATABASE_ID:valid.NOTION_DATABASE_ID}).ok, true);
assert.strictEqual(validateProductionConfig({...valid,NOTION_DATABASE_ID:"",DATABASE_ID:""}).ok, false);
assert.strictEqual(validateProductionConfig({...valid,CODE_PEPPER:"short"}).ok, false);
assert.strictEqual(validateProductionConfig({...valid,ALLOWED_ORIGINS:"http://care.example.com/path"}).ok, false);
assert.strictEqual(validateProductionConfig({...valid,ALLOW_LEGACY_NAME_LOGIN:"true"}).ok, false);
assert.throws(() => assertProductionConfig({}), /Configuración de producción inválida/);

console.log("production config tests passed");
