# CloudSim features

What the app can do **today**. This is the first place to look for "does it do X?" without reading the code. For how a feature is modelled and which numbers it uses, see [MODEL.md](MODEL.md). For the product's goals and roadmap, see [PRODUCT_SPEC.md](PRODUCT_SPEC.md).

Keep this file current: every change that adds, changes or removes something a user can see is recorded here in the same pull request (see the `cloud-simulator-workflow` skill).

## Building a design

- **Canvas.** An isometric blueprint canvas. Drag components from the palette, or click one to add it. Move, select, duplicate and delete them; connect two by dragging from the selected component's **+** handle. Pan, zoom and fit to screen. Undo and redo.
- **Components** (ten kinds, each with settings in the inspector):
  - **Client:** a source of traffic.
  - **API Gateway:** rate limiting.
  - **Load Balancer:** splits traffic between targets.
  - **App Servers:** a tier of instances.
  - **Serverless Function:** scales on its own.
  - **Database:** pool, replicas, shards.
  - **Cache** and **CDN:** answer reads.
  - **Queue:** a buffer or partitioned broker.
  - **Storage Bucket:** object storage.
- **Upgrade levels.** A component's shape grows with its settings (more vCPUs, more monitors, more crates) so how capable it is can be read at a glance.
- **New project menu.** Create a blank project, create one from a **template** (a modal listing every starter design with its description and weak point), or import a project file. The same menu exports a project file or PNG image and copies a share link.
- **Starter designs:** Link Shortener, Chat App, Video Streaming, E-commerce Store, Social Feed, Event Pipeline. Each runs healthy at steady load and has a deliberate weak point.

## The inspector

Selecting a component shows its live numbers and settings. Everything below the summary is a **collapsed section**.

- **Live panel:** health, utilization, headroom, incoming, **reads / writes**, dropped, latency, instances and scaling, plus rows that appear when they matter (blocked by geo rule, over a client or per-IP limit, out of memory, short of CPU, running from triggers, queue depth, replication lag, and so on).
- **Spec and estimated cost per hour.**
- **Settings sections** per component, for example Scale, Instance size and Downstream calls on App Servers.
- **Applications** (App Servers and Serverless): see below.
- **Triggers** (Serverless).
- **Traffic source / Application mix** (Client), **Location**, **Balancing**, **Rate limiter algorithm**, **Geo rule**, **Break it** (fault buttons).
- A connection leaving a load balancer has its own weight, backup and drain settings.

## Traffic

- **Clients** set requests per second, region (US-East, US-West, EU, APAC, LATAM, Middle East/Africa), client type, and retry policy (retries, exponential backoff with jitter, timeout).
- **Individual IPs.** A client can model many IPs: how many, the slowest and busiest rate, and how uneven they are.
- **Traffic shapes:** steady, spike, daily curve, flash sale, slow ramp. Speed 0.5× to 4×, pause and resume.
- **Retry storms** emerge from client retries on failure.

## Applications

An **application** is a kind of request on an App Servers tier or a Serverless Function.

- It lists the downstream components it **calls**. A request calls every one it lists, so each target sees that application's full traffic.
- It sets its own **reads / writes**, **response size** and, on an app tier, **CPU cost**.
- On a **serverless function** it also says the **time**, **memory** and **cores** one run needs.
- Each **client** sets the **mix** across the applications it can reach. The sliders are always 0 to 100 and add up to 100%; moving one rebalances the others.
- Without applications a tier splits its traffic evenly between its connections.

## Serverless functions

- **Memory sets CPU:** 1769 MB is one vCPU. Concurrency limit, always-warm instances, cold starts.
- A run that needs **more memory than the function has fails** ("out of memory"). A run that needs **more cores than it has runs proportionally slower** ("short of CPU"). Extra memory does not make a run faster.
- **Triggers:** run on a **schedule** (every N seconds, M runs each time) or **on writes** to a database, bucket or queue (runs per write). A trigger runs the default run (100 ms) or one of the function's applications, and takes its reads and writes from it.
- **Loops.** A function that writes to what triggers it is detected. A loop that keeps growing raises a "triggering itself" insight, and cost climbs with the invocation rate. **Stop recursive loops** ignores the function's own writes.
- **Run time calculator** (Main settings): "Will it fit?" for a described run or an application, at any memory size, with time, cold start, calls per second and cost per million runs. It changes nothing in the design.

## Rate limiting and geography

- **API Gateway** rate limit with three algorithms (fixed, token bucket, leaky bucket) and a burst allowance.
- **Limit each client** separately, and **limit each IP** separately (turns away only the IPs over the allowance).
- **Geo rules** on load balancers and app tiers: allow only, or block, a set of regions. Blocked requests are not errors.
- **Region latency:** hops between regions pay a network round trip and transfer time.

## Breaking things

- **Faults** on a component: Kill, Slow, Lose an instance, Flush (caches), Lose a zone, Bad release, Hot key, Flood (clients). Restore lifts them.
- **Scenarios** (one-click stress tests): Traffic spike, Node failure, Slow database, Cache flush, Retry storm, Zone outage, Gray failure, Bad deploy, Thundering herd, Bot flood, Hot partition.
- **Chaos experiments:** a saved timeline of faults and restores against a traffic shape, run live or previewed, with a verdict (survives or fails), peak errors and time above 2% errors.
- **Insight card:** when something fails, a plain-language "what broke and why", with a hint of what to try and a button to inspect the component.

## Resilience and scaling

- **Load balancing:** round-robin, weighted, least load, and sticky policies; health checks; slow start; connection draining; backup targets; "Add server group".
- **Autoscaling** for app servers, with start-up delay and a scale-out threshold.
- **Backpressure, timeouts, circuit breakers and fan-out** on app servers.
- **Databases:** connection pool, read replicas, replication lag, failover, strong or eventual consistency, sharding, hot keys, a connection pooler for functions.
- **Caches and CDNs:** hit rate, warm-up after a flush, request coalescing, stampedes.
- **Queues:** capacity, depth, partitions and consumers, hot partitions, poison messages and a dead-letter queue.
- **Storage buckets:** per-prefix throttling.

## Watching and understanding

- **Metrics bar:** p50, p99, error rate, throughput, cost per hour (an estimate), and an **SLO** meter with an error budget.
- **Timeline:** rewind up to the last four minutes of the simulation.
- **Dots** along each connection show traffic. Their density follows the connection's throughput.
- **Request tracing:** follow one request through every hop (click Trace, or Shift-click a moving dot). Options: the client it starts from, the type (typical, read, write, upload), the **application** (the request follows what that application calls, including several calls in order), its outcome (any, succeeds, fails, slow), and tracing 100 requests for a summary.
- **Challenges:** seven guided problems with goals, hints and a root cause shown once solved. Progress is kept in the browser.
- **Tooltips** on components and a context menu on right-click.

## Saving and sharing

- Designs **autosave** in the browser.
- **Export and import** a project as a JSON file; **export an image** (PNG); **copy a share link** that carries the whole design in its address (nothing is uploaded).

## Not in the app (removed or never built)

- The **design review** dialog (Review, Capacity and Compare tabs) and the Markdown **design report** were removed in v0.1.0. The engine pieces behind them (stress suite, suggested fixes, capacity finder, single-point-of-failure checks, recovery objectives) still exist in `src/sim/` and are used by challenges and tests, but no screen shows them.
- No accounts, backend, saved-project library, team features or AI-generated designs (frontend only).
