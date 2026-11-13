const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy-relay.sh'), 'utf8');

describe('relay CLI sandbox write gate', () => {
  it('после обычного suite и до живых файлов запускает настоящую запись', () => {
    const unit = deploy.indexOf('node --test *.test.mjs');
    const live = deploy.indexOf('RELAY_LIVE_CLI_WRITE_TEST=1 node --test sandbox-write-live.test.mjs');
    const liveFiles = deploy.indexOf('\ncd ~/file-agent', unit);

    expect(unit).toBeGreaterThan(-1);
    expect(liveFiles).toBeGreaterThan(unit);
    expect(live).toBeGreaterThan(unit);
    expect(live).toBeLessThan(liveFiles);
  });

  it('README требует тот же живой test после смены runtime и до снятия drain', () => {
    const readme = fs.readFileSync(path.join(root, 'relay-agent', 'README.md'), 'utf8');
    const section = readme.indexOf('## Обязательная проверка записи при смене sandbox runtime');
    const command = readme.indexOf('RELAY_LIVE_CLI_WRITE_TEST=1', section);
    const beforeDrain = readme.indexOf('до снятия drain', section);

    expect(section).toBeGreaterThan(-1);
    expect(command).toBeGreaterThan(section);
    expect(beforeDrain).toBeGreaterThan(section);
  });

  it('live test отправляет prompt и закрывает stdin', () => {
    const source = fs.readFileSync(path.join(root, 'relay-agent', 'sandbox-write-live.test.mjs'), 'utf8');
    const spawned = source.indexOf('child = spawn(CLI, args');
    const stdinEnd = source.indexOf('child.stdin.end(prompt);', spawned);
    const outcome = source.indexOf('const outcome = await new Promise', spawned);

    expect(spawned).toBeGreaterThan(-1);
    expect(stdinEnd).toBeGreaterThan(spawned);
    expect(stdinEnd).toBeLessThan(outcome);
  });
});
