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
