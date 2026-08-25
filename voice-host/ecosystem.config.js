// voice-host/ecosystem.config.js — PM2 config for linkeon-voice-host
module.exports = {
  apps: [
    {
      name: 'linkeon-voice-host',
      cwd: __dirname,
      script: 'dist/agent.js',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      // Драйн: воркер должен успеть довести живые звонки и отправить
      // complete-коллбэки. Рестарт посреди разговора убивает ответ молча.
      kill_timeout: 600000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
