// Kill any existing process on port 8080 and restart the server
const { execSync, spawn } = require('child_process');
const config = require('./config.json');
const port = config.port || 8080;

try {
  // Find and kill process on port
  const result = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTEN"`, { encoding: 'utf8' });
  const pid = result.trim().split(/\s+/).pop();
  if (pid && pid !== '0') {
    console.log(`Killing PID ${pid} on port ${port}...`);
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
  }
} catch {
  // No process on port, that's fine
}

// Start server
console.log('Starting server...');
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  detached: true,
});
child.unref();
setTimeout(() => process.exit(0), 1000);
