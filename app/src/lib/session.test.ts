import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authMode,
  checkCredentials,
  createSessionToken,
  readAuthConfig,
  SESSION_SECONDS,
  verifySessionToken,
} from "./session.ts";

const env = { DASHBOARD_USER: "noc", DASHBOARD_PASSWORD: "correct horse" };
const config = readAuthConfig(env)!;

test("valid token verifies, tampered or expired ones do not", async () => {
  const now = 1_700_000_000_000;
  const token = await createSessionToken(config, now);
  assert.equal(await verifySessionToken(config, token, now + 1000), true);
  assert.equal(await verifySessionToken(config, token, now + (SESSION_SECONDS + 1) * 1000), false);
  const [exp, sig] = token.split(".");
  assert.equal(await verifySessionToken(config, `${Number(exp) + 100000}.${sig}`, now), false);
  assert.equal(await verifySessionToken(config, `${exp}.${sig}x`, now), false);
  assert.equal(await verifySessionToken(config, undefined, now), false);
  assert.equal(await verifySessionToken(config, "garbage", now), false);
});

test("a token signed with another password is rejected", async () => {
  const other = readAuthConfig({ DASHBOARD_USER: "noc", DASHBOARD_PASSWORD: "different" })!;
  const token = await createSessionToken(other);
  assert.equal(await verifySessionToken(config, token), false);
});

test("SESSION_SECRET decouples the signature from the password", async () => {
  const a = readAuthConfig({ ...env, SESSION_SECRET: "s1" })!;
  const b = readAuthConfig({ ...env, DASHBOARD_PASSWORD: "changed", SESSION_SECRET: "s1" })!;
  assert.equal(await verifySessionToken(b, await createSessionToken(a)), true);
});

test("credentials", async () => {
  assert.equal(await checkCredentials(config, "noc", "correct horse"), true);
  assert.equal(await checkCredentials(config, " noc ", "correct horse"), true);
  assert.equal(await checkCredentials(config, "noc", "wrong"), false);
  assert.equal(await checkCredentials(config, "root", "correct horse"), false);
});

test("legacy basic-auth variable names still work", () => {
  const legacy = readAuthConfig({ DASHBOARD_BASIC_AUTH_USER: "u", DASHBOARD_BASIC_AUTH_PASSWORD: "p" });
  assert.equal(legacy?.username, "u");
  assert.equal(readAuthConfig({ DASHBOARD_USER: "u" }), null);
});

test("mode: production without credentials fails closed", () => {
  assert.equal(authMode({ NODE_ENV: "production" }), "misconfigured");
  assert.equal(authMode({ NODE_ENV: "development" }), "open");
  assert.equal(authMode({ NODE_ENV: "production", ...env }), "configured");
});
