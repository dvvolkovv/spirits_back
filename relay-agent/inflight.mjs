export function createInflight() {
  let active = 0;
  return {
    middleware(req, res, next) {
      active++;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        active--;
      };
      res.on("finish", done);
      res.on("close", done);
      next();
    },
    count() {
      return active;
    },
  };
}
