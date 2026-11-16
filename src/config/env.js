import "dotenv/config";
import { readFileSync } from "fs";

const required = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
};

const optional = (key, fallback) => process.env[key] ?? fallback;

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

let githubPrivateKey = null;
const keyPath = optional("GITHUB_APP_PRIVATE_KEY_PATH", "");
if (keyPath) {
  try {
    githubPrivateKey = readFileSync(keyPath, "utf8");
  } catch {
    // Key file not present during development — GitHub features will be unavailable
  }
}

export default {
  port: Number(optional("PORT", "4564")),
  isProd: optional("NODE_ENV", "development") === "production",
  nodeEnv: optional("NODE_ENV", "development"),

  mongoUri: required("MONGODB_URI"),
  redisUrl: optional("REDIS_URL", "redis://localhost:6379"),

  jwtSecret,
  jwtExpiresIn: optional("JWT_EXPIRES_IN", "8h"),

  corsOrigins: optional("CORS_ORIGIN", "http://localhost:3416").split(",").map((s) => s.trim()),

  pms: {
    apiUrl: optional("PMS_API_URL", "http://localhost:4563"),
    serviceEmail: optional("PMS_SERVICE_EMAIL", ""),
    servicePassword: optional("PMS_SERVICE_PASSWORD", ""),
  },

  github: {
    appId: optional("GITHUB_APP_ID", ""),
    privateKey: githubPrivateKey,
    installationId: optional("GITHUB_APP_INSTALLATION_ID", ""),
    isConfigured: () => !!(optional("GITHUB_APP_ID", "") && githubPrivateKey && optional("GITHUB_APP_INSTALLATION_ID", "")),
  },

  openai: {
    apiKey: optional("OPENAI_API_KEY", ""),
    baseUrl: optional("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    model: optional("OPENAI_MODEL", "gpt-4o"),
    embeddingModel: optional("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    maxTokens: Number(optional("OPENAI_MAX_TOKENS", "4096")),
    temperature: Number(optional("OPENAI_TEMPERATURE", "0.2")),
    isConfigured: () => !!optional("OPENAI_API_KEY", ""),
  },

  sandbox: {
    jobTimeoutMs: Number(optional("ORCHESTRATOR_JOB_TIMEOUT_MS", "600000")),
    workspaceDir: optional("ORCHESTRATOR_WORKSPACE_DIR", "./workspaces"),
  },

  stagger: {
    taskMs: Number(optional("TASK_STAGGER_MS", "30000")),
    githubOpMs: Number(optional("GITHUB_OP_DELAY_MS", "10000")),
  },

  qualityGate: {
    lint:       optional("QUALITY_GATE_LINT",  "true") === "true",
    test:       optional("QUALITY_GATE_TEST",  "true") === "true",
    build:      optional("QUALITY_GATE_BUILD", "true") === "true",
    timeoutMs:  Number(optional("QUALITY_GATE_TIMEOUT_MS", "120000")),
  },
};
