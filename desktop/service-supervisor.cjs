const { spawn } = require('node:child_process');

class ServiceSupervisor {
  constructor({ command, args, options, onExit, log = () => {}, spawnProcess = spawn, timeoutMs = 30000 }) {
    Object.assign(this, { command, args, options, onExit, log, spawnProcess, timeoutMs });
    this.stopped = false;
    this.process = null;
  }
  start() {
    if (this.stopped) return Promise.reject(new Error('Search service supervisor is shutting down.'));
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) return Promise.reject(new Error('Search service is already running.'));
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.command, this.args, this.options);
      this.process = child;
      let output = '', errors = '', ready = false, settled = false;
      const fail = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill(); reject(error);
      };
      const timer = setTimeout(() => fail(new Error('The local search service did not start in time.')), this.timeoutMs);
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      child.on('error', error => { this.log({event:'spawn-error', message:error.message}); fail(error); });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const record = {event:'exit', code, signal, intentional:this.stopped, stderr:errors};
        this.log(record);
        if (!ready) { if (!settled) { settled = true; reject(new Error(`Search service exited (${signal || code}). ${errors}`)); } }
        else if (!this.stopped && child === this.process) this.onExit(record);
      });
      child.stdout.on('data', chunk => {
        if (settled) return;
        output = (output + chunk).slice(0, 65536);
        if (!output.includes('\n')) return;
        try {
          const { url } = JSON.parse(output.split('\n')[0]);
          if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Invalid backend URL');
          ready = true; settled = true; clearTimeout(timer);
          this.log({event:'ready', pid:child.pid}); resolve(url);
        } catch (error) { fail(error); }
      });
    });
  }
  async terminateCurrent() {
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 2000);
      child.once('exit', finish); child.kill();
    });
  }
  stop() {
    // An intentional app shutdown must never be mistaken for a service crash.
    this.stopped = true;
    if (this.process) this.process.kill();
  }
}
module.exports = { ServiceSupervisor };
