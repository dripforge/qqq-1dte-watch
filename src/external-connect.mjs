import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateHeartbeatSecret } from './external-heartbeat.mjs';

// Read from stdin so the secret never appears in command arguments or logs.
let input = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('Ready for external heartbeat configuration on stdin (input is hidden).\n');
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) throw new Error('External heartbeat input is too large');
  if (input.includes('\n')) break;
}
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
try {
  const checked = validateHeartbeatSecret(JSON.parse(input));
  const folder = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(folder + '/external-keychain', ['put'], {
    input: JSON.stringify(checked), encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
  });
  if (result.status !== 0) throw new Error('Could not store external heartbeat connection');
  process.stdout.write('External heartbeat connection saved in Mac Keychain. Delivery remains unverified until tested.\n');
} catch {
  process.stderr.write('External heartbeat configuration could not be saved.\n'); process.exitCode = 1;
}
