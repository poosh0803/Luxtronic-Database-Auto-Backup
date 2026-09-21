// PM2 process configuration
// Usage: pm2 start ecosystem.config.cjs [--env production]
module.exports = {
  apps: [
    {
      name: 'luxtronic-db-backup',
      script: 'app.js',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
