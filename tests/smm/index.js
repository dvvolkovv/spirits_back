// Aggregator for all SMM test files. Loaded by ../runner.js as suite 'smm'.
module.exports = {
  ...require('./crypto.unit.test'),
  ...require('./storage.integration.test'),
  ...require('./pricing.integration.test'),
  ...require('./billing.integration.test'),
  ...require('./campaigns.integration.test'),
  ...require('./queues.integration.test'),
  ...require('./render-callback.integration.test'),
  ...require('./scenario-fetch.integration.test'),
};
