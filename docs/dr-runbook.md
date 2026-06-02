# Disaster Recovery Runbook — my.linkeon.io → node-3

DR target node: **node-3** (`5.45.115.22`, WG `10.10.0.3`, hostname `linkeon-node3`).
Transport: WireGuard mesh, prod `10.10.0.1` ↔ node-3 `10.10.0.3`.

Prod is single-node (`212.113.106.202`). node-3 holds a near-real-time copy of
every stateful store so a prod loss is recoverable. Failover is **manual** (no
auto-promote / patroni) — this runbook is the manual procedure.

## What's replicated, and the RPO of each

| Store | Mechanism | RPO | Monitor endpoint | Alert |
|-------|-----------|-----|------------------|-------|
| PostgreSQL (`linkeon`) | streaming replication, slot `node3_dr` | seconds | `/admin/monitoring/tech/replication` | hourly TG if lag > 60s / not streaming / slot lost |
| Neo4j | nightly `neo4j.dump.gz` rsync (in `backup.sh` step 4.5) | ≤24h | `/admin/monitoring/tech/neo4j-dr` | hourly TG if md5 mismatch / >48h / unreachable |
| MinIO (SMM media) | hourly `mc mirror` (`minio-mirror.sh`, cron `20 * * * *`) | ≤1h | `/admin/monitoring/tech/minio-dr` | hourly TG if stale / bucket behind / mc errors |

All three are surfaced together in the admin UI under **Инфра** (MonitoringInfraView).

## Health & drill — check before and after any recovery

Non-destructive smoke-test (safe to run anytime), verifies node-3 actually holds
recoverable data for all three stores:

```bash
ssh dvolkov@212.113.106.202 /home/dvolkov/backups/linkeon/dr-restore-test.sh
# add FULL_NEO4J_DRILL=1 to also load the neo4j dump into a throwaway
# container on node-3 and count nodes (pulls neo4j:5 the first time)
```

`PASS` ⇒ standby is current, a sample MinIO object matches, and the neo4j dump
is intact (or fully loads, with the flag).

---

## 1. PostgreSQL — promote node-3 standby

node-3 runs the standby in Docker container `postgres-standby` (`10.10.0.3:5433`),
consuming WAL through slot `node3_dr`. It is a hot standby (read-only) until promoted.

**Promote (point of no return — only when prod PG is truly gone):**

```bash
ssh dvolkov@10.10.0.3            # or dvolkov@5.45.115.22
docker exec postgres-standby pg_ctl promote -D /var/lib/postgresql/data
# verify it left recovery:
docker exec postgres-standby psql -U linkeon -d linkeon -c "SELECT pg_is_in_recovery()"   # expect f
```

**Repoint the app** at the promoted DB: set `DATABASE_URL` in
`~/spirits_back/.env` to `postgresql://linkeon:<pw>@10.10.0.3:5433/linkeon`
(from wherever the api now runs) and restart `linkeon-api`. If the api itself
moved off the dead prod host, deploy it to a surviving host first.

> After promotion the old slot is meaningless. When rebuilding prod, re-seed it
> from a fresh `pg_basebackup` off the (now-primary) node-3 and reverse the
> direction, or rebuild the standby relationship from scratch.

## 2. Neo4j — restore from node-3 dump

node-3 holds `/var/lib/linkeon-dr/neo4j/neo4j.dump.gz` (md5-identical to prod's
latest nightly dump; verified by the monitor). To restore into a Neo4j instance:

```bash
# on whatever host will run Neo4j (example: node-3 itself)
cp /var/lib/linkeon-dr/neo4j/neo4j.dump.gz /tmp/ && gunzip /tmp/neo4j.dump.gz
docker run --rm -v /tmp:/dumps -v neo4j_data:/data neo4j:5 \
  neo4j-admin database load neo4j --from-path=/dumps --overwrite-destination=true
docker run -d --name neo4j -p 7687:7687 -p 7474:7474 \
  -v neo4j_data:/data -e NEO4J_AUTH=neo4j/<password> neo4j:5
# sanity:
docker exec neo4j cypher-shell -u neo4j -p <password> "MATCH (n) RETURN count(n)"
```

Then point the api's `NEO4J_URI` / `NEO4J_PASSWORD` at it. RPO is up to 24h — the
graph is rebuilt continuously from chat, so a day's gap self-heals over time.

## 3. MinIO (SMM media) — restore objects from node-3

node-3 runs a MinIO mirror (`10.10.0.3:9000`, data `/var/lib/linkeon-dr/minio`)
holding buckets `linkeon-smm-videos` + `linkeon-smm-music`. The mirror is
`--overwrite` **without `--remove`**, so node-3 holds ≥ everything prod had
(a prod-side wipe does NOT cascade to DR).

```bash
# mc aliases (creds in ~/spirits_back/.env: MINIO_ROOT_USER / MINIO_ROOT_PASSWORD)
mc alias set node3minio http://10.10.0.3:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc alias set newprod    http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
# mirror back into the rebuilt prod MinIO:
mc mirror --overwrite node3minio/linkeon-smm-videos newprod/linkeon-smm-videos
mc mirror --overwrite node3minio/linkeon-smm-music  newprod/linkeon-smm-music
```

If node-3's MinIO is serving directly during an outage, point `MINIO_ENDPOINT`
at `http://10.10.0.3:9000` and restart the api/worker.

---

## Out of scope (known gaps)

- **Auto-failover** — promotion is manual on purpose; no patroni/keepalived.
- **Neo4j streaming** — Community edition can't; daily dump is the best RPO.
- **App tier** — this runbook covers data. Standing the NestJS api back up on a
  surviving host is a separate (git-based) deploy.

## Related

- Backup/restore basics & schedule: `spirits_back/CLAUDE.md` (§ Бэкапы).
- Mirror script: `/home/dvolkov/backups/linkeon/minio-mirror.sh` (cron `20 * * * *`).
- Neo4j DR sync: `backup.sh` step 4.5 (after the nightly dump).
- Monitors: `src/monitoring/{replication,neo-snapshot,minio-mirror}-health.service.ts`.
