// studio/ecosystem.config.cjs — PM2: рабочий процесс студии роликов (linkeon-studio).
// Расширение .cjs обязательно: в studio/package.json стоит "type":"module",
// и .js здесь читался бы как ESM без module.exports (как у voice-host).
// Ставит и перезапускает deploy.sh, только если рядом есть studio/.env.
module.exports = {
  apps: [
    {
      name: 'linkeon-studio',
      cwd: __dirname,
      // nice 19: съёмка (Chromium) и сборка (Remotion, ffmpeg) грузят процессор,
      // а API и чат на том же сервере важнее. node --import tsx, а не обёртка
      // tsx: pm2 видит сам рабочий процесс — его память и его выход.
      script: '/usr/bin/nice',
      args: ['-n', '19', 'node', '--import', 'tsx', 'src/worker/worker.ts'],
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Падение на старте (нет ключа Google, база недоступна) — не чаще раза в минуту.
      restart_delay: 60000,
      max_memory_restart: '2G',
      // Остановка — сообщением 'shutdown' (stop.ts): SIGINT ловят Playwright и
      // Remotion, убивают браузер и выходят сами — задание бросалось бы. Сигналы
      // детям (Chromium, ffmpeg, esbuild) тоже не рассылаются: они доводят работу.
      shutdown_with_message: true,
      treekill: false,
      // Задание — обычно 1–5 минут; дольше pm2 добьёт процесс, задание вернётся в
      // очередь по истечении аренды, оплаченное не потеряется (animation в базе).
      kill_timeout: 600000,
    },
  ],
};
