/**
 * In-memory notes. ONE store, one set of rows, one scoping rule.
 *
 * This is a TEACHING fixture: the store is a Map, it dies with the process,
 * and it holds nothing but strings someone typed into the demo. Use a real
 * database in a real service — but keep the SHAPE, because the shape is the
 * lesson.
 *
 * There is deliberately NO separate "certification" store. Certification requires
 * the harness to probe the REAL resource handlers: a service that answers
 * probes from a side channel passes certification and still leaks at runtime,
 * which is precisely the failure the harness exists to catch. So the
 * certification surface and the app surface read these same rows through
 * these same accessors.
 *
 * Every accessor takes its scope as an ARGUMENT rather than trusting a
 * caller-supplied id, which buys the property the harness checks:
 * `getForOwner(company, a, idOwnedByB)` returns undefined, so a foreign id is
 * indistinguishable from a made-up one. A caller cannot learn that another
 * identity's row EXISTS — the leak that a "403 if not yours / 404 if unknown"
 * split quietly creates.
 *
 * Every row has a tenant. The same person may belong to multiple client
 * organizations, so an email-only accessor is not an isolation boundary.
 */
import { randomUUID } from "node:crypto";

const MAX_NOTES_PER_OWNER = 100;

export function createStore() {
  /** @type {Map<string, object>} */
  const notes = new Map();

  const newestFirst = (rows) => rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const owned = (companyId, ownerEmail) =>
    [...notes.values()].filter(
      (note) => note.companyId === companyId && note.ownerEmail === ownerEmail,
    );

  return {
    /** This person's notes inside one tenant. */
    listOwn(companyId, ownerEmail) {
      return newestFirst(owned(companyId, ownerEmail));
    },
    /** Every note in one tenant. The admin plane's read. */
    listTenant(companyId) {
      return newestFirst([...notes.values()].filter((note) => note.companyId === companyId));
    },
    /** Owner-scoped single read. */
    getForOwner(companyId, ownerEmail, id) {
      const note = notes.get(id);
      return note && note.companyId === companyId && note.ownerEmail === ownerEmail
        ? note
        : undefined;
    },
    /** Tenant-scoped single read. */
    getInTenant(companyId, id) {
      const note = notes.get(id);
      return note && note.companyId === companyId ? note : undefined;
    },
    add({ companyId, ownerEmail, title, dept = null }) {
      if (typeof companyId !== "string" || companyId.length === 0) {
        return { ok: false, reason: "scope" };
      }
      if (owned(companyId, ownerEmail).length >= MAX_NOTES_PER_OWNER) {
        return { ok: false, reason: "quota" };
      }
      const note = Object.freeze({
        id: randomUUID(),
        title,
        ownerEmail,
        companyId,
        dept: typeof dept === "string" && dept.length > 0 ? dept : null,
        createdAt: new Date().toISOString(),
      });
      notes.set(note.id, note);
      return { ok: true, note };
    },
    /** Tenant-scoped delete: cannot reach out of the tenant it was given. */
    removeInTenant(companyId, id) {
      const note = this.getInTenant(companyId, id);
      if (!note) return false;
      return notes.delete(id);
    },
  };
}
