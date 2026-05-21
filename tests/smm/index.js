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
  ...require('./subtitle-chunker.unit.test'),
  ...require('./render-e2e.integration.test'),
  ...require('./scenario-generation.integration.test'),
  ...require('./approval.integration.test'),
  ...require('./producer-tools.integration.test'),
  ...require('./time-parser.unit.test'),
  ...require('./premium-billing.integration.test'),
};
