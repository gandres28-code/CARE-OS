"use strict";

const assert = require("assert");
const { codeLookup, hashCode, protectCode, verifyCode } = require("../services/auth/credentialService");

(async () => {
  const pepper = "test-only-pepper-with-more-than-32-characters";
  const code = "417829";
  const first = await protectCode(code, pepper);
  const secondHash = await hashCode(code, pepper);

  assert.notStrictEqual(first.codeHash, code);
  assert.notStrictEqual(first.codeLookup, code);
  assert.notStrictEqual(first.codeHash, secondHash, "scrypt debe usar una sal diferente");
  assert.strictEqual(first.codeLookup, codeLookup(code, pepper));
  assert.strictEqual(await verifyCode(code, first.codeHash, pepper), true);
  assert.strictEqual(await verifyCode("incorrecto", first.codeHash, pepper), false);
  assert.strictEqual(await verifyCode(code, "hash-invalido", pepper), false);
  assert.strictEqual(codeLookup("", pepper), "");

  console.log("credential service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
