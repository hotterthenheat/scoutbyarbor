module.exports = {
  apps: [
    {
      name: 'scout',
      script: 'npm',
      args: 'start',
      
      // Node.js on a Raspberry Pi should run lightly. 
      // If a memory leak occurs over weeks, restart gracefully before freezing the Pi.
      max_memory_restart: '500M',
      
      // Restart the app if it crashes, but don't spin-loop if it keeps failing instantly
      exp_backoff_restart_delay: 100,
      
      // PM2 Logging Strategy
      // Keep logs reasonably sized to prevent the Raspberry Pi SD card from filling up
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Environment
      env: {
        NODE_ENV: 'production',
        SCOUT_PORT: 8080
      }
    }
  ]
};
