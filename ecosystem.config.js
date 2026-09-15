module.exports = {
  apps: [
    {
      name: "osh-bot",
      script: "telegramBot/bot.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
    // Uncomment below if you also want to host the Express backend API on the same VPS:
    /*
    {
      name: "osh-api",
      script: "app.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
    },
    */
  ],
};
