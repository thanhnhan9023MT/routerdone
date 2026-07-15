import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels, getProviderConnections } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS, PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    const customModels = await getCustomModels();
    const connections = await getProviderConnections();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          alias: modelAliases[fullModel] || m.model,
          caps: { vision: c.vision, search: c.search, reasoning: c.reasoning },
        };
      });

    const providerIdByAlias = Object.fromEntries(Object.entries(PROVIDER_ID_TO_ALIAS || {}).map(([id, alias]) => [alias, id]));
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS || {})) {
      for (const item of providerModels || []) {
        const modelId = item?.id || item?.model;
        if (!modelId) continue;
        const fullModel = `${alias}/${modelId}`;
        const disabledList = disabled[alias] || disabled[providerIdByAlias[alias]] || [];
        if (disabledList.includes(modelId) || models.some((m) => m.fullModel === fullModel)) continue;
        const c = getCapabilitiesForModel(providerIdByAlias[alias] || alias, modelId);
        models.push({ provider: alias, model: modelId, fullModel, alias: modelAliases[fullModel] || item.name || modelId, caps: { vision: c.vision, search: c.search, reasoning: c.reasoning } });
      }
    }
    for (const conn of connections || []) {
      const prefix = conn?.providerSpecificData?.prefix || conn?.provider;
      if (!prefix || !Array.isArray(conn?.models)) continue;
      for (const id of conn.models) {
        const fullModel = `${prefix}/${String(id).trim()}`;
        if (!id || seen.has(fullModel)) continue;
        seen.add(fullModel);
        models.push({ provider: prefix, model: id, fullModel, alias: id, caps: {} });
      }
    }
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
