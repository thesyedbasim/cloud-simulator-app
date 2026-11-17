# Simulation model

Small on purpose. Every number is an approximation meant to show *behaviour*, not predict production. All of it lives in `app/src/sim/engine.ts`.

**Tick.** Fixed 100 ms steps. Speed (0.5×–4×) changes how many steps run per 100 ms of wall time. The canvas renders at 60 fps independently.

**Traffic.** `rps(t) = client.rps × shape(t) × (1 + retryFactor)`. Shapes repeat every 60 s: steady, spike (3× for 20 s), daily curve (0.4×–1.6×), flash sale (jump to 4.5× then decay), slow ramp (0.3×→3×).

**Traffic sources.** Each client node is its own source with a region (US-East, US-West, EU, APAC, LATAM, Middle East/Africa), a client type, a response size, a read share and a request cost. Flow is tracked per source, so a node knows where its requests came from.

**Geo rules.** A load balancer or app tier can allow only, or block, a set of regions. Blocked requests never reach the capacity maths: they are counted as `blocked`, not as drops, and are left out of the error rate, the error budget and the percentiles. Rejecting is not free: it costs 2 % of a normal request at a load balancer and 10 % at an app tier, so a flood from a blocked region can still hurt an app tier. A client whose traffic is blocked does not retry.

**Request mix.** The request cost multiplies the capacity an app tier spends per request. Writes cost 3× a read at the database, relative to the 90 % read mix the database numbers assume, so defaults are unchanged. Response size drives data-transfer cost ($0.05/GB, an assumed figure).

**Load balancing.** A load balancer shares each client's traffic between its targets by policy: round-robin (equal), weighted (the connection weights), least load (proportional to each target's capacity right now, so slow or lost capacity is noticed at once and autoscaling is followed) or IP hash (each client address sticks to one target using rendezvous hashing; a person-type client has 64 addresses, mobile 32, bots 2, so bots behind few addresses skew the load). Each connection can be a backup (used only when every primary is out) or draining (eases off over the drain time). Health checks probe each target every N seconds; after M failures in a row it is taken out, and after 2 good probes it is put back, then ramped in over the slow-start time. Until detection the balancer keeps sending traffic to a dead target, which is the error window. If every target is out it tries them all. Only a down target (killed, or a lone instance lost) fails a probe.

**CDN, storage bucket, API gateway (first, simple versions).** A CDN is an edge cache: `hitRate` of requests are answered at the edge (8 ms) and the rest go on to the origin; it has far more capacity than a cache (50 000 rps). A storage bucket is a leaf that serves about 5 500 requests per second per key prefix (35 ms first byte); beyond that it throttles, and more prefixes raise the limit. Cost is storage plus a small fixed fee. An API gateway (6 ms) enforces an optional rate limit and the same geo rules as a load balancer. Requests over the limit are dropped (a 429), so they count as errors and clients retry, but a gateway that is limiting shows as strained, not failed, because that is its job. Everything it lets through is split evenly between its outgoing connections; routing rules come later.

**Serverless function.** No instances to manage: it scales with load and is limited only by its concurrency limit. One call takes about 100 ms at 512 MB and less with more memory (`100 × (512 / MB)^0.6`, at least 25 ms), and `capacity = concurrency / duration`. There is no queueing below the limit; above it requests are throttled (429). Concurrent executions needed = rps × duration. When that grows, each new instance serves its first request 400 ms slower (a cold start), so the share of cold requests is the instances created this step divided by the requests this step; a handful of cold requests is enough to set p99. Idle instances are reclaimed over about a minute, and always-warm (provisioned) instances never go cold but are billed even when idle. Cost is per request plus per GB-second, so it scales to zero and grows with traffic.

**Function connections and the pooler.** Each running function instance holds a database connection, so a database fed by a serverless function sees roughly the function's concurrent executions as connections. If that exceeds the connection pool, the database refuses the share of requests that cannot get one (`capacity = offered × pool / connections`), which shows as drops and a retry storm. A connection pooler (proxy) multiplexes them onto a few real connections, so the limit goes back to query concurrency, at the price of 2 ms of waiting and a per-vCPU fee. App servers are not affected.

