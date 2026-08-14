const AuditLog = require("../models/AuditLog");

/**
 * Write an immutable audit-log entry. Fire-and-forget — never blocks or throws.
 *
 * @param {object} opts
 * @param {string} opts.action           - one of the AuditLog enum values
 * @param {object} [opts.actor]          - { id, type, name }
 * @param {object} [opts.target]         - { type, id, ref }
 * @param {object} [opts.details]        - freeform context (amounts, reasons, etc.)
 * @param {string} [opts.ip]             - request IP (admin actions)
 */
function log({ action, actor = {}, target = {}, details = {}, ip = "" }) {
  try {
    AuditLog.create({
      action,
      actorId: actor.id || undefined,
      actorType: actor.type || "system",
      actorName: actor.name || "",
      targetType: target.type || "other",
      targetId: target.id || undefined,
      targetRef: target.ref || "",
      details,
      ip,
    }).catch((e) => console.warn("[audit] write failed:", e.message));
  } catch (e) {
    console.warn("[audit] error:", e.message);
  }
}

module.exports = { log };
