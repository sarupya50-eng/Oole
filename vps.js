// VPS adapter: KVM virtual machines through LXD (`lxc launch --vm` uses QEMU/KVM).
// Host needs KVM available (nested virtualization must be on if the host is itself a VPS).
// If you provision through your own panel instead, replace the bodies of these functions.
const { execFile } = require('child_process');
const crypto = require('crypto');

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 180000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));

const lxc = (...args) => run('lxc', args);

async function create({ name, ram, cpu, disk }) {
  const password = crypto.randomBytes(9).toString('base64url');
  await lxc('launch', process.env.VPS_IMAGE || 'ubuntu:22.04', name, '--vm',
    '-c', `limits.memory=${ram}GB`,
    '-c', `limits.cpu=${cpu}`,
    '-d', `root,size=${disk}GB`);
  // VMs take longer to boot; wait for the guest agent, then set the root password
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { await lxc('exec', name, '--', 'true'); ready = true; } catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  if (!ready) throw new Error('VM started but guest agent did not come up');
  await run('sh', ['-c', `echo 'root:${password}' | lxc exec ${name} -- chpasswd`]);
  await lxc('exec', name, '--', 'sed', '-i', 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/', '/etc/ssh/sshd_config').catch(() => {});
  await lxc('exec', name, '--', 'systemctl', 'restart', 'ssh').catch(() => {});
  return { password };
}

// suspend = stop the VM only. Disk and data are untouched.
const stop = (name) => lxc('stop', name, '--force').catch(() => {});
const start = (name) => lxc('start', name);
const restart = (name) => lxc('restart', name, '--force');

// Current memory usage in GB. Change this to disk usage if that is what you limit on.
async function usageGb(name) {
  const out = await lxc('info', name);
  const m = out.match(/Memory \(current\):\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { B: 1 / 1024 ** 3, KIB: 1 / 1024 ** 2, MIB: 1 / 1024, GIB: 1, TIB: 1024 }[m[2].toUpperCase()];
  return n * mult;
}

const deleteVps = (name) => lxc('delete', name, '--force');

module.exports = { create, stop, start, restart, usageGb, deleteVps };
