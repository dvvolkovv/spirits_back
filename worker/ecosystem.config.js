// worker/ecosystem.config.js — PM2 config for linkeon-smm-worker
module.exports = {
  apps: [{
    name: 'linkeon-smm-worker',
    script: 'dist/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',
    watch: false,
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
    },
    error_file: '~/.pm2/logs/linkeon-smm-worker-error.log',
    out_file: '~/.pm2/logs/linkeon-smm-worker-out.log',
    merge_logs: true,
  }],
};
