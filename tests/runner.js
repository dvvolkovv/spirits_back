#!/usr/bin/env node
/**
 * Test runner for my.linkeon tests
 * Usage:
 *   node runner.js              # run all suites
 *   node runner.js --suite api  # run specific suite
 */

const args = process.argv.slice(2);
const suiteArg = args.indexOf('--suite');
const targetSuite = suiteArg !== -1 ? args[suiteArg + 1] : null;

const suites = {
  api: require('./api.test'),
  db: require('./db.test'),
  e2e: require('./e2e.test'),
};

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const NETWORK_ERRORS = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'timeout'];

function isNetworkError(err) {
  return NETWORK_ERRORS.some(e => err.message.includes(e) || err.code === e);
}

async function runWithRetry(fn, retries = 2, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isNetworkError(err) && attempt <= retries) {
        process.stdout.write(` [retry ${attempt}]`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

async function runSuite(name, suite) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUITE: ${name}`);
  console.log('='.repeat(60));

  for (const [testName, testFn] of Object.entries(suite)) {
    if (typeof testFn !== 'function') continue;
    process.stdout.write(`  ${testName} ... `);
    try {
      await runWithRetry(testFn);
      console.log('✓ PASS');
      passed++;
    } catch (err) {
      console.log(`✗ FAIL: ${err.message}`);
      failed++;
      failures.push({ suite: name, test: testName, error: err.message });
    }
  }
}

async function main() {
  const startTime = Date.now();

  const suitesToRun = targetSuite
    ? { [targetSuite]: suites[targetSuite] }
    : suites;

  if (targetSuite && !suites[targetSuite]) {
    console.error(`Unknown suite: ${targetSuite}. Available: ${Object.keys(suites).join(', ')}`);
    process.exit(1);
  }

  for (const [name, suite] of Object.entries(suitesToRun)) {
    await runSuite(name, suite);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped (${elapsed}s)`);

  if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach(f => {
      console.log(`  [${f.suite}] ${f.test}`);
      console.log(`    ${f.error}`);
    });
  }

  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Runner error:', err);
  process.exit(1);
});
