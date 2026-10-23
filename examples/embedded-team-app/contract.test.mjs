/**
 * Contract parity: this app against what XRAY Workspace actually sends.
 *
 * The other test files check this app against its own rules. This one checks
 * it against the Workspace: `contract/workspace-v1.json` holds tokens minted by
 * the Workspace's real minter, its real embed message names and theme
 * vocabulary, and the theme messages its real stylesheet produces, and
 * `contract/manifest.schema.json` is its real registration schema. If the
 * Workspace changes any of them, the files are regenerated and a drift fails
 * here, before it fails in a frame.
 *
 * Run: `npm run test:embedded`
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { MAX_TOKEN_TTL_SECONDS, WORKSPACE_TOKEN_ISSUER, verifyIdentityToken } from "./identity-token.mjs";
import {
  EMBED_MESSAGE,
  THEME_COLOR_PATTERN,
  THEME_FONT_ALLOWLIST,
  THEME_RADIUS_PATTERN,
  THEME_TOKEN_NAMES,
  acceptThemeMessage,
  acceptTokenMessage,
  readyMessage,
} from "./public/protocol.mjs";
import { buildManifest } from "./server.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const vectors = readJson("../../contract/workspace-v1.json");
const manifestSchema = readJson("../../contract/manifest.schema.json");

const { identityToken, embed } = vectors;
const WORKSPACE = "https://workspace.example.test";

const verify = (token) =>
  verifyIdentityToken(token, {
    secrets: [identityToken.vectorKey],
    audience: identityToken.audience,
    now: identityToken.now,
  });

test("the issuer and lifetime ceiling are the Workspace's", () => {
  assert.equal(WORKSPACE_TOKEN_ISSUER, identityToken.issuer);
  assert.equal(MAX_TOKEN_TTL_SECONDS, identityToken.maxTtlSeconds);
});

for (const vector of identityToken.cases) {
  test(`identity token: ${vector.name}`, () => {
    const result = verify(vector.token);
    assert.equal(result.ok, vector.valid, JSON.stringify(result));
    if (!vector.valid || !result.ok) return;

    const { identity } = result;
    const want = vector.expect;
    assert.equal(identity.email, want.email);
    assert.equal(identity.companyId, want.companyId);
    assert.equal(identity.tokenOrgRole ?? null, want.tokenOrgRole);
    if (want.expiresAt !== undefined) assert.equal(identity.expiresAt, want.expiresAt);
    assert.equal(identity.tokenPermissions.length, want.tokenPermissionCount);
    if (want.tokenPermissionPrefix) {
      assert.ok(identity.tokenPermissions.every((p) => p.startsWith(want.tokenPermissionPrefix)));
    }
  });
}

test("the embed message names are the Workspace's", () => {
  assert.deepEqual({ ...EMBED_MESSAGE }, embed.messages);
  assert.deepEqual(readyMessage(), { type: embed.messages.ready });
});

test("a token the Workspace posts is accepted by the browser receiver", () => {
  const parentWindow = {};
  const result = acceptTokenMessage(
    {
      origin: WORKSPACE,
      source: parentWindow,
      data: { type: embed.messages.token, token: identityToken.cases[0].token },
    },
    { expectedOrigin: WORKSPACE, parentWindow, selfWindow: {} },
  );
  assert.equal(result.ok, true);
});

test("the theme vocabulary and patterns are the Workspace's", () => {
  assert.deepEqual([...THEME_TOKEN_NAMES], embed.theme.tokens);
  assert.equal(THEME_COLOR_PATTERN.source, embed.theme.colorPattern);
  assert.equal(THEME_RADIUS_PATTERN.source, embed.theme.radiusPattern);
  assert.ok(THEME_FONT_ALLOWLIST.body.includes(embed.theme.fonts.body));
  assert.ok(THEME_FONT_ALLOWLIST.heading.includes(embed.theme.fonts.heading));
});

for (const mode of ["light", "dark"]) {
  test(`the Workspace's real ${mode} theme message is accepted whole`, () => {
    const parentWindow = {};
    const verdict = acceptThemeMessage(
      { origin: WORKSPACE, source: parentWindow, data: embed.theme.sampleMessages[mode] },
      { expectedOrigin: WORKSPACE, parentWindow, selfWindow: {} },
    );
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    if (!verdict.ok) return;
    assert.equal(verdict.theme.mode, mode);
    assert.equal(Object.keys(verdict.theme.tokens).length, embed.theme.tokens.length);
  });
}

test("the manifest passes the Workspace's registration schema", () => {
  const validate = new Ajv2020({ strict: false, useDefaults: true }).compile(manifestSchema);
  const manifest = structuredClone(buildManifest({ slug: identityToken.audience }));
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.service, identityToken.audience);
  assert.equal(manifest.requestedGrants.identity.companyId, true);
  assert.equal(manifest.requestedGrants.identity.access, true);
  assert.equal(manifest.requestedGrants.embed, true);
  assert.equal(manifest.capabilities.embed?.path, "/embed");
  assert.equal(manifest.capabilities.search, true);
  assert.equal(manifest.capabilities.merge, true);
});
