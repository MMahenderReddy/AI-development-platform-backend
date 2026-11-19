/**
 * PM2 ecosystem file — AI Development Orchestrator (production)
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup  (then run the printed command as root to auto-start on reboot)
 */
module.exports = {
  apps: [
    {
      name: "orch-api",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-analysis",
      script: "src/workers/analysis.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-codegen",
      script: "src/workers/codegen.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-quality-gate",
      script: "src/workers/qualityGate.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-push",
      script: "src/workers/push.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-pr-poll",
      script: "src/workers/prPoll.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-pms-sync",
      script: "src/workers/pmsSync.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-rework",
      script: "src/workers/rework.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-integration",
      script: "src/workers/integration.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-task-assignment",
      script: "src/workers/taskAssignment.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-reanalysis",
      script: "src/workers/reanalysis.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-code-review",
      script: "src/workers/codeReview.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-daily-scheduler",
      script: "src/workers/dailyScheduler.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
    {
      name: "orch-deploy",
      script: "src/workers/deploy.worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--experimental-vm-modules",
      env_production: { NODE_ENV: "production" },
    },
  ],
};
