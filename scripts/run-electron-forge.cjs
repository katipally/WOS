const { spawn } = require('node:child_process');

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/run-electron-forge.cjs <forge-args...>');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn('electron-forge', args, {
  stdio: 'inherit',
  shell: true,
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});