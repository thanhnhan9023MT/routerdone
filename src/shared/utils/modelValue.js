export function normalizeLiveModelValue(modelId, alias, { forceAliasPrefix = false } = {}) {
  const normalizedModelId = String(modelId || "");
  const normalizedAlias = String(alias || "");

  if (!normalizedModelId) return "";
  if (!normalizedAlias) return normalizedModelId;
  if (normalizedModelId === normalizedAlias || normalizedModelId.startsWith(`${normalizedAlias}/`)) {
    return normalizedModelId;
  }

  if (forceAliasPrefix) return `${normalizedAlias}/${normalizedModelId}`;
  return normalizedModelId.includes("/") ? normalizedModelId : `${normalizedAlias}/${normalizedModelId}`;
}
