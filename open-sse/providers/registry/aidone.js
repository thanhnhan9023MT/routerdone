export default {
  id: "aidone",
  priority: 45,
  alias: "aidone",
  display: {
    name: "Aidone / LM Studio",
    icon: "hub",
    color: "#6d5dfc",
    textIcon: "AI",
    website: "https://lmstudio.ai",
  },
  category: "apikey",
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "http://127.0.0.1:1234/v1",
    format: "openai",
  },
  serviceKinds: ["llm"],
};
