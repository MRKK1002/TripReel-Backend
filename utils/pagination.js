function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPagination(query = {}, defaultLimit = 20) {
  const page = Math.max(1, toPositiveInteger(query.page, 1));
  const safeDefault = Math.min(100, Math.max(1, toPositiveInteger(defaultLimit, 20)));
  const limit = Math.min(100, Math.max(1, toPositiveInteger(query.limit, safeDefault)));
  return { page, limit, skip: (page - 1) * limit };
}

function paginationMeta(total, page, limit) {
  const safeTotal = Math.max(0, Number(total) || 0);
  return {
    total: safeTotal,
    page,
    limit,
    totalPages: safeTotal === 0 ? 0 : Math.ceil(safeTotal / limit),
  };
}

module.exports = { getPagination, paginationMeta };