**Read replicas.** Each replica is a full copy (it costs the same as the primary). Reads can be served by any of the primary and its replicas, writes only by the primary, so the primary carries `reads / (1 + replicas) + writes × 3` instead of `reads + writes × 3`. Replicas therefore help read-heavy traffic a lot and write-heavy traffic only a little. Replication lag is not modelled.

**Flow.** Requests move along connections in topological order. A node splits its output equally across its outgoing connections. A cache sends `hitRate` of served requests straight back (success) and forwards the misses.

**Capacity & drops.** `capacity = instances × capacityPerInstance` (app), `min(capacity, poolSize / baseLatency)` (database), drain rate (queue). `util = offered / capacity`. `served = min(offered, capacity)`; the rest is dropped. A queue instead grows by `(offered − drain) × dt` and drops only when it exceeds `maxDepth`.

**Latency.** `base / (1 − min(util, 0.98))`, floored at 50× base once `util ≥ 1`, plus queue wait. Base: LB 2 ms, app 25 ms, DB 18 ms, cache 1 ms, queue 4 ms. p50 = traffic-weighted sum along the path. p99 multiplies each hop by `2 + 6·util²` (an approximation of tail inflation, not a measured distribution). Dropped requests are excluded from percentiles and counted in the error rate.

**Database pool.** `poolUsed = served × latency` (Little's law), capped at `poolSize`. As latency rises near saturation, the pool fills and capacity collapses.

**Retries.** `retryFactor` eases toward `min(2, errorRate × 2)`, so failures feed extra load back into the clients. This is what produces a retry storm.

**Health.** Failed: killed, `util ≥ 1`, or > 1 % of requests dropped. Strained: `util ≥ 0.7`. Otherwise healthy.

**Cost.** Static $/hour table scaled by size and instance count. Always shown as an estimate.

**Assumptions.** Values marked *assumed* in the inspector are defaults, not user input. No randomness is used by the engine (particles are visual only).

## Faults, scenarios and explanations (Step 4)

**Faults** (simulation-only; they never change the design): *killed* (capacity 0), *slow* (latency ×4, capacity ÷4; the database's pool then fills because queries hold connections 4× longer), *lost instance* (one instance of a scaled-out tier dies: capacity × (n−1)/n; a single instance means down).

**Scenarios** reset the simulation, run a calm baseline, then land the fault: *Traffic spike* (switches to the spike shape, 3× after ~10 s), *Node failure* (one App Servers instance after 5 s), *Slow database* (all databases after 5 s). Stopping a scenario restores the traffic shape and removes only its own faults.

**Bottleneck and "why".** Among failed components the one dropping the most requests is the bottleneck. The card is generated from the live numbers: offered vs. capacity, the CPU/RAM limit, pool exhaustion for databases, queue depth for queues, and a retry-storm note when `retryFactor > 0.15`. The "try" hint is generic advice, not a measured recommendation. Backpressure is not modelled: a failed component drops its own traffic but does not slow the components in front of it.

## Review, fixes and compare (Step 5)

**Stress suite.** `runSuite` runs Traffic spike, Node failure and Slow database headlessly for 60 simulated seconds each, using the same `step()` as the live view. A scenario *survives* if errors never exceed 2% of requests. Scenarios the design cannot express (e.g. slow database with no database) are skipped, not failed.

**Suggested fixes are found by experiment.** Candidates are generated per component (add instances, scale up, enlarge a cache, double a pool, drain a queue faster, put a cache in front of a database), each is applied to a copy of the design, the suite is re-run, and a candidate is kept only if the summed peak error rate drops by at least 2 points. Results are ranked by scenarios fixed, then improvement, then cost. A fix is a prediction from this simple model, not a guarantee about real infrastructure.

**Single points of failure** are found statically: a component that every client-to-end path passes through and that has no redundancy (an app tier with one instance, or any other kind with no parallel copy). "Add a copy" clones the component and wires it in parallel; traffic splits equally between the copies.

**Compare** pins a snapshot as design A and runs one scenario on A and on the current design B, with a metric table, a plain-words list of what changed, and overlaid error-rate and p99 charts. Applying a suggested fix pins the previous design as A automatically (once) and is a single undo step.

**Cache cost** now rises with hit rate (a bigger cache costs more).

## Saving, presets and rewind (Step 6)

**Presets.** Four starters: Link Shortener, Chat App, Video Streaming, E-commerce Store. Each runs healthy at steady load (a test enforces it) and has a deliberate weak point that at least one stress scenario exposes (also tested), so the first run teaches something.

**Fix search, extended.** If no single change gets every scenario through, pairs of changes on different components are tried. A change that fixes one link of a chain counts as progress (the score includes how many components fail at the same moment), so a design with several problems is fixed one step at a time. Designs with a queue (a write path) are never offered a cache.

**Saving.** The design autosaves to browser storage 0.4 s after each edit. Files are JSON: `{ app: "cloudsim", version: 1, savedAt, architecture }`. Everything read back, from storage or an imported file, goes through `parseProject`, which rejects non-CloudSim and newer-version files, clamps settings to their valid range, fills missing ones, drops unknown settings and kinds, drops broken or duplicate connections, caps the size, and refuses overlapping components. Warnings are shown instead of failing silently.

**Rewind.** The simulation keeps a snapshot every 0.5 simulated seconds for the last 4 minutes. Dragging the timeline pauses the simulation and shows that snapshot on the canvas, in the metrics and in the explanation card. Editing the design, changing the traffic shape, or injecting a fault returns to live and starts a fresh timeline, because the past belonged to a different design.

## Autoscaling and request tracing (Step 7)

**Autoscaling** (App Servers, off by default). `instances` becomes the minimum; `maxInstances`, `warmupSec` (start-up delay) and `scaleUpAt` (target utilisation) are the other settings. Each step the tier asks for `ceil(offered ÷ (capacity per instance × scaleUpAt))` instances, capped at the maximum. Requested instances **do not serve traffic until the start-up delay has passed**, which is the lag between a spike and new capacity, but they are billed from the moment they are requested. A lost instance (Node failure) still counts towards the group's size but serves nothing, so the group replaces it like any unhealthy instance once the start-up delay has passed; a tier that is entirely down cannot be helped by more instances, so it does not scale. Scale-in removes one instance at a time, only after 30 s without a change and only if the smaller tier would sit clearly below the scale-out line (hysteresis, so it does not flap).

Consequences the tests pin down: autoscaling cannot lower the *peak* of a sudden spike (it is still starting) but shortens how long errors last; a start-up delay longer than the spike makes it useless against that spike; it handles a slow ramp well because the delay is shorter than the climb. The stress suite therefore also measures *seconds above the error line* and includes it in a fix's score.

**Request tracing.** One request is drawn at random from the current numbers: it starts at a client (weighted by traffic), picks outgoing connections uniformly (the same equal split the engine uses), is dropped at a component with probability `dropped ÷ offered` (always, if it is down), is answered early by a cache with probability equal to the hit rate, and spends `latency × (0.8–1.4)` at each hop, with a 3% chance of a slow outlier. Over many traces this reproduces the aggregate hit rate and error rate (tested). Clicking a moving dot steers the trace through that connection.

## Capacity finder and error budget (Step 8)

**Capacity finder.** Every client's traffic is scaled by a factor, the system is run to a steady state (60 s, or three times the longest autoscaling start-up delay, up to 240 s, so retries and new instances settle), and the largest factor that still runs clean is found by doubling from today's load and then bisecting. "Clean" means errors at most 2% and no component failed. The answer is cached nowhere: it is the same engine, so turning the traffic up by hand gives the same result (tested just below and just above the limit). *Headroom* per component is its capacity divided by the load it receives today. The "why it breaks" text comes from the same explainer as the live card, evaluated 15% above the limit. If the design survives 64× today's load the result is reported as a lower bound.

**Service-level targets.** Each design may carry `slo: { availability, p99Ms }` (defaults 99.5% and 500 ms; saved in project files, clamped on load). The **error budget** is the failures the target allows. For a run so far: `used = failed requests ÷ (requests × (1 − availability))`; 100% means the budget is spent and anything above means the target is missed. *Latency in target* is the share of the run's time that p99 stayed under the limit (95% needed to count as met). Counters cover the current run and restart when the run is reset, a scenario starts, or the design's components or connections change; renaming the design or editing its targets does not restart them. Rewinding shows the counters as they were at that moment. A burn rate of 1× means failing exactly as fast as the target allows.

**Stress test and SLOs.** Each stress scenario now also reports availability over its 60 seconds and the share of time p99 was within target, and whether the design's SLO would have been met.

## Upgrade levels (visual)

Every component has a level derived from the settings that make it more capable, so how upgraded it is can be read from its shape (`app/src/canvas/tier.ts`; tested). App Servers and Databases: vCPUs 1, 2, 4, 8, 16, 32 are levels 1 to 6 (stacked servers; a taller database with one more band per level). The top tiers get an antenna (servers) or an inlaid ring (databases). Caches grow a shelf per step of hit rate (levels 1 to 4), Load Balancers are a distribution hub with one outlet pipe per target (up to six) and a taller hub at higher levels (1 to 3), Queues gain crates as the drain rate rises, and Clients gain monitors as their request rate rises. Instance count does not change the look: it shows in the label and, with autoscaling, as slots. The tooltip and inspector show "Level N" (with pips).

## Backpressure, timeouts and retry policy (Stage 1)

**Retry policy.** Each client has `retries` (default 2, as before), `backoff` (exponential backoff with jitter, off by default) and `timeoutMs` (0 = none). The retry load is `errorRate × average retries`, weighted by client rps. Backoff multiplies a client's retries by 0.4 (retries are spread out, so far fewer arrive while the system is still struggling) and slows how quickly the extra load builds (smoothing 0.08 instead of 0.2). Both numbers are approximations, not measurements.

**Client timeouts.** Latency is approximated as log-normal, fitted to the median and p99 the engine already computes (`sim/latency.ts`). The share of requests slower than a client's timeout counts as failed: `errorRate = drops + (1 − drops) × timeouts`, and those failures feed the retry loop. A timed-out request is removed from throughput.

**Backpressure.** App servers have "Workers wait on downstream calls" (off by default, so existing designs are unchanged). When on, a worker is held for its own time plus the time its downstream calls take. The tier computes `hold = (own base + downstream latency now) / (1.15 × (own base + downstream latency at idle))`, capped at 20×, eased in at 25 % per step. Capacity becomes `capacity / hold`. The 1.15 grace means ordinary queueing downstream is not counted. So a slow or saturated database now makes the app tier in front of it fail, which is how a retry storm or cascade starts. Downstream latency is read from the previous step, so the effect arrives one step late.

**Call timeout.** With a call timeout the wait is capped at the timeout, and the share of downstream calls that run past it (latency spread around its mean, p99 taken as 4× the mean) fail at this tier. This frees workers, at the price of errors. Client timeouts do not free workers; only call timeouts do.

## Replication lag and failover (Stage 2)

**Replication lag.** A database with read replicas has a lag: `lag = idle lag / (1 − min(util, 0.97))`, so the busier the primary, the further behind the replicas fall (idle lag defaults to 50 ms). The share of reads that may return stale data is `replicas / (1 + replicas) × (1 − e^(−lag / 2 s))`: reads are spread over the primary and its replicas, and a replica read is stale if the row was changed within the lag (the 2 s window is an assumed figure for hot data, not a measurement).

**Failover.** Killing a primary that has replicas does not take the database down for good. For the failover time (default 30 s) writes fail and the replicas keep serving reads only (capacity is the replicas' own, and only the read share of traffic is served). After that a replica is promoted: the database serves again with one replica fewer. The writes the old primary had acknowledged but not yet shipped (`write rps × lag`, taken the instant it died) are reported as lost. A database with no replicas stays down until restored. A database with a replica is no longer reported as a single point of failure, since it can fail over, but the outage window still counts.

**Not modelled:** split brain, partial replication failure, promoting the *most up-to-date* replica (all replicas are treated alike).

## Cold cache, stampede and circuit breaker (Stage 3)

**Cold cache.** Caches and CDNs have a *warmth* (1 = their normal hit rate). A **Flush** fault sets it to 0 once, even though the fault stays injected afterwards; it then refills linearly over the warm-up time (default 30 s, `warmSec`). The delivered hit rate is `hitRate × warmth`. A design that never flushes is always fully warm, so nothing changes for existing designs.

**Stampede.** Without *request coalescing*, many requests for the same missing item each load it separately, so a cold cache forwards `misses × (1 + 2 × (1 − warmth))`: up to 3× the misses right after a flush. With coalescing on (one load per missing key) the misses are forwarded as they are. The factor 2 is an assumption, not a measurement.

**Circuit breaker.** App servers can have one (off by default). It watches the share of its downstream calls that fail end to end (a request counts as failed if it is dropped anywhere behind this tier, weighted by how much of this tier's traffic reaches each hop; calls that ran past the call timeout count too). Closed → opens when that share is over the threshold (default 25 %). Open: requests fail fast here, and nothing is sent downstream, which also releases blocked workers. After the open time (default 10 s) it goes half-open: 10 % of requests are let through for 2 s; if the failure share is under the threshold it closes, otherwise it opens again. Because only a trickle is let through, a downstream that is still slow can look healthy at 10 %, so a breaker can cycle open and closed while the problem lasts. That is how real breakers behave too. A tier fronted by a cache sees a smaller failure share than the database behind it (hits succeed), so the threshold may need to be lower than you would expect.

## More failure scenarios (Stage 4)

Scenarios are listed in the Scenarios menu and the compare view. Six were added. The **stress suite** (the review, the fix search and the "failing" badge) still runs only the original three (`SUITE_IDS`), so it stays quick; the new ones are run from the menu or the compare view.

| Scenario | What happens | Faults used |
| --- | --- | --- |
| Cache flush | Every cache and CDN empties at 5 s and refills from cold | `flushed` |
| Retry storm | The first app tier is 4× slower from 5 s to 15 s, then recovers on its own | `slow`, lifted at 15 s |
| Zone outage | Half of every app tier (the larger zone) and every database primary are lost at 5 s | `zoneLoss`, `killed` |
| Gray failure | The first app tier is 4× slower but still passes health checks, so a load balancer keeps sending it traffic (only a *down* target fails a probe) | `slow` |
| Bad deploy | A faulty release makes 30 % of an app tier's requests fail; capacity is fine. Restore it to roll back | `bad` |
| Thundering herd | All app tiers are down from 5 s to 13 s and caches come back empty, so the returning load meets a cold cache | `killed` + `flushed`, servers lifted at 13 s |

New faults: `zoneLoss` (a lone instance is down; otherwise `floor(n/2)` of `n` instances remain, and an autoscaler counts the lost ones as dead), `bad` (served × 0.7; the 30 % is an assumed figure). A scenario can now have an `until` time at which its faults are lifted, which is what makes a brief failure possible. The Faults panel has matching buttons (Flush, Lose a zone, Bad release).

**Not modelled yet:** a canary or staged rollout (a bad release always reaches the whole tier), DNS/TTL lag, a slow memory leak (gradual degradation).

## Sharding and partitioned brokers (Stage 5)

**Sharded database.** A database has `shards` (default 1). Each shard is a full database (its own vCPUs, memory and pool, and its own replicas), so cost multiplies by the shard count. Traffic is split by key: evenly, each shard gets `1 / shards`; with `hotShare` set, the busiest shard gets that share instead (never below an even spread). The busiest shard saturates first, so capacity is `per-shard capacity / busiest share`: four even shards give 4×, but a shard taking 50 % of the traffic caps four shards at 2×, and adding more shards changes nothing. The pool gauge shows the busiest shard's pool. An unsharded database is unchanged.

**Partitioned queue (consumer group).** A queue with `partitions > 0` acts like a broker. `capacity` becomes the rate each consumer can drain. A partition is read by one consumer in the group, so `active = min(consumers, partitions)` and the extra consumers sit idle. Drain is `min(active × rate, rate / hottest partition's share)`: the busiest partition has a single reader and caps the whole group. Poison messages (`poisonPct`) without a dead-letter queue are retried about 20 times, holding up their partition: drain ÷ `(1 + poison × 20)`. With a dead-letter queue a poison message is parked after one failure: drain ÷ `(1 + poison)`, and the parked count is shown. Consumers and partitions cost money. A queue with 0 partitions is the plain queue as before.

**Hot key.** The `hotKey` fault sends 60 % (assumed) of a sharded database's or partitioned queue's traffic to one shard or partition. It does nothing to an unsharded database or a plain queue. The **Hot partition** scenario injects it on every sharded database and partitioned queue.

**Presets.** *Social Feed* (four shards, one taking half the traffic) and *Event Pipeline* (four partitions, three consumers, one hot partition).

**Not modelled:** resharding cost and downtime, cross-shard queries, per-partition backlog (the queue depth is the total), ordering guarantees, consumer rebalancing pauses.

## Rate limiting (Stage 6)

An API gateway's rate limit now has three algorithms (`limitAlgo`; the fixed limit stays the default, so existing designs are unchanged):

- **Fixed limit.** Anything over the limit is turned away at once (a 429).
- **Token bucket.** The bucket holds `limit × burst allowance` tokens (default 2 s of traffic) and starts full. Each step the gateway can pass `limit + tokens / dt`, spending tokens when traffic is over the limit and refilling at `limit − served` when it is under. So a burst passes in full while the bucket lasts, then the gateway holds the line at the limit; a quiet period refills it. The capacity the inspector shows is the configured limit, not the transient burst capacity.
- **Leaky bucket.** Requests over the limit wait in a queue (up to `limit × burst allowance`) and are released at the limit rate, so downstream sees a smooth stream and nothing is dropped until the queue is full. The price is latency: waiting time is `depth / limit`.

**Per-client limits.** With "Limit each client separately", every client is capped at its own allowance before the shared limit is applied. What a client sends over its allowance is turned away and counted as dropped, like any 429. Without it, a noisy client takes most of the shared limit and every client loses the same share (a bot sending 3 000 rps next to a user sending 300 against a 2 000 rps limit leaves both with about 60 %). The gateway reports the share of each client's requests that got through.

**Bot flood.** A new `flood` fault (and the **Bot flood** scenario, which picks a bot client if there is one) makes a client send 8× its normal traffic. The 8× is an assumed figure.

**Not modelled:** distributed limiters (several gateways sharing a bucket), limits keyed on anything but the client, sliding windows, and the `Retry-After` behaviour of well-behaved clients.

## Consistency, durability and tail latency (Stage 7)

**Strong vs eventual consistency.** A database with replicas has a `consistency` setting (eventual by default, as before). *Eventual:* reads are shared by the primary and its replicas, and some may be stale (Stage 2). *Strong:* every read goes to the primary, so replicas take no read load and nothing is stale, and each write waits for a replica to confirm it, which adds `write share × replication lag` to the database's latency (a rough figure: the lag stretches as the primary gets busy). In return a failover loses no acknowledged writes. Strong consistency costs no extra money by itself, but it costs capacity and latency.

**Recovery objectives (RTO and RPO).** The review tab lists, for every database and without running anything: *RTO*, how long writes fail after the primary is lost (the failover time with a replica; "manual" with none), and *RPO*, how many seconds of acknowledged writes can be lost (the idle replication lag; none with strong consistency; "everything" with no replica, since the model has no backups). Under load the lag, and so the real loss, is larger than the idle figure; the live inspector shows what a failover actually lost.

**Fan-out and tail latency.** App servers have `fanout`, the number of parallel downstream calls each request makes and waits for (default 1). Waiting for the slowest of N calls: if one call's latency were log-normal with a p99 of 4× its median, the slowest of N has the p99 of `0.99^(1/N)` and the median of `0.5^(1/N)` of that curve, read with the inverse normal. With 10 calls the p99 of the wait is about 1.7× that of one call, with 100 about 2.3×, and the median stretches too (with 100 calls the median request still waits for something that is slow 1 time in 100). The extra wait is added to the tier's contribution to p50 and p99. **Only latency is modelled**: the extra load that N calls put on the downstream, and the higher chance that one of them fails, are not.

## Chaos experiments (Stage 8)

A **chaos experiment** is a list of events on a timeline: at `t` seconds, apply a fault to a component, or restore it (lift whatever fault it has). It also carries a traffic shape. `faultsAt(events, t)` gives the faults in force at time `t`: events apply in time order (events at the same moment in the order listed), a later fault on the same target replaces the earlier one, and a restore lifts only its target. Experiments are saved with the design (project files and browser storage), up to 20 of them with up to 30 events each, times from 0 to 300 s. Anything read back goes through the same sanitising as the rest of a project: events that point at a component that no longer exists, or name an unknown fault, are dropped with a warning.

**Running.** *Headless*: `runExperiment` uses the same engine and the same rules as the scenarios (a scenario and the equivalent experiment give identical results, and a test pins that), runs until 30 s after the last event (at least 60 s), and reports peak errors, seconds above the 2 % line, peak p99 and the SLO result, so an experiment can be replayed after every design change to see whether it helped. *Live*: the Chaos button runs it on the canvas; each event lands when the simulation clock passes it, only the experiment's own targets are touched, and stopping it lifts its faults and restores the traffic shape. Editing the design while it runs does not restart it; saving or deleting an experiment is not a design change.

The faults offered for a component are the ones that make sense for its kind (for example *Flush* only for caches and CDNs, *Hot key* only for databases and queues).

**Not modelled:** faults with a duration (use a fault and a later restore), randomised faults, and conditions ("if errors exceed 5 %, then…").

## Guided challenges (Stage 9)

A **challenge** is a starting design with a problem, goals, hints and a root cause that is shown only once it is solved (`sim/challenges.ts`). Goals are checked by the same engine as everything else, so meeting one means the design really survives that scenario:

- *survive* a scenario: errors never exceed 2 % of requests;
- *recover* from a scenario: errors are back under 2 % at a given second (the system may fail meanwhile), which is how a retry storm that never ends is told apart from one that does;
- *cost*: steady-state estimated cost per hour is within a budget (which is what rules out brute-forcing a problem with hardware);
- *recovery*: every database's RTO and RPO (Stage 7) are within limits.

Seven challenges, from beginner to advanced: *The Black Friday spike*, *Lose a server, keep the site*, *When the cache forgets*, *The outage that would not end* (a metastable failure: five retries per failed request keep a recovered system down; backoff or fewer retries lets it recover), *The slow database that took down the app* (a cascading failure through blocked workers), *The celebrity problem* (a hot key on a sharded database) and *A zone goes dark*. The incident ones retell kinds of outage, not specific events. Every challenge has a test that its starting design fails, that a reference answer passes, and that the obvious wrong answer (more servers, more shards, a bigger database) does not.

The dialog checks the design against the active challenge as you edit it (deferred, so editing stays smooth). Solved ids are kept in browser storage only. Starting a challenge replaces the current design as one undo step.
