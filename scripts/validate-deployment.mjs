// Offline consistency checks; run from the repository root with Node.js 22+.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const lock = JSON.parse(await fs.readFile('source-lock.json', 'utf8'));
const dockerfile = await fs.readFile('Dockerfile', 'utf8');
const modules = await fs.readFile('.gitmodules', 'utf8');
assert.match(lock.commit, /^[a-f0-9]{40}$/);
assert.match(lock.digest, /^sha256:[a-f0-9]{64}$/);
assert.equal(lock.tag, `v${lock.image.split(':').at(-1)}`);
assert.ok(dockerfile.includes(`FROM ${lock.image}@${lock.digest}\n`), 'Docker image differs from source-lock.json');
assert.ok(dockerfile.includes(`com.tromsobyggtre.erp.revision="${lock.commit}"`));
assert.match(dockerfile, /^USER oe:oe$/m, 'Explicit non-root user and group required for the data volume');
assert.ok(modules.includes(`path = ${lock.path}`));
assert.ok(modules.includes(`url = ${lock.repository}`));

const git = process.env.DEPLOY_GIT ?? 'git';
const staged = execFileSync(git, ['ls-files', '--stage', lock.path], {encoding: 'utf8'}).trim();
assert.ok(staged.startsWith(`160000 ${lock.commit} 0\t`), 'ERP submodule commit differs from the locked release');

const document = JSON.parse(await fs.readFile('deploy/northflank.template.json', 'utf8'));
function resolveDefaults(value) {
  if (typeof value === 'string') {
    const argument = /^\$\{args\.([A-Za-z0-9_]+)\}$/.exec(value);
    return argument ? document.arguments[argument[1]] : value;
  }
  if (Array.isArray(value)) return value.map(resolveDefaults);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveDefaults(child)]));
  return value;
}
const template = resolveDefaults(document);
assert.equal(template.apiVersion, 'v1.2');
const nodes = [];
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.kind && value.spec) nodes.push(value);
  for (const child of Object.values(value)) visit(child);
}
visit(template);
for (const kind of ['Project', 'Addon', 'CombinedService', 'SecretGroup', 'Volume']) {
  assert.ok(nodes.some(node => node.kind === kind), `Missing Northflank ${kind}`);
}
const app = nodes.find(node => node.kind === 'CombinedService');
assert.equal(app.spec.deployment.instances, 1, 'The data volume requires one replica');
assert.ok(app.spec.ports.some(port => port.internalPort === 8080 && port.public === false), 'First admin setup must use a private port');
for (const [key, value] of Object.entries({APP_ENV:'production', APP_DEBUG:'false', SEED_DEMO:'false', OE_REGISTRATION_MODE:'closed', OE_DATA_DIR:'/data'})) {
  assert.equal(app.spec.runtimeEnvironment[key], value, `Unsafe or missing ${key}`);
}
assert.ok(!app.spec.runtimeEnvironment.ALLOWED_ORIGINS.includes('*'), 'CORS must list explicit origins');
for (const type of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
  assert.ok(app.spec.healthChecks.some(probe => probe.type === type && probe.path === '/api/health' && probe.port === 8080));
}
const pg = nodes.find(node => node.kind === 'Addon' && node.spec.type === 'postgresql');
assert.ok(pg, 'PostgreSQL is required');
assert.equal(pg.spec.tlsEnabled, true);
assert.equal(pg.spec.externalAccessEnabled, false);
const volume = nodes.find(node => node.kind === 'Volume');
assert.ok(volume.spec.mounts.some(mount => mount.containerMountPath === '/data'));
assert.equal(volume.spec.spec.accessMode, 'ReadWriteOnce');
assert.ok(nodes.indexOf(volume) < nodes.indexOf(app), 'Create the data volume before the first application boot');
assert.ok(app.spec.createOptions.volumesToAttach.includes(`\${refs.${volume.ref}.id}`));
const secrets = nodes.find(node => node.kind === 'SecretGroup');
assert.equal(secrets.spec.secrets.variables.PGSSLMODE, 'require');
assert.ok(secrets.spec.secrets.variables.JWT_SECRET.startsWith('${fn.randomSecret('));
const aliases = secrets.spec.addonDependencies.flatMap(dependency => dependency.keys.flatMap(key => key.aliases));
for (const key of ['OE_DB_HOST', 'OE_DB_PORT', 'OE_DB_USER', 'OE_DB_PASSWORD', 'OE_DB_NAME']) {
  assert.ok(aliases.includes(key), `Missing database connection alias ${key}`);
}
console.log(`Deployment configuration OK: ${lock.tag}, source ${lock.commit.slice(0, 12)}, pinned image, private PostgreSQL and app, persistent /data.`);
