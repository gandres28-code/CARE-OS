"use strict";

const crypto = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(crypto.scrypt);
const HASH_PREFIX = "scrypt-v1";
const KEY_LENGTH = 64;

function normalizeCode(value) {
  return String(value || "").trim();
}

function credentialPepper(explicitPepper) {
  const value = String(
    explicitPepper || process.env.CODE_PEPPER || process.env.SESSION_SECRET || ""
  );
  if (!value) throw new Error("Falta CODE_PEPPER para proteger los códigos de acceso.");
  if (process.env.NODE_ENV === "production" && value.length < 32) {
    throw new Error("CODE_PEPPER debe tener al menos 32 caracteres en producción.");
  }
  return value;
}

function codeLookup(code, pepper) {
  const cleanCode = normalizeCode(code);
  if (!cleanCode) return "";
  return crypto
    .createHmac("sha256", credentialPepper(pepper))
    .update(cleanCode, "utf8")
    .digest("hex");
}

async function hashCode(code, pepper) {
  const cleanCode = normalizeCode(code);
  if (!cleanCode) throw new Error("El código de acceso no puede estar vacío.");
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(`${credentialPepper(pepper)}:${cleanCode}`, salt, KEY_LENGTH);
  return `${HASH_PREFIX}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyCode(code, encodedHash, pepper) {
  const cleanCode = normalizeCode(code);
  const parts = String(encodedHash || "").split("$");
  if (!cleanCode || parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(parts[2], "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = await scryptAsync(`${credentialPepper(pepper)}:${cleanCode}`, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}

async function protectCode(code, pepper) {
  const cleanCode = normalizeCode(code);
  return {
    codeHash: await hashCode(cleanCode, pepper),
    codeLookup: codeLookup(cleanCode, pepper),
  };
}

module.exports = { codeLookup, hashCode, normalizeCode, protectCode, verifyCode };
