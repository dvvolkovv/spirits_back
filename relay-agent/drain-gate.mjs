import fs from "node:fs";

export function createDrainGate({
  drainPath = process.env.RELAY_DRAIN_FILE || "/tmp/linkeon-relay-drain",
} = {}) {
  return function drainGate(req, res, next) {
    if (fs.existsSync(drainPath)) {
      return res.status(503).json({ error: "relay_draining" });
    }
    return next();
  };
}
