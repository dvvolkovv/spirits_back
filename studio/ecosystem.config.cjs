// studio/ecosystem.config.cjs — PM2: рабочий процесс студии роликов (linkeon-studio).
// Расширение .cjs обязательно: в studio/package.json стоит "type":"module",
// и .js здесь читался бы как ESM без module.exports (как у voice-host).
// Запускает deploy.sh (pm2 startOrReload), только если рядом есть studio/.env.
module.exports = {
  apps: [
    {
      name: 'linkeon-studio',
      cwd: __dirname,
      // nice 19: съёмка (Chromium) и сборка (Remotion, ffmpeg) грузят процессор,
      // а API и чат на том же сервере важнее. Команда — та же, что npm run worker.
      script: '/usr/bin/nice',
      args: ['-n', '19', 'node_modules/.bin/tsx', 'src/worker/worker.ts'],
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Падение на старте (нет ключа Google, база недоступна) — не чаще раза в минуту.
      restart_delay: 60000,
      max_memory_restart: '2G',
      // SIGINT — рабочий процесс доводит текущее задание и выходит (worker.ts);
      // задание — обычно 1–5 минут. Дольше — pm2 добьёт, задание вернётся в
      // очередь по истечении аренды, оплаченное не потеряется (animation в базе).
      kill_timeout: 600000,
    },
  ],
};
